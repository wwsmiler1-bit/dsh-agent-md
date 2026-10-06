/**
 * dsh-agent-md —— 人格文件的读写与合成（纯 node: 内置模块，无任何第三方依赖）。
 *
 * 三层文件模型（优先级从高到低）：
 *   1. 项目内 AGENT.md      <cwd>/AGENT.md              —— 跟着仓库走，可提交进 git（可选启用）
 *   2. 项目人格（本机存储）  <base>/projects/<slug>.md   —— 设置页里编辑的那份
 *   3. 全局人格（本机存储）  <base>/AGENT.md             —— 所有会话的基础人设
 *
 * 生效 `project` 时只取 1、2 里优先级最高的那**一份**（避免两份打架）；
 * 全局人格默认作为底座一起注入，可在设置里关掉（includeGlobal=false →
 * 纯项目人格）。
 *
 * 本文件刻意只 import node: 内置模块：本地 link: 安装时 Node 以真实路径解析
 * 本插件，沿目录向上找不到 profile 的 node_modules，裸包名会解析失败。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** 人格文件最大可写字节（防手滑写进巨物）。 */
export const MAX_FILE_BYTES = 512 * 1024
/** 注入到系统提示里的正文上限（超出即截断，避免撑爆上下文）。 */
export const MAX_INJECT_CHARS = 40_000
/** 默认探测的项目内文件名（按顺序取第一个存在的）。 */
export const DEFAULT_LOCAL_NAMES = ['AGENT.md']

/** DSH 家目录（状态、人格文件都放这儿，与 DSH 其他用户数据同域）。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 人格文件根目录：<DSH_HOME>/agents。 */
export function agentsRoot() {
  return join(dshHome(), 'agents')
}

/** 本插件自身状态文件：<DSH_HOME>/agent-md.json。 */
export function statePath() {
  return join(dshHome(), 'agent-md.json')
}

/** 全局人格文件：<DSH_HOME>/AGENT.md。 */
export function globalPath() {
  return join(dshHome(), 'AGENT.md')
}

/** 内置项目人格默认路径：<base>/default.md（用户没设项目时注入它）。 */
export function defaultProjectPath() {
  return join(agentsRoot(), 'default.md')
}

/** 项目人格目录：<base>/projects。 */
export function projectsDir() {
  return join(agentsRoot(), 'projects')
}

/** 内置模板目录：<base>/templates。 */
export function templatesDir() {
  return join(agentsRoot(), 'templates')
}

/** 项目登记表：<base>/projects.json（只用于列出/去重，注入不依赖它）。 */
export function registryPath() {
  return join(agentsRoot(), 'projects.json')
}

/**
 * 全局字典：把工作目录规范化成可比较的键。
 *
 * ⚠️ 写文件时**绝不能**用这个键当文件名：Windows 上 `C:\Users\<你>` 里的 `:`
 * 是非法文件名字符。文件名一律用短 slug（见 slugFor）。
 */
export function normalizePathKey(cwd) {
  if (typeof cwd !== 'string') return ''
  let p = cwd.trim().replace(/\\/g, '/')
  if (p === '') return ''
  // 统一去掉结尾斜杠（但保留根：C:/ 与 /）
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '')
  if (p === '') p = '/'
  // Git / Windows 路径大小写不敏感；先比小写，展示时用登记表里的原始值
  return p.toLowerCase()
}

/** FNV-1a 32 位 → 8 位十六进制，用于生成短 slug。 */
function hash8(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 路径 → 文件名安全的 slug（保留可读目录名 + 8 位哈希防撞）。 */
export function slugFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return {
    key: '',
    slug: 'unknown',
    fileName: 'unknown.md',
    path: join(projectsDir(), 'unknown.md'),
  }
  const tail = key.replace(/\/+$/, '').split('/').filter((s) => s !== '').pop() || 'root'
  // 只保留 ASCII 字母数字、汉字、连字符、下划线、点；其余一律 '-'
  const safe = tail.replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '-').slice(0, 40) || 'root'
  const slug = `${safe}-${hash8(key)}`
  return { key, slug, fileName: `${slug}.md`, path: join(projectsDir(), `${slug}.md`) }
}

/** 人格名（展示用）：路径最后一段；根目录回落成盘符/斜杠。 */
export function displayNameFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return '（未命名）'
  const parts = key.replace(/\/+$/, '').split('/').filter((s) => s !== '')
  const tail = parts[parts.length - 1]
  if (tail !== undefined && tail.length > 0) return tail
  return key
}

/**
 * 模板变量降级：宿主（@deepseek-ai/dsh-system-prompt）的段渲染器把段正文里的
 * `{{name}}` 当模板变量解析，未注册的名字会抛 unknown prompt variable 并让整轮
 * 注入失败（只有 provider/model/cwd 是注册的）。用户在地道 Markdown 里写
 * `{{xxx}}` 完全合法，所以注入前统一降级成 `{name}`——保留字面意思，不再被宿主解析。
 *
 * 已知风险（沿自 dsh-memory-evolve 的处理手法）：理论上降级后的 `{'{'}` 相邻仍可能
 * 被误判，但宿主只认 `{{` 开头，单花括号安全。
 */
export function sanitizeForHost(text) {
  // 目标：正文里不再出现**连续两个左花括号**——宿主只把 `{{name}}` 当模板变量，
  // 命中未注册的 name 就抛错并让整轮注入失败。
  // 所以把任意长度的连续左花括号压成一个：`{{x}}` -> `{x}`。
  // ⚠️ 右花括号必须原样保留（`{x}}` 不会被宿主解析）；早先"再把 `}}` 也收掉"的写法
  // 实测不可靠（JS 正则里连续右括号的转义在字符串/工具链上多次被吃掉），
  // 而保留它是安全的——这条注释就是那个坑的记录。
  return String(text).replace(/\{+/g, String.fromCharCode(123))
}

/** 项目内 AGENT.md 探测（同步 statSync：只有注入路径会用到，必须同步）。 */
export function localFileFor(cwd, localNames) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null
  const dir = resolve(cwd)
  const names = Array.isArray(localNames) && localNames.length > 0 ? localNames : DEFAULT_LOCAL_NAMES
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') continue
    const file = join(dir, name.trim())
    try {
      if (statSync(file).isFile()) return file
    } catch {
      // 不存在/无权限 → 试下一个候选名
    }
  }
  return null
}

/** 读文件，失败或缺失返回 null（注入路径绝不能让读失败冒泡）。 */
export function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截文件被会话读到。 */
export function writeTextFile(file, text) {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 统一的纯文本判定：去掉 BOM；CRLF/CR 一律归一到 LF。 */
export function normalizeText(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * 空人格判定：剥掉 HTML 注释后没有正文就算空。
 *
 * ⚠️ 这里**刻意不把 Markdown 标题算空**（早先版本踩过）：模板正文本身就是标题
 * 形式（`# 你是谁` + 下面一句话），而用户写「# 这个项目里你是资深维护者」这种
 * 单标题人格完全合法——把标题算空会让用户的真实人格被静默跳过。
 * 注释承担「未填写」的信号：模板里的注释没删就是没写。
 */
export function isEffectivelyEmpty(raw) {
  const text = normalizeText(raw)
  if (text.trim() === '') return true
  // 去掉 HTML 注释（`<!` 连写即注释起始，行首标记不参与匹配，避免模板里出现该字样时误判）
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  return stripped === ''
}

/**
 * 剥掉 HTML 注释：注释是写给**用户看的说明**（模板里的填写提示），不该进模型的
 * 上下文——既省 token，也避免「（例：…）」这类示例文字被模型当成真实设定执行。
 */
export function stripComments(raw) {
  return normalizeText(raw).replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 项目登记表读写（读失败一律回退空表：登记表坏了不能影响注入）。 */
export function readRegistry() {
  const file = registryPath()
  const raw = readTextFile(file)
  if (raw === null) return { version: 1, projects: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.projects)) {
      return { version: 1, projects: parsed.projects.filter((p) => p !== null && typeof p === 'object' && typeof p.slug === 'string') }
    }
  } catch {
    // 解析失败：当作空表（下次写入即修复）
  }
  return { version: 1, projects: [] }
}

/** 登记一个项目（幂等：同 key 更新 cwd/lastSeen）。 */
export function registerProject(cwd, patch = {}) {
  const key = normalizePathKey(cwd)
  if (key === '') return readRegistry()
  const registry = readRegistry()
  const { slug, path } = slugFor(cwd)
  const now = new Date().toISOString()
  const existing = registry.projects.find((p) => p !== null && typeof p === 'object' && p.key === key)
  if (existing !== undefined) {
    existing.cwd = cwd
    existing.slug = slug
    existing.path = path
    existing.lastSeen = now
    if (typeof patch.active === 'boolean') existing.active = patch.active
  } else {
    registry.projects.push({ key, cwd, displayName: displayNameFor(cwd), slug, path, lastSeen: now, active: patch.active === true })
  }
  // 只留最近 200 个：登记表是展示用的，不是真相来源
  registry.projects.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
  registry.projects = registry.projects.slice(0, 200)
  try {
    writeTextFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
  } catch {
    // 写失败不影响注入
  }
  return registry
}

/** 单个项目人格正文随 /state 一起回传的上限（超过就只报状态，正文按需再拉）。 */
export const MAX_INLINE_CONTENT_CHARS = 64_000

/**
 * 一份项目人格的最新状态（正文 + 时间 + 字节）。
 *
 * ⚠️ 这里必须带上 `content`：设置页的项目页签靠它填编辑框。早先版本只回 `exists`
 * 不回正文，于是「文件明明有内容、编辑框却是空的」——用户一按保存就把文件写空，
 * 这是「项目人格看起来没生效」的真凶之一。
 */
function projectDetail(cwd, file) {
  const raw = readTextFile(file)
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    bytes = 0
  }
  const text = raw === null ? '' : normalizeText(raw)
  const tooBig = text.length > MAX_INLINE_CONTENT_CHARS
  return {
    path: file,
    exists: raw !== null,
    empty: raw === null ? true : isEffectivelyEmpty(raw),
    updatedAt: raw === null ? null : mtimeIso(file),
    bytes,
    content: tooBig ? '' : text,
    contentTruncated: tooBig,
  }
}

/** 列出<按登记表 + 磁盘>的项目人格清单（磁盘上存在但没登记的也列出来）。 */
export function listProjects() {
  const registry = readRegistry()
  const out = []
  for (const p of registry.projects) {
    if (typeof p.key !== 'string' || p.key === '') continue
    const cwd = typeof p.cwd === 'string' ? p.cwd : ''
    const file = typeof p.path === 'string' && p.path !== '' ? p.path : slugFor(cwd).path
    out.push({
      key: p.key,
      slug: typeof p.slug === 'string' ? p.slug : slugFor(cwd).slug,
      cwd,
      displayName: typeof p.displayName === 'string' && p.displayName !== '' ? p.displayName : displayNameFor(cwd),
      lastSeen: typeof p.lastSeen === 'string' ? p.lastSeen : '',
      ...projectDetail(cwd, file),
    })
  }
  // 磁盘上存在但登记表没有的（手写文件/换机器）：补进来
  let files = []
  try {
    files = readdirSync(projectsDir()).filter((f) => f.endsWith('.md'))
  } catch {
    files = []
  }
  for (const f of files) {
    if (f.startsWith('_')) continue
    const full = join(projectsDir(), f)
    if (out.some((p) => p.path === full)) continue
    const slug = f.replace(/\.md$/, '')
    out.push({ key: '', slug, cwd: '', displayName: slug, lastSeen: '', ...projectDetail('', full) })
  }
  out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
  return out
}

// ---- 本机所有工作区（DSH workspace 表 + 会话目录 + 插件登记表）-------------

/** DSH 自己维护的工作区表：<DSH_HOME>/storages/workspace.json。 */
export function workspaceStorePath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/** 会话目录根：<DSH_HOME>/sessions（DSH 给每个工作区一个目录）。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * DSH 会话目录名 → 工作目录。
 *
 * DSH 把 cwd 编码成目录名：`D:\肥鱼` → `--D-~80A5~9C7C--`。规则是**盘符冒号与路径
 * 分隔符都写成 `-`**，非 ASCII/不安全字符写成 `~XXXX`（UTF-16 码元）。这是枚举
 * 「本机用过哪些工作区」的兜底来源，所以哪怕带点启发式也留着。
 */
export function decodeSessionDirName(name) {
  if (typeof name !== 'string' || name.length < 5) return ''
  if (!name.startsWith('--') || !name.endsWith('--')) return ''
  const body = name.slice(2, -2)
  if (body === '') return ''
  const sep = process.platform === 'win32' ? '\\' : '/'
  let text = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '~' && /^[0-9A-Fa-f]{4}$/.test(body.slice(i + 1, i + 5))) {
      text += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
      continue
    }
    text += body[i] === '-' ? sep : body[i]
  }
  // 盘符的冒号也被写成了 `-`（`D-team` 其实是 `D:\team`），这里补回来
  return text.replace(/^([A-Za-z])[\\/]/, `$1:${sep}`).replace(/[\\/]+$/, '')
}

/** 读 DSH 的工作区表（坏文件回退空表：列工作区失败不能拖垮设置页）。 */
export function readWorkspaceStore() {
  const raw = readTextFile(workspaceStorePath())
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    const table = parsed !== null && typeof parsed === 'object' && parsed.tables !== undefined ? parsed.tables.workspaces : undefined
    if (table === null || table === undefined || typeof table !== 'object') return []
    return Object.values(table).filter((w) => w !== null && typeof w === 'object' && typeof w.path === 'string' && w.path.trim() !== '')
  } catch {
    return []
  }
}

/**
 * 本机所有已知工作区（设置页「项目」下拉的清单）。
 *
 * 三个来源合并去重，按最近活跃倒序：
 *   1. DSH 的工作区表（最权威，带 title / updatedAt）；
 *   2. 插件自己的项目登记表（写过人格的）；
 *   3. `~/.dsh/sessions` 目录名（老工作区、没进工作区表的也捞得回来）。
 */
export function listWorkspaces() {
  const map = new Map()
  const ensure = (cwd) => {
    if (typeof cwd !== 'string' || cwd.trim() === '') return null
    const key = normalizePathKey(cwd)
    if (key === '') return null
    let entry = map.get(key)
    if (entry === undefined) {
      entry = { key, cwd, title: '', sources: [], lastActive: '', sessionCount: 0, registered: false }
      map.set(key, entry)
    }
    return entry
  }
  const mark = (entry, source) => {
    if (entry !== null && !entry.sources.includes(source)) entry.sources.push(source)
  }

  for (const w of readWorkspaceStore()) {
    const entry = ensure(w.path)
    if (entry === null) continue
    mark(entry, 'workspace')
    if (typeof w.title === 'string' && w.title !== '') entry.title = w.title
    if (typeof w.updatedAt === 'string' && w.updatedAt > entry.lastActive) entry.lastActive = w.updatedAt
    if (Array.isArray(w.sessionIds)) entry.sessionCount = Math.max(entry.sessionCount, w.sessionIds.length)
  }

  for (const p of readRegistry().projects) {
    const entry = ensure(typeof p.cwd === 'string' ? p.cwd : '')
    if (entry === null) continue
    mark(entry, 'persona')
    entry.registered = true
    if (typeof p.lastSeen === 'string' && p.lastSeen > entry.lastActive) entry.lastActive = p.lastSeen
  }

  let dirs = []
  try {
    dirs = readdirSync(sessionsRoot(), { withFileTypes: true })
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    if (d.isDirectory() !== true) continue
    const cwd = decodeSessionDirName(d.name)
    if (!/^[A-Za-z]:[\\/]/.test(cwd) && !cwd.startsWith('/')) continue
    const entry = ensure(cwd)
    if (entry === null) continue
    mark(entry, 'sessions')
    try {
      const iso = statSync(join(sessionsRoot(), d.name)).mtime.toISOString()
      if (iso > entry.lastActive) entry.lastActive = iso
    } catch {
      // 读不到时间就只按目录名收录
    }
  }

  const out = []
  for (const entry of map.values()) {
    const { slug, path: file } = slugFor(entry.cwd)
    out.push({
      key: entry.key,
      slug,
      cwd: entry.cwd,
      displayName: entry.title !== '' ? entry.title : displayNameFor(entry.cwd),
      sources: entry.sources,
      lastActive: entry.lastActive,
      sessionCount: entry.sessionCount,
      registered: entry.registered,
      path: file,
      exists: existsSync(file),
    })
  }
  out.sort((a, b) => String(b.lastActive || '').localeCompare(String(a.lastActive || '')))
  return out
}

/** 候选模板清单（<base>/templates/*.md）。 */
export function listTemplates() {
  try {
    return readdirSync(templatesDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ id: f.replace(/\.md$/, ''), name: f.replace(/\.md$/, ''), path: join(templatesDir(), f) }))
  } catch {
    return []
  }
}

/** 解析一个人格文件的「有效来源」：项目内 > 内置项目 > 无。 */
export function resolveProjectPersona(cwd, localNames) {
  const local = localFileFor(cwd, localNames)
  if (local !== null) {
    const content = readTextFile(local)
    if (content !== null && !isEffectivelyEmpty(content)) return { kind: 'local', path: local, content }
  }
  const stored = slugFor(cwd).path
  const content = readTextFile(stored)
  if (content !== null && !isEffectivelyEmpty(content)) return { kind: 'project', path: stored, content }
  return null
}

/** 深读一个人格文件的状态（给设置页用）。 */
export function fileInfo(file, label) {
  const raw = readTextFile(file)
  return {
    label,
    path: file,
    exists: raw !== null,
    empty: raw === null ? true : isEffectivelyEmpty(raw),
    bytes: raw === null ? 0 : Buffer.byteLength(raw, 'utf8'),
    updatedAt: raw === null ? null : mtimeIso(file),
  }
}

/** 文件修改时间（ISO）；失败返回 null。 */
export function mtimeIso(file) {
  try {
    return statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * 合成注入正文。
 *
 * @param {object} options
 * @param {string} options.cwd - 当前会话工作目录
 * @param {object} options.config - { enabled, includeGlobal, localNames, projectPersonaEnabled }
 * @returns {{ text: string, sources: Array<{label:string,path:string,chars:number}>, note: string }}
 */
export function composePersona(options) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : ''
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const includeGlobal = config.includeGlobal !== false
  const localNames = Array.isArray(config.localNames) ? config.localNames : DEFAULT_LOCAL_NAMES
  const useProject = config.projectPersonaEnabled !== false

  const sources = []
  const blocks = []

  if (includeGlobal) {
    const gp = globalPath()
    const raw = readTextFile(gp)
    if (raw !== null && !isEffectivelyEmpty(raw)) {
      const body = stripComments(raw)
      blocks.push(`### 全局人格（对所有会话生效）\n适用文件：${gp}\n\n${body}`)
      sources.push({ label: '全局', path: gp, chars: body.length })
    }
  }

  if (useProject && cwd !== '') {
    const found = resolveProjectPersona(cwd, localNames)
    if (found !== null) {
      const body = stripComments(found.content)
      const named = displayNameFor(cwd)
      blocks.push(`### 当前项目人格（进「${named}」时生效，优先于全局人格）\n适用项目：${cwd}\n适用文件：${found.path}\n\n${body}`)
      sources.push({ label: '项目', path: found.path, chars: body.length, kind: found.kind })
    }
  }

  if (blocks.length === 0) return { text: '', sources, note: '' }

  let body = blocks.join('\n\n')
  let note = ''
  if (body.length > MAX_INJECT_CHARS) {
    body = `${body.slice(0, MAX_INJECT_CHARS)}\n\n（人格正文过长已截断，请精简 AGENT.md。）`
    note = 'truncated'
  }

  const text = [
    '## 人格设定（AGENT.md）',
    '以下是用户为本机写下的角色/性格设定，是「你是谁、怎么说话、怎么做事」的第一依据，请始终照此扮演：',
    '',
    body,
    '',
    '约束：人格设定只决定语气、风格与行事偏好，不改变安全规则、工具用法与任务事实；两者冲突时以安全规则和事实为准。',
  ].join('\n')

  return { text: sanitizeForHost(text), sources, note }
}

/** 删除一个人格文件（存在才删）。 */
export function removeFile(file) {
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 给人格文件根目录建好全部子目录。 */
export function ensureDirs() {
  for (const dir of [agentsRoot(), projectsDir(), templatesDir()]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // 建不了目录时读取路径照常降级（读不到就是没人格）
    }
  }
}

/** 判断某路径是否位于人格根目录内（防越权读写）。 */
export function isInsideAgentsRoot(file) {
  const root = resolve(agentsRoot())
  const target = resolve(file)
  const sep = process.platform === 'win32' ? '\\' : '/'
  return target === root || target.startsWith(root + sep)
}

/** 内置人格模板：新建文件时的初始内容。 */
export function buildTemplate(kind, name) {
  const label = typeof name === 'string' && name !== '' ? name : '未命名'
  if (kind === 'global') {
    return [
      '<!-- AGENT.md · 全局人格：对所有会话生效。写完后保存即生效（下一个回合开始） -->',
      '',
      '# 你是谁',
      '',
      '（例：你是「先生」的专属助手，说话简洁、直接给结论，不说客套话。）',
      '',
      '# 语气与风格',
      '',
      '- 中文回答，句子短，先给结论再给理由',
      '- 不确定就说不确定，不编造',
      '',
      '# 行事偏好',
      '',
      '- 动手前先确认关键歧义；能一次做完的不要来回问',
      '',
      '# 边界',
      '',
      '- 不改变安全规则与事实判断',
      '',
    ].join('\n')
  }
  return [
    '<!-- AGENT.md · 项目人格：只在进入这个项目时生效，优先级高于全局人格 -->',
    `<!-- 项目：${label} -->`,
    '',
    '# 在这个项目里你是谁',
    '',
    '（例：你是这个仓库的资深维护者，熟悉它的架构，改动前先读代码。）',
    '',
    '# 本项目特有的规矩',
    '',
    '- （例：改完必须跑一遍测试）',
    '- （例：注释用中文，提交信息用英文）',
    '',
  ].join('\n')
}

/** 项目人格的文件名（暴露给 API 层做「新建」）。 */
export function projectFileFor(cwd) {
  return slugFor(cwd).path
}

/** 目录名（给设置页显示）。 */
export function baseDirName() {
  return basename(agentsRoot())
}
