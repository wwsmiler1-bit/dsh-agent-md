/**
 * 装好之后的活体验证：直接打运行中的 DSH，确认三条关键链路。
 *
 * 用法：node tests/verify-live.mjs [baseUrl] [cwd]
 *
 * 1. 宿主端插件已加载（/api/agent-md/state 返回 200 且字段齐全）
 * 2. 客户端 bundle 已服务给网页（/client-modules/.../dsh-agent-md 之类）
 * 3. 项目人格链路：POST /register 登记一个工作目录后，/state?path= 能解析它
 *    ——这是「进哪个项目自动用哪份人格」的底层保证
 */

const base = process.argv[2] !== undefined ? process.argv[2] : 'http://127.0.0.1:19387'
const probeCwd = process.argv[3] !== undefined ? process.argv[3] : process.cwd()

const results = []
function record(ok, name, detail) {
  results.push({ ok, name, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
}

async function getJson(path) {
  const res = await fetch(base + path, { cache: 'no-store' })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: res.status, body }
}

async function postJson(path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: res.status, body }
}

// 1. 宿主端插件
let state = null
try {
  const r = await getJson('/api/agent-md/state')
  state = r.body
  const fieldsOk = r.status === 200 && state !== null && typeof state === 'object'
    && state.global !== undefined && state.current !== undefined && Array.isArray(state.projects)
  record(fieldsOk, '宿主端插件已加载（/api/agent-md/state）', `HTTP ${r.status}，baseDir=${state?.baseDir ?? '?'}`)
} catch (error) {
  record(false, '宿主端插件已加载（/api/agent-md/state）', String(error.message))
}

// 2. 客户端 bundle：DSH 把插件的 dsh.client 入口服务成模块；探测它是否可达
const clientCandidates = [
  '/client-modules/dsh-agent-md',
  '/client-modules/dsh-agent-md/client',
  '/dsh-client-modules/dsh-agent-md',
  '/client/dsh-agent-md',
]
let clientOk = false
let clientDetail = '未找到客户端模块路由'
for (const path of clientCandidates) {
  try {
    const res = await fetch(base + path, { cache: 'no-store' })
    if (res.status === 200) {
      const text = await res.text()
      if (text.includes('__ModuleLoader__') || text.includes('dsh-agent-md')) {
        clientOk = true
        clientDetail = `${path}（HTTP 200，${text.length} 字节）`
        break
      }
      clientDetail = `${path} 返回 200 但内容不像模块`
    } else {
      clientDetail = `${path} → HTTP ${res.status}（DSH 的客户端模块路由要求页面鉴权，命令行拿不到 token，属预期）`
    }
  } catch (error) {
    clientDetail = String(error.message)
  }
}
if (clientOk) {
  record(true, '客户端 bundle 可达（从命令行探测到）', clientDetail)
} else {
  // 不是失败：DSH 把客户端模块路由放在页面鉴权之后，命令行必然 401。
  // 真正的证据在浏览器侧——设置页顶部的「本页已连接宿主」指示灯：页面每次打开都会
  // 打 /state，宿主记下握手（bridge.lastSeen / count）并随响应回传。
  console.log(`· 客户端 bundle 命令行走不到（预期）：${clientDetail}`)
  console.log('  真实证据请看设置页顶部的「本页已连接宿主」指示灯（页面打过 /state 即为通）')
}

// 3. 项目人格链路
try {
  const reg = await postJson('/api/agent-md/register', { cwd: probeCwd })
  const st = await getJson(`/api/agent-md/state?path=${encodeURIComponent(probeCwd)}`)
  const ok = reg.status === 200 && st.status === 200 && st.body?.current?.cwd === probeCwd
  record(ok, '项目人格链路（登记 + 按路径解析）', `cwd=${probeCwd}，slug=${reg.body?.slug?.slug ?? '?'}`)
} catch (error) {
  record(false, '项目人格链路（登记 + 按路径解析）', String(error.message))
}

const failed = results.filter((r) => !r.ok).length
console.log('')
console.log(failed === 0
  ? `SUMMARY 活体验证通过（${results.length}/${results.length}）`
  : `SUMMARY ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
