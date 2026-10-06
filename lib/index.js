/**
 * dsh-agent-md —— 宿主半：人格文件服务 + 系统提示注入 + 同源 HTTP API。
 *
 * 注入机制（关键）：
 *   `systemPrompt.context({ text: (context) => ... })` 的 **text 是函数**，每次装配
 *   提示词都会被调用，并且拿到 `context.agent`；`context.agent.session.header.cwd`
 *   就是该会话的工作目录。于是「同一个 DSH 里，不同项目不同人格」是天然成立的——
 *   不需要任何会话钩子，也没有缓存过期问题。
 *
 * 渲染语义：DSH 把 context 段materialize 成一条 user 角色尾消息，且**只在渲染
 * 文本变化时**重新追加 —— 所以改完 AGENT.md 会在下一个回合生效，而稳定前缀
 * （系统提示 + 历史）的缓存不会被无谓打断。
 *
 * 本文件只 import node: 内置模块与同目录 ./persona.js（本地 link: 安装时 Node
 * 以真实路径解析，裸包名会解析失败）。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, promises as fs } from 'node:fs'
import path from 'node:path'

import {
  MAX_FILE_BYTES,
  agentsRoot,
  buildTemplate,
  composePersona,
  displayNameFor,
  ensureDirs,
  fileInfo,
  globalPath,
  isEffectivelyEmpty,
  listProjects,
  listTemplates,
  listWorkspaces,
  normalizePathKey,
  normalizeText,
  projectsDir,
  readTextFile,
  registerProject,
  resolveProjectPersona,
  slugFor,
  statePath,
  writeTextFile,
} from './persona.js'

export const name = 'agent-md'

/**
 * 声明式依赖：systemPrompt（注入）与 webServer（同源 API）。
 * sessions 刻意走可选读取（ctx.get）：它用于反向解析「某个会话的工作目录」，
 * 缺失时设置页退化成「只能编辑已登记项目」，注入本身完全不受影响。
 */
export const inject = ['systemPrompt', 'webServer']

/** 同源 API 前缀（浏览器半侧 fetch 它）。 */
const API_PREFIX = '/api/agent-md'

/** 默认配置。 */
const DEFAULT_CONFIG = {
  enabled: true,
  includeGlobal: true,
  projectPersonaEnabled: true,
  localNames: ['AGENT.md'],
  showInSettings: true,
}

/** 内存态配置（启动时从 statePath() 读回）。 */
let config = { ...DEFAULT_CONFIG }

/**
 * 浏览器半侧的握手回执。
 *
 * 页面一打开设置页就会 fetch `/state`，所以「最近一次 /state 请求」就是
 * 「客户端 bundle 真的被服务给页面、并且页面真的连上了宿主」的硬证据。
 * 这既是我交付时的自检信号，也是用户排障时的第一手线索：面板顶部会据此
 * 显示「本页已连接宿主」，页面没连上时能一眼看出来。
 */
const bridge = { lastSeen: null, count: 0, userAgent: '', build: 'v0.2.0' }

/**
 * 注入记录：每次装配系统提示词时，把人数组件**实际吐出的内容**记一行。
 *
 * 「人格到底生效了没有」是这份插件最容易被误解的问题，而它唯一的硬证据就是这次
 * 装配实际注入了什么。记录写在 `<base>/inject-log.jsonl`（文本没变就不重复记），
 * 设置页显示最后几条——排障不用再靠猜。
 */
const injectLog = []
let injectLogLast = ''

function injectLogPath() {
  return path.join(agentsRoot(), 'inject-log.jsonl')
}

function recordInjection(entry) {
  try {
    const line = JSON.stringify(entry)
    if (line === injectLogLast) return
    injectLogLast = line
    injectLog.push(entry)
    while (injectLog.length > 20) injectLog.shift()
    appendFileSync(injectLogPath(), `${line}\n`, 'utf8')
    const raw = readTextFile(injectLogPath())
    if (raw !== null) {
      const lines = raw.split('\n').filter((l) => l.trim() !== '')
      if (lines.length > 200) writeTextFile(injectLogPath(), `${lines.slice(-100).join('\n')}\n`)
    }
  } catch {
    // 记录失败绝不能影响装配
  }
}

/** 读配置（失败回默认：坏掉的配置不能让插件整个失效）。 */
function loadConfig() {
  const raw = readTextFile(statePath())
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return
    if (typeof parsed.enabled === 'boolean') config.enabled = parsed.enabled
    if (typeof parsed.includeGlobal === 'boolean') config.includeGlobal = parsed.includeGlobal
    if (typeof parsed.projectPersonaEnabled === 'boolean') config.projectPersonaEnabled = parsed.projectPersonaEnabled
    if (typeof parsed.showInSettings === 'boolean') config.showInSettings = parsed.showInSettings
    if (Array.isArray(parsed.localNames)) {
      const names = parsed.localNames.filter((n) => typeof n === 'string' && n.trim() !== '' && !n.includes('/') && !n.includes('\\') && !n.includes('..'))
      if (names.length > 0) config.localNames = names.slice(0, 5)
    }
  } catch {
    // 损坏 → 保持默认
  }
}

/** 写配置（原子写）。 */
async function persistConfig() {
  try {
    await fs.mkdir(path.dirname(statePath()), { recursive: true })
    const tmp = `${statePath()}.tmp-${process.pid}`
    await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, statePath())
  } catch (error) {
    console.error(`[agent-md] 配置写入失败: ${String((error && error.message) || error)}`)
  }
}

/** 在系统文件管理器中选中一个文件（跨平台）。 */
function openInFileManager(filePath) {
  const dir = path.dirname(filePath)
  const plat = process.platform
  const cmd = plat === 'win32' ? 'explorer' : plat === 'darwin' ? 'open' : 'xdg-open'
  const args = plat === 'win32'
    ? ['/select,', filePath]
    : plat === 'darwin'
      ? ['-R', filePath]
      : [dir]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出
      }
      resolve()
    }, 3000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 弹一个系统「选择文件夹」对话框，返回选中的目录（取消返回空串）。
 *
 * 为什么要它：设置页里「项目人格」原本只能从**登记过的**工作区里挑，用户想让
 * 任意目录有自己的人格时无路可走。浏览器拿不到原生目录选择器，所以这一步由宿主
 * （Node 侧）代劳。三条平台分支各用系统自带工具，没有额外依赖。
 */
function pickFolder() {
  return new Promise((resolve, reject) => {
    const plat = process.platform
    let cmd
    let args
    if (plat === 'win32') {
      cmd = 'powershell'
      args = [
        '-NoProfile',
        '-STA',
        '-Command',
        // ① [Console]::OutputEncoding 必须先设成 UTF-8：否则中文路径（例 D:\肥鱼）会以
        //    控制台代码页（CP936）吐出来，Node 侧按 UTF-8 解码就变成乱码。
        // ② -STA 是 WinForms 对话框的要求，缺了会直接抛。
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择要用项目人格的工作目录'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      ]
    } else if (plat === 'darwin') {
      cmd = 'osascript'
      args = ['-e', 'POSIX path of (choose folder with prompt "选择要用项目人格的工作目录")']
    } else {
      cmd = 'zenity'
      args = ['--file-selection', '--directory', '--title=选择要用项目人格的工作目录']
    }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', () => {
      resolve(out.trim())
    })
  })
}

/** JSON 响应。 */function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** 读 JSON 请求体（上限略高于单文件上限，留出 JSON 包装的余量）。 */
function readBody(req, maxBytes = MAX_FILE_BYTES + 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 从 URL 里取 query 参数。 */
function queryOf(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** 一个人格文件的完整状态（含正文，供设置页编辑器使用）。 */
function personaFileDetail(file, label) {
  const raw = readTextFile(file)
  return {
    ...fileInfo(file, label),
    content: raw === null ? '' : normalizeText(raw),
  }
}

export function apply(ctx) {
  ensureDirs()
  loadConfig()

  /** 会话 id → 工作目录（会话服务缺失时返回空串）。 */
  const cwdOfSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return ''
    try {
      const session = sessions.get(sessionId)
      const cwd = session?.header?.cwd
      return typeof cwd === 'string' ? cwd : ''
    } catch {
      return ''
    }
  }

  /**
   * 会话服务里「最近活跃的那个会话」。
   *
   * 设置页弹层是全局的，某些 DSH 版本不给 `settings.section` 传 sessionId，
   * 于是「当前工作目录」解析成空、面板直接死路。这里退一步：从会话服务里挑一个
   * 最近活跃且有 cwd 的会话，作为**兜底**（面板会标明这是兜底值，不是当前会话）。
   */
  const recentSession = () => {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
    if (sessions === null || sessions === undefined || typeof sessions.list !== 'function') return null
    try {
      const list = sessions.list()
      if (!Array.isArray(list)) return null
      let best = null
      for (const session of list) {
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') continue
        const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
        if (best === null || stamp > best.stamp) {
          best = { stamp, cwd, id: String(session?.header?.id ?? session?.id ?? '') }
        }
      }
      return best
    } catch {
      return null
    }
  }

  /**
   * 把「这一回合实际会注入什么」说成人话。
   *
   * ⚠️ 早先的设置页横幅只看 `current.resolved`（项目人格解析结果），于是「只写了
   * 全局人格」的用户会看到「尚未写入任何人格」——明明写了、也确实注入了。这里把
   * 全局与项目一起算，并且把「两个开关都关着」这种配置错误直说。
   */
  const describeEffective = (composed, cwd) => {
    if (!config.enabled) return { kind: 'off', label: '总开关已关闭 · 人格未注入' }
    const sources = Array.isArray(composed.sources) ? composed.sources : []
    if (sources.length === 0) {
      let why = '还没有写过人格（写一份即生效）'
      if (!config.includeGlobal && !config.projectPersonaEnabled) {
        why = '两个开关都关着（全局人格一起注入 / 启用项目人格）——当前不会注入任何人格'
      } else if (cwd === '') {
        why = '没解析到工作目录，且全局人格是空的'
      } else if (!config.includeGlobal) {
        why = '已关闭全局人格注入，且这个工作区没有项目人格'
      } else if (!config.projectPersonaEnabled) {
        why = '已关闭项目人格，且全局人格是空的'
      }
      return { kind: 'none', label: why }
    }
    const head = sources[0]
    const kind = head.label === '项目' ? (head.kind === 'local' ? 'local' : 'project') : 'global'
    const name = kind === 'local' ? '项目内 AGENT.md' : kind === 'project' ? '项目人格' : '全局人格'
    return {
      kind,
      chars: composed.text.length,
      sources,
      label: `${name} · ${head.path}（${head.chars} 字）`,
      extra: sources.slice(1).map((s) => (s.label === '全局' ? '＋（叠加）全局人格' : '＋（叠加）项目人格')),
    }
  }

  // ---- 1. 人格注入 ------------------------------------------------------
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({
        name: 'agent-md:persona',
        // 200 段之后（VCP 视觉协议 200 之后、记忆快照之后）：人格是「你是谁」，
        // 放在能力说明之后更贴近用户消息，同时不与既有段抢位。
        order: 260,
        text: (context) => {
          if (!config.enabled) return ''
          const cwd = context?.agent?.session?.header?.cwd
          const resolvedCwd = typeof cwd === 'string' ? cwd : ''
          const composed = composePersona({ cwd: resolvedCwd, config })
          // 留痕：这一回合到底注入了什么（文本没变就不重复记）
          if (composed.text !== '') {
            recordInjection({ at: new Date().toISOString(), cwd: resolvedCwd, chars: composed.text.length, sources: composed.sources })
          }
          return composed.text
        },
      })
    } catch (error) {
      // 幂等保护：DSH 的 loader 曾把插件在无 scope 标签的 ctx 上装配两次，
      // 同名重复注册会抛 "already registered"；命中时跳过，别连带 API 一起失效。
      if (error instanceof Error && error.message.includes('already registered')) {
        console.warn('[agent-md] agent-md:persona 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-md: persona context')

  // ---- 2. 同源 API ------------------------------------------------------
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          // 记录这次握手：这是「页面真的连上了」的证据（自检与排障都用它）
          bridge.lastSeen = new Date().toISOString()
          bridge.count += 1
          const ua = req.headers !== undefined && req.headers !== null ? req.headers['user-agent'] : ''
          if (typeof ua === 'string' && ua !== '') bridge.userAgent = ua.slice(0, 160)

          const query = queryOf(req)
          let sessionId = query.get('session') ?? ''
          let cwd = cwdOfSession(sessionId)
          let cwdSource = cwd === '' ? 'none' : 'session'
          // 会话不可解析时允许显式传 path（设置页里手选一个项目）
          if (cwd === '') {
            const explicit = query.get('path') ?? ''
            if (explicit !== '') {
              cwd = explicit
              cwdSource = 'path'
            }
          }
          // 再退一步：用「最近活跃会话」的工作目录兜底，别让面板变成死路
          if (cwd === '') {
            const recent = recentSession()
            if (recent !== null && recent !== undefined) {
              cwd = recent.cwd
              cwdSource = 'recent'
              if (sessionId === '') sessionId = recent.id
            }
          }
          if (cwd !== '') registerProject(cwd, { active: true })
          const resolved = cwd === '' ? null : resolveProjectPersona(cwd, config.localNames)
          const stored = cwd === '' ? null : slugFor(cwd)
          const composed = composePersona({ cwd, config })
          return sendJson(res, 200, {
            enabled: config.enabled,
            includeGlobal: config.includeGlobal,
            projectPersonaEnabled: config.projectPersonaEnabled,
            localNames: config.localNames,
            showInSettings: config.showInSettings,
            baseDir: agentsRoot(),
            statePath: statePath(),
            global: personaFileDetail(globalPath(), '全局人格'),
            // 「这一回合实际会注入什么」的结论（全局 + 项目一起算）
            effective: describeEffective(composed, cwd),
            bridge: { lastSeen: bridge.lastSeen, count: bridge.count, build: bridge.build },
            current: {
              sessionId,
              cwd,
              cwdSource,
              displayName: cwd === '' ? '' : displayNameFor(cwd),
              projectFile: stored === null ? '' : stored.path,
              projectFileExists: stored === null ? false : readTextFile(stored.path) !== null,
              projectContent: stored === null ? '' : normalizeText(readTextFile(stored.path) ?? ''),
              resolved: resolved === null
                ? null
                : { kind: resolved.kind, path: resolved.path, chars: normalizeText(resolved.content).trim().length },
            },
            projects: listProjects(),
            // 本机所有工作区（不只是登记过的）：设置页的项目下拉用它
            workspaces: listWorkspaces(),
            injectLog: injectLog.slice(-5).reverse(),
            templates: listTemplates(),
          })
        }

        if (route === '/save' && req.method === 'POST') {
          const body = await readBody(req)
          const scope = String(body.scope ?? '')
          const mode = String(body.mode ?? 'save')
          const content = typeof body.content === 'string' ? body.content : ''

          /** 写一个受管人格文件（带 .bak 备份）。 */
          const writeManaged = async (file) => {
            if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
              throw Object.assign(new Error(`内容超过上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB`), { status: 413 })
            }
            const normalized = normalizeText(content)
            if (mode === 'delete') {
              try {
                await fs.unlink(file)
              } catch {
                // 本来就不存在
              }
              return
            }
            if (mode === 'revert') {
              try {
                await fs.writeFile(file, '', 'utf8')
              } catch {
                // 文件不存在即已是空
              }
              return
            }
            // 备份上一次内容（丢了也能救回来；只留一份 .bak）
            const previous = readTextFile(file)
            if (previous !== null && previous.trim() !== '') {
              try {
                await fs.mkdir(path.dirname(file), { recursive: true })
                await fs.writeFile(`${file}.bak`, previous, 'utf8')
              } catch {
                // 备份失败不阻断保存
              }
            }
            await fs.mkdir(path.dirname(file), { recursive: true })
            const tmp = `${file}.tmp-${process.pid}`
            await fs.writeFile(tmp, normalized, 'utf8')
            await fs.rename(tmp, file)
          }

          /** 删掉项目内 AGENT.md（只允许删除我们探测到的那份）。 */
          const removeLocal = async (cwd) => {
            const names = config.localNames
            for (const n of names) {
              const candidate = path.join(cwd, n)
              if (readTextFile(candidate) !== null) {
                await fs.unlink(candidate)
                return candidate
              }
            }
            throw Object.assign(new Error('项目内没有找到可删除的 AGENT.md'), { status: 404 })
          }

          if (scope === 'global') {
            await writeManaged(globalPath())
            return sendJson(res, 200, { saved: true, file: globalPath(), scope })
          }

          if (scope === 'project') {
            const cwd = String(body.cwd ?? '').trim()
            const kind = String(body.kind ?? 'stored')
            if (cwd === '') throw Object.assign(new Error('缺少 cwd'), { status: 400 })
            registerProject(cwd, { active: true })
            if (kind === 'local') {
              if (mode === 'revert' || mode === 'delete') {
                const deleted = await removeLocal(cwd)
                return sendJson(res, 200, { saved: true, file: deleted, scope, kind, deleted: true })
              }
              const target = path.join(cwd, config.localNames[0])
              if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
                throw Object.assign(new Error(`内容超过上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB`), { status: 413 })
              }
              const previous = readTextFile(target)
              if (previous !== null && previous.trim() !== '') {
                try {
                  await fs.writeFile(`${target}.bak`, previous, 'utf8')
                } catch {
                  // 忽略
                }
              }
              await fs.mkdir(path.dirname(target), { recursive: true })
              const tmpLocal = `${target}.tmp-${process.pid}`
              await fs.writeFile(tmpLocal, normalizeText(content), 'utf8')
              await fs.rename(tmpLocal, target)
              return sendJson(res, 200, { saved: true, file: target, scope, kind })
            }
            const file = slugFor(cwd).path
            await writeManaged(file)
            return sendJson(res, 200, { saved: true, file, scope, kind: 'stored' })
          }

          if (scope === 'template') {
            const id = String(body.id ?? '').replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '')
            if (id === '') throw Object.assign(new Error('缺少模板 id'), { status: 400 })
            const file = path.join(agentsRoot(), 'templates', `${id}.md`)
            await writeManaged(file)
            return sendJson(res, 200, { saved: true, file, scope })
          }

          throw Object.assign(new Error(`未知 scope: ${scope}`), { status: 400 })
        }

        if (route === '/create' && req.method === 'POST') {
          const body = await readBody(req)
          const scope = String(body.scope ?? 'global')
          const overwrite = body.overwrite === true
          if (scope === 'global') {
            const file = globalPath()
            if (!overwrite && readTextFile(file) !== null) {
              return sendJson(res, 200, { created: false, reason: 'exists', file })
            }
            writeTextFile(file, buildTemplate('global'))
            return sendJson(res, 200, { created: true, file })
          }
          if (scope === 'project') {
            const cwd = String(body.cwd ?? '').trim()
            if (cwd === '') throw Object.assign(new Error('缺少 cwd'), { status: 400 })
            registerProject(cwd, { active: true })
            const kind = String(body.kind ?? 'stored')
            const file = kind === 'local' ? path.join(cwd, config.localNames[0]) : slugFor(cwd).path
            if (!overwrite && readTextFile(file) !== null && !isEffectivelyEmpty(readTextFile(file) ?? '')) {
              return sendJson(res, 200, { created: false, reason: 'exists', file })
            }
            writeTextFile(file, buildTemplate('project', displayNameFor(cwd)))
            return sendJson(res, 200, { created: true, file, kind })
          }
          if (scope === 'template') {
            const id = String(body.id ?? '').trim().replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '')
            if (id === '') throw Object.assign(new Error('缺少模板名'), { status: 400 })
            const file = path.join(agentsRoot(), 'templates', `${id}.md`)
            if (!overwrite && readTextFile(file) !== null) {
              return sendJson(res, 200, { created: false, reason: 'exists', file })
            }
            writeTextFile(file, buildTemplate('project', id))
            return sendJson(res, 200, { created: true, file })
          }
          throw Object.assign(new Error(`未知 scope: ${scope}`), { status: 400 })
        }

        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req)
          if (typeof body.enabled === 'boolean') config.enabled = body.enabled
          if (typeof body.includeGlobal === 'boolean') config.includeGlobal = body.includeGlobal
          if (typeof body.projectPersonaEnabled === 'boolean') config.projectPersonaEnabled = body.projectPersonaEnabled
          if (typeof body.showInSettings === 'boolean') config.showInSettings = body.showInSettings
          if (Array.isArray(body.localNames)) {
            const names = body.localNames
              .filter((n) => typeof n === 'string' && n.trim() !== '' && !n.includes('/') && !n.includes('\\') && !n.includes('..'))
              .map((n) => n.trim())
            config.localNames = names.length > 0 ? names.slice(0, 5) : DEFAULT_CONFIG.localNames
          }
          await persistConfig()
          return sendJson(res, 200, { ok: true, config: { ...config } })
        }

        if (route === '/open' && req.method === 'POST') {
          const body = await readBody(req)
          const scope = String(body.scope ?? 'global')
          let target = ''
          if (scope === 'global') {
            target = globalPath()
            if (readTextFile(target) === null) writeTextFile(target, buildTemplate('global'))
          } else if (scope === 'project') {
            const cwd = String(body.cwd ?? '').trim()
            if (cwd === '') throw Object.assign(new Error('缺少 cwd'), { status: 400 })
            const kind = String(body.kind ?? 'stored')
            if (kind === 'local') {
              target = path.join(cwd, config.localNames[0])
              if (readTextFile(target) === null) writeTextFile(target, buildTemplate('project', displayNameFor(cwd)))
            } else {
              target = slugFor(cwd).path
              if (readTextFile(target) === null) writeTextFile(target, buildTemplate('project', displayNameFor(cwd)))
            }
          } else if (scope === 'template') {
            const id = String(body.id ?? '').trim().replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '')
            target = path.join(agentsRoot(), 'templates', `${id}.md`)
          } else if (scope === 'dir') {
            target = projectsDir()
          } else {
            throw Object.assign(new Error(`未知 scope: ${scope}`), { status: 400 })
          }
          try {
            await openInFileManager(target)
            return sendJson(res, 200, { opened: target })
          } catch (error) {
            return sendJson(res, 500, { error: `无法打开文件管理器：${String((error && error.message) || error)}` })
          }
        }

        // 项目/会话两级登记：设置页用它把「当前会话」之外的会话也拉进来
        if (route === '/register' && req.method === 'POST') {
          const body = await readBody(req)
          const cwd = String(body.cwd ?? '').trim()
          if (cwd === '') throw Object.assign(new Error('缺少 cwd'), { status: 400 })
          const registry = registerProject(cwd, { active: body.active === true })
          return sendJson(res, 200, { ok: true, registry, slug: slugFor(cwd) })
        }

        // 系统「选择文件夹」：让任意目录都能成为项目人格的归属
        if (route === '/pick' && req.method === 'POST') {
          try {
            const picked = await pickFolder()
            if (picked === '') return sendJson(res, 200, { picked: '', cancelled: true })
            registerProject(picked, { active: false })
            return sendJson(res, 200, { picked, cancelled: false, slug: slugFor(picked) })
          } catch (error) {
            return sendJson(res, 500, { error: `打不开系统文件夹选择器：${String((error && error.message) || error)}；可以直接把路径粘到输入框里。` })
          }
        }

        return sendJson(res, 404, { error: `未知接口: ${route}` })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 500
        return sendJson(res, status, { error: String((error && error.message) || error) })
      }
    },
  })

  ctx.logger?.info?.(`AGENT.md 人格配置：${config.enabled ? '开' : '关'}（全局 ${globalPath()}；项目目录 ${projectsDir()}）`)
}

/** 供测试使用：把配置重置为默认（不落盘）。 */
export function __resetConfigForTest() {
  config = { ...DEFAULT_CONFIG }
}
