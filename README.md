# dsh-agent-md · AGENT.md 人格配置

给 DeepSeek Harness 装一套「像 VS Code 那样用 Markdown 写模型人格」的机制：
**全局一份 + 每个项目一份，项目覆盖全局**；既能在设置页里可视化编辑，也能一键
打开原文件用任何编辑器改。

## 它长什么样

设置 → **人格**：

- 顶部一条「本会话当前生效」——直接告诉你此刻吃的是哪份文件、多少字；
  **全局与项目一起算**：只写了全局人格时这里显示「全局人格 · …」，
  而不是误导性的「尚未写入任何人格」；
- 两个页签：**全局人格** / **项目人格**，中间是一个 Markdown 编辑器；
- **项目人格页签的工作区下拉 = 本机所有工作区**（不只有登记过的）：来源是 DSH 的
  `storages/workspace.json` + `sessions/` 目录名 + 插件登记表；想在任意目录用项目
  人格时，可以直接手填路径，或点「选择文件夹」用系统目录选择器挑一个；
- 「打开原文件」把文件在系统文件管理器里选中，想用 VS Code 改就改；
- 三个开关：全局人格是否一起注入 / 是否启用项目人格 / 是否优先读项目内 AGENT.md；
- 底部一行**注入记录**：最近一次装配实际注入了哪一份、多少字、哪个工作目录
  （数据来自 `<DSH_HOME>/agents/inject-log.jsonl`）——「到底生效没有」不再靠猜。

## 三层文件与优先级

| 优先级 | 文件 | 说明 |
| --- | --- | --- |
| 高 | `<项目目录>/AGENT.md` | 跟着仓库走，可提交进 git；开关可关 |
| 中 | `<DSH_HOME>/agents/projects/<目录名>-<哈希>.md` | 本机存储，设置页里编辑的就是它 |
| 低 | `<DSH_HOME>/AGENT.md` | 全局底座，默认一起注入 |

生效规则：项目层取前两层里**优先级最高的那一份**（避免两份打架）；全局人格默认
作为底座**一起**注入，可在设置里关掉变成「纯项目制」。没有 `cwd` 的会话只用全局。

>`<DSH_HOME>` 一般是 `C:\Users\<你>\.dsh`（跟随 DSH 的 `DSH_HOME` 环境变量）。

## 生效时机

人格通过 `systemPrompt.context({ text: (context) => … })` 注入，渲染成一条 user
角色的尾消息，**只在渲染文本变化时**重新追加：所以改完文件会在**下一个回合**生效，
而稳定前缀（系统提示 + 历史）的缓存不会被无谓打断。

「不同项目不同人格」是天然成立的——注入函数每次装配都会读当前会话的
`context.agent.session.header.cwd`，不需要任何会话钩子，也没有缓存过期问题。

## 写法建议

- 用 Markdown 写，`# 你是谁` / `# 语气与风格` / `# 行事偏好` / `# 边界` 这种分节就够；
- **HTML 注释 `<!-- ... -->` 是给你自己看的**：不会进模型上下文（省 token，也防止
  「（例：…）」这种示例文字被模型当成真实设定）。模板里的注释没删 = 这份还没写；
- 正文里写 `{{xxx}}` 会被自动降级成 `{xxx}`——宿主把 `{{名字}}` 当模板变量解析，
  未注册的名字会让整轮注入失败，插件替你兜住了；
- 单标题人格（只写一行 `# 这个项目里你是资深维护者`）完全合法，会被正常注入。

## 安装

### 拿到源码

```powershell
# <DSH_HOME> 一般是 C:\Users\<你>\.dsh（跟 DSH_HOME 环境变量走）
git clone https://github.com/smiler/dsh-agent-md.git "<DSH_HOME>\plugins\dsh-agent-md"
```

### 挂进 profile（本地 link 方式）

本插件以「本地 link」方式装在 DSH 桌面 profile 下：

```
<DSH_HOME>\plugins\dsh-agent-md\                     ← 源码（改这里）
<DSH_HOME>\profiles\desktop\node_modules\dsh-agent-md ← junction 指向上面
<DSH_HOME>\profiles\desktop\package.json             ← dependencies + dsh.profile.bundles 各一行
```

**卸载 / 回滚**（两步都要做，否则下次启动会因「声明了却装不起来」卡住）：

1. 编辑 `<DSH_HOME>\profiles\desktop\package.json`：
   - `dependencies` 里删掉 `"dsh-agent-md": "link:..."` 那一行；
   - `dsh.profile.bundles` 里删掉 `"dsh-agent-md"` 那一行；
2. 删掉 `<DSH_HOME>\profiles\desktop\node_modules\dsh-agent-md`（junction 本身，
   不删源码）——然后重启 DSH。

## 开发与自检

```powershell
$node = "<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
# 宿主自带的 node 不一定在这个路径，任意 Node 20+ 都能跑下面的脚本

# 单元 + 冒烟测试（29 项：人格合成/优先级/API/客户端 bundle 注册）
& $node --test "tests/*.test.js"

# 启动安全预检：逐个验证 profile 里每个 bundle 能否加载
& $node tests/preflight-bundles.mjs "<DSH_HOME>\profiles\desktop"

# 活体验证：确认运行中的 DSH 已经装上（宿主端 + 项目链路）
& $node tests/verify-live.mjs "http://127.0.0.1:19387" "<你的项目目录>"
```

改完代码重启 DSH 即生效（源码目录与 profile 里的 junction 是同一份，改一边即可）。

## HTTP 接口（浏览器半侧只走同源 fetch，不碰 RPC）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/agent-md/state?session=&path=` | 全部状态：全局/项目文件、`effective`（这一回合实际会注入什么）、`current`（含 `cwdSource`）、项目清单（含正文）、**所有工作区**、注入记录 |
| POST | `/api/agent-md/save` | 写人格（`scope`: global/project/template，`mode`: save/revert/delete） |
| POST | `/api/agent-md/create` | 用模板新建（已存在不覆盖） |
| POST | `/api/agent-md/config` | 开关：enabled / includeGlobal / projectPersonaEnabled / localNames |
| POST | `/api/agent-md/open` | 在系统文件管理器里打开/选中文件（scope 可为 dir） |
| POST | `/api/agent-md/register` | 登记一个工作目录（设置页把非当前会话的项目也拉进来） |
| POST | `/api/agent-md/pick` | 弹系统「选择文件夹」并登记选中目录（任意目录都能用项目人格） |

写文件都带 `.bak` 备份；单文件上限 512 KB；注入正文上限 40000 字符（超出截断并提示）。

## 排障：明明写了人格，却好像没生效

按这个顺序看，一步定位：

1. **底下两个开关都关着就是谁也不注入**。`全局人格一起注入` + `启用项目人格` 全关 =
   空注入（面板现在会红字直说这一点）。状态落在 `<DSH_HOME>/agent-md.json`：
   `includeGlobal` / `projectPersonaEnabled` 都该是 `true`。
2. **看底部「注入记录」那一行**：它写的是最近一次真实装配的结果。空着 = 还没跑过回合；
   显示「全局人格 · … 1207 字」= 已经注入了。
   原始记录在 `<DSH_HOME>/agents/inject-log.jsonl`（文本没变不重复记）。
3. **看顶部「当前工作目录」**：`（本页拿不到会话 id → 用最近活跃工作区兜底）`
   说明设置页没拿到 session id——不影响注入，但要编辑某个项目的项目人格时，
   记得在下拉里选对工作区（下拉里是本机所有工作区）。
4. **生效时机**：人格是每回合装配时按会话 cwd 现算的，改完文件**下一个回合**生效；
   宿主端代码改了要重启 DSH，纯客户端（`lib/client.js`）改了刷新页面即可。
5. **设置页整块空白（左侧导航还在、右侧内容区空的）**：那是客户端组件在渲染时抛异常、
   被 React 吃掉了整棵子树。最快恢复：刷新页面（客户端 bundle 是页面加载时取的）。
   现在注册处外面套了**错误边界**，任何渲染异常都会显示成红字加原始错误消息，不再
   白屏；测试里的「hook 一致性防线」也会在提交前拦住这类错误。

### 2026-10-05 修掉的四处真问题

- `listProjects()` 只回 `exists` 不回正文 → 设置页项目编辑框永远是空的，用户一按
  保存就把项目人格写空（现在回正文 + `bytes` + `updatedAt`）；
- 顶部横幅只看项目人格 → 只写全局人格的用户被告知「尚未写入任何人格」（现在全局
  与项目一起算，并专门点破「两个开关都关」这种配置错误）；
- 项目下拉只有登记过的目录 → 现在列**所有工作区**，还能手填/系统选择器挑任意目录；
- 客户端把一个 `useMemo` 写在了两处「早返回」之后 → 首帧少调一个 hook、第二帧多调
  一个，真实 React 抛 `Rendered more hooks than during the previous render`，
  整个「人格」页白屏（假 React 测试替身不检查这个，所以测试全绿也照崩）。现已挪回
  早返回之前，并补了两条防线：渲染路径的 **hook 调用数一致性断言** +
  注册处的**错误边界**。

## 自检指示灯（本页已连接宿主）

设置页顶部那条横幅右侧有个小圆点：

- **绿点 · 本页已连接宿主** —— 页面刚刚成功打过 `/api/agent-md/state`，
  说明客户端 bundle 已被服务给网页、并且真的连上了宿主；
- **黄点 · 等待连接宿主** —— 宿主还没收到本页的请求（插件没加载 / 页面没刷新）。

宿主端把每次 `/state` 握手记在内存里（`bridge.lastSeen / count`）并随响应回传，
所以这个指示灯不是装饰：它是「插件两端是否真的接通了」的可验证证据。
排障顺序也由它决定——黄点说明问题在**加载**（重启 DSH），绿点说明问题在**内容**。

## 配色：完全跟随宿主主题

设置页不自己造色，全部走宿主的设计令牌（`--dsw-alias-*`）——宿主换主题/换深浅色，
这一页跟着变，不会出现「面板是深灰、卡片自带米白」那种脏感。层级分配：

| 用途 | 令牌 |
| --- | --- |
| 主文字 / 次要 / 最弱 | `label-primary` / `label-secondary` / `label-tertiary` |
| 卡片底 / 工具条底 / 编辑区底 | `bg-layer-1` / `bg-layer-2` / `bg-layer-3` |
| 边框（强 / 弱） | `border-l2` / `border-l1` |
| 强调色（主按钮 · 当前页签 · 勾选框，只此三处） | `brand-primary` |
| 状态色（已连接 / 未保存 / 出错） | `state-success-primary` / `state-warn-primary` / `state-error-primary` |

配色纪律：**一个强调色、三个层级**。所有令牌都带中性色回落（`@supports not` 一层），
所以万一宿主没给令牌也不会画成一片白。

改配色就改 `lib/client.js` 里 `var CSS = [...]` 的令牌映射；改完刷新页面即生效
（客户端 bundle 是页面加载时取的文件，不需要重启 DSH）。

## 已知边界

- 项目内 `AGENT.md` 的探测是**同步**的（注入路径不能用异步），所以只认文件、不递归。
- `context.agent` 的结构由 DSH 决定，插件对缺字段、空会话都做了兜底（不抛异常）。
- 设置页入口用官方 `settings.section` 槽位；宿主不提供该槽位的旧版本上，页面不会出现
  （宿主端注入不受影响）。
