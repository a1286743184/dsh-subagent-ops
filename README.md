# dsh-subagent-ops

子代理运维套件：一个 bundle 开关管三个组件。

## 为什么打包

三个插件原先是 `cordis.patch.yml` 里手工 `insert` 的裸 `file://` 模块，不属于任何
bundle，因此不出现在官方插件管理页（`list_bundles` 查不到），没有 UI 开关，也容易
被遗忘。打成一个 bundle 后：一个条目管三个组件、获得列表开关、源码纳入 git。

## 组件

| entry id | specifier | 职责 |
|---|---|---|
| `subagent-model-pool` | `dsh-subagent-ops/pool` | 均衡寻路、失败冷却、粘滞绑定、跨进程租约 |
| `subagent-pool-ui` | `dsh-subagent-ops`（包根） | 把池的内存管理面暴露成 `/api/subagent-pool`，并挂浏览器界面 |
| `subagent-watch` | `dsh-subagent-ops/watch` | 健康探针、卡住催办、上游失败续命、跨会话告警 |

**包根那一行为什么是 UI**：`dsh-client-modules` 只在 specifier 等于包名的那一行挂载
包的浏览器半侧（`exports["./client"]`）。

## 浏览器半侧的注册 id 必须等于包名（硬性）

`client.js` 里 `window.__ModuleLoader__.load({ id })` 的 id **必须逐字等于
`package.json` 的 `name`**，不能写成 entry id 或任何别名。

原因在 client-modules 的组合逻辑：启动图的 row id 恒为包名
（`reconcilePackage(packageName)`），`arrive()` 只认 `factories.has(包名)`。
注册成别名时它判定「脚本执行了却没注册」，于是回退到单资源 URL 把 bundle
**再执行一遍**；第二次注册撞上已存在的 factory，抛：

```
client-modules: duplicate factory registration for "<别名>" (bundle executed twice without invalidate?)
```

后果是启动审计报 `web boot: 1 entry did not activate` → `import failed`，
整个 Web boot 失败，应用起不来（2026-11-10 实际发生，只能停用全部插件并清配置才恢复）。

同一条约束还作用于样式标签：`style.dataset.plugin` 必须是包名，否则
`claimStyles`/`removeOwnedStyles` 按 row id 找不到这条样式，HMR 无法回收。

成熟插件（`dshmarket`、`dsh-better-sidebar`、`ds-harness-remote`、
`@michengai/dsh-skills-manager`、`dsh-ops`）全部是 `id === 包名`。
`test/smoke.mjs` 会真正执行一次 bundle 并断言这条，改动后先跑它。

## 启动期爆炸半径（硬性）

前端 boot 审计遍历**全部** entry，任意一行不是 active 就整体抛
`web boot: N entries did not activate`，整页起不来。因此本包任何一处挂载失败
都不能向上抛，只能降级为「本插件缺席」：

- 浏览器半侧 `apply()` 用 try/catch 包住整个挂载，失败只 `console.error`；
  否则 locale 重复注册、CSP 拦截样式、slots 形状变化都会重演「应用打不开」。
- 宿主半侧 `apply()` 包住 `webServer.register`，失败只让本行缺 API
  （典型触发是重复挂载导致的 `duplicate prefix route`），不让整行 fiber FAILED。

`cordis.patch.yml` 的包根行另带 `disabled: !!js` 双挂载守卫：已有别的 row 挂同一
裸包名时本行自动让位，避免 `resolves from multiple active Loader sources`。

## engines.dsh 的范围

`>=0.2.2-rc.1 <0.3.0-0`。**不要收窄到 `<0.2.3-0`**：`app-boot` 的
`unmetRequirements` 判定不满足时会把整个 bundle 归入 `skippedBundles`，
三个 row 一起静默消失，只在 stderr 留一行 `skipping profile bundle`，
排查时极易误判为「插件没装」。

## 寻路硬约束（勿改回请求覆写）

池只用官方持久选择 `agent.model.select({provider, model, reasoningEffort})` 在步进之前
定路由。**绝不能**在 `agent/request` 或 `system-prompt/assemble` 上覆写这三项：
`agent-loop` 的 `preStep()` 先把 selection 定死，`prepareRequest()` 随后校验 waterfall
返回必须与之全等，不一致直接抛错终止子代理
（`agent/request proposed ... after step preparation fixed ...`）。

失败处置：冷却失败路由 + 给该子代理换下一条（下一步生效），同一步内的重试沿用已定死的
selection，无法换上游。唤醒由 `subagent-watch` 的 `autoRevive` 负责，历史是持久事件流，
进度不丢。冷恢复时官方 `setup` 先回填原路由，随后 `agent/created` 触发池按持久化绑定
盖回健康路由（后写覆盖先写）。

## 路由字段与调度顺序

一条 route = 一个固定模型。池文件里每条 route 可写这些键：

| 键 | 含义 |
|---|---|
| `id` | 路由标识，省略时为 `provider/model` |
| `provider` / `model` | 固定模型，必填 |
| `weight` | 容量分母，正数，默认 1；score = 当前占位数 / weight，越小越先派 |
| `priority` | 同级优先顺序，整数，默认 0，**数字小的先派** |
| `reasoningEffort` | 思考档；省略表示不指定，交给模型默认 |
| `enabled` | `false` 直接排除出候选 |

选择顺序是 `score` → `priority` → `lastAssigned`：

1. 先比 score（占位数 / weight），**priority 不压过 weight**，只在负载算平之后生效；
2. score 相同比 priority，小的先派；
3. priority 也相同比 lastAssigned，取最久未被分配的那条；
4. 三者全相同按池文件里的书写顺序。

因此「优先用 A，A 忙了再上 B」的写法是：A、B 都 `weight: 1`，A 写 `priority: 0`、
B 写 `priority: 1`。全空闲时 A 恒被选中，A 有 1 个在跑时分母相等而 A 的 score 更高，
于是溢出到 B；A 空出来又自动回 A。想让 A 同时扛两个，把 `weight` 调大而不是调 priority。
界面上这两个字段都是下拉框，标题旁的「?」鼠标悬浮（或键盘 Tab 聚焦）给整段白话解释：
`weight` 的说明是「这条路由同时跑 N 个子代理，才和别的路由跑 1 个一样沉」，选完立刻在
下方按当前值重算这句话；`priority` 的 0 项标注「默认」，其余为 1-5。表格里的权重/优先级
单元格也带同一套悬浮说明。

## 思考档从上游现拉

池里写死不支持的 `reasoningEffort`，宿主 `resolveCallWithInfo` 会直接抛
`UNSUPPORTED_REASONING_EFFORT`，子代理整个失败。所以每档允许值不再以配置预设为准：

- 目录由 `llm.listProviders()` → `llm.listModels()` → `llm.resolveModelInfo()` 现拉，
  与宿主校验用的是同一份答案（直连供应商 `/v1/models` 不可靠：要鉴权，且各家字段不一）；
- 结果落 `~/.dsh/subagent-model-catalog.json`，带本地日期；同一天只读缓存，
  跨日后的第一次 `catalog` 请求自动重拉；
- `POST /api/subagent-pool/catalog.refresh` 手动刷新，body `{"provider": "wbn"}` 只刷一家，
  省略 provider 刷全部；
- 刷新失败（无凭据、全部供应商报错）不回写缓存，旧缓存保留并在响应里带 `refreshError`/`stale`；
- 配置里手写的 `reasoningEfforts` 只在运行时没报时才作为兜底显示，响应里用
  `effortSource`（`runtime` / `config`）标出来源。

## 配置

本包的 `cordis.patch.yml` 只声明挂载，**不含配置**。所有调参由 profile 的
`cordis.patch.yml` 以 id-targeted override 提供，重装/升级本包不会冲掉它们：

- `subagent-model-pool`：`poolFile`、`stateFile`（省略则默认 `~/.dsh/subagent-model-pool.*`）
- `subagent-pool-ui`：`apiPrefix`
- `subagent-watch`：`stallSeconds`、`autoRevive`、`maxRevives`、`alertFile` 等

运行态文件仍在 `~/.dsh/` 下，路径不随本包改变。

## 安装

要求 DSH `>=0.2.2-rc.1 <0.3.0-0`、Node `^22.19 || >=24`。尚未发布到 npm，从 GitHub 安装：

```text
plugin_manager install_bundle github:a1286743184/dsh-subagent-ops
```

本地开发时指向工作副本：

```text
dsh plugin --profile desktop add <本仓库绝对路径>/packages/dsh-subagent-ops
```

安装前须移除 profile `cordis.patch.yml` 里三条手工 `insert`，否则重复挂载会导致
`duplicate prefix route` 使整棵插件树启动失败。

## 重载纪律（重要）

本包带浏览器半侧（`dsh.client`）。改 `lib/client.js` **不需要重启**：宿主的 client-hmr 每 500ms 轮询 bundle 的 mtime/ctime/size，变化即 `rebuilt`，经 `/plugins/events` 通知后浏览器半侧会卸载旧 fiber、重新 import、刷新 entry。保存后等一两秒看界面即可。

必须完整退出重启的只有三种：

- **模块路径变了**：迁移/重装、link 指向改变。旧包路径要保留到重启之后再删，否则重组会去 import 一个不存在的模块。
- **`duplicate factory registration`**：同一页面把同一 bundle 执行了两次，reload 队列已污染。先跑 `node test/smoke.mjs` 核对注册 id 是否等于包名，再退出重开。
- **Host release 变了**（version/commit）：日志会写 `plugin updates pause until this page reloads`，此时热替换会主动停摆。

## 测试

```
node test/smoke.mjs
```

无依赖，不需要安装 profile。覆盖：

- 注册 id === 包名、样式标签身份、`apply` 不向调用方抛错
- 宿主自检按包名查启动图、路由注册失败被降级
- `pool.mjs` 不用裸 specifier 解析 YAML，且真实池文件能解析出 routes
- 三条 row 的 `name` 都能被 `exports` 解析、包根行是裸包名
- `engines.dsh` 上界与双挂载守卫
- `pickByLoad` 的 score → priority → lastAssigned 三级比较（含「priority 不越权」）
- priority 贯通 normalize/snapshot/patch/add 与前端表格、弹窗
- 权重/优先级带悬浮说明（表头四处挂 `HoverTip`），且两者都是下拉框、权重说明随选中值变化
- 思考档按 `resolveModelInfo` 的运行时答案覆盖配置预设
- 目录当日缓存、`catalog.refresh` 动词走 POST 而不进 GET 白名单

每条都实测能捕获回归（改回错误写法即 FAIL 且退出码 1）。

## 依赖

`pool.mjs` 动态 `import('js-yaml')` 解析 YAML 池文件，依赖 profile 顶层已装的
`js-yaml`（向上查找可命中）；缺失时只支持 `.json` 池文件。
