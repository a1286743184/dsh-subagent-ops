/**
 * subagent-pool-ui —— 浏览器半侧
 *
 * 两个挂载点：
 *   1. sidebar.footer.action（order 0）：脚部按钮，排在 Remote（order -20）右侧；
 *   2. shell.overlay：点按钮弹出的浮层管理面板（不占用会话工作区）。
 *
 * 数据面只有一条路：POST /api/subagent-pool/<verb>，由宿主半侧转给
 * subagent-model-pool 的管理面服务。这里不发号施令，只呈现与转发用户意图。
 */
window.__ModuleLoader__.load({
  // 注册 id 必须是包名，不能是 entry id。
  //
  // client-modules 用「包名」作为启动图 row id（reconcilePackage(packageName)），
  // 而 arrive() 只认 factories.has(包名)。注册成别的名字时它判定
  // "loaded without registering"，于是回退到单资源 URL 把本 bundle 再执行一遍；
  // 第二次注册撞上已存在的 factory，抛
  // `duplicate factory registration (bundle executed twice without invalidate?)`，
  // 整个 web boot 失败，应用起不来。
  //
  // 成熟插件（dshmarket、dsh-better-sidebar、ds-harness-remote、
  // @michengai/dsh-skills-manager、dsh-ops）全部是 id === 包名。
  // 顶层 const 会与同一 combo 脚本里的其他 bundle 撞名，故不在此处声明变量。
  id: 'dsh-subagent-ops',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const reactDom = require('react-dom');

    /** 与上面的注册 id 一致；样式标签也用它，HMR 才能按 row id 回收。 */
    const MODULE_ID = 'dsh-subagent-ops';
    /** locale 命名空间，与包名解耦，改动会影响 profile 里的 slot locale 配置。 */
    const NS = 'subagent-pool-ui';
    const API = '/api/subagent-pool';
    const HEADERS = { 'content-type': 'application/json', 'x-subagent-pool-client': '1' };

    // ---- 文案 ----
    const zh = {
      title: '子代理模型池',
      entry: '子代理模型',
      subtitle: '决定每个子代理用哪个模型、怎么分摊负载。改动只影响之后派发的子代理。',
      refresh: '刷新',
      reload: '重读配置',
      reloadDone: '已重新读取池文件',
      close: '关闭',
      loading: '加载中…',
      failed: '加载失败',
      retry: '重试',
      routes: '模型路由',
      routesHint: '一条路由 = 一个固定模型。新子代理总是派给「占位数 ÷ 权重」最小的那条；负载打平时优先级数字小的先派。',
      addRoute: '新增路由',
      addRouteTitle: '新增模型路由',
      editRouteTitle: '编辑路由',
      colId: 'ID',
      colProvider: '渠道',
      colModel: '模型',
      colEffort: '思考档',
      colWeight: '权重',
      colPriority: '优先级',
      tipWeight: '权重 = 这条路由的分量，决定它该分到多少个子代理。填 1 是标准；填 4 表示这条路由同时跑 4 个子代理，才和别的路由跑 1 个一样沉。系统每次派发都选「当前占位数 ÷ 权重」最小的那条，所以权重越大分到的越多。它是容量比例，不是上限：没有别的路由可选时，这条照样会被继续派。',
      tipPriority: '优先级只在负载打平时决定先后，数字小的先派。它不压过权重：负载不同时，永远是负载小的先上。所有路由都留空（等于 0）时不分先后，按「最久没被派过」轮流来，也就是池文件里的顺序轮转。想让某条路由「优先用，忙了才换下一条」，把它的权重设成和别人一样、优先级设得比别人小。',
      colLoad: '占位 子/主/其他',
      colState: '状态',
      colActions: '操作',
      stateOk: '可用',
      stateDisabled: '已停用',
      stateManual: '人工禁用',
      stateCooling: '冷却中',
      edit: '编辑',
      remove: '删除',
      disable: '禁用',
      enable: '启用',
      cancel: '取消',
      save: '保存',
      applying: '保存中…',
      saved: '已保存',
      fieldId: '路由 ID（可自定义；留空按渠道/模型生成）',
      fieldProvider: '供应商',
      fieldModel: '模型',
      fieldWeight: '权重',
      fieldPriority: '优先级',
      fieldPriorityHint: '负载打平时数字小的先派；全都一样就轮流来。不改就是 0。',
      fieldEffort: '思考档（模型自动决定可选值）',
      confirmRemove: '确定删除路由 {id}？正在使用它的子代理会保持原路由直到结束。',
      settings: '全局参数',
      settingsHint: '粘滞、计负载口径、卡死判定、冷却与切换次数。改完保存即生效。',
      agents: '当前占用',
      agentsHint: '占位 = 此刻计入负载；卡死 = 在跑但会话久不推进，已停止占位。',
      agentNone: '当前没有子代理绑定到池内路由。',
      agentSettled: '已结算',
      agentHolding: '占位',
      agentIdle: '空闲未占位',
      agentStale: '卡死',
      bindings: '粘滞绑定',
      bindingsHint: '同一会话再次唤醒时沿用上次模型，保住已缓存的 KV 前缀。',
      bindingsCount: '共 {count} 条',
      clearBindings: '清空全部',
      pruneBindings: '清理失效',
      bindingsCleared: '已清空 {count} 条粘滞绑定',
      bindingsPruned: '清理完成，剩余 {count} 条',
      emptyRoutes: '池里还没有任何路由，子代理会继承父 Agent 的模型。',
      emptyBindings: '还没有粘滞绑定。',
      files: '文件位置',
      providerUnknown: '（渠道未注册）',
      catalogLoading: '正在读取上游模型能力…',
      catalogError: '上游模型清单读取失败',
      catalogNoProviders: '未发现可用供应商；请检查模型配置。',
      catalogChooseProvider: '请先选择供应商',
      catalogNoModels: '该供应商未提供可选模型',
      catalogEmptyEffort: '不设置（沿用默认）',
      catalogDefaultEffort: '默认档',
      catalogCapability: '能力',
      catalogContext: '上下文',
      catalogMaxTokens: '最大输出',
      catalogInput: '输入',
      catalogEfforts: '思考档',
      catalogSource: '来源',
      catalogEffortSource: '思考档来源',
      catalogAutoHint: '供应商、模型和思考档均来自已配置的上游能力，无需手输。',
      catalogModelCount: '个模型',
      catalogIdAuto: '留空自动生成；已按上游配置预填',
      catalogWeight: '权重',
      weightHint: '这条路由同时跑 {n} 个子代理，才和别的路由跑 1 个一样沉。',
      priorityDefault: '默认',
      catalogCustom: '（现有值，未在上游清单中）',
      catalogStaleEffort: '当前档位不在上游允许的清单里，调用会被宿主拒绝，建议改成下面的可选值。',
      catalogNoEffort: '上游报告该模型不支持思考档，将不发送 reasoningEffort。',
      catalogRefresh: '刷新上游能力',
      catalogRefreshing: '刷新中…',
      catalogMeta: '上游能力：{state}',
      catalogMetaToday: '今日已缓存（{time}）',
      catalogMetaStale: '缓存已过期（{day}）',
      catalogMetaLive: '刚刚拉取',
      catalogRefreshDone: '已刷新上游能力',
      catalogRefreshProvider: '刷新该供应商',
      catalogStaleNotice: '上游刷新失败（{error}），当前显示的是 {day} 的缓存。',
      fieldScope: '作用范围',
      scopeAll: '所有子代理（含 workflow）',
      scopeTeam: '仅团队成员',
      errorPrefix: '操作失败：',
      silentSuffix: ' 秒前推进',
      disableHint: '禁用时长',
      minutes: '分钟',
      forever: '一直禁用',
    };
    const en = {
      title: 'Subagent model pool',
      entry: 'Subagent models',
      subtitle: 'Which model each subagent gets, and how load spreads. Changes affect only dispatches made afterwards.',
      refresh: 'Refresh',
      reload: 'Reload file',
      reloadDone: 'Pool file reloaded',
      close: 'Close',
      loading: 'Loading…',
      failed: 'Failed to load',
      retry: 'Retry',
      routes: 'Model routes',
      routesHint: 'One route is one fixed model. Each dispatch goes to the smallest "slots / weight"; ties go to the lower priority.',
      addRoute: 'Add route',
      addRouteTitle: 'Add model route',
      editRouteTitle: 'Edit route',
      colId: 'ID',
      colProvider: 'Provider',
      colModel: 'Model',
      colEffort: 'Effort',
      colWeight: 'Weight',
      colPriority: 'Priority',
      tipWeight: 'Weight is this route\'s share of the pool. 1 is standard; 4 means four subagents running here count as heavy as one elsewhere. Every dispatch picks the smallest "slots / weight", so a bigger weight attracts more work. It is a ratio, not a cap: if no other route is available, this one keeps taking work.',
      tipPriority: 'Priority only breaks ties between equal loads; the lower number goes first. It never overrides weight: a lighter route always wins. Leave every route at 0 and order becomes pure rotation, oldest-assigned first, i.e. pool file order. To get "use A first, B only when A is busy", give both the same weight and A a smaller priority.',
      colLoad: 'Slots sub/lead/other',
      colState: 'State',
      colActions: 'Actions',
      stateOk: 'ok',
      stateDisabled: 'disabled',
      stateManual: 'manually off',
      stateCooling: 'cooling',
      edit: 'Edit',
      remove: 'Delete',
      disable: 'Disable',
      enable: 'Enable',
      cancel: 'Cancel',
      save: 'Save',
      applying: 'Saving…',
      saved: 'Saved',
      fieldId: 'Route id (custom; empty derives from provider/model)',
      fieldProvider: 'Provider',
      fieldModel: 'Model',
      fieldWeight: 'Weight',
      fieldPriority: 'Priority',
      fieldPriorityHint: 'Compared only when loads tie; lower goes first. All equal means plain rotation. 0 unless changed.',
      fieldEffort: 'Reasoning effort (from model capabilities)',
      confirmRemove: 'Delete route {id}? Subagents already using it keep it until they finish.',
      settings: 'Global settings',
      settingsHint: 'Stickiness, slot counting, stall detection, cooldown and switch budget. Saving applies immediately.',
      agents: 'Current occupancy',
      agentsHint: 'Slots count live load; stalled means running but not advancing, so it no longer holds a slot.',
      agentNone: 'No subagent is bound to a pool route right now.',
      agentSettled: 'settled',
      agentHolding: 'holding',
      agentIdle: 'idle, not holding',
      agentStale: 'stalled',
      bindings: 'Sticky bindings',
      bindingsHint: 'A woken session reuses its last model to keep the cached KV prefix.',
      bindingsCount: '{count} total',
      clearBindings: 'Clear all',
      pruneBindings: 'Prune stale',
      bindingsCleared: 'Cleared {count} sticky bindings',
      bindingsPruned: 'Pruned, {count} remaining',
      emptyRoutes: 'No route in the pool yet; subagents inherit the parent model.',
      emptyBindings: 'No sticky binding yet.',
      files: 'Files',
      providerUnknown: '(provider not registered)',
      catalogLoading: 'Loading upstream model capabilities…',
      catalogError: 'Failed to load upstream model catalog',
      catalogNoProviders: 'No usable provider found; check model configuration.',
      catalogChooseProvider: 'Select a provider first',
      catalogNoModels: 'This provider advertises no selectable models',
      catalogEmptyEffort: 'Unset (use default)',
      catalogDefaultEffort: 'default',
      catalogCapability: 'Capabilities',
      catalogContext: 'Context',
      catalogMaxTokens: 'Max output',
      catalogInput: 'Input',
      catalogEfforts: 'Efforts',
      catalogSource: 'Source',
      catalogEffortSource: 'Effort source',
      catalogAutoHint: 'Providers, models and reasoning efforts come from the configured upstream catalog.',
      catalogModelCount: 'models',
      catalogIdAuto: 'Optional; prefilled from the upstream catalog',
      catalogWeight: 'Weight',
      weightHint: 'Running {n} subagents here is as heavy as running 1 elsewhere.',
      priorityDefault: 'default',
      catalogCustom: '(current value, not in catalog)',
      catalogStaleEffort: 'This level is not in the upstream allowed list; the host would reject the call. Pick one below.',
      catalogNoEffort: 'Upstream reports no reasoning levels for this model; no reasoningEffort will be sent.',
      catalogRefresh: 'Refresh catalog',
      catalogRefreshing: 'Refreshing…',
      catalogMeta: 'Upstream catalog: {state}',
      catalogMetaToday: 'cached today ({time})',
      catalogMetaStale: 'stale cache ({day})',
      catalogMetaLive: 'fetched just now',
      catalogRefreshDone: 'Upstream catalog refreshed',
      catalogRefreshProvider: 'Refresh provider',
      catalogStaleNotice: 'Refresh failed ({error}); showing the cache from {day}.',
      fieldScope: 'Scope',
      scopeAll: 'All subagents (including workflow)',
      scopeTeam: 'Team members only',
      errorPrefix: 'Failed: ',
      silentSuffix: 's since last advance',
      disableHint: 'Disable for',
      minutes: 'minutes',
      forever: 'until enabled',
    };

    // ---- 样式 ----
    const CSS = `
/* 遮罩必须是视口级：挂到 document.body 的 portal 上，position:fixed 才以视口为准。
   顶部避开窗口标题栏（菜单 + 最小化/最大化/关闭），其余三边贴到窗口边缘。 */
.spu-backdrop{position:fixed;top:var(--dsh-frame-top-clearance,0px);right:0;bottom:0;left:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:16px 20px;background:rgba(0,0,0,.38)}
.spu-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(1120px,100%);max-height:100%;border-radius:16px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-family:inherit;box-shadow:0 24px 72px rgba(0,0,0,.36);overflow:hidden}
.spu-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none}
.spu-headtext{min-width:0;flex:1}
.spu-title{margin:0;font-size:16px;line-height:24px;font-weight:650}
.spu-sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.spu-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.spu-body{flex:1;min-height:0;overflow:auto;padding:16px 18px 20px;display:flex;flex-direction:column;gap:14px}
.spu-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;transition:border-color 120ms ease,background 120ms ease}
.spu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.spu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.spu-btn:disabled{opacity:.5;cursor:default}
.spu-btn.is-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.spu-btn.is-danger{color:var(--dsw-alias-state-error-primary)}
.spu-btn.is-icon{width:28px;padding:0}
.spu-card{box-sizing:border-box;display:flex;flex-direction:column;min-width:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;flex:none}
.spu-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.spu-card-title{font-size:13px;font-weight:650}
.spu-card-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:1;min-width:160px}
.spu-card-body{padding:10px 12px}
.spu-table-wrap{width:100%;overflow-x:auto}
.spu-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.spu-table th{position:sticky;top:0;padding:7px 9px;text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:0.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.spu-table td{padding:8px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l1);vertical-align:middle}
.spu-table tr:last-child td{border-bottom:0}
.spu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.spu-dim{color:var(--dsw-alias-label-tertiary)}
.spu-num{text-align:right;font-variant-numeric:tabular-nums}
.spu-badge{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 7px;border-radius:999px;font-size:11px;line-height:19px;white-space:nowrap;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.spu-badge.is-ok{color:var(--dsw-alias-state-success-primary)}
.spu-badge.is-warn{color:var(--dsw-alias-state-warn-primary)}
.spu-badge.is-error{color:var(--dsw-alias-state-error-primary)}
.spu-row-actions{display:flex;align-items:center;gap:5px;flex-wrap:nowrap}
.spu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px}
.spu-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.spu-label{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.spu-input{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.spu-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0;border-color:transparent}
.spu-check{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.spu-check input{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}
.spu-empty{padding:16px 4px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.spu-error{margin:0;padding:8px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.spu-notice{margin:0;padding:8px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.spu-entry{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:36px;margin:0;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;cursor:pointer;width:100%;min-width:0;text-align:left}
.spu-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.spu-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.spu-entry.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}
.spu-entry-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spu-entry.is-icon{width:36px;justify-content:center;padding:0;border-radius:50%}
.spu-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 12px;font-size:11px;line-height:17px;margin:0}
.spu-kv dt{color:var(--dsw-alias-label-tertiary);margin:0}
.spu-kv dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.spu-section-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.spu-inline{display:flex;align-items:center;gap:6px;font-size:12px}
.spu-inline .spu-input{width:88px}
.spu-select{box-sizing:border-box;width:100%;height:32px;padding:0 30px 0 9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 15px) 13px,calc(100% - 10px) 13px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.spu-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0;border-color:transparent}
.spu-select:disabled{opacity:.55;cursor:default}
.spu-hint{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.spu-tip{display:inline-flex;align-items:center;gap:4px;cursor:help;border-bottom:1px dotted var(--dsw-alias-border-l3);padding-bottom:1px;outline:none;white-space:nowrap}
.spu-tip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:3px}
.spu-tip-mark{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l3);font-size:9px;line-height:1;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.spu-tip-pop{position:fixed;z-index:90;box-sizing:border-box;max-width:320px;padding:8px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;line-height:17px;font-weight:400;white-space:normal;text-align:left;box-shadow:0 10px 28px rgba(0,0,0,.3);pointer-events:none}
.spu-capability{margin:0;padding:9px 11px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.spu-capability dt{display:inline;color:var(--dsw-alias-label-tertiary);margin:0 5px 0 0}
.spu-capability dd{display:inline;margin:0 14px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word}
`;
    function installStyle() {
      // 已注入过就不再追加：HMR 或重复 apply 时避免同一份 CSS 叠多份。
      // 判据用 data-plugin-css（每份 CSS 的稳定身份），与成熟插件一致。
      const tagId = `${MODULE_ID}/ui.css`;
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
      if (existing !== null) return () => existing.remove();

      const style = document.createElement('style');
      // data-plugin 必须等于启动图 row id（包名）：client-modules 的
      // claimStyles/removeOwnedStyles 按 row id 打标与回收。
      style.dataset.plugin = MODULE_ID;
      // data-plugin-css 标记这一份 CSS 的身份，一个包里多份 CSS 才能分别追踪。
      style.dataset.pluginCss = tagId;
      style.textContent = CSS;
      document.head.append(style);
      return () => style.remove();
    }

    // ---- 数据面 ----
    /**
     * 调宿主 API。成功返回 data，失败抛出带可读消息的 Error，交给调用方展示。
     * 读用 GET（只读动词），写用 POST + JSON + 客户端标记头。
     */
    async function call(verb, body) {
      const readOnly = verb === 'snapshot' || verb === 'describe' || verb === 'catalog';
      const options = readOnly
        ? { method: 'GET' }
        : { method: 'POST', headers: HEADERS, body: JSON.stringify(body ?? {}) };
      let response;
      try {
        response = await fetch(`${API}/${verb}`, options);
      } catch (caught) {
        throw new Error(`网络请求失败：${String(caught && caught.message ? caught.message : caught)}`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch (caught) {
        throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error(String((payload && payload.error) || `HTTP ${response.status}`));
      }
      return payload.data;
    }

    /** 把渲染异常送回宿主落盘；失败也不影响界面表现。 */
    function reportError(message, stack) {
      try {
        void fetch(`${API}/client.error`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ message, stack }),
        }).catch(() => {});
      } catch {
        /* 忽略 */
      }
    }

    /** 错误边界：面板内部任何渲染异常都在界面上显示出来，而不是留下一片空白。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        reportError(
          String((error && error.message) || error),
          `${(error && error.stack) || ''}\n--- component stack ---\n${(info && info.componentStack) || ''}`,
        );
      }
      render() {
        if (this.state.error !== null) {
          const message = String((this.state.error && this.state.error.message) || this.state.error);
          return jsx.jsxs('div', {
            className: 'spu-body',
            children: [
              jsx.jsx('p', { className: 'spu-error', children: `${this.props.failed}: ${message}` }),
              this.props.errorHint
                ? jsx.jsx('p', { className: 'spu-sub', children: this.props.errorHint })
                : null,
            ],
          });
        }
        return this.props.children;
      }
    }

    const formatSeconds = (ms) => (typeof ms === 'number' && ms >= 0 ? String(Math.round(ms / 1000)) : '—');
    const fill = (template, key, value) => String(template).split(`{${key}}`).join(String(value));

    const badgeClass = (route) => {
      if (route.manualDisabled) return 'is-error';
      if (route.enabled === false) return 'is-warn';
      if (route.cooldownUntil !== null) return 'is-warn';
      return 'is-ok';
    };
    const routeStateLabel = (route, t) => {
      if (route.manualDisabled) return t.stateManual;
      if (route.enabled === false) return t.stateDisabled;
      if (route.cooldownUntil !== null) return t.stateCooling;
      return t.stateOk;
    };

    const NUMERIC_SETTINGS = [
      'staleSubagentMs',
      'watchIntervalMs',
      'cooldownMs',
      'maxSwitches',
      'bindingTtlMs',
      'leaseTtlMs',
      'leaseRenewMs',
    ];
    const BOOLEAN_SETTINGS = [
      'sticky',
      'countLead',
      'countLeadWhenIdle',
      'idleSubagentHoldsSlot',
    ];
    const SCOPE_OPTIONS = ['all-subagents', 'team'];
    const fmtTokens = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      return number >= 10000 ? `${Math.round(number / 1000)}K` : String(number);
    };
    /** 把 catalog 的缓存状态翻成一句人话：过期 > 今日缓存 > 刚拉。 */
    const catalogMetaText = (catalog, t) => {
      if (catalog === null) return '';
      const time = catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleTimeString() : '—';
      const state = catalog.stale
        ? fill(t.catalogMetaStale, 'day', catalog.cacheDay ?? catalog.day ?? '—')
        : catalog.cached
          ? fill(t.catalogMetaToday, 'time', time)
          : t.catalogMetaLive;
      return fill(t.catalogMeta, 'state', state);
    };
    const findProvider = (catalog, id) => (catalog?.providers ?? []).find((item) => item.id === id);
    const findModel = (provider, id) => (provider?.models ?? []).find((item) => item.id === id);
    const modelLabel = (model) =>
      model === undefined ? '' : model.name === model.id ? model.id : `${model.name} · ${model.id}`;

    // ---- 弹窗里的主体 ----
    function PanelContent(props) {
      const { t } = props;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [editing, setEditing] = React.useState(null);
      const [draftSettings, setDraftSettings] = React.useState(null);
      const [disableMinutes, setDisableMinutes] = React.useState('');
      const [catalog, setCatalog] = React.useState(null);
      const [catalogError, setCatalogError] = React.useState(null);
      const [catalogBusy, setCatalogBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const next = await call('snapshot');
          setData(next);
          setError(null);
          setDraftSettings((current) => current || next.settings);
        } catch (caught) {
          setError(String((caught && caught.message) || caught));
        }
      }, []);

      const loadCatalog = React.useCallback(async () => {
        try {
          const next = await call('catalog');
          setCatalog(next);
          setCatalogError(null);
        } catch (caught) {
          setCatalogError(String((caught && caught.message) || caught));
        }
      }, []);

      /** 手动刷新上游能力：不带 provider 全量重拉，带 provider 只重拉一家。 */
      const refreshCatalog = React.useCallback(
        async (provider) => {
          setCatalogBusy(true);
          try {
            const next = await call('catalog.refresh', provider === undefined ? {} : { provider });
            setCatalog(next);
            setCatalogError(null);
            setNotice(provider === undefined ? t.catalogRefreshDone : `${t.catalogRefreshDone}（${provider}）`);
          } catch (caught) {
            setCatalogError(String((caught && caught.message) || caught));
          } finally {
            setCatalogBusy(false);
          }
        },
        [t],
      );

      React.useEffect(() => {
        let live = true;
        void load();
        void loadCatalog();
        const timer = window.setInterval(() => {
          if (live && !document.hidden) void load();
        }, 5000);
        return () => {
          live = false;
          window.clearInterval(timer);
        };
      }, [load, loadCatalog]);

      const run = async (task) => {
        setBusy(true);
        setNotice(null);
        try {
          const message = await task();
          await load();
          void loadCatalog();
          setNotice(message || t.saved);
        } catch (caught) {
          setError(`${t.errorPrefix}${String((caught && caught.message) || caught)}`);
        } finally {
          setBusy(false);
        }
      };

      if (data === null) {
        return jsx.jsxs('div', {
          className: 'spu-body',
          children: [
            error === null
              ? jsx.jsx('div', { className: 'spu-empty', children: catalog === null ? t.catalogLoading : t.loading })
              : jsx.jsxs('div', {
                  className: 'spu-empty',
                  children: [
                    jsx.jsx('p', { className: 'spu-error', children: `${t.failed}：${error}` }),
                    jsx.jsx('button', {
                      type: 'button',
                      className: 'spu-btn',
                      style: { marginTop: '10px' },
                      onClick: () => void load(),
                      children: t.retry,
                    }),
                  ],
                }),
          ],
        });
      }

      const routes = data.routes || [];
      const agents = data.agents || [];
      const bindings = data.bindings || [];
      const providers =
        catalog === null
          ? data.providers || []
          : (catalog.providers || []).map((provider) => ({
              id: provider.id,
              name: provider.name,
              modelCount: (provider.models || []).length,
            }));
      const knownProviders = new Set(providers.map((provider) => provider.id));
      const settings = data.settings || {};
      const draft = draftSettings || settings;
      const minutesNumber = Number(disableMinutes);
      const disablePayload = disableMinutes.trim() === '' || !Number.isFinite(minutesNumber) || minutesNumber <= 0 ? undefined : minutesNumber;

      const routeRows = routes.map((route) =>
        jsx.jsxs(
          'tr',
          {
            children: [
              jsx.jsx('td', { className: 'spu-mono', children: route.id }),
              jsx.jsxs('td', {
                children: [
                  (providers.find((provider) => provider.id === route.provider) || {}).name || route.provider,
                  knownProviders.has(route.provider)
                    ? null
                    : jsx.jsx('span', { className: 'spu-dim', children: ` ${t.providerUnknown}` }),
                ],
              }),
              jsx.jsx('td', {
                className: 'spu-mono',
                title: route.model,
                children:
                  modelLabel(findModel(findProvider(catalog, route.provider), route.model)) || route.model,
              }),
              jsx.jsx('td', {
                children:
                  route.reasoningEffort === null
                    ? '—'
                    : (findModel(findProvider(catalog, route.provider), route.model)?.reasoningEfforts || []).find(
                        (effort) => effort.id === route.reasoningEffort,
                      )?.name || route.reasoningEffort,
              }),
              jsx.jsx('td', {
                className: 'spu-num',
                title: fill(t.weightHint, 'n', route.weight),
                children: route.weight,
              }),
              jsx.jsx('td', {
                className: 'spu-num',
                title: t.tipPriority,
                children: route.priority === undefined || route.priority === null ? 0 : route.priority,
              }),
              jsx.jsx('td', {
                className: 'spu-num',
                children: `${route.subagents} / ${route.leads} / ${route.external}`,
              }),
              jsx.jsx('td', {
                children: jsx.jsx('span', {
                  className: `spu-badge ${badgeClass(route)}`,
                  children: routeStateLabel(route, t),
                }),
              }),
              jsx.jsxs('td', {
                children: jsx.jsxs('div', {
                  className: 'spu-row-actions',
                  children: [
                    jsx.jsx('button', {
                      type: 'button',
                      className: 'spu-btn',
                      disabled: busy,
                      onClick: () => setEditing({ mode: 'edit', route }),
                      children: t.edit,
                    }),
                    jsx.jsx('button', {
                      type: 'button',
                      className: 'spu-btn',
                      disabled: busy,
                      onClick: () =>
                        void run(async () => {
                          if (route.manualDisabled) {
                            await call('route.enable', { id: route.id });
                            return `已启用 ${route.id}`;
                          }
                          await call('route.disable', { id: route.id, minutes: disablePayload });
                          return `已禁用 ${route.id}`;
                        }),
                      children: route.manualDisabled ? t.enable : t.disable,
                    }),
                    jsx.jsx('button', {
                      type: 'button',
                      className: 'spu-btn is-danger',
                      disabled: busy,
                      onClick: () => {
                        if (!window.confirm(fill(t.confirmRemove, 'id', route.id))) return;
                        void run(async () => {
                          await call('route.remove', { id: route.id });
                          return `已删除 ${route.id}`;
                        });
                      },
                      children: t.remove,
                    }),
                  ],
                }),
              }),
            ],
          },
          route.id,
        ),
      );

      const agentItems =
        agents.length === 0
          ? [jsx.jsx('div', { className: 'spu-empty', children: t.agentNone }, 'none')]
          : agents.map((agent) => {
              const label =
                agent.status === 'holding'
                  ? t.agentHolding
                  : agent.status === 'stale'
                    ? t.agentStale
                    : agent.status === 'settled'
                      ? t.agentSettled
                      : t.agentIdle;
              return jsx.jsxs(
                'div',
                {
                  className: 'spu-check',
                  style: { justifyContent: 'space-between', gap: '12px' },
                  children: [
                    jsx.jsx('span', {
                      className: 'spu-mono',
                      children: `${agent.id.slice(0, 8)} → ${agent.routeId}`,
                    }),
                    jsx.jsxs('span', {
                      className: 'spu-dim',
                      children: [
                        label,
                        agent.silentForMs === null ? '' : ` · ${formatSeconds(agent.silentForMs)}${t.silentSuffix}`,
                      ],
                    }),
                  ],
                },
                agent.id,
              );
            });

      const bindingItems =
        bindings.length === 0
          ? [jsx.jsx('div', { className: 'spu-empty', children: t.emptyBindings }, 'none')]
          : bindings
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 60)
              .map((binding) =>
                jsx.jsxs(
                  'div',
                  {
                    className: 'spu-check',
                    style: { justifyContent: 'space-between', gap: '12px' },
                    children: [
                      jsx.jsx('span', { className: 'spu-mono', children: binding.sessionId.slice(0, 8) }),
                      jsx.jsx('span', { className: 'spu-dim', children: binding.routeId }),
                    ],
                  },
                  binding.sessionId,
                ),
              );

      const settingFields = [];
      for (const key of BOOLEAN_SETTINGS) {
        settingFields.push(
          jsx.jsxs(
            'label',
            {
              className: 'spu-field',
              children: [
                jsx.jsx('span', {
                  className: 'spu-label',
                  children: key,
                }),
                jsx.jsxs('span', {
                  className: 'spu-check',
                  children: [
                    jsx.jsx('input', {
                      type: 'checkbox',
                      checked: draft[key] === true,
                      onChange: (event) => setDraftSettings({ ...draft, [key]: event.target.checked }),
                    }),
                    jsx.jsx('span', { className: 'spu-dim', children: String(draft[key]) }),
                  ],
                }),
              ],
            },
            key,
          ),
        );
      }
      settingFields.push(
        jsx.jsxs(
          'label',
          {
            className: 'spu-field',
            children: [
              jsx.jsx('span', { className: 'spu-label', children: t.fieldScope }),
              jsx.jsx('select', {
                className: 'spu-select',
                value: draft.scope || 'all-subagents',
                onChange: (event) => setDraftSettings({ ...draft, scope: event.target.value }),
                children: SCOPE_OPTIONS.map((scope) =>
                  jsx.jsx(
                    'option',
                    { value: scope, children: scope === 'all-subagents' ? t.scopeAll : t.scopeTeam },
                    scope,
                  ),
                ),
              }),
            ],
          },
          'scope',
        ),
      );
      for (const key of NUMERIC_SETTINGS) {
        settingFields.push(
          jsx.jsxs(
            'label',
            {
              className: 'spu-field',
              children: [
                jsx.jsx('span', { className: 'spu-label', children: key }),
                jsx.jsx('input', {
                  className: 'spu-input',
                  type: 'number',
                  min: 0,
                  value: String(draft[key] === undefined ? '' : draft[key]),
                  onChange: (event) =>
                    setDraftSettings({
                      ...draft,
                      [key]: event.target.value === '' ? 0 : Number(event.target.value),
                    }),
                }),
              ],
            },
            key,
          ),
        );
      }

      return jsx.jsxs('div', {
        className: 'spu-body',
        children: [
          error === null ? null : jsx.jsx('p', { className: 'spu-error', children: error }),
          catalogError === null
            ? null
            : jsx.jsxs('p', {
                className: 'spu-error',
                children: [
                  `${t.catalogError}：${catalogError}`,
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn',
                    style: { marginLeft: '8px' },
                    onClick: () => void loadCatalog(),
                    children: t.retry,
                  }),
                ],
              }),
          catalog !== null && catalog.stale === true
            ? jsx.jsx('p', {
                className: 'spu-error',
                children: fill(
                  fill(t.catalogStaleNotice, 'error', catalog.refreshError || '—'),
                  'day',
                  catalog.cacheDay ?? catalog.day ?? '—',
                ),
              })
            : null,
          catalog !== null && (catalog.providers || []).every((provider) => (provider.models || []).length === 0)
            ? jsx.jsx('p', { className: 'spu-error', children: t.catalogNoProviders })
            : null,
          notice === null ? null : jsx.jsx('p', { className: 'spu-notice', children: notice }),
          jsx.jsxs('section', {
            className: 'spu-card',
            children: [
              jsx.jsxs('div', {
                className: 'spu-card-head',
                children: [
                  jsx.jsx('span', { className: 'spu-card-title', children: t.routes }),
                  jsx.jsx('p', { className: 'spu-card-hint', children: t.routesHint }),
                  jsx.jsxs('span', {
                    className: 'spu-inline',
                    children: [
                      jsx.jsx('span', { className: 'spu-label', children: t.disableHint }),
                      jsx.jsx('input', {
                        className: 'spu-input',
                        type: 'number',
                        min: 1,
                        placeholder: t.forever,
                        value: disableMinutes,
                        onChange: (event) => setDisableMinutes(event.target.value),
                      }),
                      jsx.jsx('span', { className: 'spu-label', children: t.minutes }),
                    ],
                  }),
                  jsx.jsx('span', { className: 'spu-label', children: catalogMetaText(catalog, t) }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn',
                    disabled: busy || catalogBusy,
                    onClick: () => void refreshCatalog(undefined),
                    children: catalogBusy ? t.catalogRefreshing : t.catalogRefresh,
                  }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn is-primary',
                    disabled: busy || catalog === null,
                    onClick: () => setEditing({ mode: 'add', route: null }),
                    children: t.addRoute,
                  }),
                ],
              }),
              routes.length === 0
                ? jsx.jsx('div', { className: 'spu-empty', children: t.emptyRoutes })
                : jsx.jsx('div', {
                    className: 'spu-table-wrap',
                    children: jsx.jsxs('table', {
                      className: 'spu-table',
                      children: [
                        jsx.jsx('thead', {
                          children: jsx.jsxs('tr', {
                            children: [
                              jsx.jsx('th', { children: t.colId }),
                              jsx.jsx('th', { children: t.colProvider }),
                              jsx.jsx('th', { children: t.colModel }),
                              jsx.jsx('th', { children: t.colEffort }),
                              jsx.jsx('th', {
                                className: 'spu-num',
                                children: jsx.jsx(HoverTip, { text: t.tipWeight, children: t.colWeight }),
                              }),
                              jsx.jsx('th', {
                                className: 'spu-num',
                                children: jsx.jsx(HoverTip, { text: t.tipPriority, children: t.colPriority }),
                              }),
                              jsx.jsx('th', { className: 'spu-num', children: t.colLoad }),
                              jsx.jsx('th', { children: t.colState }),
                              jsx.jsx('th', { children: t.colActions }),
                            ],
                          }),
                        }),
                        jsx.jsx('tbody', { children: routeRows }),
                      ],
                    }),
                  }),
            ],
          }),
          jsx.jsxs('section', {
            className: 'spu-card',
            children: [
              jsx.jsxs('div', {
                className: 'spu-card-head',
                children: [
                  jsx.jsx('span', { className: 'spu-card-title', children: t.settings }),
                  jsx.jsx('p', { className: 'spu-card-hint', children: t.settingsHint }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn is-primary',
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        const patch = {};
                        for (const key of BOOLEAN_SETTINGS) patch[key] = draft[key];
                        for (const key of NUMERIC_SETTINGS) patch[key] = draft[key];
                        patch.scope = draft.scope || 'all-subagents';
                        await call('settings.patch', { patch });
                        return t.saved;
                      }),
                    children: busy ? t.applying : t.save,
                  }),
                ],
              }),
              jsx.jsx('div', {
                className: 'spu-card-body',
                children: jsx.jsx('div', { className: 'spu-grid', children: settingFields }),
              }),
            ],
          }),
          jsx.jsxs('section', {
            className: 'spu-card',
            children: [
              jsx.jsxs('div', {
                className: 'spu-card-head',
                children: [
                  jsx.jsx('span', { className: 'spu-card-title', children: t.agents }),
                  jsx.jsx('p', { className: 'spu-card-hint', children: t.agentsHint }),
                ],
              }),
              jsx.jsx('div', { className: 'spu-card-body', children: agentItems }),
            ],
          }),
          jsx.jsxs('section', {
            className: 'spu-card',
            children: [
              jsx.jsxs('div', {
                className: 'spu-card-head',
                children: [
                  jsx.jsx('span', { className: 'spu-card-title', children: t.bindings }),
                  jsx.jsx('p', {
                    className: 'spu-card-hint',
                    children: `${t.bindingsHint} · ${fill(t.bindingsCount, 'count', bindings.length)}`,
                  }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn',
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        const result = await call('bindings.prune');
                        return fill(t.bindingsPruned, 'count', result.after);
                      }),
                    children: t.pruneBindings,
                  }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn is-danger',
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        const result = await call('bindings.clear');
                        return fill(t.bindingsCleared, 'count', result.removed);
                      }),
                    children: t.clearBindings,
                  }),
                ],
              }),
              jsx.jsx('div', { className: 'spu-card-body', children: bindingItems }),
            ],
          }),
          jsx.jsxs('section', {
            className: 'spu-card',
            children: [
              jsx.jsx('div', {
                className: 'spu-card-head',
                children: jsx.jsx('span', { className: 'spu-card-title', children: t.files }),
              }),
              jsx.jsx('div', {
                className: 'spu-card-body',
                children: jsx.jsxs('dl', {
                  className: 'spu-kv',
                  children: [
                    jsx.jsx('dt', { children: 'pool' }),
                    jsx.jsx('dd', { title: data.poolFile, children: data.poolFile }),
                    jsx.jsx('dt', { children: 'state' }),
                    jsx.jsx('dd', { title: data.stateFile, children: data.stateFile }),
                    jsx.jsx('dt', { children: 'shared' }),
                    jsx.jsx('dd', { title: data.sharedFile, children: data.sharedFile }),
                  ],
                }),
              }),
            ],
          }),
          editing === null
            ? null
            : jsx.jsx(RouteModal, {
                t,
                editing,
                catalog,
                catalogError,
                routes,
                busy,
                onReloadCatalog: loadCatalog,
                onRefreshCatalog: refreshCatalog,
                onCancel: () => setEditing(null),
                onSubmit: (payload) => {
                  const mode = editing.mode;
                  const routeId = editing.route ? editing.route.id : '';
                  setEditing(null);
                  void run(async () => {
                    if (mode === 'add') {
                      await call('route.add', payload);
                      return `已新增 ${payload.id || `${payload.provider}/${payload.model}`}`;
                    }
                    await call('route.patch', { id: routeId, patch: payload });
                    return `已保存 ${routeId}`;
                  });
                },
              }),
        ],
      });
    }

    /** 从上游模型 ID 推导可读、稳定的路由 ID；已被占用时自动追加序号。 */
    function deriveRouteId(provider, model, existing) {
      if (!provider || !model) return '';
      const tail = String(model).split('/').filter(Boolean).pop() || model;
      const slug = String(tail)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      const base = `${String(provider).trim()}-${slug}`.slice(0, 80);
      if (!existing.includes(base)) return base;
      for (let index = 2; index < 100; index += 1) {
        const candidate = `${base}-${index}`;
        if (!existing.includes(candidate)) return candidate;
      }
      return base;
    }

    /**
     * 新增 / 编辑路由：供应商、模型、思考档全部改为级联下拉。
     * 数据只来自宿主侧 catalog 接口（配置文件能力 + 运行时 llm 目录），
     * 用户不需要知道模型 ID 的拼写，也不需要手输档位。
     */
    function RouteModal(props) {
      const {
        t,
        editing,
        catalog,
        catalogError,
        routes,
        busy,
        onCancel,
        onSubmit,
        onReloadCatalog,
        onRefreshCatalog,
      } = props;
      const isEdit = editing.mode === 'edit';
      const route = editing.route;
      const [form, setForm] = React.useState({
        id: isEdit && route ? route.id : '',
        provider: isEdit && route ? route.provider : '',
        model: isEdit && route ? route.model : '',
        weight: isEdit && route ? route.weight : 1,
        priority: isEdit && route ? route.priority ?? 0 : 0,
        reasoningEffort: isEdit && route ? route.reasoningEffort || '' : '',
      });
      const [idEdited, setIdEdited] = React.useState(false);
      const [autoPicked, setAutoPicked] = React.useState(false);

      const existingIds = routes.map((item) => item.id);
      const catalogProviders = catalog?.providers ?? [];
      const providerOptions = catalogProviders.slice().sort((a, b) => {
        const aCount = (a.models || []).length;
        const bCount = (b.models || []).length;
        if (aCount === 0 && bCount > 0) return 1;
        if (bCount === 0 && aCount > 0) return -1;
        return 0;
      });
      if (form.provider && !providerOptions.some((item) => item.id === form.provider)) {
        providerOptions.unshift({ id: form.provider, name: form.provider, models: [], missing: true });
      }
      const selectedProvider = providerOptions.find((item) => item.id === form.provider);
      let modelOptions = (selectedProvider?.models ?? []).slice();
      if (form.model && !modelOptions.some((item) => item.id === form.model)) {
        modelOptions = [
          { id: form.model, name: form.model, reasoningEfforts: [], missing: true },
          ...modelOptions,
        ];
      }
      const selectedModel = modelOptions.find((item) => item.id === form.model);
      const efforts = (selectedModel?.reasoningEfforts ?? []).slice();
      if (form.reasoningEffort && !efforts.some((item) => item.id === form.reasoningEffort)) {
        efforts.push({ id: form.reasoningEffort, name: form.reasoningEffort, missing: true });
      }
      const defaultEffort = selectedModel?.defaultEffort;
      const effortOptions = [
        { id: '', name: t.catalogEmptyEffort },
        ...efforts.map((effort) => ({
          id: effort.id,
          name:
            `${effort.name}${effort.id === defaultEffort ? ` · ${t.catalogDefaultEffort}` : ''}` +
            (effort.missing ? ` ${t.catalogCustom}` : ''),
        })),
      ];
      React.useEffect(() => {
        if (isEdit || autoPicked || catalog === null || form.provider !== '') return;
        const candidate = providerOptions.find((provider) => (provider.models || []).length > 0);
        if (candidate === undefined) return;
        const firstModel = candidate.models[0];
        const id = deriveRouteId(candidate.id, firstModel.id, existingIds);
        setForm((current) => ({
          ...current,
          provider: candidate.id,
          model: firstModel.id,
          reasoningEffort: firstModel.defaultEffort || '',
          id,
        }));
        setAutoPicked(true);
      }, [autoPicked, catalog, existingIds, form.provider, isEdit]);

      // 上游只报可用档位；当前值不在里面就直说会被宿主拒绝，而不是让用户自己撞墙。
      const supportedEfforts = selectedModel?.reasoningEfforts ?? [];
      const effortWarning =
        form.reasoningEffort !== '' && !supportedEfforts.some((effort) => effort.id === form.reasoningEffort)
          ? t.catalogStaleEffort
          : selectedModel !== undefined && !selectedModel.missing && supportedEfforts.length === 0
            ? t.catalogNoEffort
            : null;

      const priorityOptions = [0, 1, 2, 3, 4, 5];
      if (!priorityOptions.includes(Number(form.priority))) {
        priorityOptions.push(Number(form.priority) || 0);
        priorityOptions.sort((a, b) => a - b);
      }

      const weightOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      if (!weightOptions.includes(Number(form.weight)) && Number(form.weight) > 0) {
        weightOptions.push(Number(form.weight));
      }

      const applySelection = (providerId, modelId) => {
        const provider = providerOptions.find((item) => item.id === providerId);
        const model = (provider?.models ?? []).find((item) => item.id === modelId);
        setForm((current) => ({
          ...current,
          provider: providerId,
          model: modelId,
          reasoningEffort: model?.defaultEffort || '',
          id: isEdit || idEdited ? current.id : deriveRouteId(providerId, modelId, existingIds),
        }));
      };

      const set_ = (key) => (event) => setForm({ ...form, [key]: event.target.value });
      const submit = () => {
        const payload = {
          provider: form.provider.trim(),
          model: form.model.trim(),
          weight: Number(form.weight),
          priority: Number(form.priority === '' ? 0 : form.priority),
          reasoningEffort: form.reasoningEffort,
        };
        if (!isEdit) payload.id = form.id.trim();
        onSubmit(payload);
      };

      const capabilityRows = [];
      if (selectedModel?.contextWindow) {
        capabilityRows.push([t.catalogContext, fmtTokens(selectedModel.contextWindow)]);
      }
      if (selectedModel?.maxTokens) {
        capabilityRows.push([t.catalogMaxTokens, fmtTokens(selectedModel.maxTokens)]);
      }
      if ((selectedModel?.inputModalities ?? []).length > 0) {
        capabilityRows.push([t.catalogInput, selectedModel.inputModalities.join(' / ')]);
      }
      if (efforts.length > 0) {
        capabilityRows.push([t.catalogEfforts, efforts.map((effort) => effort.id).join(' · ')]);
      }
      if (selectedModel?.source) {
        capabilityRows.push([t.catalogSource, selectedModel.source]);
      }
      if (selectedModel?.effortSource) {
        capabilityRows.push([t.catalogEffortSource, selectedModel.effortSource]);
      }

      const providerSelect = jsx.jsxs(
        'select',
        {
          className: 'spu-select',
          value: form.provider,
          disabled: catalog === null,
          onChange: (event) => {
            const providerId = event.target.value;
            const provider = providerOptions.find((item) => item.id === providerId);
            const firstModel = (provider?.models ?? [])[0]?.id ?? '';
            applySelection(providerId, firstModel);
          },
          children: [
            jsx.jsx('option', { value: '', children: t.catalogChooseProvider }, ''),
            ...providerOptions.map((provider) =>
              jsx.jsx(
                'option',
                {
                  value: provider.id,
                  disabled: (provider.models || []).length === 0,
                  children:
                    `${provider.name} · ${(provider.models || []).length} ${t.catalogModelCount}` +
                    (provider.missing ? ` ${t.catalogCustom}` : ''),
                },
                provider.id,
              ),
            ),
          ],
        },
      );

      const modelSelect = jsx.jsxs(
        'select',
        {
          className: 'spu-select spu-mono',
          value: form.model,
          disabled: catalog === null || form.provider === '' || modelOptions.length === 0,
          onChange: (event) => applySelection(form.provider, event.target.value),
          children:
            modelOptions.length === 0
              ? [jsx.jsx('option', { value: '', children: t.catalogNoModels }, 'empty')]
              : modelOptions.map((model) =>
                  jsx.jsx(
                    'option',
                    {
                      value: model.id,
                      children: modelLabel(model) + (model.missing ? ` ${t.catalogCustom}` : ''),
                    },
                    model.id,
                  ),
                ),
        },
      );

      const effortSelect = jsx.jsx('select', {
        className: 'spu-select',
        value: form.reasoningEffort,
        disabled: catalog === null || form.model === '' || effortOptions.length <= 1,
        onChange: set_('reasoningEffort'),
        children: effortOptions.map((effort) =>
          jsx.jsx('option', { value: effort.id, children: effort.name }, effort.id),
        ),
      });

      return jsx.jsxs('div', {
        className: 'spu-backdrop',
        style: { zIndex: 80 },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel();
        },
        children: [
          jsx.jsxs('div', {
            className: 'spu-modal',
            style: { width: 'min(620px,100%)' },
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': isEdit ? t.editRouteTitle : t.addRouteTitle,
            children: [
              jsx.jsxs('div', {
                className: 'spu-head',
                children: [
                  jsx.jsxs('div', {
                    className: 'spu-headtext',
                    children: [
                      jsx.jsx('h2', {
                        className: 'spu-title',
                        children: isEdit ? t.editRouteTitle : t.addRouteTitle,
                      }),
                      jsx.jsx('p', { className: 'spu-sub', children: t.catalogAutoHint }),
                    ],
                  }),
                ],
              }),
              jsx.jsxs('div', {
                className: 'spu-body',
                children: [
                  catalogErrorBlock(catalog, catalogError, t, onReloadCatalog),
                  jsx.jsxs('div', {
                    className: 'spu-field',
                    children: [
                      jsx.jsxs('div', {
                        className: 'spu-inline',
                        style: { justifyContent: 'space-between' },
                        children: [
                          jsx.jsx('span', { className: 'spu-label', children: t.fieldProvider }),
                          jsx.jsx('button', {
                            type: 'button',
                            className: 'spu-btn',
                            disabled: busy || form.provider.trim() === '',
                            onClick: () => onRefreshCatalog(form.provider.trim()),
                            children: t.catalogRefreshProvider,
                          }),
                        ],
                      }),
                      providerSelect,
                    ],
                  }),
                  jsx.jsxs('label', {
                    className: 'spu-field',
                    children: [jsx.jsx('span', { className: 'spu-label', children: t.fieldModel }), modelSelect],
                  }),
                  jsx.jsxs('div', {
                    className: 'spu-grid',
                    children: [
                      jsx.jsxs('div', {
                        className: 'spu-field',
                        children: [
                          jsx.jsx('span', { className: 'spu-label', children: t.fieldEffort }),
                          effortSelect,
                          effortWarning === null
                            ? null
                            : jsx.jsx('p', {
                                className: effortWarning === t.catalogNoEffort ? 'spu-hint' : 'spu-error',
                                children: effortWarning,
                              }),
                        ],
                      }),
                      jsx.jsxs('label', {
                        className: 'spu-field',
                        children: [
                          jsx.jsx('span', {
                            className: 'spu-label',
                            children: jsx.jsx(HoverTip, { text: t.tipWeight, children: t.catalogWeight }),
                          }),
                          jsx.jsx('select', {
                            className: 'spu-select',
                            value: String(form.weight),
                            onChange: (event) => setForm({ ...form, weight: Number(event.target.value) }),
                            children: weightOptions.map((weight) =>
                              jsx.jsx('option', { value: String(weight), children: String(weight) }, weight),
                            ),
                          }),
                          jsx.jsx('p', { className: 'spu-hint', children: fill(t.weightHint, 'n', form.weight) }),
                        ],
                      }),
                      jsx.jsxs('label', {
                        className: 'spu-field',
                        children: [
                          jsx.jsx('span', {
                            className: 'spu-label',
                            children: jsx.jsx(HoverTip, { text: t.tipPriority, children: t.fieldPriority }),
                          }),
                          jsx.jsx('select', {
                            className: 'spu-select',
                            value: String(Number(form.priority) || 0),
                            onChange: (event) => setForm({ ...form, priority: event.target.value }),
                            children: priorityOptions.map((priority) =>
                              jsx.jsx('option', {
                                value: String(priority),
                                children:
                                  priority === 0
                                    ? String(priority) + '（' + t.priorityDefault + '）'
                                    : String(priority),
                              }, priority),
                            ),
                          }),
                          jsx.jsx('p', { className: 'spu-hint', children: t.fieldPriorityHint }),
                        ],
                      }),
                    ],
                  }),
                  capabilityRows.length === 0
                    ? null
                    : jsx.jsxs('dl', {
                        className: 'spu-capability',
                        children: [
                          jsx.jsx('dt', { children: t.catalogCapability }),
                          ...capabilityRows.map(([label, value]) =>
                            jsx.jsxs('div', {
                              style: { display: 'inline' },
                              children: [
                                jsx.jsx('dt', { children: label }),
                                jsx.jsx('dd', { children: value }),
                              ],
                            }, label),
                          ),
                        ],
                      }),
                  isEdit
                    ? null
                    : jsx.jsxs('label', {
                        className: 'spu-field',
                        children: [
                          jsx.jsx('span', { className: 'spu-label', children: t.fieldId }),
                          jsx.jsx('input', {
                            className: 'spu-input',
                            value: form.id,
                            onChange: (event) => {
                              setIdEdited(true);
                              setForm({ ...form, id: event.target.value });
                            },
                          }),
                          jsx.jsx('p', { className: 'spu-hint', children: t.catalogIdAuto }),
                        ],
                      }),
                ],
              }),
              jsx.jsxs('div', {
                className: 'spu-head',
                style: {
                  borderTop: '0.5px solid var(--dsw-alias-border-l1)',
                  borderBottom: 0,
                  justifyContent: 'flex-end',
                },
                children: [
                  jsx.jsx('button', { type: 'button', className: 'spu-btn', onClick: onCancel, children: t.cancel }),
                  jsx.jsx('button', {
                    type: 'button',
                    className: 'spu-btn is-primary',
                    disabled: busy || catalog === null || form.provider.trim() === '' || form.model.trim() === '',
                    onClick: submit,
                    children: busy ? t.applying : t.save,
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /** 能力目录尚未就绪时在弹窗里给出状态，避免用户面对空下拉。 */
    function catalogErrorBlock(catalog, catalogError, t, onReloadCatalog) {
      if (catalog !== null) return null;
      if (catalogError !== null) {
        return jsx.jsxs('p', {
          className: 'spu-error',
          children: [
            `${t.catalogError}：${catalogError}`,
            jsx.jsx('button', {
              type: 'button',
              className: 'spu-btn',
              style: { marginLeft: '8px' },
              onClick: () => void onReloadCatalog(),
              children: t.retry,
            }),
          ],
        });
      }
      return jsx.jsx('p', { className: 'spu-hint', children: t.catalogLoading });
    }

    // ---- 悬浮说明 ----
    /**
     * 参数名旁边的一个「?」，鼠标悬浮或键盘聚焦弹出解释。
     *
     * 弹出层必须 portal 到 body：表格头和弹窗都在 overflow:auto 的滚动容器里，
     * absolute 定位会被裁掉；portal 后 position:fixed 才以视口为准。
     * 用 event.currentTarget 取锚点，不引 useRef（bundle 的 React 成员越少越稳）。
     */
    function HoverTip(props) {
      const { text, children, className } = props;
      const [box, setBox] = React.useState(null);
      const open = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const viewWidth = window.innerWidth || 1280;
        const viewHeight = window.innerHeight || 800;
        const left = Math.max(8, Math.min(rect.left, viewWidth - 336));
        // 下方空间够就贴下方，否则向上翻，避免贴窗口底边时看不到。
        setBox(
          rect.bottom < viewHeight * 0.65
            ? { left, top: rect.bottom + 6 }
            : { left, bottom: viewHeight - rect.top + 6 },
        );
      };
      const close = () => setBox(null);
      const style =
        box === null
          ? undefined
          : {
              left: box.left + 'px',
              top: box.top === undefined ? undefined : box.top + 'px',
              bottom: box.bottom === undefined ? undefined : box.bottom + 'px',
            };
      return jsx.jsxs('span', {
        className: className === undefined ? 'spu-tip' : 'spu-tip ' + className,
        tabIndex: 0,
        role: 'note',
        'aria-label': text,
        onMouseEnter: open,
        onMouseLeave: close,
        onFocus: open,
        onBlur: close,
        children: [
          children,
          jsx.jsx('span', { className: 'spu-tip-mark', 'aria-hidden': 'true', children: '?' }),
          box === null
            ? null
            : jsx.jsx(PortalToBody, {
                children: jsx.jsx('span', { className: 'spu-tip-pop', role: 'tooltip', style, children: text }),
              }),
        ],
      });
    }

    // ---- 浮层管理面板 ----
    /**
     * 把子树 portal 到 document.body。
     *
     * 必须这么做：shell.overlay 的 slot 渲染在 AppFrame 的 overlayLayer 里，而它所在的
     * 祖先链上有带 transform / grid 定位的容器；position:fixed 一旦遇到这样的祖先，
     * 就以祖先而不是视口为基准，遮罩会缩成中间一列、露出侧边栏和顶栏。
     * 挂到 body 之后 fixed 才真正对齐视口。
     */
    function PortalToBody(props) {
      const [host] = React.useState(() => {
        const node = document.createElement('div');
        node.dataset.subagentPoolPortal = '';
        return node;
      });
      React.useEffect(() => {
        document.body.append(host);
        return () => {
          try {
            host.remove();
          } catch {
            /* 忽略 */
          }
        };
      }, [host]);
      if (typeof reactDom.createPortal !== 'function') return props.children;
      return reactDom.createPortal(props.children, host);
    }

    function PoolDialog(props) {
      const { t, onClose } = props;
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [onClose]);

      return jsx.jsx('div', {
        className: 'spu-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        children: jsx.jsxs('div', {
          className: 'spu-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t.title,
          children: [
            jsx.jsxs('div', {
              className: 'spu-head',
              children: [
                jsx.jsxs('div', {
                  className: 'spu-headtext',
                  children: [
                    jsx.jsx('h2', { className: 'spu-title', children: t.title }),
                    jsx.jsx('p', { className: 'spu-sub', children: t.subtitle }),
                  ],
                }),
                jsx.jsx('button', {
                  type: 'button',
                  className: 'spu-btn is-icon',
                  title: t.close,
                  'aria-label': t.close,
                  onClick: onClose,
                  children: '✕',
                }),
              ],
            }),
            jsx.jsx(PanelBoundary, {
              failed: t.failed,
              children: jsx.jsx(PanelContent, { t }),
            }),
          ],
        }),
      });
    }

    // ---- 侧边栏入口 ----
    /** 图标与 Remote 的显示器同风格，但画的是分层模块，避免两个按钮混淆。 */
    function PoolIcon(props) {
      return jsx.jsxs('svg', {
        width: props.size || 18,
        height: props.size || 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        children: [
          jsx.jsx('rect', { x: 3, y: 4, width: 18, height: 5, rx: 1.6 }),
          jsx.jsx('rect', { x: 3, y: 12, width: 18, height: 5, rx: 1.6 }),
          jsx.jsx('path', { d: 'M7 20h10' }),
          jsx.jsx('path', { d: 'M12 17v3' }),
        ],
      });
    }

    function SidebarEntry(props) {
      const { t, wide, active, onOpen } = props;
      return jsx.jsx('div', {
        className: 'spu-entry-wrap',
        style: { display: 'flex', flex: wide ? '0 1 auto' : 'none', minWidth: 0 },
        children: jsx.jsxs('button', {
          type: 'button',
          className: `spu-entry${wide ? '' : ' is-icon'}${active ? ' is-active' : ''}`,
          title: t.entry,
          'aria-label': t.entry,
          'aria-pressed': active === true,
          onClick: onOpen,
          children: [
            jsx.jsx(PoolIcon, {}),
            wide ? jsx.jsx('span', { className: 'spu-entry-label', children: t.entry }) : null,
          ],
        }),
      });
    }

    const inject = ['slots', 'locale'];

    /**
     * 挂载入口。整段用 try/catch 包住，失败只降级为「面板不出现」。
     *
     * 为什么必须包：前端 boot 审计 qZ() 遍历**全部** entry，任意一行不是 active
     * 就整体抛 `web boot: N entries did not activate`，整页起不来。
     * 我们这里任何一次抛错（locale 命名空间重复注册、installStyle 被 CSP 拒、
     * slots 服务形状变化）都会把「一个面板没了」放大成「应用打不开」。
     * 成熟插件（dshmarket 等）同样在 apply 层做这层隔离。
     */
    function apply(ctx) {
      try {
        mount(ctx);
      } catch (error) {
        // 只记录，不向上抛：让本插件缺席，其余界面照常启动。
        console.error(
          '[dsh-subagent-ops] 面板挂载失败，本次会话将没有子代理模型池界面；' +
            '其余功能不受影响。请把下面的错误一并反馈。',
          error,
        );
      }
    }

    /** 真正的挂载逻辑；抛错由上面的 apply 兜住。 */
    function mount(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-pool-ui: dictionaries');
      ctx.effect(() => installStyle(), 'subagent-pool-ui: styles');
      const t = makeDict(ctx.locale.bind(NS), zh);

      // 打开状态放在插件事务里：按钮与浮层是两个独立 slot，需要一个共用的小 store。
      let open = false;
      const listeners = new Set();
      const setOpen = (next) => {
        if (open === next) return;
        open = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* 忽略单个订阅者异常 */
          }
        }
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      ctx.effect(() => () => listeners.clear(), 'subagent-pool-ui: dialog store');

      function useOpen() {
        return React.useSyncExternalStore(subscribe, () => open, () => open);
      }

      // 侧边栏脚部按钮：Remote 占 order -20，这里 order 0 排在其右侧。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'subagent-pool-entry',
            order: 0,
            locale: NS,
          },
          (props) => {
            const isOpen = useOpen();
            return jsx.jsx(SidebarEntry, {
              t,
              wide: props.wide,
              active: isOpen,
              onOpen: () => setOpen(!open),
            });
          },
        ),
      );

      // 浮层：挂在 shell.overlay，不占用 main 的会话工作区。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'subagent-pool-dialog',
            order: 40,
            locale: NS,
          },
          () => {
            const isOpen = useOpen();
            if (!isOpen) return null;
            return jsx.jsx(PortalToBody, {
              children: jsx.jsx(PoolDialog, { t, onClose: () => setOpen(false) }),
            });
          },
        ),
      );
    }

    /**
     * 把 locale.bind 的翻译函数包装成属性字典：读 t.xxx 时现取当前语言的值。
     * 用 getter 而不是快照，语言切换后下一次渲染自然拿到新文案。
     */
    function makeDict(translate, reference) {
      const dict = {};
      for (const key of Object.keys(reference)) {
        Object.defineProperty(dict, key, {
          enumerable: true,
          get: () => translate(key),
        });
      }
      return dict;
    }

    return Object.assign(module.exports, { apply, inject });
  },
});
