/**
 * Dependency-free smoke test for dsh-subagent-ops.
 *
 * Run with: node test/smoke.mjs
 *
 * 覆盖两条曾经导致线上故障的硬约束：
 *
 * 1. **浏览器半侧的注册 id 必须等于包名**。client-modules 用包名当启动图
 *    row id（reconcilePackage(packageName)），arrive() 只认 factories.has(包名)。
 *    注册成别名时它判定「脚本执行了却没注册」，回退单资源 URL 再执行一遍；
 *    第二次注册撞上已有 factory，抛 duplicate factory registration，
 *    整个 web boot 失败。2026-11-10 实际发生，应用起不来。
 *
 * 2. **YAML 池文件必须能从插件真实路径解析到库**。本包是 link 安装，
 *    仓库里没有 node_modules，裸 `import('js-yaml')` 必然失败；早期还吞掉了
 *    异常，表现成「routes 恒为 0」而没有任何可见原因。
 *
 * 检查按顺序 await 执行，任何一条失败都会以非零码退出。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');

let failures = 0;
/** 顺序执行一条检查：同步或异步都支持，抛错计入失败。 */
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error?.message ?? error}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const clientPath = path.join(PKG_ROOT, pkg.exports['./client'].replace(/^\.\//, ''));
const clientSource = fs.readFileSync(clientPath, 'utf8');

/** 用最小 fake loader 执行一次 bundle，拿到它自报的注册信息。 */
function loadClientBundle() {
  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => registrations.push(registration),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: clientPath });
  return registrations;
}

console.log('dsh-subagent-ops smoke');

const registrations = loadClientBundle();

await check('bundle 恰好注册一次', () => {
  assert.equal(registrations.length, 1, `注册了 ${registrations.length} 次`);
});

await check('注册 id 等于包名（client-modules 的 row id）', () => {
  assert.equal(registrations[0]?.id, pkg.name);
});

await check('factory 是函数', () => {
  assert.equal(typeof registrations[0]?.factory, 'function');
});

await check('factory 物化后导出 apply 与 inject', () => {
  /** 只实现 bundle 实际用到的 React 成员；缺一个就会在物化期抛错，正好当契约用。 */
  class FakeComponent {
    constructor(props) {
      this.props = props;
    }
    setState() {}
    forceUpdate() {}
  }
  const fakeReact = {
    Component: FakeComponent,
    createElement: (type, props) => ({ type, props }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const fakeRequire = (spec) => {
    if (spec === 'react') return fakeReact;
    if (spec === 'react/jsx-runtime') {
      const jsx = (type, props) => ({ type, props });
      return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
    }
    if (spec === 'react-dom') return { createPortal: (node) => node };
    throw new Error(`unexpected require("${spec}")`);
  };
  const exported = registrations[0].factory(fakeRequire);
  assert.equal(typeof exported.apply, 'function');
  assert.ok(Array.isArray(exported.inject));
  assert.ok(exported.inject.includes('slots'));
  assert.ok(exported.inject.includes('locale'));
});

const hostSource = fs.readFileSync(path.join(PKG_ROOT, pkg.main.replace(/^\.\//, '')), 'utf8');

await check('宿主自检按包名查启动图', () => {
  assert.ok(
    hostSource.includes(`const PACKAGE_NAME = '${pkg.name}'`),
    '宿主半侧缺少 PACKAGE_NAME 常量或与包名不一致',
  );
  assert.ok(
    !/clientPath\('subagent-pool-ui'\)/.test(hostSource),
    '宿主自检仍在用 entry id 查启动图',
  );
});

const poolSource = fs.readFileSync(path.join(PKG_ROOT, 'lib/pool.mjs'), 'utf8');

await check('pool.mjs 不再裸 import YAML 库', () => {
  assert.ok(
    !/await import\('js-yaml'\)/.test(poolSource),
    'pool.mjs 仍在使用裸 specifier import，link 安装下必然失败',
  );
  assert.ok(poolSource.includes('createRequire'), 'pool.mjs 缺少 createRequire 基准解析');
});

await check('真实池文件能被 YAML 解析出 routes', async () => {
  const poolFile = path.join(os.homedir(), '.dsh', 'subagent-model-pool.yaml');
  if (!fs.existsSync(poolFile)) {
    console.log('       （跳过：本机没有池文件）');
    return;
  }
  const text = fs.readFileSync(poolFile, 'utf8');
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  // 依赖装在 profile 下，基准取 profile 的 package.json，与 pool.mjs 的口径一致。
  const base = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json');
  const require = createRequire(base);
  const module = await import(pathToFileURL(require.resolve('js-yaml')).href);
  const lib = module.default ?? module;
  const data = lib.load(text);
  assert.ok(Array.isArray(data?.routes), '池文件解析后没有 routes 数组');
  assert.ok(data.routes.length > 0, '池文件解析后 routes 为空');
});

const patch = fs.readFileSync(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8');
const rowNames = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*(\S+)/gm)].map((m) => ({
  id: m[1],
  name: m[2],
}));

await check('cordis.patch.yml 声明三条 row', () => {
  assert.equal(rowNames.length, 3);
});

await check('每个 row 的 name 都能被 exports 解析', () => {
  for (const row of rowNames) {
    const subpath = row.name === pkg.name ? '.' : `.${row.name.slice(pkg.name.length)}`;
    assert.ok(
      Object.hasOwn(pkg.exports, subpath),
      `row ${row.id} 的 name ${row.name} 需要 exports["${subpath}"]`,
    );
  }
});

await check('包根那一行的 name 就是包名（浏览器半侧靠它挂载）', () => {
  const rootRow = rowNames.find((row) => row.name === pkg.name);
  assert.ok(rootRow, '没有 name 等于包名的 row，浏览器半侧不会被挂载');
});

// --- 启动期爆炸半径：apply 必须自己兜住异常 ---
//
// 前端 boot 审计遍历全部 entry，任意一行非 active 就整体抛
// `web boot: N entries did not activate`，整页起不来。
// 所以浏览器半侧的 apply 必须把异常降级成「面板缺席」，不能向上抛。
await check('client.js 的 apply 不向调用方抛错', () => {
  const exported = registrations[0].factory((spec) => {
    if (spec === 'react') {
      return {
        Component: class {},
        createElement: () => ({}),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useSyncExternalStore: (_s, get) => get(),
      };
    }
    if (spec === 'react/jsx-runtime') {
      const jsx = (type, props) => ({ type, props });
      return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
    }
    if (spec === 'react-dom') return { createPortal: (node) => node };
    throw new Error(`unexpected require("${spec}")`);
  });
  // 故意让 ctx 上的每个服务访问都抛错，模拟挂载期故障。
  const hostileCtx = new Proxy(
    {},
    {
      get() {
        throw new Error('boom: 模拟挂载期故障');
      },
    },
  );
  assert.doesNotThrow(() => exported.apply(hostileCtx), 'apply 抛错会让整个 web boot 失败');
});

await check('宿主 apply 不让路由注册失败变成整行 FAILED', () => {
  assert.ok(
    /catch\s*\(caught\)\s*\{[\s\S]{0,400}注册[\s\S]{0,80}失败/.test(hostSource),
    '宿主 apply 缺少 webServer.register 的 try/catch 降级',
  );
});

await check('engines.dsh 上界不窄于 0.3.0（避免升级后整包静默消失）', () => {
  // app-boot 的 unmetRequirements 判定不满足时整个 bundle 被 skippedBundles 跳过，
  // 三个 row 一起消失且只有一行 stderr 提示。
  assert.match(pkg.engines.dsh, /<0\.3\.0-0/, `engines.dsh 过窄：${pkg.engines.dsh}`);
});

await check('cordis.patch.yml 带双挂载守卫', () => {
  assert.match(patch, /disabled:\s*!!js/, '包根行缺少 disabled 守卫，重复挂载会让整棵树启动失败');
});

const watchSource = fs.readFileSync(path.join(PKG_ROOT, 'lib/watch.mjs'), 'utf8');

// --- 寻路必须能影响「本步内」的重试，而不只是下一步 ---
//
// 实测事故（2026-11-10，会话 ff29020d）：agent-loop 的 step() 在重试循环前就把
// selection 定死成 decision.selection，循环内 prepareRequest() 只读那个对象。
// 只调 agent.model.select() 的话，重试仍打旧路由，5 次全 FAIL，turn 以 error 结束，
// 下一个 step 根本不存在——换路从未生效，却已经冷却了健康路由、烧掉了 maxSwitches。
await check('pool.mjs 改写本步在飞的 selection（不只调 model.select）', () => {
  assert.match(poolSource, /agent\/pre-step/, '缺少 pre-step 监听，拿不到 decision.selection 的活对象');
  assert.match(poolSource, /liveSelections/, '缺少在飞 selection 的记录表');
  assert.match(poolSource, /forceLiveSelection/, '缺少本步内改写 selection 的实现');
  // 改写必须发生在 request-error 处理里，且与 select() 并列
  const errBlock = poolSource.slice(poolSource.indexOf('agent/request-error'));
  assert.match(errBlock, /applyRoute\(agent, alternative\)/, 'request-error 里缺少持久化换路');
  assert.match(errBlock, /forceLiveSelection\(agent, failed, alternative\)/, 'request-error 里缺少本步内改写');
});

await check('pool.mjs 不再只声明「下一步生效」', () => {
  assert.ok(
    !/第 \$\{[^}]+\} 次，下一步生效/.test(poolSource),
    '日志仍固定写「下一步生效」，会掩盖本步内是否真的换成功',
  );
});

// --- 续命预算不能是一次性闩锁 ---
//
// 实测事故（2026-11-10）：同一天三个子代理的 giveup 原因全是
// `预算耗尽（wall-clock=30min）`，attempt 均为 0——一次都没续过就被判死，
// 因为更早的一次复活点亮了全局时钟，30 分钟后所有后来者永久失去资格。
await check('watch.mjs 的墙钟预算是滑动窗口，不是一次性闩锁', () => {
  assert.match(watchSource, /reviveGlobal\.recent/, '缺少滑动窗口时间戳列表');
  assert.ok(
    !/now - first >= wall/.test(watchSource),
    '仍在用「首次复活时刻」做一次性闩锁判定',
  );
});

await check('watch.mjs 预算耗尽不置终态、不写 giveup', () => {
  const budgetBlock = watchSource.slice(watchSource.indexOf('const budget = reviveBudgetLeft'));
  const head = budgetBlock.slice(0, 900);
  assert.ok(
    !/giveUp\(state, row, 'upstream-failure', `预算耗尽/.test(head),
    '预算耗尽仍调用 giveUp，会把「暂时没额度」写成「永不复活」',
  );
  assert.match(head, /continue;/, '预算不足时应跳过本 tick 而不是终结该目标');
});

await check('watch.mjs 重建状态时跳过「预算耗尽」类历史 giveup', () => {
  assert.match(
    watchSource,
    /reason\.includes\('预算耗尽'\)/,
    '历史告警里的预算耗尽记录仍会被恢复成 terminal，旧 bug 被固化',
  );
});

await check('pool.mjs 换路次数用尽时也要拆掉失败绑定', () => {
  // 实测事故（2026-11-10，会话 469f40af）：maxSwitches 用尽后直接 return，
  // 把刚失败的粘滞绑定原样留着；autoRevive 冷恢复时 stickyRoute() 又命中它，
  // 复活第一件事就是再撞一次死路由，又卡 600s——续命等于白救。
  const errBlock = poolSource.slice(poolSource.indexOf('agent/request-error'));
  const head = errBlock.slice(0, 2600);
  assert.match(head, /runtime\.bindings\.delete\(agent\.id\)/, '缺少拆绑定的动作');
  // 拆绑定必须发生在「换路额度用尽就 return」之前
  const delAt = head.indexOf('runtime.bindings.delete(agent.id)');
  const capAt = head.indexOf('>= runtime.maxSwitches');
  assert.ok(delAt > 0 && capAt > delAt, '拆绑定必须在额度检查之前，否则用尽时仍会保留死绑定');
  assert.match(head, /runtime\.cooldown\.set\(failed\.id/, '冷却也必须无条件执行，不能只在能换路时冷却');
});

// --- 同级优先顺序（priority）---
//
// 用户要求：权重算出来的负载相同时，还要能指定先后。weight 表达容量比例，
// priority 只做同分时的次序尺，两者不能互相顶替——下面四条把顺序钉死。
const poolModule = await import(pathToFileURL(path.join(PKG_ROOT, 'lib/pool.mjs')).href);
const pickByLoad = poolModule.pickByLoad;

await check('pickByLoad：负载不同时 priority 不越权', () => {
  const busy = { route: { id: 'a' }, score: 2, priority: 0, last: 1 };
  const idle = { route: { id: 'b' }, score: 0, priority: 9, last: 1 };
  assert.equal(pickByLoad([busy, idle]).id, 'b', 'priority 压过了 score，权重失去意义');
});

await check('pickByLoad：负载相同由 priority 小的先派', () => {
  const high = { route: { id: 'low-priority' }, score: 0, priority: 5, last: 1 };
  const low = { route: { id: 'high-priority' }, score: 0, priority: 1, last: 9 };
  assert.equal(pickByLoad([high, low]).id, 'high-priority');
});

await check('pickByLoad：priority 也相同时取最久未分配', () => {
  const older = { route: { id: 'older' }, score: 0, priority: 0, last: 1 };
  const newer = { route: { id: 'newer' }, score: 0, priority: 0, last: 9 };
  assert.equal(pickByLoad([newer, older]).id, 'older');
});

await check('pickByLoad：全空闲且 priority 相同时按池文件顺序', () => {
  const first = { route: { id: 'first' }, score: 0, priority: 0, last: 0 };
  const second = { route: { id: 'second' }, score: 0, priority: 0, last: 0 };
  assert.equal(pickByLoad([first, second]).id, 'first');
});

await check('priority 贯穿池文件读写与快照', () => {
  assert.match(poolSource, /const priority = Number.isFinite\(raw\.priority\)/, 'normalizeRoute 没读 priority');
  assert.match(poolSource, /priority: route\.priority \?\? 0/, 'snapshot 没输出 priority');
  assert.match(poolSource, /item\.set\('priority'/, 'patchRoute 没写 priority');
  assert.match(poolSource, /priority: Math\.trunc\(priority\)/, 'addRoute 没写 priority');
});

await check('priority 出现在表格列与弹窗表单', () => {
  assert.match(clientSource, /t\.colPriority/, '表格缺少优先级列');
  assert.match(clientSource, /t\.fieldPriority/, '弹窗缺少优先级字段');
  assert.match(clientSource, /priority: Number\(form\.priority/, '提交时没带 priority');
});

// 权重/优先级都是「说不清就别让人填」的参数：必须有悬浮解释、必须能下拉选。
await check('权重与优先级带悬浮说明', () => {
  assert.match(clientSource, /function HoverTip\(/, '缺少 HoverTip 组件');
  assert.match(clientSource, /tipWeight:/, '没有权重说明文案');
  assert.match(clientSource, /tipPriority:/, '没有优先级说明文案');
  assert.match(clientSource, /text: t\.tipWeight, children: t\.colWeight/, '表头权重没有悬浮说明');
  assert.match(clientSource, /text: t\.tipPriority, children: t\.colPriority/, '表头优先级没有悬浮说明');
  assert.match(clientSource, /text: t\.tipWeight, children: t\.catalogWeight/, '弹窗权重没有悬浮说明');
  assert.match(clientSource, /text: t\.tipPriority, children: t\.fieldPriority/, '弹窗优先级没有悬浮说明');
});

await check('权重与优先级都是下拉框，且权重给出实时白话解释', () => {
  assert.match(clientSource, /const priorityOptions = \[0, 1, 2, 3, 4, 5\]/, '优先级没有下拉候选');
  const priorityField = clientSource.slice(clientSource.indexOf("text: t.tipPriority, children: t.fieldPriority"));
  assert.match(priorityField.slice(0, 900), /'select'/, '优先级仍是输入框而非下拉');
  assert.match(clientSource, /fill\(t\.weightHint, 'n', form\.weight\)/, '权重下方没有实时说明');
  assert.match(clientSource, /value: String\(Number\(form\.priority\) \|\| 0\)/, '优先级下拉没有收住空值');
});

// --- 上游思考档现拉 + 当日缓存 ---
//
// 事故背景：池里写死不支持的 reasoningEffort，宿主 resolveCallWithInfo 直接抛
// UNSUPPORTED_REASONING_EFFORT，子代理整个失败。档位必须以 llm.resolveModelInfo
// 的运行时答案为准，且当日缓存 + 可手动刷新。
await check('宿主按运行时答案覆盖思考档，而不是让配置预设顶上来', () => {
  assert.match(hostSource, /reasoningKnown/, '缺少「运行时确实报了思考档」的判定');
  assert.match(hostSource, /effortSource = 'runtime'/, '运行时档位没有标记来源');
  assert.match(hostSource, /resolveModelInfo/, '没有调用 llm.resolveModelInfo 现拉');
});

await check('目录带当日缓存与手动刷新入口', () => {
  assert.match(hostSource, /CATALOG_CACHE_VERSION/, '缺少缓存版本号');
  assert.match(hostSource, /function localDay\(/, '缺少本地日期判定');
  assert.match(hostSource, /subagent-model-catalog\.json/, '缓存文件名缺失');
  assert.match(hostSource, /'catalog\.refresh'/, '缺少手动刷新动词');
  assert.match(hostSource, /writeCatalogCache/, '刷新后没落缓存');
});

await check('刷新动词走 POST（写缓存不能被简单请求触发）', () => {
  assert.match(hostSource, /VERBS = new Set\(\[[\s\S]{0,600}'catalog\.refresh'/, 'VERBS 未登记 catalog.refresh');
  const getLine = hostSource.split('\n').find((line) => line.includes("verb !== 'snapshot'"));
  assert.ok(getLine !== undefined && !getLine.includes('catalog.refresh'), '刷新不该进 GET 白名单');
  assert.match(clientSource, /call\('catalog\.refresh'/, '前端没有调用刷新');
});

// --- 目录缓存与手动刷新（功能级，用临时 home + llm 替身）---
const hostModule = await import(pathToFileURL(path.join(PKG_ROOT, 'lib/index.mjs')).href);

/** 造一个最小 llm 替身：调用序列记进 calls，failOn 命中时抛错。 */
function fakeLlm(calls) {
  const state = { failOn: null };
  const llm = {
    listProviders: () => [
      { id: 'p1', name: 'P1' },
      { id: 'p2', name: 'P2' },
    ],
    listModels: async (id) => {
      calls.push(`list:${id}`);
      if (state.failOn === id) throw new Error('MISSING_CREDENTIAL');
      return [{ id: `${id}-m` }];
    },
    resolveModelInfo: async () => ({
      reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
    }),
  };
  return { llm, state };
}

await check('目录按本地日缓存：同一天第二次请求不再问上游', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spu-cat-'));
  try {
    const calls = [];
    const { llm } = fakeLlm(calls);
    const ctx = { get: (name) => (name === 'dshHomePath' ? () => home : name === 'llm' ? llm : undefined) };
    const first = await hostModule.catalogReport(ctx);
    assert.equal(first.cached, false, '首次应现拉');
    assert.ok(calls.length >= 2, '首次应逐个供应商拉取');
    assert.equal(first.providers[0].models[0].effortSource, 'runtime', '思考档应标记为运行时来源');
    calls.length = 0;
    const second = await hostModule.catalogReport(ctx);
    assert.equal(second.cached, true, '同日第二次应命中缓存');
    assert.equal(calls.length, 0, '命中缓存时不该再调 llm');
    assert.ok(fs.existsSync(path.join(home, 'subagent-model-catalog.json')), '缓存文件应已落盘');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check('单供应商刷新只重拉那一家，失败时保留它上次的缓存', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spu-cat-'));
  try {
    const calls = [];
    const { llm, state } = fakeLlm(calls);
    const ctx = { get: (name) => (name === 'dshHomePath' ? () => home : name === 'llm' ? llm : undefined) };
    await hostModule.catalogReport(ctx);
    calls.length = 0;
    await hostModule.catalogReport(ctx, { provider: 'p2' });
    assert.deepEqual(calls, ['list:p2'], '单家刷新只该碰这一家');
    calls.length = 0;
    state.failOn = 'p2';
    const failed = await hostModule.catalogReport(ctx, { provider: 'p2' });
    assert.equal(failed.refreshError, 'MISSING_CREDENTIAL', '刷新失败要如实回报');
    assert.equal(failed.cacheDay, failed.day, '缓存日期要单独回报，stale 提示才能说清是哪天的缓存');
    const p2 = failed.providers.find((provider) => provider.id === 'p2');
    assert.equal(p2.models.length, 1, '刷新失败不能把旧缓存里的模型清空');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
