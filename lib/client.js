/**
 * dsh-agent-md —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 注册一个「人格」设置页（slot: settings.section），页面里可以：
 *   - 编辑全局人格 <DSH_HOME>/AGENT.md；
 *   - 编辑当前项目人格 <DSH_HOME>/agents/projects/<slug>.md；
 *   - 一键在系统文件管理器里打开原文件（用户想去文件原位置改时用）；
 *   - 看到「本会话此刻实际用的是哪一份人格」（优先级解析结果）。
 *
 * 与宿主端只走同源 HTTP（/api/agent-md/*），不碰 RPC：
 * 失败模式最少，也没有 connection 服务缺失的降级分支。
 *
 * 这个文件是「手写 bundle」：包在 window.__ModuleLoader__.load 里，只 require
 * 宿主已提供的模块表（react）。修改后 `node --check lib/client.js` 验证语法
 * （它是表达式不是语句，check 只验语法不执行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-md',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/agent-md'
    var NS = 'dsh-agent-md'

    // ---- 同源 API ---------------------------------------------------------

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }
    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = data && data.error ? data.error : ('HTTP ' + res.status)
          var err = new Error(msg)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    // ---- 小工具 -----------------------------------------------------------

    /** 字符数 → 「N 字」；超过 1200 字提示会拖慢注入。 */
    function charLabel(n) {
      if (!n) return '0 字'
      return String(n) + ' 字'
    }

    /** 「今天 14:32」这种人类可读时间；解析不了就回显原值。 */
    function timeLabel(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      var pad = function (x) { return x < 10 ? '0' + x : String(x) }
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /** 只取路径最后两段，防止长路径撑爆侧栏。 */
    function shortPath(p) {
      if (typeof p !== 'string' || p === '') return ''
      var parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
      if (parts.length <= 2) return p
      return '…/' + parts.slice(-2).join('/')
    }

    /**
     * 会话 id 的来源兼容。
     *
     * DSH 给槽位组件的 props 在不同版本/不同槽位下可能是字符串、也可能是一个懒求值
     * 函数；旧版这里只认字符串，拿不到 session id 就整页解析不出工作目录（面板上
     * 显示「未解析到」）。三种形态都吃：函数、字符串、props.session.id。
     */
    function readSessionId(props) {
      if (props === null || props === undefined) return ''
      var raw = props.sessionId
      if (typeof raw === 'function') {
        try {
          raw = raw()
        } catch (e) {
          raw = ''
        }
      }
      if (typeof raw === 'string' && raw !== '') return raw
      var s = props.session
      if (typeof s === 'string' && s !== '') return s
      if (s !== null && typeof s === 'object' && typeof s.id === 'string' && s.id !== '') return s.id
      return ''
    }

    /** props 里顺带带出来的工作目录（会话对象上有就直接用，省一次宿主解析）。 */
    function readCwdHint(props) {
      if (props === null || props === undefined) return ''
      var s = props.session
      if (s !== null && typeof s === 'object' && s.header !== null && typeof s.header === 'object' && typeof s.header.cwd === 'string' && s.header.cwd !== '') return s.header.cwd
      if (typeof props.cwd === 'string' && props.cwd !== '') return props.cwd
      return ''
    }

    /** 路径比较键（大小写、斜杠方向、结尾斜杠都不该影响「是不是同一个工作区」）。 */
    function pathKey(p) {
      if (typeof p !== 'string') return ''
      var t = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      return t.toLowerCase()
    }

    function samePath(a, b) {
      return pathKey(a) !== '' && pathKey(a) === pathKey(b)
    }

    /** 内联图标（不用 emoji，避免拉低设置页质感）。 */    function Icon(props) {
      var size = props.size || 15
      var common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', flex: '0 0 auto' },
      }
      var paths
      if (props.name === 'folder') {
        paths = [h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' })]
      } else if (props.name === 'save') {
        paths = [
          h('path', { key: 'a', d: 'M5 4.5h10l4 4v11H5z' }),
          h('path', { key: 'b', d: 'M8.5 4.5v5h7v-5' }),
          h('path', { key: 'c', d: 'M8.5 14.5h7v5h-7z' }),
        ]
      } else if (props.name === 'refresh') {
        paths = [
          h('path', { key: 'a', d: 'M19 12a7 7 0 1 1-2.1-5' }),
          h('path', { key: 'b', d: 'M19.5 4v4.2h-4.2' }),
        ]
      } else if (props.name === 'plus') {
        paths = [
          h('path', { key: 'a', d: 'M12 5.5v13' }),
          h('path', { key: 'b', d: 'M5.5 12h13' }),
        ]
      } else if (props.name === 'file') {
        paths = [
          h('path', { key: 'a', d: 'M6 3.5h7l5 5v12H6z' }),
          h('path', { key: 'b', d: 'M13 3.5v5h5' }),
        ]
      } else {
        paths = [h('circle', { key: 'a', cx: 12, cy: 12, r: 8 })]
      }
      return h('svg', common, paths)
    }

    // ---- 组件 -------------------------------------------------------------

    /**
     * 设置页的错误边界（必须是 class：React 只认 class 的 getDerivedStateFromError）。
     *
     * 存在的理由很实在：2026-10-05 组件里一个 hook 顺序问题把整个「人格」页渲染成
     * 空白——用户看不到任何提示，只能猜「插件坏了」。有了它，任何渲染异常都会变成
     * 一段可读红字加一句「把报错发给我」，而不是让内容区凭空消失。
     */
    class AgentMdErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-agent-md] 设置页渲染失败：', error)
        } catch (e) {
          // 控制台不可用就静默
        }
      }

      render() {
        if (this.state.error !== null) {
          var msg = this.state.error !== null && this.state.error !== undefined
            ? (this.state.error.message !== undefined ? this.state.error.message : String(this.state.error))
            : '未知错误'
          return h('div', { className: 'am-root' }, [
            h('div', { key: 'h', className: 'am-h1' }, '人格 · AGENT.md（dsh-agent-md）'),
            h('div', { key: 'e', className: 'am-error' }, '这个设置页渲染时出错了：' + String(msg)),
            h('div', { key: 'd', className: 'am-muted' }, '人格注入本身不受影响（注入发生在宿主侧，与这个页面无关）。把上面这段报错、连同浏览器控制台的内容发给我即可定位。'),
          ])
        }
        return this.props.children
      }
    }

    function Pill(props) {
      return h('button', {
        type: 'button',
        className: 'am-pill' + (props.active ? ' am-pill-on' : ''),
        onClick: props.onClick,
        disabled: props.disabled === true,
      }, props.children)
    }

    function ActionButton(props) {
      return h('button', {
        type: 'button',
        className: 'am-btn' + (props.primary ? ' am-btn-primary' : ''),
        onClick: props.onClick,
        disabled: props.disabled === true,
        title: props.title || '',
      }, [
        props.icon ? h(Icon, { key: 'i', name: props.icon }) : null,
        h('span', { key: 't' }, props.children),
      ])
    }

    /** 一行开关（勾选框 + 标签 + 说明）。 */
    function ToggleRow(props) {
      return h('label', { className: 'am-toggle' }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: props.checked === true,
          onChange: function (e) { props.onChange(e.target.checked) },
        }),
        h('span', { key: 'b', className: 'am-toggle-body' }, [
          h('span', { key: 't', className: 'am-toggle-title' }, props.label),
          props.hint ? h('span', { key: 'h', className: 'am-toggle-hint' }, props.hint) : null,
        ]),
      ])
    }

    function AgentMdSection(props) {
      var sessionId = readSessionId(props)
      var cwdHint = readCwdHint(props)

      var [loading, setLoading] = useState(true)
      var [error, setError] = useState('')
      var [state, setState] = useState(null)
      var [scope, setScope] = useState('global')
      var [projectCwd, setProjectCwd] = useState('')
      var [pathDraft, setPathDraft] = useState('')
      var [extra, setExtra] = useState({})
      var [draft, setDraft] = useState('')
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState('')
      var [toast, setToast] = useState(null)
      var loadedRef = useRef({ key: '', content: null })

      /** 当前编辑目标：全局 / 项目（本机存储）。 */
      var target = useMemo(function () {
        if (state === null) return null
        if (scope === 'global') {
          return {
            scope: 'global',
            kind: 'global',
            key: 'global',
            known: true,
            path: state.global.path,
            exists: state.global.exists,
            content: state.global.content,
            updatedAt: state.global.updatedAt,
            empty: state.global.empty,
          }
        }
        var cwd = projectCwd || (state.current && state.current.cwd) || ''
        var stored = (state.projects || []).filter(function (p) { return samePath(p.cwd, cwd) })[0]
        var current = state.current && samePath(state.current.cwd, cwd) ? state.current : null
        var fallback = extra[cwd] || null
        var content = stored ? (stored.content || '')
          : (current ? (current.projectContent || '') : (fallback ? (fallback.content || '') : ''))
        var exists = stored ? stored.exists === true
          : (current ? current.projectFileExists === true : (fallback ? fallback.exists === true : false))
        var ws = (state.workspaces || []).filter(function (w) { return samePath(w.cwd, cwd) })[0]
        return {
          scope: 'project',
          kind: 'stored',
          key: 'project:' + pathKey(cwd),
          cwd: cwd,
          known: stored !== undefined || current !== null || fallback !== null,
          label: (current && current.displayName) || (stored && stored.displayName) || (ws && ws.displayName) || cwd,
          path: (stored && stored.path) || (current && current.projectFile) || (fallback && fallback.path) || '',
          exists: exists,
          content: content,
          updatedAt: (stored && stored.updatedAt) || (fallback && fallback.updatedAt) || null,
          empty: content.trim() === '',
        }
      }, [state, scope, projectCwd, extra])

      var reload = useCallback(function (opts) {
        var query = []
        if (sessionId) query.push('session=' + encodeURIComponent(sessionId))
        var path = opts && opts.path ? opts.path : cwdHint
        if (path) query.push('path=' + encodeURIComponent(path))
        setLoading(true)
        return apiGet('/state' + (query.length ? '?' + query.join('&') : ''))
          .then(function (data) {
            setState(data)
            setError('')
            return data
          })
          .catch(function (err) {
            setError(String((err && err.message) || err))
            return null
          })
          .then(function (data) {
            setLoading(false)
            return data
          })
      }, [sessionId, cwdHint])

      // 首次加载（也用于会话切换后重新解析当前项目）
      useEffect(function () {
        var alive = true
        reload().then(function (data) {
          if (!alive || data === null) return
          if (data.current && data.current.cwd) setProjectCwd(data.current.cwd)
        })
        return function () { alive = false }
      }, [reload])

      /**
       * 选中的工作区不在登记表里（新目录/手写的目录）时，单独拉一次它的状态。
       * `/state?path=` 会把它登记进来并带回该目录的人格正文。
       */
      useEffect(function () {
        if (state === null || scope !== 'project' || projectCwd === '') return
        if ((state.projects || []).some(function (p) { return samePath(p.cwd, projectCwd) })) return
        if (state.current && samePath(state.current.cwd, projectCwd)) return
        if (extra[projectCwd] !== undefined) return
        var alive = true
        apiGet('/state?path=' + encodeURIComponent(projectCwd)).then(function (data) {
          if (!alive || data === null) return
          var cur = data.current || {}
          setExtra(function (prev) {
            var next = Object.assign({}, prev)
            next[projectCwd] = {
              path: cur.projectFile || '',
              exists: cur.projectFileExists === true,
              content: cur.projectContent || '',
              updatedAt: null,
            }
            return next
          })
        }).catch(function () {
          // 拉不到就按「还没创建」渲染，用户仍可新建
        })
        return function () { alive = false }
      }, [state, scope, projectCwd, extra])

      // 目标切换 → 把草稿重置成该文件的当前内容
      useEffect(function () {
        if (target === null) return
        // 项目详情还没到位（既不在登记表、也不是当前会话目录、extra 也没回来）就先别清空草稿
        if (target.scope === 'project' && target.cwd !== '' && target.known !== true) return
        if (loadedRef.current.key === target.key && loadedRef.current.content === target.content) return
        loadedRef.current = { key: target.key, content: target.content }
        setDraft(target.content || '')
        setDirty(false)
      }, [target])

      /**
       * 重新载入某个工作区的人格正文。
       * 登记表里有（/state 已带回正文）就用它，没有就单独打一次 `/state?path=`。
       */
      var syncTarget = useCallback(function (cwd) {
        if (!cwd) return Promise.resolve(null)
        return apiGet('/state?path=' + encodeURIComponent(cwd)).then(function (data) {
          if (data === null) return null
          var cur = data.current || {}
          var stored = (data.projects || []).filter(function (p) { return samePath(p.cwd, cwd) })[0]
          var detail = stored !== undefined
            ? { path: stored.path, exists: stored.exists === true, content: stored.content || '', updatedAt: stored.updatedAt || null }
            : { path: cur.projectFile || '', exists: cur.projectFileExists === true, content: cur.projectContent || '', updatedAt: null }
          setExtra(function (prev) {
            var next = Object.assign({}, prev)
            next[cwd] = detail
            return next
          })
          return detail
        }).catch(function () { return null })
      }, [])

      var doSave = useCallback(function () {
        if (target === null) return
        setBusy('save')
        apiPost('/save', {
          scope: target.scope,
          kind: target.kind,
          cwd: target.cwd || '',
          content: draft,
        }).then(function () {
          setDirty(false)
          // 草稿就是刚写下去的内容：把它记成「已载入」，避免随后的刷新把光标位置顶掉
          loadedRef.current = { key: target.key, content: draft }
          setToast({ kind: 'ok', text: '已保存。' + (target.scope === 'global' ? '全局人格' : '项目人格') + '会在下一个回合生效。' })
          return reload({ path: target.cwd || '' }).then(function () {
            if (target.scope === 'project') return syncTarget(target.cwd)
            return null
          })
        }).catch(function (err) {
          setToast({ kind: 'err', text: '保存失败：' + String((err && err.message) || err) })
        }).then(function () { setBusy('') })
      }, [target, draft, reload, syncTarget])

      var doCreate = useCallback(function () {
        if (target === null) return
        setBusy('create')
        apiPost('/create', { scope: target.scope, kind: target.kind, cwd: target.cwd || '', overwrite: false })
          .then(function (res) {
            if (res && res.created === false) {
              setToast({ kind: 'err', text: '文件已存在，已直接载入现有内容。' })
            }
            // 载入新内容交给 target 变化后的重置逻辑：这里只负责把状态刷新回来
            return reload({ path: target.cwd || '' }).then(function () {
              if (target.scope === 'project') return syncTarget(target.cwd)
              return null
            })
          })
          .catch(function (err) {
            setToast({ kind: 'err', text: '新建失败：' + String((err && err.message) || err) })
          })
          .then(function () { setBusy('') })
      }, [target, reload, syncTarget])

      var doOpen = useCallback(function () {
        if (target === null) return
        setBusy('open')
        apiPost('/open', { scope: target.scope, kind: target.kind, cwd: target.cwd || '' })
          .then(function (res) {
            setToast({ kind: 'ok', text: '已在文件管理器中打开：' + (res && res.opened ? res.opened : '') })
          })
          .catch(function (err) {
            setToast({ kind: 'err', text: '打开失败：' + String((err && err.message) || err) })
          })
          .then(function () { setBusy('') })
      }, [target])

      var doConfig = useCallback(function (patch) {
        setBusy('config')
        apiPost('/config', patch)
          .then(function () { return reload() })
          .catch(function (err) {
            setToast({ kind: 'err', text: '设置失败：' + String((err && err.message) || err) })
          })
          .then(function () { setBusy('') })
      }, [reload])

      /** 让宿主弹系统「选择文件夹」，结果填进输入框。 */
      var doPick = useCallback(function () {
        setBusy('pick')
        apiPost('/pick', {})
          .then(function (res) {
            if (res && res.picked) {
              setPathDraft(res.picked)
              setToast({ kind: 'ok', text: '已选中：' + res.picked + '（再点「使用」切过去）' })
            } else {
              setToast({ kind: 'ok', text: '已取消选择。' })
            }
          })
          .catch(function (err) {
            setToast({ kind: 'err', text: '打不开选择器：' + String((err && err.message) || err) })
          })
          .then(function () { setBusy('') })
      }, [])

      /** 用手填/选中的目录当工作区（登记 + 切过去 + 拉它的项目人格）。 */
      var usePickedCwd = useCallback(function (rawCwd) {
        var cwd = (typeof rawCwd === 'string' && rawCwd !== '' ? rawCwd : pathDraft).trim()
        if (cwd === '') {
          setToast({ kind: 'err', text: '先填一个目录，或者点「选择文件夹」。' })
          return
        }
        setBusy('pick')
        apiPost('/register', { cwd: cwd, active: true }).then(function () {
          setScope('project')
          setProjectCwd(cwd)
          setToast({ kind: 'ok', text: '已切到工作区：' + cwd })
          return reload({ path: cwd })
        }).catch(function (err) {
          setToast({ kind: 'err', text: '登记失败：' + String((err && err.message) || err) })
        }).then(function () { setBusy('') })
      }, [pathDraft, reload])

      // toast 自动消失
      useEffect(function () {
        if (toast === null) return
        var t = setTimeout(function () { setToast(null) }, 4200)
        return function () { clearTimeout(t) }
      }, [toast])

      /**
       * 项目下拉的候选：本机所有工作区（DSH 工作区表 + 会话记录 + 登记表）。
       *
       * ⚠️ 这个 hook 必须待在下面两处「早返回」**之前**：React 要求每次渲染的 hook
       * 调用数量完全一致，而首帧（state 还是 null）会走早返回。曾经它写在早返回之后，
       * 于是首帧少调一个 hook、第二帧多调一个 —— 真实 React 直接抛
       * 「Rendered more hooks than during the previous render」，整个「人格」设置页
       * 白屏（假 React 测试替身不检查这个，所以测试全绿也照崩）。
       */
      var projectOptions = useMemo(function () {
        if (state === null) return []
        var list = (state.workspaces || []).filter(function (w) { return typeof w.cwd === 'string' && w.cwd !== '' })
        var cur = state.current && state.current.cwd ? state.current.cwd : ''
        if (cur !== '' && !list.some(function (w) { return samePath(w.cwd, cur) })) {
          list = [{ key: cur, cwd: cur, displayName: state.current.displayName || cur, exists: false, sources: [] }].concat(list)
        }
        var selected = projectCwd || cur
        if (selected !== '' && !list.some(function (w) { return samePath(w.cwd, selected) })) {
          list = [{ key: selected, cwd: selected, displayName: selected, exists: false, sources: [] }].concat(list)
        }
        return list
      }, [state, projectCwd])

      if (loading && state === null) {
        return h('div', { className: 'am-root' }, h('div', { className: 'am-loading' }, '正在读取人格配置…'))
      }

      if (state === null) {
        return h('div', { className: 'am-root' }, [
          h('div', { key: 'h', className: 'am-h1' }, '人格 · AGENT.md'),
          h('div', { key: 'e', className: 'am-error' }, '读取失败：' + error),
          h('div', { key: 'r', className: 'am-actions' }, h(ActionButton, { icon: 'refresh', onClick: function () { reload() } }, '重试')),
        ])
      }

      var resolved = state.current && state.current.resolved ? state.current.resolved : null
      var effective = state.effective || null
      var charCount = draft.length

      /**
       * 连接回执：页面刚打过 /state，所以宿主记下的 bridge.lastSeen 必然新鲜。
       * 面板上显示这一行是真实可用的自检——页面没连上宿主时它会变成黄色提示，
       * 用户（和我）都能一眼看出「设置页是不是真的通了」。
       */
      var bridgeInfo = state.bridge || null
      var bridgeFresh = false
      if (bridgeInfo !== null && typeof bridgeInfo.lastSeen === 'string') {
        var seenAt = new Date(bridgeInfo.lastSeen).getTime()
        bridgeFresh = !isNaN(seenAt) && (Date.now() - seenAt) < 60000
      }

      /**
       * 优先级解析结果横幅：本会话此刻实际吃的是哪一份。
       *
       * 结论由宿主算好（`state.effective`：全局 + 项目一起算）。旧版这里只看项目人格，
       * 于是「只写了全局人格」的用户会看到「尚未写入任何人格」——明明写了也注入了。
       */
      var effectiveKind = effective !== null && typeof effective.kind === 'string' ? effective.kind : 'none'
      var effectiveText = effective !== null && typeof effective.label === 'string'
        ? effective.label
        : (resolved === null
          ? '尚未写入任何人格（写一份即生效）'
          : (resolved.kind === 'local' ? '项目内 AGENT.md · ' : '项目人格 · ') + shortPath(resolved.path) + '（' + charLabel(resolved.chars) + '）')
      var effectiveVal = effectiveText + (effective !== null && Array.isArray(effective.extra) && effective.extra.length > 0 ? '　' + effective.extra.join('　') : '')

      var resolvedBanner = h('div', { className: 'am-resolved' }, [
        h('div', { key: 'l', className: 'am-resolved-line' }, [
          h('span', { key: 'k', className: 'am-resolved-key' }, '本会话当前生效'),
          h('span', { key: 'v', className: 'am-resolved-val' + (effectiveKind === 'none' || effectiveKind === 'off' ? ' am-val-warn' : '') }, effectiveVal),
          bridgeFresh
            ? h('span', { key: 'b', className: 'am-live', title: timeLabel(bridgeInfo.lastSeen) + ' 与本页握手' }, '本页已连接宿主')
            : h('span', { key: 'b', className: 'am-live am-live-stale', title: '宿主还没有收到本页的请求' }, '等待连接宿主'),
        ]),
        state.current && state.current.cwd
          ? h('div', { key: 'c', className: 'am-resolved-line am-muted' }, [
            h('span', { key: 'k', className: 'am-resolved-key' }, '当前工作目录'),
            h('span', { key: 'v', className: 'am-resolved-val' }, state.current.cwd
              + (state.current.cwdSource === 'recent' ? '（本页拿不到会话 id → 用最近活跃工作区兜底）' : '')
              + (state.current.cwdSource === 'path' ? '（手动指定）' : '')),
          ])
          : h('div', { key: 'c', className: 'am-resolved-line am-muted' }, [
            h('span', { key: 'k', className: 'am-resolved-key' }, '当前工作目录'),
            h('span', { key: 'v', className: 'am-resolved-val' }, '未解析到 —— 切到「项目人格」页签可以手选任意目录'),
          ]),
      ])

      /** 优先级说明（一次讲清三层文件的关系）。 */
      var precedence = h('div', { className: 'am-hint' }, [
        h('span', { key: 'a', className: 'am-hint-step' }, '项目内 AGENT.md'),
        h('span', { key: 'b', className: 'am-arrow' }, '›'),
        h('span', { key: 'c', className: 'am-hint-step' }, '项目人格（本机）'),
        h('span', { key: 'd', className: 'am-arrow' }, '›'),
        h('span', { key: 'e', className: 'am-hint-step' }, '全局人格'),
        h('span', { key: 'f', className: 'am-hint-note' }, '左侧优先：进项目先看项目内文件，再退到项目人格；全局人格默认作底座一起注入。'),
      ])

      var globalTab = h(Pill, {
        key: 'g',
        active: scope === 'global',
        onClick: function () { setScope('global') },
      }, '全局人格')

      var projectTab = h(Pill, {
        key: 'p',
        active: scope === 'project',
        onClick: function () { setScope('project') },
      }, '项目人格')

      return h('div', { className: 'am-root' }, [
        // ---- 头部 ----
        h('div', { key: 'head', className: 'am-head' }, [
          h('div', { key: 'lt', className: 'am-head-left' }, [
            h('div', { key: 't', className: 'am-h1' }, '人格 · AGENT.md（dsh-agent-md）'),
            h('div', { key: 's', className: 'am-sub' }, '像 VS Code 那样，用 Markdown 写模型的人格与性格；也可以直接打开原文件改。'),
          ]),
          h('label', { key: 'tg', className: 'am-switch' }, [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: state.enabled === true,
              disabled: busy === 'config',
              onChange: function (e) { doConfig({ enabled: e.target.checked }) },
            }),
            h('span', { key: 'l', className: 'am-switch-label' }, state.enabled ? '已启用' : '已停用'),
          ]),
        ]),

        resolvedBanner,
        state.includeGlobal === false && state.projectPersonaEnabled === false
          ? h('div', { key: 'warn', className: 'am-warn' }, '两个开关都关着（「全局人格一起注入」+「启用项目人格」）——当前不会注入任何人格。在下面打开任意一个即恢复。')
          : null,
        precedence,

        // ---- 编辑器 ----
        h('div', { key: 'editor', className: 'am-editor' }, [
          h('div', { key: 'bar', className: 'am-bar' }, [
            h('div', { key: 'tabs', className: 'am-tabs' }, [globalTab, projectTab]),
            h('div', { key: 'spacer', className: 'am-flex' }),
            h('div', { key: 'stat', className: 'am-stat' }, [
              h('span', { key: 'c', className: 'am-stat-num' }, String(charCount)),
              h('span', { key: 'l', className: 'am-stat-unit' }, ' 字'),
              dirty ? h('span', { key: 'd', className: 'am-dirty' }, '· 未保存') : null,
            ]),
          ]),

          scope === 'project'
            ? h('div', { key: 'psel', className: 'am-ws' }, [
              h('div', { key: 'r1', className: 'am-row' }, [
                h('span', { key: 'l', className: 'am-row-label' }, '工作区'),
                projectOptions.length > 0
                  ? h('select', {
                    key: 's',
                    className: 'am-select',
                    value: projectCwd,
                    onChange: function (e) { setProjectCwd(e.target.value) },
                  }, projectOptions.map(function (w) {
                    var tags = []
                    if (w.exists === true) tags.push('已有人格')
                    else tags.push('空')
                    if (w.sources && w.sources.indexOf('persona') >= 0) tags.push('已登记')
                    return h('option', { key: w.key || w.cwd, value: w.cwd }, (w.displayName || w.cwd) + '（' + tags.join('·') + '） — ' + w.cwd)
                  }))
                  : h('span', { key: 'n', className: 'am-muted' }, '还没发现本机的工作区——下面手填一个目录即可。'),
              ]),
              h('div', { key: 'r2', className: 'am-row' }, [
                h('span', { key: 'l', className: 'am-row-label' }, '任意目录'),
                h('input', {
                  key: 'i',
                  className: 'am-input',
                  value: pathDraft,
                  spellCheck: false,
                  placeholder: '例：D:\\team（也可以点右边用系统选择器挑）',
                  onChange: function (e) { setPathDraft(e.target.value) },
                  onKeyDown: function (e) { if (e.key === 'Enter') usePickedCwd('') },
                }),
                h(ActionButton, { key: 'p', icon: 'folder', onClick: doPick, disabled: busy === 'pick' }, '选择文件夹'),
                h(ActionButton, { key: 'u', onClick: function () { usePickedCwd('') }, disabled: busy === 'pick' }, '使用'),
              ]),
            ])
            : null,

          target !== null && target.path
            ? h('div', { key: 'path', className: 'am-filebar' }, [
              h('span', { key: 'i', className: 'am-filebar-icon' }, h(Icon, { name: 'file' })),
              h('span', { key: 'p', className: 'am-filebar-path', title: target.path }, target.path),
              h('span', { key: 'm', className: 'am-filebar-meta' }, target.exists ? ('上次改动 ' + timeLabel(target.updatedAt)) : '文件尚未创建'),
            ])
            : null,

          !target.exists || target.empty
            ? h('div', { key: 'empty', className: 'am-empty' }, [
              h('div', { key: 't', className: 'am-empty-title' }, target.exists ? '这份人格还是空的' : '这份人格还没创建'),
              h('div', { key: 'd', className: 'am-empty-desc' }, '点「新建」写入一个带结构注释的模板，或直接在下面开始写。'),
              h('div', { key: 'b', className: 'am-actions' }, h(ActionButton, { icon: 'plus', onClick: doCreate, disabled: busy === 'create' }, '新建模板')),
            ])
            : null,

          h('textarea', {
            key: 'ta',
            className: 'am-textarea',
            value: draft,
            spellCheck: false,
            placeholder: '# 你是谁\n\n（例：你是「先生」的专属助手，说话简洁、直接给结论。）\n\n# 语气与风格\n\n- 中文回答，先给结论再给理由\n\n# 行事偏好\n\n- 动手前先确认关键歧义',
            onChange: function (e) {
              setDraft(e.target.value)
              setDirty(true)
            },
          }),

          h('div', { key: 'act', className: 'am-actions' }, [
            h(ActionButton, { key: 's', icon: 'save', primary: true, onClick: doSave, disabled: busy === 'save' || !dirty }, dirty ? '保存' : '已保存'),
            h(ActionButton, { key: 'o', icon: 'folder', onClick: doOpen, disabled: busy === 'open' }, '打开原文件'),
            h(ActionButton, {
              key: 'r',
              icon: 'refresh',
              onClick: function () {
                // 重新载入：以磁盘上的内容为准，顺手把 loadedRef 对齐（否则 draft 不会被重置）
                setBusy('refresh')
                apiGet('/state' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''))
                  .then(function (data) {
                    if (data === null) return null
                    setState(data)
                    if (target.scope === 'global') {
                      var fresh = data.global.content || ''
                      loadedRef.current = { key: 'global', content: fresh }
                      setDraft(fresh)
                      return null
                    }
                    return syncTarget(target.cwd).then(function (detail) {
                      if (detail !== null) {
                        loadedRef.current = { key: target.key, content: detail.content || '' }
                        setDraft(detail.content || '')
                      }
                      return null
                    })
                  })
                  .catch(function (err) { setToast({ kind: 'err', text: '重新载入失败：' + String((err && err.message) || err) }) })
                  .then(function () { setDirty(false); setBusy('') })
              },
              disabled: busy === 'refresh',
            }, '重新载入'),
            h('div', { key: 'f', className: 'am-flex' }),
            target.exists && scope !== 'global'
              ? h(ActionButton, {
                key: 'd',
                icon: 'file',
                title: '把这个项目的人格清空（文件保留，内容清掉）',
                onClick: function () {
                  setBusy('save')
                  apiPost('/save', { scope: target.scope, kind: target.kind, cwd: target.cwd || '', mode: 'revert' })
                    .then(function () {
                      setDraft('')
                      setDirty(false)
                      setToast({ kind: 'ok', text: '已清空这份项目人格。' })
                      return reload({ path: target.cwd || '' })
                    })
                    .catch(function (err) { setToast({ kind: 'err', text: '清空失败：' + String((err && err.message) || err) }) })
                    .then(function () { setBusy('') })
                },
                disabled: busy === 'save',
              }, '清空')
              : null,
          ]),
        ]),

        // ---- 选项 ----
        h('div', { key: 'opts', className: 'am-opts' }, [
          h(ToggleRow, {
            key: 'g',
            label: '全局人格一起注入',
            hint: '关掉后，只在进入有项目人格的项目时才注入（纯项目制）。两个开关都关 = 谁也不注入。',
            checked: state.includeGlobal === true,
            onChange: function (v) { doConfig({ includeGlobal: v }) },
          }),
          h(ToggleRow, {
            key: 'p',
            label: '启用项目人格',
            hint: '关掉后只吃全局人格，项目文件保留但不生效。',
            checked: state.projectPersonaEnabled === true,
            onChange: function (v) { doConfig({ projectPersonaEnabled: v }) },
          }),
          h(ToggleRow, {
            key: 'l',
            label: '优先读取项目内的 AGENT.md',
            hint: '打开后，工作目录里若存在 AGENT.md 就直接用它（可以提交进 git 跟仓库一起走），本机项目人格退居其次。',
            checked: (state.localNames || []).length > 0,
            onChange: function (v) { doConfig({ localNames: v ? ['AGENT.md'] : [] }) },
          }),
        ]),

        // ---- 注入记录（排障用的硬证据：最近一次装配实际注入了什么）----
        h('div', { key: 'inj', className: 'am-log' }, (function () {
          var rows = Array.isArray(state.injectLog) ? state.injectLog : []
          if (rows.length === 0) return '本机还没有记录到人格注入：写一份人格后，任意会话跑一个回合就会出现记录。'
          var last = rows[0]
          var parts = (last.sources || []).map(function (s) { return s.label + ' ' + s.chars + ' 字' })
          return '最近一次注入 · ' + timeLabel(last.at) + ' · ' + String(last.chars) + ' 字 · ' + (last.cwd || '（无工作目录）') + ' · ' + parts.join('，')
        })()),

        h('div', { key: 'foot', className: 'am-foot' }, [
          h('span', { key: 'a', className: 'am-muted' }, '文件位置：'),
          h('code', { key: 'b', className: 'am-code', title: state.baseDir }, state.baseDir),
          h('span', { key: 'c', className: 'am-flex' }),
          h(ActionButton, {
            key: 'd',
            icon: 'folder',
            onClick: function () {
              setBusy('open')
              apiPost('/open', { scope: 'dir' })
                .then(function () { setToast({ kind: 'ok', text: '已打开人格目录。' }) })
                .catch(function (err) { setToast({ kind: 'err', text: String((err && err.message) || err) }) })
                .then(function () { setBusy('') })
            },
          }, '打开目录'),
        ]),

        toast !== null
          ? h('div', { key: 'toast', className: 'am-toast am-toast-' + toast.kind }, toast.text)
          : null,
      ])
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      ".am-root{",
      "--am-fg:var(--dsw-alias-label-primary,#1f1c18);",
      "--am-muted:var(--dsw-alias-label-secondary,#6f6558);",
      "--am-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));",
      "--am-card:var(--dsw-alias-bg-layer-1,#fffdf8);",
      "--am-bar:var(--dsw-alias-bg-layer-2,#f4efe4);",
      "--am-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));",
      "--am-line:var(--dsw-alias-border-l2,#e3daca);",
      "--am-line-soft:var(--dsw-alias-border-l1,#ece5d8);",
      "--am-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));",
      "--am-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#1f1c18));",
      "--am-brand-fg:var(--dsw-alias-label-primary-foreground,#fffdf8);",
      "--am-ok:var(--dsw-alias-state-success-primary,#2f6b46);",
      "--am-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);",
      "--am-err:var(--dsw-alias-state-error-primary,#a83a2c);",
      "--am-err-bg:color-mix(in srgb, var(--am-err) 10%, transparent);",
      "--am-err-line:color-mix(in srgb, var(--am-err) 35%, transparent);",
      "font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif));",
      "color:var(--am-fg);display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;}",
      ".am-head{display:flex;align-items:flex-start;gap:16px;}",
      ".am-head-left{flex:1 1 auto;min-width:0;}",
      ".am-h1{font-size:15px;font-weight:650;letter-spacing:.2px;line-height:1.4;}",
      ".am-sub{font-size:12.5px;color:var(--am-muted);margin-top:4px;line-height:1.6;}",
      ".am-switch{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--am-muted);white-space:nowrap;cursor:pointer;padding-top:2px;}",
      ".am-switch input{accent-color:var(--am-brand);cursor:pointer;}",
      ".am-resolved{background:var(--am-bar);border:1px solid var(--am-line-soft);border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:7px;}",
      ".am-resolved-line{display:flex;gap:10px;font-size:12.5px;line-height:1.5;align-items:baseline;}",
      ".am-resolved-key{color:var(--am-faint);flex:0 0 auto;min-width:88px;}",
      ".am-resolved-val{word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--am-fg);}",
      ".am-val-warn{color:var(--am-warn);}",
      ".am-warn{border:1px solid var(--am-err-line);background:var(--am-err-bg);color:var(--am-err);font-size:12px;border-radius:10px;padding:9px 12px;line-height:1.6;}",
      ".am-log{font-size:11.5px;color:var(--am-faint);line-height:1.6;word-break:break-all;}",
      ".am-ws{display:flex;flex-direction:column;border-bottom:1px solid var(--am-line-soft);}",
      ".am-ws .am-row{border-bottom:0;}",
      ".am-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);}",
      ".am-live{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--am-ok);white-space:nowrap;display:inline-flex;align-items:center;gap:5px;}",
      ".am-live::before{content:\"\";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto;}",
      ".am-live-stale{color:var(--am-warn);}",
      ".am-hint{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;font-size:11.5px;color:var(--am-faint);overflow:hidden;}",
      ".am-hint-step{border:1px solid var(--am-line-soft);border-radius:6px;padding:2px 7px;white-space:nowrap;color:var(--am-muted);}",
      ".am-hint-note{margin-left:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--am-faint);}",
      ".am-arrow{color:var(--am-faint);opacity:.7;}",
      ".am-editor{background:var(--am-card);border:1px solid var(--am-line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;}",
      ".am-bar{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid var(--am-line-soft);background:var(--am-bar);}",
      ".am-tabs{display:flex;gap:4px;}",
      ".am-pill{border:1px solid transparent;background:transparent;color:var(--am-muted);font:inherit;font-size:12.5px;padding:4px 11px;border-radius:7px;cursor:pointer;transition:background-color .15s ease,color .15s ease;}",
      ".am-pill:hover:not(:disabled){background:var(--am-hover);color:var(--am-fg);}",
      ".am-pill-on,.am-pill-on:hover{background:var(--am-brand);border-color:transparent;color:var(--am-brand-fg);font-weight:600;}",
      ".am-stat{font-size:11.5px;color:var(--am-faint);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap;font-variant-numeric:tabular-nums;}",
      ".am-stat-num{color:var(--am-fg);font-weight:600;}",
      ".am-dirty{color:var(--am-warn);}",
      ".am-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--am-line-soft);}",
      ".am-row-label{font-size:12.5px;color:var(--am-faint);flex:0 0 auto;}",
      ".am-select{flex:1 1 auto;min-width:0;max-width:100%;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);}",
      ".am-filebar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--am-line-soft);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;color:var(--am-faint);}",
      ".am-filebar-icon{display:inline-flex;flex:0 0 auto;color:var(--am-faint);}",
      ".am-filebar-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--am-fg);}",
      ".am-filebar-meta{flex:0 0 auto;color:var(--am-faint);}",
      ".am-empty{padding:18px 16px;text-align:center;border-bottom:1px solid var(--am-line-soft);display:flex;flex-direction:column;align-items:center;gap:8px;}",
      ".am-empty-title{font-size:13px;font-weight:600;color:var(--am-fg);}",
      ".am-empty-desc{font-size:12px;color:var(--am-muted);line-height:1.6;}",
      ".am-textarea{width:100%;box-sizing:border-box;min-height:320px;height:44vh;resize:vertical;border:0;border-bottom:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,\"Cascadia Mono\",monospace);font-size:13px;line-height:1.78;padding:14px 15px;tab-size:2;outline:none;}",
      ".am-textarea::placeholder{color:var(--am-faint);opacity:.8;}",
      ".am-actions{display:flex;align-items:center;gap:8px;padding:10px 12px;flex-wrap:nowrap;}",
      ".am-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:5px 11px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-card);color:var(--am-fg);cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease;}",
      ".am-btn:hover:not(:disabled){background:var(--am-hover);border-color:var(--am-line);}",
      ".am-btn:disabled{opacity:.45;cursor:default;}",
      ".am-btn-primary,.am-btn-primary:hover:not(:disabled){background:var(--am-brand);border-color:var(--am-brand);color:var(--am-brand-fg);font-weight:600;}",
      ".am-btn-primary:disabled{opacity:.5;}",
      ".am-flex{flex:1 1 auto;}",
      ".am-opts{background:var(--am-card);border:1px solid var(--am-line);border-radius:12px;padding:4px 13px;}",
      ".am-toggle{display:flex;align-items:flex-start;gap:9px;padding:9px 0;cursor:pointer;border-bottom:1px solid var(--am-line-soft);}",
      ".am-toggle:last-child{border-bottom:0;}",
      ".am-toggle input{margin-top:2px;accent-color:var(--am-brand);cursor:pointer;flex:0 0 auto;}",
      ".am-toggle-body{display:flex;flex-direction:column;gap:3px;min-width:0;}",
      ".am-toggle-title{font-size:12.5px;color:var(--am-fg);}",
      ".am-toggle-hint{font-size:11.5px;color:var(--am-muted);line-height:1.55;}",
      ".am-foot{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--am-faint);padding-top:2px;}",
      ".am-code{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;background:var(--am-bar);border:1px solid var(--am-line-soft);border-radius:6px;padding:2px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%;color:var(--am-muted);}",
      ".am-muted{color:var(--am-muted);}",
      ".am-loading{font-size:12.5px;color:var(--am-muted);padding:20px 0;}",
      ".am-error{color:var(--am-err);background:var(--am-err-bg);border:1px solid var(--am-err-line);font-size:12.5px;border-radius:10px;padding:11px 13px;line-height:1.6;}",
      ".am-toast{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:10px 13px;border-radius:10px;border:1px solid var(--am-line);background:var(--am-bar);color:var(--am-fg);}",
      ".am-toast-ok::before{content:\"\";width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--am-ok);}",
      ".am-toast-err{color:var(--am-err);border-color:var(--am-err-line);background:var(--am-err-bg);}",
      ".am-toast-err::before{content:\"\";width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--am-err);}",
      "@supports not (color:var(--dsw-alias-label-primary)){.am-root{--am-fg:#241f18;--am-muted:#6f6558;--am-faint:#9a9084;--am-card:#fffdf8;--am-bar:#f6f2ea;--am-field:#fbf8f2;--am-line:#e0d7c8;--am-line-soft:#ece5d8;--am-hover:rgba(0,0,0,.05);--am-brand:#241f18;--am-brand-fg:#fffdf8;--am-ok:#2f6b46;--am-warn:#8a6a2f;--am-err:#a83a2c}}",
    ].join('')

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      // 样式随插件生命周期：<style data-dsh-agent-md> 挂上，卸载时摘掉
      ctx.effect(function () {
        var id = 'dsh-agent-md-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-agent-md: styles')

      // 设置页导航项：settings.section = 设置弹层左侧的一级入口
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'agent-md',
          order: 46,
          locale: NS,
          label: function () { return '人格' },
        }, function (props) {
          // 外层套错误边界：设置页崩了也要看得见原因，而不是整块白屏
          var p = props !== null && props !== undefined ? props : {}
          return h(AgentMdErrorBoundary, { sessionId: p.sessionId }, h(AgentMdSection, p))
        })
      })
    }

    module.exports = {
      name: 'agent-md',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
