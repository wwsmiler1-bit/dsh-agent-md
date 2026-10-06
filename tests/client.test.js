/**
 * 浏览器半侧（lib/client.js）的冒烟测试：不装浏览器也能验出「注册写错」类故障。
 *
 * 手法：用 node:vm 造一个近似的浏览器环境（window / document / fetch / console），
 * 把 client.js 当普通脚本执行（它只是调用 window.__ModuleLoader__.load），再运行
 * factory 拿到插件导出，然后用假 ctx 调 apply，检查注册项与渲染函数。
 *
 * 覆盖的故障类型（真实环境里表现为「设置页整页空白 / 导航项不出现」）：
 *   - factory 抛异常（require 了宿主没有的模块）
 *   - 导出形状不对（没有 name/inject/apply）
 *   - slots.register 的 meta 缺字段
 *   - 渲染函数抛异常（React 元素构造错误、引用未定义变量）
 *   - 样式 effect 不幂等（重复挂 / 卸载不摘）
 *
 * 注意：所有的假 React 把 useEffect 实现成**不执行**——这样组件停在 loading 态，
 * 既不会发真实网络请求，也把断言聚焦在「注册与元素构造」这一层。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_SRC, 'utf8')

/** 极简 React 替身：只够验证「元素树造得出来、hooks 拿得到初始值」。 */
function makeFakeReact() {
  function createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
  }
  const noop = () => {}
  return {
    createElement,
    Component: class FakeComponent {},
    useEffect: noop, // 不执行：保持 loading 态，不发请求
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
  }
}

/** 注册处的渲染函数外面套了一层错误边界，取组件本体时要剥掉。 */
function unwrapBoundary(element) {
  if (element !== null && typeof element === 'object' && typeof element.type === 'function'
    && element.type.name === 'AgentMdErrorBoundary') {
    return element.props.children.type
  }
  return element.type
}

/** 造一个假 document（够 style 注入用）。 */
function makeFakeDocument() {
  const nodes = []
  const doc = {
    nodes,
    getElementById(id) { return nodes.find((n) => n.id === id) || null },
    createElement(tag) {
      const node = { tagName: tag, id: '', textContent: '', parentNode: null }
      nodes.push(node)
      return node
    },
    head: {
      appendChild(node) { node.parentNode = doc.head },
      removeChild(node) { node.parentNode = null },
    },
  }
  return doc
}

/** 在 vm 里跑 client.js，返回 { exported, sandbox }。 */
function loadClient() {
  const document = makeFakeDocument()
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('测试里不该真的发请求') },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  let loaded = null
  sandbox.__ModuleLoader__ = { load(def) { loaded = def } }

  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' })

  assert.ok(loaded !== null, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-agent-md')
  assert.equal(typeof loaded.factory, 'function')

  const exported = loaded.factory((name) => {
    if (name === 'react') return makeFakeReact()
    throw new Error(`未预期的 require: ${name}`)
  })

  return { exported, sandbox, document }
}

/** 造一个假 ctx：记录 inject 的槽位名与 register 的返回值。 */
function makeCtx() {
  const effects = []
  const injected = []
  const registrations = []
  const ctx = {
    effect(fn) {
      effects.push(fn)
      const d = fn()
      return () => { if (typeof d === 'function') d() }
    },
    slots: {
      inject(slot, register) {
        injected.push(slot)
        registrations.push(register())
      },
      register(meta, render) {
        return { meta, render }
      },
    },
  }
  return { ctx, effects, injected, registrations }
}

test('client bundle 形状正确：有 name/inject/apply', () => {
  const { exported } = loadClient()
  assert.equal(exported.name, 'agent-md')
  assert.ok(Array.isArray(exported.inject), 'inject 必须是数组')
  assert.ok(exported.inject.includes('slots'), '必须声明依赖 slots')
  assert.equal(typeof exported.apply, 'function')
})

test('apply 注册设置页入口，meta 字段完整', () => {
  const { exported } = loadClient()
  const { ctx, injected, registrations } = makeCtx()
  exported.apply(ctx)

  assert.ok(injected.includes('settings.section'), '必须注册到设置页一级入口')
  assert.equal(registrations.length, 1, '应注册恰好一个设置页')

  const entry = registrations[0]
  assert.equal(entry.meta.name, 'settings.section')
  assert.equal(entry.meta.id, 'agent-md')
  assert.equal(typeof entry.meta.order, 'number')
  assert.equal(typeof entry.meta.label, 'function')
  assert.equal(entry.meta.label(), '人格')
  assert.equal(typeof entry.render, 'function', '必须给出渲染函数')
})

test('渲染函数能造出 React 元素树（含缺 props 的兜底）', () => {
  const { exported } = loadClient()
  const { ctx, registrations } = makeCtx()
  exported.apply(ctx)
  const render = registrations[0].render

  // render 返回的是「渲染组件」的元素（宿主负责真正挂载）
  const outer = render({ sessionId: 'sess-1' })
  assert.ok(outer !== null && typeof outer === 'object', 'render 必须返回元素')
  assert.equal(typeof outer.type, 'function', 'render 的元素类型应是组件')
  assert.equal(outer.props.sessionId, 'sess-1', '会话 id 必须透传进组件')

  // 直接调用组件本体：验证组件内部的元素构造（假 React 不跑 effect → 停在读取中态）
  const Section = unwrapBoundary(outer)
  const tree = Section({ sessionId: 'sess-1' })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'am-root')
  const child = Array.isArray(tree.props.children) ? tree.props.children[0] : tree.props.children
  assert.equal(child.props.className, 'am-loading')

  // 缺 props / 异常 props 也要能进组件不抛
  assert.doesNotThrow(() => render(undefined))
  assert.doesNotThrow(() => render({}))
  assert.doesNotThrow(() => Section({}))
  assert.doesNotThrow(() => Section({ sessionId: 42 }))
})

test('样式 effect：挂了带固定 id 的样式节点，卸载时摘掉，重复调用不叠加', () => {
  const { exported, document } = loadClient()
  const { ctx, effects } = makeCtx()
  exported.apply(ctx)

  assert.ok(effects.length >= 1, '应至少注册一个 effect（样式注入）')
  const cleanups = effects.map((fn) => fn())
  const styleNode = document.nodes.find((n) => n.id === 'dsh-agent-md-styles')
  assert.ok(styleNode !== undefined, '样式节点必须带固定 id（供幂等判断）')
  assert.equal(styleNode.parentNode, document.head, '样式必须挂在 head 上')
  assert.ok(String(styleNode.textContent).includes('.am-root'), '样式内容必须真的写进去')

  // 再跑一次 effect：id 已存在，不应重复插入
  const before = document.nodes.length
  effects[0]()
  assert.equal(document.nodes.length, before, '重复注入不该再造节点')

  for (const c of cleanups) if (typeof c === 'function') c()
  assert.equal(styleNode.parentNode, null, '卸载后样式必须摘掉')
})

test('渲染函数在极端输入下不抛（防御性）', () => {
  const { exported } = loadClient()
  const { ctx, registrations } = makeCtx()
  exported.apply(ctx)
  const render = registrations[0].render
  assert.doesNotThrow(() => render({ sessionId: 123 }))
  assert.doesNotThrow(() => render({ sessionId: null }))
})
