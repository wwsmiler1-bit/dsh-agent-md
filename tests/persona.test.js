/**
 * dsh-agent-md 的端到端测试。
 *
 * 用法：node --test "tests/*.test.js"
 *
 * ⚠️ 设计成**一个测试函数**、内部顺序 await：
 * node --test 的顶层用例之间会交错（异步用例在 await 处让出，别的用例趁机跑），
 * 而本插件的行为依赖「家目录里的文件内容」这一共享状态——拆成多个顶层用例时
 * 一个用例写的全局人格会被另一个用例覆盖，断言随执行顺序漂移（实测踩过）。
 * 顺序执行换来确定性：用例内部的每一步都各写各的文件、各断言各的结果。
 *
 * 环境隔离：在 import 被测模块**之前**把 DSH_HOME 指到临时目录。同样因为交错
 * 问题，进程级环境变量的临时改写放在另一个文件（empty-home）里跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-md-test-'))
process.env.DSH_HOME = SANDBOX

const persona = await import('../lib/persona.js')
const plugin = await import('../lib/index.js')

const {
  agentsRoot, globalPath, slugFor, normalizePathKey, displayNameFor,
  isEffectivelyEmpty, sanitizeForHost, composePersona, writeTextFile, readTextFile,
  listProjects, registerProject, buildTemplate, registryPath, statePath,
} = persona

/** 造一个工作目录。 */
function makeWorkspace(name) {
  const dir = join(SANDBOX, 'ws', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一个最小可用的 cordis ctx + 假 webServer（记录注册了什么）。 */
function makeCtx() {
  const registered = []
  const sections = []
  const ctx = {
    effect(fn) {
      const d = fn()
      return () => { if (typeof d === 'function') d() }
    },
    on() { return () => {} },
    get() { return undefined },
    logger: { info() {}, warn() {} },
    systemPrompt: {
      context(def) { sections.push(def); return () => {} },
      section(def) { sections.push(def); return () => {} },
    },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
  return { ctx, registered, sections }
}

/** 跑一次路由：伪造 req/res，拿回 { status, body }。 */
async function callRoute(route, { method = 'GET', url = '/', body = null } = {}) {
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== null) cb(Buffer.from(JSON.stringify(body), 'utf8'))
      if (event === 'end') cb()
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    statusCode: 0,
    headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(buf) { if (buf !== undefined) chunks.push(Buffer.from(buf)) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, body: text === '' ? null : JSON.parse(text) }
}

test('dsh-agent-md 全量行为', async (t) => {
  // ---------------------------------------------------------------------
  await t.test('模板变量降级：正文里不再出现连续两个左花括号', () => {
    // 宿主（@deepseek-ai/dsh-system-prompt）把段正文里的 {{name}} 当模板变量解析，
    // 未注册的名字会抛 unknown prompt variable 并让整轮注入失败。
    const out = sanitizeForHost('记录 {{session}} 与 {{date}}')
    assert.ok(!out.includes('{{'), '绝不能留下 {{')
    assert.equal(out, '记录 {session}} 与 {date}}')
    assert.equal(sanitizeForHost('{{{x}}}'), '{x}}}')
    assert.equal(sanitizeForHost('{{'), '{')
    assert.equal(sanitizeForHost('没有花括号'), '没有花括号')
  })

  await t.test('空人格识别：注释算空，标题算正文（模板正文就是标题）', () => {
    assert.equal(isEffectivelyEmpty(''), true)
    assert.equal(isEffectivelyEmpty('   \n\n  '), true)
    assert.equal(isEffectivelyEmpty('<!-- 只有注释 -->'), true)
    assert.equal(isEffectivelyEmpty('<!-- 注释 -->\n\n<!-- 又一条 -->'), true)
    // 关键：模板正文以标题形式书写，单标题人格必须算「有内容」，否则会被静默跳过
    assert.equal(isEffectivelyEmpty('# 这个项目里你是资深维护者'), false)
    assert.equal(isEffectivelyEmpty('# 标题\n\n正文'), false)
  })

  await t.test('路径规范化与 slug：Windows 盘符不会进文件名', () => {
    assert.equal(normalizePathKey('D:\\Team\\'), 'd:/team')
    assert.equal(normalizePathKey('d:/team/'), 'd:/team')
    assert.equal(displayNameFor('D:\\team\\dsh-agent-md'), 'dsh-agent-md')

    const a = slugFor('D:\\team\\proj')
    const b = slugFor('d:/team/proj/')
    const c = slugFor('D:\\other\\proj')
    assert.equal(a.slug, b.slug, '同一目录不同写法必须同 slug')
    assert.notEqual(a.slug, c.slug, '同名不同父目录必须不同 slug')
    assert.ok(!a.slug.includes(':'), 'slug 不能含冒号（Windows 非法文件名）')
    assert.ok(a.fileName.endsWith('.md'))
    assert.ok(a.path.startsWith(join(agentsRoot(), 'projects')), '项目文件必须落在人格根目录内')
  })

  await t.test('合成人格：只有全局时单独生效', () => {
    writeTextFile(globalPath(), '# 全局底座人格\n\n说话简洁。')
    const r = composePersona({ cwd: '', config: { enabled: true } })
    assert.ok(r.text.includes('人格设定'))
    assert.ok(r.text.includes('全局底座人格'))
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0].label, '全局')
  })

  await t.test('合成人格：项目人格与全局并存，项目段在后', () => {
    const ws = makeWorkspace('project-priority')
    writeTextFile(slugFor(ws).path, '# 这个项目里你是资深维护者')
    const r = composePersona({ cwd: ws, config: { enabled: true } })
    assert.equal(r.sources.length, 2)
    assert.ok(r.text.includes('全局底座人格'), '全局作底座一起注入')
    assert.ok(r.text.includes('这个项目里你是资深维护者'))
    const globalAt = r.text.indexOf('全局人格')
    const projectAt = r.text.indexOf('当前项目人格')
    assert.ok(globalAt !== -1 && projectAt !== -1 && globalAt < projectAt, '项目段必须在全局段之后')
    assert.ok(r.text.includes('优先于全局人格'))
  })

  await t.test('合成人格：项目内 AGENT.md 压过本机项目人格', () => {
    const ws = makeWorkspace('local-wins')
    writeTextFile(slugFor(ws).path, '本机存储的版本')
    writeTextFile(join(ws, 'AGENT.md'), '仓库里带走的版本')
    const r = composePersona({ cwd: ws, config: { enabled: true } })
    assert.ok(r.text.includes('仓库里带走的版本'))
    assert.ok(!r.text.includes('本机存储的版本'), '高优先级命中后不再注入低优先级那份')
    assert.equal(r.sources[1].kind, 'local')
  })

  await t.test('合成人格：三个开关各自生效', () => {
    const ws = makeWorkspace('switches')
    writeTextFile(slugFor(ws).path, '项目内容')

    const onlyProject = composePersona({ cwd: ws, config: { includeGlobal: false } })
    assert.ok(onlyProject.text.includes('项目内容'))
    assert.ok(!onlyProject.text.includes('全局底座人格'), 'includeGlobal=false 时全局不注入')

    const onlyGlobal = composePersona({ cwd: ws, config: { projectPersonaEnabled: false } })
    assert.ok(onlyGlobal.text.includes('全局底座人格'))
    assert.ok(!onlyGlobal.text.includes('项目内容'))
  })

  await t.test('合成人格：真实注入文本里的模板变量也被降级', () => {
    writeTextFile(globalPath(), '会话是 {{session}}，模型是 {{model}}')
    const r = composePersona({ cwd: '', config: { enabled: true } })
    assert.ok(r.text.includes('{session}'))
    assert.ok(!r.text.includes('{{session}}'))
    writeTextFile(globalPath(), '# 全局底座人格\n\n说话简洁。')
  })

  await t.test('宿主端：注册了注入段与 API 路由', () => {
    const { ctx, registered, sections } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    assert.ok(route !== undefined, '必须注册 /api/agent-md 前缀路由')
    assert.equal(route.kind, 'prefix')
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'agent-md:persona')
  })

  await t.test('宿主端：text(context) 按会话 cwd 取对应项目人格，互不串味', async () => {
    const { ctx, sections } = makeCtx()
    plugin.apply(ctx)
    const def = sections[0]

    const ws = makeWorkspace('inject-by-session')
    writeTextFile(slugFor(ws).path, '这个项目的人格：稳重')
    const text = await def.text({ agent: { id: 'sess-1', session: { header: { cwd: ws } } } })
    assert.ok(text.includes('这个项目的人格：稳重'))

    const other = makeWorkspace('inject-other')
    const text2 = await def.text({ agent: { id: 'sess-2', session: { header: { cwd: other } } } })
    assert.ok(!text2.includes('这个项目的人格：稳重'), '别的项目不能串味')
    assert.ok(!text2.includes('当前项目人格'), '没有项目人格时不该出现项目段')
  })

  await t.test('宿主端：context 缺字段时不抛异常（会话模型变动的兜底）', async () => {
    const { ctx, sections } = makeCtx()
    plugin.apply(ctx)
    const def = sections[0]
    await def.text(undefined)
    await def.text({})
    await def.text({ agent: {} })
    await def.text({ agent: { session: {} } })
    await def.text({ agent: { session: { header: {} } } })
  })

  await t.test('API：GET /state 返回全局 / 项目 / 解析结果', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    writeTextFile(globalPath(), 'state 探针内容')

    const { status, body } = await callRoute(route, { url: '/api/agent-md/state' })
    assert.equal(status, 200)
    assert.equal(body.enabled, true)
    assert.equal(body.global.content, 'state 探针内容')
    assert.equal(body.baseDir, agentsRoot())
    assert.ok(Array.isArray(body.projects))
    assert.ok(body.current !== undefined)
    assert.ok(Array.isArray(body.templates))
  })

  await t.test('API：GET /state?path=<cwd> 能解析指定项目', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const ws = makeWorkspace('state-by-path')
    writeTextFile(slugFor(ws).path, '路径解析到的项目人格')

    const { status, body } = await callRoute(route, { url: `/api/agent-md/state?path=${encodeURIComponent(ws)}` })
    assert.equal(status, 200)
    assert.equal(body.current.cwd, ws)
    assert.equal(body.current.resolved.kind, 'project')
    assert.ok(body.current.resolved.chars > 0)
  })

  await t.test('API：POST /save 落盘全局、归一换行、备份上一版', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')

    writeTextFile(globalPath(), '第一版')
    const { status, body } = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/save',
      body: { scope: 'global', content: '第二版\r\n换行也要归一' },
    })
    assert.equal(status, 200)
    assert.equal(body.saved, true)
    assert.equal(readTextFile(globalPath()), '第二版\n换行也要归一', 'CRLF 必须归一成 LF')
    assert.equal(readTextFile(`${globalPath()}.bak`), '第一版', '必须留下 .bak 备份')
  })

  await t.test('API：POST /save 超大内容被拒（413）', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const huge = 'x'.repeat(persona.MAX_FILE_BYTES + 10)
    const { status, body } = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/save',
      body: { scope: 'global', content: huge },
    })
    assert.equal(status, 413)
    assert.match(body.error, /上限/)
  })

  await t.test('API：POST /config 落盘，重启后读回并真实生效', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const { status, body } = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/config',
      body: { enabled: false, includeGlobal: false, localNames: ['AGENT.md'] },
    })
    assert.equal(status, 200)
    assert.equal(body.config.enabled, false)
    assert.equal(body.config.includeGlobal, false)
    assert.ok(existsSync(statePath()), '配置文件必须落盘')

    // 新 ctx（模拟重启）：配置读回，且 enabled=false → 完全不注入
    writeTextFile(globalPath(), '重启后不该出现')
    const second = makeCtx()
    plugin.apply(second.ctx)
    const text = await second.sections[0].text({ agent: { session: { header: { cwd: '' } } } })
    assert.equal(text, '', 'enabled=false 时必须完全不注入')

    // 恢复开启，避免影响后续用例
    await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/config',
      body: { enabled: true, includeGlobal: true },
    })
    writeTextFile(globalPath(), '# 全局底座人格\n\n说话简洁。')
  })

  await t.test('API：/create 建模板且不覆盖已有文件', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const ws = makeWorkspace('create-probe')

    const created = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/create',
      body: { scope: 'project', cwd: ws, kind: 'stored' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.created, true)
    const content = readTextFile(slugFor(ws).path)
    assert.ok(content.includes('项目人格'))
    assert.ok(content.includes(displayNameFor(ws)), '模板里要写明是哪个项目')

    const again = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/create',
      body: { scope: 'project', cwd: ws, kind: 'stored' },
    })
    assert.equal(again.body.created, false, '已存在时不覆盖')
    assert.equal(again.body.reason, 'exists')
  })

  await t.test('API：kind=local 写项目内 AGENT.md，revert 走删除语义', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const ws = makeWorkspace('local-save')

    const saved = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/save',
      body: { scope: 'project', kind: 'local', cwd: ws, content: '仓库自带的人格' },
    })
    assert.equal(saved.status, 200)
    assert.equal(readTextFile(join(ws, 'AGENT.md')), '仓库自带的人格')
    assert.ok(listProjects().some((p) => p.cwd === ws), '保存后该项目必须进登记表')

    const cleared = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/save',
      body: { scope: 'project', kind: 'local', cwd: ws, mode: 'revert' },
    })
    assert.equal(cleared.status, 200)
    assert.equal(existsSync(join(ws, 'AGENT.md')), false, 'revert 应删掉项目内文件')
  })

  await t.test('API：未知路由返回 404，缺 cwd 返回 400', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')

    const missing = await callRoute(route, { url: '/api/agent-md/nope' })
    assert.equal(missing.status, 404)

    const badBody = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/save',
      body: { scope: 'project', kind: 'stored', content: 'x' },
    })
    assert.equal(badBody.status, 400)
  })

  await t.test('健壮性：坏掉的登记表不影响注入，写一次即自愈', () => {
    writeTextFile(registryPath(), '{ 这不是 JSON')
    const ws = makeWorkspace('bad-registry')
    writeTextFile(slugFor(ws).path, '坏登记表也照样生效')
    const r = composePersona({ cwd: ws, config: { enabled: true } })
    assert.ok(r.text.includes('坏登记表也照样生效'))
    registerProject(ws)
    assert.ok(listProjects().some((p) => p.cwd === ws))
    assert.doesNotThrow(() => JSON.parse(readFileSync(registryPath(), 'utf8')))
  })

  await t.test('健壮性：注释不算人格，标题算；注释不会被注入', () => {
    const ws = makeWorkspace('only-comment')
    writeTextFile(slugFor(ws).path, '<!-- 注释 -->\n# 这个项目的一条规矩')
    writeTextFile(globalPath(), '<!-- 也是注释 -->')
    const r = composePersona({ cwd: ws, config: { enabled: true } })
    assert.ok(r.text.includes('这个项目的一条规矩'), '标题是真实人格，必须注入')
    assert.ok(!r.text.includes('也是注释'), '只有注释的全局文件视为空，不注入')
    assert.ok(!r.text.includes('<!-- 注释 -->'), '注释不入注入正文')

    // 纯注释的项目文件 → 视为空，退到全局（全局此刻也是空的）→ 不注入任何东西
    const ws2 = makeWorkspace('only-comment-2')
    writeTextFile(slugFor(ws2).path, '<!-- 还没写 -->')
    const r2 = composePersona({ cwd: ws2, config: { enabled: true, includeGlobal: false } })
    assert.equal(r2.text, '', '只有注释时不该注入')
  })

  await t.test('模板：新建内容含结构注释且不为空', () => {
    const g = buildTemplate('global')
    assert.ok(g.includes('全局人格'))
    assert.ok(g.includes('# 你是谁'))
    assert.equal(isEffectivelyEmpty(g), false)
    const p = buildTemplate('project', 'dsh-agent-md')
    assert.ok(p.includes('dsh-agent-md'))
    assert.equal(isEffectivelyEmpty(p), false)
  })

  // ---------------------------------------------------------------------
  // 2026-10-05 修复的回归用例：人格「看起来没生效」的三个真凶
  // ---------------------------------------------------------------------

  await t.test('项目清单必须带回正文（否则编辑框空白、一按保存就把人格写空）', () => {
    const ws = makeWorkspace('inline-content')
    writeTextFile(slugFor(ws).path, '# 项目人格正文不可丢')
    registerProject(ws)
    const row = listProjects().find((p) => p.cwd === ws)
    assert.ok(row !== undefined, '登记过的项目必须出现在清单里')
    assert.equal(row.content.trim(), '# 项目人格正文不可丢', '/state 必须能带回正文')
    assert.ok(row.bytes > 0)
    assert.equal(typeof row.updatedAt, 'string')
    assert.equal(row.empty, false)
  })

  await t.test('工作区列举：DSH 工作区表 + 会话目录名 + 登记表三源合并', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    assert.equal(persona.decodeSessionDirName('--D-team--'), `D:${sep}team`)
    assert.equal(persona.decodeSessionDirName('--D-~80A5~9C7C--'), `D:${sep}肥鱼`)
    assert.equal(persona.decodeSessionDirName('随便什么名字'), '')

    // 造一份 DSH 工作区表 + 一个会话目录（中文路径）
    mkdirSync(join(SANDBOX, 'storages'), { recursive: true })
    writeTextFile(join(SANDBOX, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      tables: {
        workspaces: {
          a: { path: `D:${sep}alpha`, title: 'alpha', sessionIds: ['s1', 's2'], updatedAt: '2026-10-04T10:00:00.000Z' },
        },
      },
    }))
    mkdirSync(join(SANDBOX, 'sessions', '--D-~80A5~9C7C--'), { recursive: true })
    const registered = makeWorkspace('reg-ws')
    registerProject(registered)

    const list = persona.listWorkspaces()
    const alpha = list.find((w) => w.cwd === `D:${sep}alpha`)
    assert.ok(alpha !== undefined, 'DSH 工作区表里的目录必须在清单里')
    assert.equal(alpha.title === 'alpha' || alpha.displayName === 'alpha', true)
    assert.equal(alpha.sessionCount, 2)
    assert.ok(list.some((w) => w.cwd === `D:${sep}肥鱼`), '会话目录名要能还原出中文工作区')
    assert.ok(list.some((w) => w.registered === true && w.cwd === registered), '登记表来源要标记 registered')
    assert.ok(list.every((w) => typeof w.path === 'string' && w.path.endsWith('.md')))
  })

  await t.test('API：只写全局人格时，结论必须是「全局人格」而不是「尚未写入」', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/config',
      body: { enabled: true, includeGlobal: true, projectPersonaEnabled: true },
    })
    writeTextFile(globalPath(), '# 只有全局人格')

    const { body } = await callRoute(route, { url: '/api/agent-md/state' })
    assert.equal(body.effective.kind, 'global')
    assert.ok(body.effective.label.includes('全局人格'))
    assert.ok(Array.isArray(body.workspaces), '/state 必须给出工作区清单')
    assert.ok(Array.isArray(body.injectLog))
    assert.equal(typeof body.bridge.build, 'string')
  })

  await t.test('API：两个开关都关时，结论要直说「不会注入任何人格」', async () => {
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/config',
      body: { enabled: true, includeGlobal: false, projectPersonaEnabled: false },
    })
    const { body } = await callRoute(route, { url: '/api/agent-md/state' })
    assert.equal(body.effective.kind, 'none')
    assert.ok(body.effective.label.includes('两个开关'), '必须点破配置错误，而不是说「还没写人格」')
    // 复原，别影响后面的用例
    await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/config',
      body: { enabled: true, includeGlobal: true, projectPersonaEnabled: true },
    })
  })

  await t.test('API：页面拿不到 session id 时，用最近活跃会话的工作目录兜底', async () => {
    const { ctx, registered } = makeCtx()
    const ws = makeWorkspace('recent-fallback')
    ctx.get = (name) => (name === 'sessions'
      ? {
        get() { return undefined },
        list() { return [{ header: { id: 'session-recent', cwd: ws, updatedAt: '2026-10-05T00:00:00.000Z' } }] },
      }
      : undefined)
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    const { body } = await callRoute(route, { url: '/api/agent-md/state' })
    assert.equal(body.current.cwd, ws)
    assert.equal(body.current.cwdSource, 'recent')
    assert.equal(body.current.sessionId, 'session-recent')
  })
})
