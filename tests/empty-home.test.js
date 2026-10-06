/**
 * 环境隔离用例：把 DSH_HOME 指到一个完全空的家目录，验证「一个字都没有时
 * 不注入空段落」。
 *
 * 单独成文件的原因：本用例必须临时改写**进程级** DSH_HOME，而 node --test
 * 的顶层用例之间会交错执行——放在主测试文件里时，别的用例会在这段窗口里
 * 读到空家目录而产生假失败（实测踩过）。独立文件 + 独立进程（node --test
 * 每个文件一个子进程）换来干净隔离。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('家目录为空时不注入任何内容', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'agent-md-empty-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = emptyHome
  try {
    // 注意：必须在设好 DSH_HOME 之后再 import，路径才是空的
    const { composePersona } = await import('../lib/persona.js')
    const r = composePersona({ cwd: '', config: { enabled: true } })
    assert.equal(r.text, '', '没有全局也没有项目人格时不应注入')
    assert.deepEqual(r.sources, [])

    // 只有空目录但传了 cwd 也一样为空
    const r2 = composePersona({ cwd: emptyHome, config: { enabled: true } })
    assert.equal(r2.text, '')
  } finally {
    process.env.DSH_HOME = prev
    rmSync(emptyHome, { recursive: true, force: true })
  }
})
