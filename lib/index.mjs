/**
 * subagent-pool-ui —— 子代理模型池管理界面的宿主半侧
 *
 * 只做两件事：
 *   1. 把运行中的 subagent-model-pool 管理面服务（subagentModelPool）暴露成 HTTP API；
 *   2. 声明 dsh.client 让浏览器半侧（client.js）被 client-modules 组合进前端。
 *
 * 为什么不在本插件里直接读写池文件：运行态（真实占位、冷却、粘滞绑定、人工禁用）
 * 只存在于 subagent-model-pool 的内存里，从文件读不到；写回也必须走它的热加载。
 * 因此本插件是纯适配层，所有事实都由它现算。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'subagent-pool-ui';
export const inject = ['webServer'];

/**
 * 包名，也是 client-modules 启动图里本包那一行的 id。
 *
 * 必须与 package.json 的 name 逐字一致：组合层用包名当 row id，
 * 浏览器半侧必须用同一个名字调用 `__ModuleLoader__.load({ id })`，
 * 否则会被判定「执行了却没注册」，进而二次执行并抛 duplicate registration。
 */
const PACKAGE_NAME = 'dsh-subagent-ops';

/** 所有 API 挂在同一个前缀下；客户端与宿主共用这一个常量。 */
const API_PREFIX = '/api/subagent-pool';
const CLIENT_MARKER_HEADER = 'x-subagent-pool-client';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function log(ctx, level, message) {
  const sink = ctx?.logger?.[level];
  if (typeof sink === 'function') {
    try {
      sink.call(ctx.logger, message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/**
 * 变更请求的本地信任栅栏。
 * 这个 API 能改动子代理模型配置，必须挡住跨站表单与随便一个网页的 fetch：
 *   - 自定义头拿不到（跨站自定义头会触发预检，预检被这里拒）；
 *   - Origin 必须与 Host 同源；
 *   - 必须是 application/json。
 */
function rejectMutation(req) {
  const marker = req.headers[CLIENT_MARKER_HEADER];
  if (marker !== '1') return { statusCode: 403, error: '缺少客户端标记头' };
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const originHost = new URL(origin).host;
      const requestHost = req.headers.host ?? new URL(req.url ?? '/', 'http://localhost').host;
      if (originHost !== requestHost) return { statusCode: 403, error: '拒绝跨源变更请求' };
    } catch {
      return { statusCode: 403, error: 'Origin 无效' };
    }
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return { statusCode: 415, error: 'content-type 必须是 application/json' };
  return null;
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (caught) {
    const error = new Error(`JSON 解析失败：${String(caught?.message ?? caught)}`);
    error.statusCode = 400;
    throw error;
  }
}

function requireService(ctx) {
  let service;
  try {
    service = ctx.get('subagentModelPool', false);
  } catch {
    service = undefined;
  }
  if (service === undefined || service === null) {
    const error = new Error('subagent-model-pool 未运行：请确认该插件已挂载并加载成功');
    error.statusCode = 503;
    throw error;
  }
  return service;
}

const VERBS = new Set([
  'snapshot',
  'route.patch',
  'route.add',
  'route.remove',
  'route.disable',
  'route.enable',
  'settings.patch',
  'bindings.clear',
  'bindings.prune',
  'pool.reload',
  'describe',
  'catalog',
  'catalog.refresh',
  'client.graph',
  'client.error',
]);

/**
 * 自检：本插件的浏览器半侧有没有被 client-modules 组合进启动图。
 * 这是排查「面板不出现」的第一手证据——组合失败时前端只会静默少一个插件。
 *
 * 查的是**包名**：client-modules 的启动图 row id 恒为包名
 * （`reconcilePackage(packageName)`），entry id 不参与组合。
 * 早期按 entry id `subagent-pool-ui` 查，结果永远是 composed:false，
 * 既误导排查，也是「注册 id 用别名」这个致命 bug 的同一处误判。
 */
function clientGraphReport(ctx) {
  let registry;
  try {
    registry = ctx.get('clientModules', false);
  } catch {
    registry = undefined;
  }
  if (registry === undefined || registry === null) {
    return { available: false, reason: 'clientModules 服务不可用（可能未挂载 @deepseek-ai/dsh-client-modules）' };
  }
  const graph = typeof registry.graph === 'function' ? registry.graph() : undefined;
  const rows = (graph?.entries ?? []).map((entry) => ({
    id: entry.id,
    rev: entry.rev,
    inject: entry.inject ?? [],
  }));
  const own = rows.find((row) => row.id === PACKAGE_NAME);
  let clientPath;
  try {
    clientPath = typeof registry.clientPath === 'function' ? registry.clientPath(PACKAGE_NAME) : undefined;
  } catch {
    clientPath = undefined;
  }
  let stat;
  if (typeof clientPath === 'string') {
    try {
      const info = fs.statSync(clientPath);
      stat = { size: info.size, mtimeMs: info.mtimeMs };
    } catch (caught) {
      stat = { error: String(caught?.message ?? caught) };
    }
  }
  return {
    available: true,
    composed: own !== undefined,
    row: own ?? null,
    clientPath: clientPath ?? null,
    stat: stat ?? null,
    totalEntries: rows.length,
    ids: rows.map((row) => row.id),
    graphRev: graph?.rev ?? null,
  };
}


/** 本机 DSH 主目录；配置目录 API 与错误日志共用同一个解析口径。 */
function dshHome(ctx) {
  try {
    const getter = ctx?.get?.('dshHomePath');
    if (typeof getter === 'function') {
      const value = getter();
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    /* 回落到默认位置 */
  }
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/** 给运行时目录查询加一个短超时：任何一个渠道卡住都不该拖住配置页。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 按 profile 基准解析 YAML 库。
 *
 * 本包是 link 安装，模块按真实路径（仓库内）解析，仓库里没有 node_modules，
 * 裸 `import('yaml')` 必然 ERR_MODULE_NOT_FOUND。依赖装在 profile 下，
 * 因此以各 profile 的 package.json 作为基准去 require。
 * 失败时抛出带候选路径的错误，不静默降级成空结果。
 */
async function loadYamlModule() {
  const bases = [];
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    const profiles = path.join(home, '.dsh', 'profiles');
    try {
      for (const name of fs.readdirSync(profiles)) bases.push(path.join(profiles, name, 'package.json'));
    } catch {
      /* profiles 目录不存在时跳过 */
    }
  }
  bases.push(path.join(process.cwd(), 'package.json'));

  const tried = [];
  for (const base of bases) {
    for (const specifier of ['yaml', 'js-yaml']) {
      try {
        const require = createRequire(base);
        const module = await import(pathToFileURL(require.resolve(specifier)).href);
        const lib = module.default ?? module;
        if (typeof lib.parseDocument === 'function' || typeof lib.load === 'function') return lib;
        tried.push(`${specifier} @ ${base}：接口不符`);
      } catch (error) {
        tried.push(`${specifier} @ ${base}：${String(error?.code ?? error?.message ?? error)}`);
      }
    }
  }
  throw new Error(`找不到可用的 YAML 库。已尝试：\n  ${tried.join('\n  ')}`);
}

function parseYaml(text, yaml) {
  if (typeof yaml.parseDocument === 'function') {
    const doc = yaml.parseDocument(text);
    if (doc.errors !== undefined && doc.errors.length > 0) throw doc.errors[0];
    return doc.toJS({ maxAliasCount: 100 });
  }
  if (typeof yaml.load === 'function') return yaml.load(text);
  throw new Error('没有可用的 YAML 解析器');
}

/** 从 cordis.patch.yml（数组）与 settings.yaml（命名空间）里捞出 llm-pi-ai.providers。 */
function collectProviderMaps(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderMaps(item, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const config = value.config;
  if (value.id === 'llm-pi-ai' && config?.providers && typeof config.providers === 'object') {
    out.push(config.providers);
  }
  const namespace = value['llm-pi-ai'];
  if (namespace?.providers && typeof namespace.providers === 'object') out.push(namespace.providers);
  if (value.insert !== undefined) collectProviderMaps(value.insert, out);
}

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function configEfforts(raw) {
  if (raw === undefined || raw === null || raw === false) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [];
  return EFFORT_ORDER.filter(
    (level) => Object.prototype.hasOwnProperty.call(raw, level) && raw[level] !== null && raw[level] !== undefined,
  ).map((level) => ({ id: level, name: level.charAt(0).toUpperCase() + level.slice(1) }));
}

const effortIds = (efforts) => (efforts ?? []).map((effort) => String(effort.id));

function highestEffort(efforts) {
  const ids = effortIds(efforts);
  for (let index = EFFORT_ORDER.length - 1; index >= 0; index -= 1) {
    if (ids.includes(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
  }
  return undefined;
}

/** 只补空缺：先读到的配置优先，运行时目录不覆盖用户已写死的能力。 */
function mergeDefined(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (Array.isArray(result[key]) && result[key].length > 0) continue;
    if (result[key] !== undefined && result[key] !== null) continue;
    result[key] = value;
  }
  return result;
}

function modelFromConfig(raw) {
  const efforts = configEfforts(raw.reasoningEfforts);
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    contextWindow: Number.isFinite(raw.contextWindow) ? Number(raw.contextWindow) : undefined,
    maxTokens: Number.isFinite(raw.maxTokens) ? Number(raw.maxTokens) : undefined,
    inputModalities: Array.isArray(raw.input) ? raw.input.map(String) : undefined,
    reasoningEfforts: efforts,
    defaultEffort: highestEffort(efforts),
    effortSource: efforts.length > 0 ? 'config' : undefined,
    source: 'config',
  };
}

function modelFromRuntimeList(raw) {
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputModalities: Array.isArray(raw.inputModalities) ? raw.inputModalities.map(String) : undefined,
    source: 'runtime',
  };
}

function mergeRuntimeInfo(base, info) {
  const hasReasoning = info?.reasoning !== null && typeof info?.reasoning === 'object';
  const efforts =
    hasReasoning && Array.isArray(info.reasoning.efforts)
      ? info.reasoning.efforts.map((effort) => ({
          id: String(effort.id),
          name: String(effort.name ?? effort.id),
        }))
      : [];
  const runtime = {
    name: typeof info?.name === 'string' && info.name.length > 0 ? info.name : undefined,
    description: typeof info?.description === 'string' ? info.description : undefined,
    contextWindow: Number.isFinite(info?.context?.contextWindow) ? Number(info.context.contextWindow) : undefined,
    maxTokens: Number.isFinite(info?.defaultMaxTokens) ? Number(info.defaultMaxTokens) : undefined,
    inputModalities: Array.isArray(info?.inputModalities) ? info.inputModalities.map(String) : undefined,
  };
  const merged = mergeDefined(base, runtime);
  if (hasReasoning) {
    // 宿主明确报告了思考能力：以它为准，空数组代表“这个模型没有可选档”。
    // 不能走 mergeDefined —— 那里会跳过空数组，配置里的预设就会顶上来，
    // 于是 UI 又给出宿主根本不接受的档位。
    merged.reasoningKnown = true;
    merged.reasoningEfforts = efforts;
    merged.defaultEffort =
      typeof info.reasoning.defaultEffort === 'string' ? info.reasoning.defaultEffort : highestEffort(efforts);
    merged.effortSource = 'runtime';
  }
  return merged;
}

async function configCatalog(home, yaml) {
  const files = [];
  const profileRoot = path.join(home, 'profiles');
  try {
    for (const entry of fs.readdirSync(profileRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(profileRoot, entry.name, 'cordis.patch.yml'));
    }
  } catch {
    /* 没有 profiles 目录时跳过 */
  }
  files.push(path.join(home, 'settings.yaml'));
  const maps = [];
  const readFiles = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      readFiles.push(file);
      collectProviderMaps(parseYaml(text, yaml), maps);
    } catch {
      /* 单个文件解析失败不影响其它来源 */
    }
  }
  const providers = new Map();
  for (const map of maps) {
    for (const [id, raw] of Object.entries(map)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = providers.get(id) ?? { id, name: String(raw.displayName ?? id), models: new Map() };
      if (typeof raw.displayName === 'string' && raw.displayName.length > 0) entry.name = raw.displayName;
      for (const item of Array.isArray(raw.models) ? raw.models : []) {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) continue;
        const model = modelFromConfig(item);
        const previous = entry.models.get(model.id);
        entry.models.set(model.id, previous ? mergeDefined(previous, model) : model);
      }
      providers.set(id, entry);
    }
  }
  return { providers, files: readFiles };
}

/** 运行时目录：llm.listModels + llm.resolveModelInfo，覆盖配置文件没写的内置渠道。 */
async function resolveLlm(ctx) {
  try {
    const llm = ctx.get?.('llm');
    if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') return llm;
  } catch {
    /* 服务缺失按不可用处理 */
  }
  return null;
}

/**
 * 单个供应商的运行时能力。
 *
 * 「思考档现拉」的唯一来源就是这里：resolveModelInfo 返回的 reasoning.efforts
 * 是宿主在当前安装配置下真正会接受的档位（dsh-llm 校验用的就是它）。
 * 配置文件里的 reasoningEfforts 只是喂给宿主的 thinkingLevelMap 预设，
 * 不能直接当作界面可选值——预设写宽了，UI 就会给出必被拒绝的档。
 */
async function runtimeProviderEntry(llm, provider) {
  const entry = { id: provider.id, name: provider.name, models: new Map(), error: null, fetchedAt: Date.now() };
  if (typeof llm.listModels !== 'function') {
    entry.error = 'llm.listModels 不可用';
    return entry;
  }
  let models = [];
  try {
    models = await withTimeout(llm.listModels(entry.id), 1500, 'listModels(' + entry.id + ')');
  } catch (caught) {
    entry.error = String(caught?.message ?? caught);
  }
  for (const raw of Array.isArray(models) ? models : []) {
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0) continue;
    entry.models.set(raw.id, modelFromRuntimeList(raw));
  }
  if (typeof llm.resolveModelInfo !== 'function') return entry;
  await Promise.all(
    [...entry.models.values()].map(async (base) => {
      try {
        const info = await withTimeout(
          llm.resolveModelInfo(entry.id, base.id),
          1500,
          'resolveModelInfo(' + entry.id + '/' + base.id + ')',
        );
        entry.models.set(base.id, mergeRuntimeInfo(base, info));
      } catch {
        /* 单个模型元数据失败只影响能力摘要 */
      }
    }),
  );
  return entry;
}

/** only 为空 → 全量；否则只重拉指定供应商（界面上手动刷新某一家）。 */
async function runtimeCatalog(ctx, only) {
  const llm = await resolveLlm(ctx);
  if (llm === null) return { available: false, providers: [], error: 'llm 服务不可用' };
  let listed = [];
  try {
    listed = llm.listProviders().map((provider) => ({
      id: String(provider.id),
      name: String(provider.name ?? provider.id),
    }));
  } catch (caught) {
    return { available: true, providers: [], error: String(caught?.message ?? caught) };
  }
  if (Array.isArray(only) && only.length > 0) {
    const wanted = new Set(only);
    const known = new Set(listed.map((provider) => provider.id));
    for (const id of wanted) if (!known.has(id)) listed.push({ id, name: id });
    listed = listed.filter((provider) => wanted.has(provider.id));
  }
  const providers = await Promise.all(listed.map((provider) => runtimeProviderEntry(llm, provider)));
  return { available: true, providers, error: null };
}

// ---- 当日缓存 ----
//
// 为什么要有：上游能力（尤其思考档）只能在宿主运行时问出来，每次打开面板都全量问一遍
// 既慢又容易撞上供应商限流。缓存按本地自然日失效：每天第一次打开面板刷新一次，
// 当天后续打开直接读缓存；界面上另有「刷新」按钮按供应商手动重拉。

const CATALOG_CACHE_VERSION = 1;

/** 本地自然日（不用 UTC：用户看到的「今天」是本地今天）。 */
function localDay(now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function catalogCacheFile(home) {
  return path.join(home, 'subagent-model-catalog.json');
}

function readCatalogCache(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogCacheFile(home), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.version !== CATALOG_CACHE_VERSION || !Array.isArray(raw.providers)) return null;
    return raw;
  } catch {
    return null;
  }
}

function entryToJson(entry) {
  return {
    id: entry.id,
    name: entry.name,
    error: entry.error ?? null,
    fetchedAt: Number(entry.fetchedAt) || Date.now(),
    models: [...entry.models.values()].map((model) => ({ ...model })),
  };
}

function entryFromJson(raw) {
  const models = new Map();
  for (const model of Array.isArray(raw?.models) ? raw.models : []) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue;
    models.set(model.id, { ...model, source: 'runtime' });
  }
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? raw?.id ?? ''),
    error: typeof raw?.error === 'string' ? raw.error : null,
    fetchedAt: Number(raw?.fetchedAt) || 0,
    models,
  };
}

/** 原子写缓存；写失败只影响下次是否重拉，不影响本次响应。 */
function writeCatalogCache(home, day, entries) {
  const stamps = entries.map((entry) => Number(entry.fetchedAt) || 0).filter((value) => value > 0);
  const payload = {
    version: CATALOG_CACHE_VERSION,
    day,
    fetchedAt: stamps.length > 0 ? Math.max(...stamps) : Date.now(),
    providers: entries.map(entryToJson),
  };
  try {
    const file = catalogCacheFile(home);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写不进就退化成不缓存 */
  }
  return payload;
}

/**
 * 合并配置口径与运行时口径。
 * 运行时报告过的能力优先（它就是宿主真正接受的口径），配置只补运行时没给的部分。
 */
function finalizeModel(base, runtime) {
  const merged = { ...base };
  if (runtime) {
    if (typeof runtime.name === 'string' && runtime.name.length > 0) merged.name = runtime.name;
    if (typeof runtime.description === 'string') merged.description = runtime.description;
    if (Number.isFinite(runtime.contextWindow)) merged.contextWindow = Number(runtime.contextWindow);
    if (Number.isFinite(runtime.maxTokens)) merged.maxTokens = Number(runtime.maxTokens);
    if (Array.isArray(runtime.inputModalities) && runtime.inputModalities.length > 0) {
      merged.inputModalities = runtime.inputModalities;
    }
    if (runtime.reasoningKnown) {
      merged.reasoningEfforts = runtime.reasoningEfforts ?? [];
      merged.defaultEffort = runtime.defaultEffort;
      merged.effortSource = 'runtime';
    }
    merged.source = base.source === 'config' ? 'config+runtime' : 'runtime';
  }
  const efforts = Array.isArray(merged.reasoningEfforts) ? merged.reasoningEfforts : [];
  const ids = effortIds(efforts);
  merged.reasoningEfforts = efforts;
  merged.defaultEffort =
    merged.defaultEffort !== undefined && ids.includes(merged.defaultEffort)
      ? merged.defaultEffort
      : highestEffort(efforts);
  if (merged.effortSource === undefined && efforts.length > 0) merged.effortSource = 'config';
  return merged;
}

/**
 * 能力目录 = 配置文件的模型定义 ∪ 运行时 llm 目录（带当日缓存）。
 *
 * options.refresh  全量重拉（忽略当日缓存）
 * options.provider 只重拉这一家，其余沿用缓存
 * 都不传时：当天缓存命中就直接用，跨天或没有缓存才现拉。
 */
export async function catalogReport(ctx, options = {}) {
  const home = dshHome(ctx);
  const today = localDay();
  const requestedProvider =
    typeof options.provider === 'string' && options.provider.length > 0 ? String(options.provider) : undefined;
  const cache = readCatalogCache(home);
  // 只刷一家要求当日缓存已经成立：跨天或没缓存时其余家本来就是旧数据，
  // 单刷一家却把整份缓存的日期改成今天，会害得别家今天不再刷新。
  const wantProvider =
    requestedProvider !== undefined && cache !== null && cache.day === today ? requestedProvider : undefined;
  const wantRefresh = options.refresh === true || requestedProvider !== undefined;

  let entries = cache === null ? [] : cache.providers.map(entryFromJson);
  let cached = cache !== null && cache.day === today && !wantRefresh;
  let stale = false;
  let refreshError = null;

  if (!cached) {
    let result;
    try {
      result = await runtimeCatalog(ctx, wantProvider === undefined ? undefined : [wantProvider]);
    } catch (caught) {
      result = { available: false, providers: [], error: String(caught?.message ?? caught) };
    }
    // 店在、货没拿到（供应商鉴权失败/限流）也算刷新失败：不能让空结果把好缓存冲掉。
    const nothingFetched =
      result.available &&
      result.providers.length > 0 &&
      result.providers.every((entry) => entry.error !== null && entry.models.size === 0);
    if (!result.available || nothingFetched) {
      refreshError =
        result.error ??
        result.providers.find((entry) => entry.error !== null)?.error ??
        'llm 服务不可用';
      stale = cache !== null;
      entries = cache === null ? [] : cache.providers.map(entryFromJson);
    } else {
      // 逐家合并：某一家这次没拉到货（鉴权失败/超时），就保留它上次的缓存，
      // 不要因为别家刷新成功而把这一家的模型清单一起清空。
      const previous = new Map(entries.map((entry) => [entry.id, entry]));
      const fresh = result.providers.map((entry) => {
        if (entry.error !== null && entry.models.size === 0) {
          const old = previous.get(entry.id);
          if (old !== undefined && old.models.size > 0) return old;
        }
        return entry;
      });
      if (wantProvider === undefined) {
        entries = fresh;
      } else {
        entries = [...entries.filter((entry) => entry.id !== wantProvider), ...fresh];
      }
      const written = writeCatalogCache(home, today, entries);
      entries = written.providers.map(entryFromJson);
      refreshError = result.error;
    }
  }

  let config = { providers: new Map(), files: [] };
  let configError = null;
  try {
    const yaml = await loadYamlModule();
    config = await configCatalog(home, yaml);
  } catch (caught) {
    configError = String(caught?.message ?? caught);
  }

  const runtimeById = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = new Set([...config.providers.keys(), ...runtimeById.keys()]);
  const providers = [];
  for (const id of ids) {
    const fromConfig = config.providers.get(id);
    const fromRuntime = runtimeById.get(id);
    const models = [];
    const seen = new Set();
    for (const model of fromConfig?.models.values() ?? []) {
      models.push(finalizeModel(model, fromRuntime?.models.get(model.id)));
      seen.add(model.id);
    }
    for (const model of fromRuntime?.models.values() ?? []) {
      if (seen.has(model.id)) continue;
      models.push(finalizeModel(model, undefined));
      seen.add(model.id);
    }
    providers.push({
      id,
      name: fromConfig?.name ?? fromRuntime?.name ?? id,
      source: fromConfig && fromRuntime ? 'config+runtime' : fromConfig ? 'config' : 'runtime',
      error: fromRuntime?.error ?? null,
      fetchedAt: fromRuntime?.fetchedAt ?? null,
      models,
    });
  }
  return {
    generatedAt: Date.now(),
    day: today,
    // stale 时 UI 要显示「这是哪天的缓存」，不能用今天的日期糊过去。
    cacheDay: cache === null ? null : cache.day,
    fetchedAt: cached
      ? cache.fetchedAt ?? null
      : entries.reduce((latest, entry) => Math.max(latest, Number(entry.fetchedAt) || 0), 0) || null,
    cached,
    stale,
    refreshed: wantRefresh ? (wantProvider ?? 'all') : null,
    refreshError,
    llmAvailable: cached || refreshError === null,
    llmError: refreshError,
    configError,
    configFiles: config.files,
    providers,
  };
}

async function handle(ctx, verb, body) {
  if (verb === 'catalog') return catalogReport(ctx);
  if (verb === 'catalog.refresh') {
    // 手动刷新：{ provider } 只重拉一家，缺省全量。会写缓存，所以必须走 POST。
    return catalogReport(ctx, { refresh: true, provider: body?.provider });
  }
  if (verb === 'client.graph') return clientGraphReport(ctx);
  if (verb === 'client.error') {
    // 浏览器半侧渲染异常回传：前端只显示一句“加载失败”，真正原因在这里留痕。
    const message = String(body.message ?? '').slice(0, 4000);
    const stack = String(body.stack ?? '').slice(0, 8000);
    log(ctx, 'warn', `[subagent-pool-ui] 客户端异常：${message}\n${stack}`);
    try {
      const home = dshHome(ctx);
      fs.appendFileSync(
        path.join(home, 'subagent-pool-ui.log'),
        `${new Date().toISOString()} ${message}\n${stack}\n\n`,
        'utf8',
      );
    } catch {
      /* 落盘失败不影响响应 */
    }
    return { ok: true };
  }
  const service = requireService(ctx);
  const readOnly = verb === 'snapshot' || verb === 'describe';

  if (readOnly) {
    return verb === 'snapshot' ? service.snapshot() : { text: service.describe() };
  }

  switch (verb) {
    case 'route.patch':
      await service.patchRoute(String(body.id ?? ''), body.patch ?? {});
      return { ok: true };
    case 'route.add':
      await service.addRoute(body);
      return { ok: true };
    case 'route.remove':
      await service.removeRoute(String(body.id ?? ''));
      return { ok: true };
    case 'route.disable':
      return { ok: true, until: service.disableRoute(String(body.id ?? ''), body.minutes) };
    case 'route.enable':
      service.enableRoute(String(body.id ?? ''));
      return { ok: true };
    case 'settings.patch':
      await service.patchSettings(body.patch ?? body);
      return { ok: true };
    case 'bindings.clear':
      return { ok: true, removed: service.clearBindings() };
    case 'bindings.prune':
      return { ok: true, ...service.pruneBindings() };
    case 'pool.reload':
      await service.reload();
      return { ok: true };
    default:
      throw Object.assign(new Error(`未知操作：${String(verb)}`), { statusCode: 404 });
  }
}

/** 一个极简 JSON API：POST /api/subagent-pool/<verb>。 */
function createApiHandler(ctx) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const verb = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');

    if (verb === '' || !VERBS.has(verb)) {
      sendJson(res, 404, { ok: false, error: `未知接口：${verb}` });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // GET 只允许只读动词，避免用简单请求绕过变更栅栏。
      if (verb !== 'snapshot' && verb !== 'describe' && verb !== 'catalog' && verb !== 'client.graph') {
        sendJson(res, 405, { ok: false, error: '该操作必须使用 POST' });
        return;
      }
      try {
        const data =
          verb === 'catalog'
            ? await catalogReport(ctx)
            : verb === 'client.graph'
              ? clientGraphReport(ctx)
              : verb === 'snapshot'
                ? requireService(ctx).snapshot()
                : { text: requireService(ctx).describe() };
        sendJson(res, 200, { ok: true, data });
      } catch (caught) {
        sendJson(res, Number(caught?.statusCode) || 500, { ok: false, error: String(caught?.message ?? caught) });
      }
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
      return;
    }

    const denied = rejectMutation(req);
    if (denied !== null) {
      sendJson(res, denied.statusCode, { ok: false, error: denied.error });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const data = await handle(ctx, verb, body);
      sendJson(res, 200, { ok: true, data });
    } catch (caught) {
      const status = Number(caught?.statusCode);
      sendJson(res, Number.isInteger(status) ? status : 500, {
        ok: false,
        error: String(caught?.message ?? caught),
      });
    }
  };
}

export async function apply(ctx, config = {}) {
  const prefix =
    typeof config.apiPrefix === 'string' && config.apiPrefix.length > 0 ? config.apiPrefix : API_PREFIX;

  // 路由注册失败只让本行缺 API，不要连累整行 fiber 变 FAILED。
  // 典型触发：同一 profile 里重复挂载导致 duplicate prefix route。
  // 失败时面板会显示「加载失败」，比整行崩掉更好排查。
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: prefix,
          handler: createApiHandler(ctx),
        }),
      'subagent-pool-ui: API routes',
    );
  } catch (caught) {
    log(ctx, 'error', `[subagent-pool-ui] 注册 ${prefix} 失败，模型池面板将不可用：${String(caught)}`);
    return;
  }

  // 挂载心跳：应用不写文件日志，靠这个文件确认插件真的被加载。
  try {
    const home = dshHome(ctx);
    fs.writeFileSync(
      path.join(home, 'subagent-pool-ui.mounted'),
      `${new Date().toISOString()} v=1 api=${prefix} pid=${process.pid} dir=${HERE}\n`,
      'utf8',
    );
  } catch {
    /* 心跳失败不影响插件 */
  }

  log(ctx, 'info', `[subagent-pool-ui] mounted，API 前缀 ${prefix}`);
}
