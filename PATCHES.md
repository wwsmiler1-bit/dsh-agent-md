# 本地改动记录

这份插件是 `wwsmiler1-bit/dsh-agent-md` 的私有仓库（无 npm 发布），本机以
`link:H:/DeepSeek记忆/插件/dsh-agent-md` 方式挂在 DSH profile 上。

上游更新覆盖 `lib/` 后，本文件列出的改动会丢，用 `patches/` 里的补丁重新打回去。

---

## 0001 · 修复 inject-log 去重永远不命中

**症状**：`C:\Users\14095\.dsh\agents\inject-log.jsonl` 每装配一次系统提示词就多写一行，
内容完全一样，只有 `at` 时间戳不同。跑一夜能堆到文件里只剩重复行，
设置页「注入记录」翻十行看不出任何变化。

**根因**：`lib/index.js` 的 `recordInjection()` 里

```js
const line = JSON.stringify(entry)
if (line === injectLogLast) return   // 永远不成立
```

`entry` 是 `{ at: new Date().toISOString(), cwd, chars, sources }`，
`at` 每次都不一样，所以整行永远不等于上一次。
注释写的是「文本没变就不重复记」，实际比的是含时间戳的整行，
去重形同虚设。

**修法**：比内容指纹，不比整行。

```js
const fingerprint = JSON.stringify({ ...entry, at: undefined })
if (fingerprint === injectLogLast) return
injectLogLast = fingerprint
```

落盘仍然写完整 `line`（带时间戳，不影响排障看时间）。

**测试**：`tests/persona.test.js` 新增用例
「注入留痕：同一份内容连续装配多轮，只记一行」。
注意里面有一行 `setTimeout(5)` 是必须的——不拉开时间的话几轮跑在同一毫秒内，
时间戳撞车，旧实现也能侥幸通过，测不出这个 bug。
（先用旧代码验证过：去掉补丁后该用例确实 FAIL。）

**验证**：全量 39 个测试通过；重启 Electron 后 `/api/agent-md/state` 返回的
`injectLog` 内存窗口连续两轮对话只有 1 条。

---

## 应用方式

```bash
cd H:/DeepSeek记忆/插件/dsh-agent-md
git apply patches/0001-fix-inject-log-dedup.patch
node --test tests/persona.test.js
```

打完必须重启 Electron，插件是启动时加载进内存的，不热更新。
