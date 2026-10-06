/**
 * 数据态渲染测试：把**真实宿主 API 的响应**喂给设置页组件，验证它真的渲染出
 * 可编辑界面（编辑器 / 页签 / 保存 / 打开原文件 / 连接指示灯）。
 *
 * 为什么需要它：另一个客户端测试（client.test.js）只跑到「读取中」态（那里的假
 * React 不执行 useEffect），覆盖不到数据态——而「在设置页里可视化编辑人格」正是
 * 本插件要交付的核心能力。
 *
 * 做法：用一个会执行 effect、并把 setState 回填后重渲染的假 React 把组件渲染到
 * 稳定态，数据由**真的宿主插件实例**（假 ctx + 假 webServer）产出，所以断言对着的
 * 是真接口的形状，不是手写的假数据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

// 隔离家目录（必须在 import 宿主模块之前设好）
const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-md-render-'))
process.env.DSH_HOME = SANDBOX

const plugin = await import('../lib/index.js')
const persona = await import('../lib/persona.js')

// ---- 宿主侧：起真插件实例 ---------------------------------------------------

function startHost() {
  const registered = []
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on() { return () => {} },
    get() { return undefined },
    logger: { info() {}, warn() {} },
    systemPrompt: { context() { return () => {} }, section() { return () => {} } },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
  plugin.apply(ctx)
  return registered.find((r) => r.path === '/api/agent-md')
}

/** 用真实路由跑一次请求，拿 JSON 响应。 */
async function callHost(route, { method = 'GET', url = '/', body = null } = {}) {
  const req = {
    method,
    url,
    headers: { 'user-agent': 'render-test/1.0' },
    on(event, cb) {
      if (event === 'data' && body !== null) cb(Buffer.from(JSON.stringify(body), 'utf8'))
      if (event === 'end') cb()
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    writeHead() {},
    end(buf) { if (buf !== undefined) chunks.push(Buffer.from(buf)) },
  }
  await route.handler(req, res)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ---- 假 React：会执行 effect、并把状态回填后重渲染 --------------------------

function makeLiveReact() {
  const element = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })

  function createHooks() {
    const slots = []
    let cursor = 0
    let scheduled = false
    let started = false
    /** 每次渲染用掉的 hook 槽数（React 要求它逐帧恒定）。 */
    const counts = []
    return {
      reset() {
        if (started) counts.push(cursor)
        started = true
        cursor = 0
      },
      /** 手工记录当前这一帧用掉的槽数（renderStable 在最后一帧后调用）。 */
      record() { counts.push(cursor) },
      counts() { return counts.slice() },
      takeConsumed() { const s = scheduled; scheduled = false; return s },
      useState(init) {
        const i = cursor++
        if (slots[i] === undefined) slots[i] = { value: typeof init === 'function' ? init() : init }
        const slot = slots[i]
        return [slot.value, (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (value !== slot.value) { slot.value = value; scheduled = true }
        }]
      },
      useRef(init) {
        const i = cursor++
        if (slots[i] === undefined) slots[i] = { current: init }
        return slots[i]
      },
      useCallback(fn) { cursor += 1; return fn },
      useMemo(fn) { cursor += 1; return fn() },
      useEffect(fn, deps) {
        const i = cursor++
        const same = (a, b) => {
          if (a === undefined || b === undefined) return false
          if (a.length !== b.length) return false
          for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false
          return true
        }
        // ⚠️ 必须实现依赖数组语义：早先版本「只在首次执行」，于是「目标切换 → 把文件
        // 内容填进编辑器」这个 effect 永远不跑，文本域一直是空的——那是测试替身的
        // 缺陷，不是产品代码的问题（很容易误判成组件 bug）。
        const prev = slots[i]
        const shouldRun = prev === undefined || deps === undefined || !same(prev, deps)
        if (shouldRun) {
          slots[i] = deps
          Promise.resolve().then(() => fn())
        }
      },
    }
  }

  return { createElement: element, createHooks }
}

/** 在 vm 里加载 client bundle，注入「本次实例专属」的 hooks 与 fetch。 */
function loadClient() {
  const document = {
    nodes: [],
    getElementById(id) { return this.nodes.find((n) => n.id === id) || null },
    createElement(tag) { const n = { tagName: tag, id: '', textContent: '', parentNode: null }; this.nodes.push(n); return n },
  }
  document.head = { appendChild(n) { n.parentNode = document.head }, removeChild(n) { n.parentNode = null } }

  let fetchImpl = async () => { throw new Error('未设置 fetch 实现') }
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    fetch: (url, options) => fetchImpl(String(url), options),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  let loaded = null
  sandbox.__ModuleLoader__ = { load(def) { loaded = def } }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' })

  // ⚠️ hooks 必须**每个实例一份**、闭包在 factory 里：
  // 早先版本用一个共享 hooks + bind 切换，结果两个测试的组件混用了对方的 hooks 槽
  // → useState 读串、渲染中途中断 → 按钮的 className 整个消失（表现为「文本在、
  // 样式类丢」这种很误导人的断言失败）。实例隔离才是对的。
  const react = makeLiveReact()
  const hooks = react.createHooks()
  const fakeReact = {
    createElement: react.createElement,
    // 最小可用的 class 基类：错误边界继承它，测试要能 new 出来检查渲染结果
    Component: class FakeComponent { constructor(props) { this.props = props || {} } },
    useEffect: (fn) => hooks.useEffect(fn),
    useCallback: (fn) => { hooks.useCallback(fn); return fn },
    useMemo: (fn) => hooks.useMemo(fn),
    useRef: (v) => hooks.useRef(v),
    useState: (init) => hooks.useState(init),
  }

  const exported = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`未预期的 require: ${name}`)
  })

  return { exported, hooks, setFetch: (fn) => { fetchImpl = fn }, document }
}

/** 渲染到稳定态：反复渲染直到没有新的状态变更（上限防死循环）。 */
async function renderStable(hooks, Section, props, maxRounds = 30) {
  let tree = null
  for (let round = 0; round < maxRounds; round += 1) {
    hooks.reset()
    tree = Section(props)
    await new Promise((r) => setTimeout(r, 0))
    if (!hooks.takeConsumed()) break
  }
  hooks.reset()
  tree = Section(props)
  hooks.record()

  // ⚠️ 真实 React 的硬规则：每次渲染的 hook 调用数量必须完全一致。首帧（还没拿到数据）
  // 与数据帧走的 if 分支不同，一旦某个 hook 落在早返回之后，就会命中
  // 「Rendered more hooks than during the previous render」——整页白屏。
  // 假 React 不做这个检查，所以在这里补上（2026-10-05 白屏事故的回归防线）。
  const counts = hooks.counts()
  const first = counts[0]
  for (const c of counts) {
    assert.equal(c, first, `每次渲染的 hook 调用数必须一致（React 规则），实测每帧为：${counts.join(' / ')}`)
  }
  return tree
}

/** 从 bundle 里取出注册进 settings.section 的渲染函数与组件函数。 */
function mountSection(exported) {
  let render = null
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    slots: {
      inject(slot, register) {
        const entry = register()
        if (slot === 'settings.section') render = entry.render
      },
      register(meta, r) { return { meta, render: r } },
    },
  }
  exported.apply(ctx)
  assert.equal(typeof render, 'function', '必须注册 settings.section 渲染函数')
  const outer = render({ sessionId: 'sess-render' })
  // 注册处外面套了一层错误边界（白屏加固），取组件本体时剥掉它
  const Section = outer !== null && typeof outer === 'object' && typeof outer.type === 'function'
    && outer.type.name === 'AgentMdErrorBoundary'
    ? outer.props.children.type
    : outer.type
  return { render, Section }
}

// ---- 元素树工具 -------------------------------------------------------------

/** 把元素树里的字符串拼起来，便于断言「某段文字出现了」。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props !== undefined && node.props !== null ? node.props.children : undefined)
}

/** 按元素类型的函数名统计（组件元素不展开成 DOM，只能这样数）。 */
function countByType(node, typeName, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) countByType(n, typeName, out); return out }
  if (typeof node.type === 'function' && node.type.name === typeName) out.push(node)
  countByType(node.props !== undefined && node.props !== null ? node.props.children : undefined, typeName, out)
  return out
}

/** 按 className（整词）收集元素。 */
function collectByClass(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectByClass(n, className, out); return out }
  const cls = node.props !== undefined && node.props !== null ? node.props.className : undefined
  if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) out.push(node)
  collectByClass(node.props !== undefined && node.props !== null ? node.props.children : undefined, className, out)
  return out
}

// ---- 用例 -------------------------------------------------------------------

test('设置页在数据态真的渲染出可编辑界面（喂真实宿主响应）', async () => {
  // 准备：真起宿主，写一份全局人格 + 一个项目人格
  const route = startHost()
  const ws = join(SANDBOX, 'ws', 'rendered-project')
  mkdirSync(ws, { recursive: true })
  persona.writeTextFile(persona.globalPath(), '# 全局人格\n\n说话简洁。')
  persona.writeTextFile(persona.slugFor(ws).path, '# 项目人格\n\n这个项目里稳重一点。')

  const stateBody = await callHost(route, { url: `/api/agent-md/state?path=${encodeURIComponent(ws)}` })
  assert.ok(stateBody.bridge.count >= 1, '宿主必须记录握手（bridge）')

  // 加载 bundle，把真响应喂进去
  const { exported, hooks, setFetch } = loadClient()
  setFetch(async (url) => {
    const body = String(url).includes('/state') ? stateBody : { ok: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })

  const { Section } = mountSection(exported)
  const tree = await renderStable(hooks, Section, { sessionId: 'sess-render' })
  const text = textOf(tree)

  // 界面长出来了
  assert.equal(collectByClass(tree, 'am-loading').length, 0, '不该停在读取中态')
  assert.equal(collectByClass(tree, 'am-root').length, 1, '根容器在')
  assert.equal(collectByClass(tree, 'am-textarea').length, 1, '必须有可编辑的文本域')
  // 页签与按钮是 React 组件元素（本测试的假 React 不像真 React 那样把组件展开成
  // DOM），所以断言组件元素本身，而不是它们的 DOM class
  assert.equal(countByType(tree, 'Pill').length, 2, '必须有全局 / 项目两个页签')
  const names = new Set()
  ;(function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    names.add(typeof n.type === 'function' ? (n.type.name || 'anon') : String(n.type))
    walk(n.props?.children)
  })(tree)
  assert.ok(
    countByType(tree, 'ActionButton').length >= 2,
    '至少要有保存与打开原文件两个按钮；实到 ' + countByType(tree, 'ActionButton').length
      + '；树里出现过的类型 = ' + [...names].join(','),
  )
  assert.equal(countByType(tree, 'ToggleRow').length, 3, '三个开关')
  assert.equal(collectByClass(tree, 'am-root').length, 1, '根容器在')
  assert.equal(collectByClass(tree, 'am-live').length, 1, '必须有连接指示灯')
  assert.equal(collectByClass(tree, 'am-live-stale').length, 0, '刚请求过，指示灯应是「已连接」')

  const textarea = collectByClass(tree, 'am-textarea')[0]
  assert.equal(typeof textarea.props.value, 'string', '文本域必须受控且带内容')

  // 关键信息与按钮文案都在
  assert.ok(text.includes('人格 · AGENT.md'), '标题在')
  assert.ok(text.includes('本会话当前生效'), '生效横幅在')
  assert.ok(text.includes('本页已连接宿主'), '连接回执在')
  assert.ok(text.includes('全局人格'), '全局页签在')
  assert.ok(text.includes('项目人格'), '项目页签在')
  assert.ok(text.includes('打开原文件'), '打开原文件按钮在')
  assert.ok(text.includes('保存'), '保存按钮在')
  assert.ok(text.includes(ws), '当前工作目录显示出来了')

  // 编辑器里装的是**真实**的全局人格内容（默认页签是全局）
  assert.ok(textarea.props.value.includes('全局人格'), '文本域装着全局人格的真实内容')
})

test('设置页在「一份人格都没有」时给出新建引导而不是空白', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'agent-md-render-empty-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = emptyHome
  try {
    const route = startHost()
    const body = await callHost(route, { url: '/api/agent-md/state' })
    assert.equal(body.global.exists, false, '空家目录下全局人格不存在')

    const { exported, hooks, setFetch } = loadClient()
    setFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }))

    const { Section } = mountSection(exported)
    const tree = await renderStable(hooks, Section, { sessionId: '' })
    const text = textOf(tree)

    assert.ok(text.includes('这份人格还没创建'), '应给出「还没创建」引导')
    assert.ok(text.includes('新建模板'), '应给出新建按钮')
    assert.equal(collectByClass(tree, 'am-textarea').length, 1, '空的也要能直接开始写')
  } finally {
    process.env.DSH_HOME = prev
  }
})

test('错误边界：渲染异常变成可读红字，而不是白屏', () => {
  const { exported } = loadClient()
  const { render } = mountSection(exported)
  const outer = render({ sessionId: 'sess-boundary' })
  assert.equal(outer.type.name, 'AgentMdErrorBoundary', '注册处必须套一层错误边界')

  const Boundary = outer.type
  const child = { type: 'div', props: {} }
  const instance = new Boundary({ sessionId: 'sess-boundary', children: child })
  assert.equal(instance.render(), child, '没出错时必须原样渲染子组件')

  // 模拟 React 捕获到子组件抛错后的状态（getDerivedStateFromError）
  instance.state = Boundary.getDerivedStateFromError(new Error('boom: 渲染炸了'))
  const text = textOf(instance.render())
  assert.ok(text.includes('渲染时出错'), '必须给出「渲染出错」的诊断而不是空白')
  assert.ok(text.includes('boom: 渲染炸了'), '必须把原始错误消息显示出来')
  assert.ok(text.includes('人格注入本身不受影响'), '必须告诉用户人格注入不受影响')
})

test('hook 一致性防线本身有效（白屏事故不会再溜过测试）', async () => {
  // 故意造一个「首帧少调一个 hook」的组件——这正是那次白屏的形态：
  // 首帧走早返回、第二帧才多调一个。renderStable 必须把它抓住。
  const react = makeLiveReact()
  const hooks = react.createHooks()
  let frame = 0
  const Broken = () => {
    frame += 1
    if (frame === 1) {
      const [, bump] = hooks.useState(0)
      bump(1)
      return { type: 'div', props: {} }
    }
    hooks.useState(0)
    hooks.useState(0)
    return { type: 'div', props: {} }
  }
  await assert.rejects(
    () => renderStable(hooks, Broken, {}),
    /hook 调用数必须一致/,
    'hook 顺序违规必须被这条防线抓住',
  )
})
