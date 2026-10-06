/**
 * 启动安全预检：模拟 DSH 组装 profile 时的 bundle 解析，确保新加的插件不会
 * 让下一次启动卡在组装阶段（那种情况下桌面端窗口根本不打开）。
 *
 * 用法：node tests/preflight-bundles.mjs [profileDir]
 *
 * 每个 dsh.profile.bundles 里的包检查：
 *   1. 能从 profile/node_modules 解析到；
 *   2. package.json 能解析；main 入口存在（exports 兼容字符串 / 条件对象两种写法）；
 *   3. dsh.bundle.patch 指向的文件存在、非空、含 insert: 段；
 *   4. patch 里 insert 段的 **包名行** 能解析到（只查像包名的行，YAML 里的分组名
 *      与 `cordis:group` 之类不算——早先版本把它们当包名，产生一堆误报）。
 *
 * 退出码：0 = 全部可加载；1 = 有 bundle 会在下次启动时出问题。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const profileDir = process.argv[2] !== undefined ? resolve(process.argv[2]) : resolve(HERE, '..')

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`✗ 找不到 profile 清单：${manifestPath}`)
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('✗ profile 清单里没有 dsh.profile.bundles 数组')
  process.exit(2)
}

/** 解析一个包名到目录（node 的解析顺序：profile/node_modules/<name>）。 */
function resolvePackageDir(name) {
  const candidate = name.startsWith('@')
    ? join(profileDir, 'node_modules', ...name.split('/'))
    : join(profileDir, 'node_modules', name)
  return existsSync(candidate) ? candidate : null
}

/** exports 字段可能是字符串，也可能是 {import, require, default} 条件对象。 */
function pickTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    for (const key of ['import', 'default', 'require', 'node']) {
      const found = pickTarget(value[key])
      if (found !== null) return found
    }
  }
  return null
}

/** 一行 name: 是否指代一个可解析的包（而不是 YAML 分组名 / cordis:xxx）。 */
function looksLikePackageName(name) {
  if (name === '') return false
  if (name.includes(':')) return false // cordis:group 之类
  if (!/^[@a-z0-9]/.test(name)) return false
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(\/.*)?$/.test(name)) return false
  return name.startsWith('@') || name.startsWith('dsh-') || name.includes('/') || /^[a-z][a-z0-9-]*$/.test(name)
}

let failures = 0
const rows = []

for (const name of bundles) {
  if (typeof name !== 'string') {
    rows.push({ name: String(name), status: '✗', detail: 'bundle 名不是字符串' })
    failures += 1
    continue
  }

  const dir = resolvePackageDir(name)
  if (dir === null) {
    rows.push({ name, status: '·', detail: 'profile 里没有该包（官方 in-box bundle，来自安装目录）' })
    continue
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch (error) {
    rows.push({ name, status: '✗', detail: `package.json 解析失败：${String(error.message)}` })
    failures += 1
    continue
  }

  const problems = []

  // 入口（main 可以是字符串；exports["."] 可能是条件对象）
  const main = pickTarget(pkg.main) ?? pickTarget(pkg?.exports?.['.'])
  if (typeof main === 'string' && main !== '') {
    if (!existsSync(resolve(dir, main))) problems.push(`入口不存在：${main}`)
  }

  // bundle patch
  const patch = pickTarget(pkg?.dsh?.bundle?.patch)
  if (typeof patch === 'string' && patch !== '') {
    const patchPath = resolve(dir, patch)
    if (!existsSync(patchPath)) {
      problems.push(`dsh.bundle.patch 不存在：${patch}`)
    } else {
      const raw = readFileSync(patchPath, 'utf8')
      if (raw.trim() === '') problems.push('patch 文件是空的')
      else if (!/insert:/m.test(raw)) problems.push('patch 里没有 insert: 段')
      // 只检查「insert 之下、且像包名」的 name: 行；本包自己当然可解析
      const names = [...raw.matchAll(/^\s+name:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((m) => m[1])
      for (const inserted of names) {
        if (inserted === name) continue
        // 子路径（包名/子路径）只解析包名部分
        const pkgName = inserted.startsWith('@') ? inserted.split('/').slice(0, 2).join('/') : inserted.split('/')[0]
        // 官方包一律来自 DSH 安装目录、不在 profile 的 node_modules 里——不查（否则全是误报）
        if (pkgName.startsWith('@deepseek-ai/')) continue
        if (!looksLikePackageName(pkgName)) continue
        if (resolvePackageDir(pkgName) === null) {
          problems.push(`patch 里 insert 的包名解析不到：${inserted}`)
        }
      }
    }
  }

  // 客户端 bundle
  const clientTarget = pickTarget(pkg?.exports?.['./client'])
  if (typeof clientTarget === 'string' && clientTarget !== '') {
    const clientPath = resolve(dir, clientTarget)
    if (!existsSync(clientPath)) {
      problems.push(`exports["./client"] 不存在：${clientTarget}`)
    } else if (!/__ModuleLoader__/.test(readFileSync(clientPath, 'utf8'))) {
      problems.push('客户端 bundle 里没有 __ModuleLoader__ 注册（宿主无法加载）')
    }
  }

  if (problems.length === 0) {
    rows.push({ name, status: '✓', detail: pkg.version !== undefined ? `v${pkg.version}` : 'ok' })
  } else {
    rows.push({ name, status: '✗', detail: problems.join('；') })
    failures += 1
  }
}

const width = Math.max(...rows.map((r) => r.name.length), 10)
for (const r of rows) console.log(`${r.status} ${r.name.padEnd(width)}  ${r.detail}`)

console.log('')
console.log(failures === 0
  ? `SUMMARY 全部可加载（${rows.length} 个 bundle，0 个失败）`
  : `SUMMARY ${failures} 个 bundle 会在下次启动时出问题`)
process.exit(failures === 0 ? 0 : 1)
