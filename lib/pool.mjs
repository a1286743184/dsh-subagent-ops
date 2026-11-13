/**
 * subagent-model-pool
 *
 * 给所有子智能体（subagent / subagent_fork / workflow 派生的子代理，以及仍开启时的团队成员）
 * 分配一条固定的模型路由，并做两件事：
 *   1. 均衡：按“当前在跑子代理数 / 权重”选最少占用的那条；score 并列时先比 priority
 *      （数字小者优先，默认 0），仍并列则取最久未分配的，保证长期均匀；
 *   2. 失败避让：子代理请求终态失败且属于可切换错误码时，把该路由打入冷却（后续派发不再选它），
 *      并给这个子代理换到池内下一条；换路走官方 agent.model.select()，从它的下一步生效。
 *
 * 寻路方式（硬约束，勿改回请求覆写）：
 *   只在步进之前用官方持久选择 agent.model.select({provider, model, reasoningEffort}) 固定路由。
 *   agent-loop 每步 preStep 先读 model.current() 把 selection 定死，随后 prepareRequest 校验
 *   agent/request waterfall 的返回必须与该 selection 全等，不一致直接抛错终止子代理
 *   （"agent/request proposed ... after step preparation fixed ..."）。
 *   因此绝不能在 agent/request / system-prompt/assemble 上覆写 provider/model/reasoningEffort。
 *
 * 设计约束：
 *   - 只使用 Node 内置模块；YAML 解析优先用 profile 内已安装的 js-yaml，缺失时只支持 .json 池文件。
 *   - 不改任何官方插件代码，全部通过公开扩展点（agent/created、agent/request 等 waterfall）实现。
 *   - 池配置支持热加载：轮询池文件，改完保存即对“下一次分配”生效，不需要重启应用。
 *   - 不依赖 agentTeams 服务：智能体团队关闭（乃至整个团队 bundle 移除）后照常工作。
 *
 * 占位口径：
 *   判定依据是“此刻是否真的在产生上游请求”，不是“会话存在”：
 *     - 在跑（status === running）的子代理占位；
 *     - 空闲（status !== running）的子代理默认不占位，可用 idleSubagentHoldsSlot 改回；
 *     - 在跑但会话序号超过 staleSubagentMs 没有推进的（工具悬挂、轮次不结束）判定卡死，
 *       停止占位并告警，绑定仍保留；团队成员这类长期驻留对象会走到这里；
 *     - 主 Agent（Lead）只在 running 时计负载：闲置会话停留在某条路由上不应永久压满它。
 *   ---------------------------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * 纯函数：在候选里按 score → priority → lastAssigned 取最小，返回命中的 route。
 *
 * 抽到模块级只有一个原因：这段比较顺序是「权重先、同级再分先后」的唯一真源，
 * 放在 apply 闭包里就没法测。score 由调用方算好（占用/权重），这里只比大小。
 */
export function pickByLoad(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const better =
      candidate.score < best.score ||
      (candidate.score === best.score && candidate.priority < best.priority) ||
      (candidate.score === best.score && candidate.priority === best.priority && candidate.last < best.last);
    if (better) best = candidate;
  }
  return best === null ? undefined : best.route;
}

export const name = 'subagent-model-pool';
export const inject = ['agents', 'tools'];

/** 可触发“换上游重试”的失败码；其余失败（上下文超限、参数错、鉴权）换哪条都没用。 */
const SWITCHABLE_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

const DEFAULTS = {
  scope: 'all-subagents', // all-subagents = 所有子智能体（默认）；team = 只作用于团队成员（旧口径）
  sticky: true, // 同一会话再次唤醒时沿用上次的路由，保住 KV 缓存前缀
  countLead: true, // 主 Agent（Leader）自身占用的池内路由也计入负载
  countLeadWhenIdle: false, // Leader 闲置时是否仍计负载（默认否：闲置会话不该永久压满一条路由）
  idleSubagentHoldsSlot: false, // 空闲但驻留的子代理是否继续占位（默认否：不产生负载就不压路由；轮转由 lastAssigned 保证）
  staleSubagentMs: 30 * 60 * 1000, // 在跑但会话久不推进，超过此时长判定卡死并停止占位
  watchIntervalMs: 2000,
  cooldownMs: 120000,
  maxSwitches: 2,
  bindingTtlMs: 7 * 24 * 60 * 60 * 1000,
  leaseTtlMs: 60000,
  leaseRenewMs: 15000,
  routes: [],
};

const TUNABLES = [
  'scope',
  'sticky',
  'countLead',
  'countLeadWhenIdle',
  'idleSubagentHoldsSlot',
  'staleSubagentMs',
  'watchIntervalMs',
  'cooldownMs',
  'maxSwitches',
  'bindingTtlMs',
  'leaseTtlMs',
  'leaseRenewMs',
];

function log(ctx, level, message) {
  const logger = ctx?.logger;
  const sink = logger?.[level];
  if (typeof sink === 'function') {
    try {
      sink.call(logger, message);
      return;
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

function resolveHome(ctx) {
  try {
    const homePath = ctx.get?.('dshHomePath');
    if (typeof homePath === 'function') {
      const value = homePath();
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    /* 回落到 ~/.dsh */
  }
  return path.join(os.homedir(), '.dsh');
}

/** 把一条原始路由规范化为内部结构；缺 provider/model 的条目直接丢弃。 */
function normalizeRoute(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (provider.length === 0 || model.length === 0) return null;
  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : `${provider}/${model}`;
  const weight =
    Number.isFinite(raw.weight) && raw.weight > 0 ? Number(raw.weight) : 1;
  // 同负载先后次序：数字越小越优先，默认 0。
  // 只作 score 并列时的 tie-break，不参与容量比例（容量仍由 weight 决定）。
  const priority = Number.isFinite(raw.priority) ? Math.trunc(Number(raw.priority)) : 0;
  const reasoningEffort =
    typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.length > 0
      ? raw.reasoningEffort
      : undefined;
  return {
    id,
    provider,
    model,
    weight,
    priority,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    enabled: raw.enabled !== false,
  };
}

function normalizeRoutes(rawRoutes) {
  const seen = new Set();
  const routes = [];
  for (const raw of Array.isArray(rawRoutes) ? rawRoutes : []) {
    const route = normalizeRoute(raw);
    if (route === null || seen.has(route.id)) continue;
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
}

/**
 * 按 profile 基准解析 YAML 库。
 *
 * 为什么不能直接 `import('js-yaml')`：本包是 link 安装，模块按**真实路径**
 * `.../packages/dsh-subagent-ops/lib`（link 指向的真实路径）解析，
 * 仓库里没有 node_modules，裸 specifier 必然 ERR_MODULE_NOT_FOUND。
 * 依赖装在 profile 下（`~/.dsh/profiles/<name>/node_modules`），
 * 所以要从 profile 目录作为基准去 require。
 *
 * 早期写法直接 import 且把异常吞成 null，表现是池文件读不出、routes 恒为 0，
 * 只有一行 warn，界面上看不出所以然。这里改成：逐个基准尝试，
 * 全失败时抛出带全部候选路径的错误，让 reload 的 warn 能说清原因。
 *
 * @param preference 需要的能力：`load`（读取）优先 js-yaml，
 *   `parseDocument`（保留注释写回）只能用 yaml 库。
 */
async function loadYamlLibrary(preference = 'load') {
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
  // 兼容从 profile 内部加载的场景（此时相对解析本来就能成功）。
  bases.push(path.join(process.cwd(), 'package.json'));

  const order = preference === 'parseDocument' ? ['yaml'] : ['js-yaml', 'yaml'];
  const tried = [];
  for (const base of bases) {
    for (const specifier of order) {
      try {
        const require = createRequire(base);
        const resolved = require.resolve(specifier);
        const module = await import(pathToFileURL(resolved).href);
        const lib = module.default ?? module;
        if (specifier === 'js-yaml' && typeof lib.load === 'function') return { kind: 'js-yaml', lib };
        if (specifier === 'yaml' && typeof lib.parse === 'function') return { kind: 'yaml', lib };
        tried.push(`${specifier} @ ${base}：接口不符`);
      } catch (error) {
        tried.push(`${specifier} @ ${base}：${String(error?.code ?? error?.message ?? error)}`);
      }
    }
  }
  throw new Error(`找不到可用的 YAML 库（js-yaml / yaml）。已尝试：\n  ${tried.join('\n  ')}`);
}

async function readPoolFile(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.json') return JSON.parse(text);
  const { kind, lib } = await loadYamlLibrary();
  return kind === 'js-yaml' ? lib.load(text) : lib.parse(text);
}

function readStateFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    /* 首次运行或文件损坏，按空状态处理 */
  }
  return { disabled: {} };
}

function writeStateFile(file, state) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(`写入 ${file} 失败：${String(error)}`);
  }
}

/** 判定某个 Agent 是否归本插件管辖。 */
function isEligible(ctx, agent, scope) {
  const header = agent?.session?.header;
  if (header === undefined || header === null) return false;
  if (header.origin !== 'subagent') return false;
  if (scope === 'all-subagents') return true;
  if (header.delegationDepth !== 1) return false;
  const parentId = header.parentSession;
  if (parentId === undefined) return false;
  let parent;
  try {
    parent = ctx.agents.get(parentId);
  } catch {
    return false;
  }
  if (parent === undefined) return false;
  const teams = ctx.get?.('agentTeams');
  if (teams === undefined || typeof teams.tryMembership !== 'function') return false;
  try {
    return teams.tryMembership(parent)?.role === 'lead';
  } catch {
    return false;
  }
}

export async function apply(ctx, config = {}) {
  const home = resolveHome(ctx);
  const poolFile =
    typeof config.poolFile === 'string' && config.poolFile.length > 0
      ? config.poolFile
      : path.join(home, 'subagent-model-pool.yaml');
  const stateFile =
    typeof config.stateFile === 'string' && config.stateFile.length > 0
      ? config.stateFile
      : path.join(home, 'subagent-model-pool.state.json');

  const persisted = readStateFile(stateFile);
  const runtime = {
    // 先用 DEFAULTS 铺满全部可调项，再由 config / 池文件覆盖。
    // 少了这一步，未显式配置的项会是 undefined（例如 idleSubagentHoldsSlot !== false 恒为真），
    // 默认值就静默失效了。
    ...Object.fromEntries(TUNABLES.map((key) => [key, DEFAULTS[key]])),
    routes: [],
    /** agentId -> 绑定的 routeId */
    active: new Map(),
    /** routeId -> 绑定到它的成员数（仅记账，真实负载见 subagentOccupancy） */
    counts: new Map(),
    /** routeId -> 冷却截止时间戳 */
    cooldown: new Map(),
    /** routeId -> 最近一次分配时间戳 */
    lastAssigned: new Map(),
    /** agentId -> 已切换次数 */
    switches: new Map(),
    /**
     * agentId -> 活跃度采样 { seq, running, changedAt }。
     * 团队成员不会被主 Agent 回收，所以“存在”不等于“在占位”：
     * 用会话序号推进判断它是否真的在干活，久不推进即视为卡死并停止占位。
     */
    liveness: new Map(),
    /** 人工禁用：routeId -> true 或截止时间戳 */
    manualDisabled: persisted.disabled ?? {},
    /**
     * 粘滞绑定：会话 id -> { routeId, updatedAt }。
     * 团队成员被回收后再次唤醒时是同一个会话 id，命中绑定即可沿用上一轮的模型，
     * 保住该会话已缓存的 KV 前缀。
     */
    bindings: new Map(
      Object.entries(persisted.bindings ?? {}).map(([sessionId, value]) => [
        sessionId,
        { routeId: String(value?.routeId ?? value), updatedAt: Number(value?.updatedAt ?? 0) },
      ]),
    ),
  };

  for (const key of TUNABLES) {
    if (config[key] !== undefined) runtime[key] = config[key];
  }
  runtime.routes = normalizeRoutes(config.routes);
  runtime.stateFile = stateFile;
  runtime.sharedFile =
    typeof config.sharedFile === 'string' && config.sharedFile.length > 0
      ? config.sharedFile
      : path.join(home, 'subagent-model-pool.shared.json');

  const isManuallyDisabled = (routeId, now) => {
    const value = runtime.manualDisabled[routeId];
    if (value === undefined || value === false) return false;
    if (value === true) return true;
    return typeof value === 'number' && value > now;
  };

  const isAvailable = (route, now) =>
    route.enabled &&
    route.weight > 0 &&
    !isManuallyDisabled(route.id, now) &&
    (runtime.cooldown.get(route.id) ?? 0) <= now;

  // ---- 跨进程共享占用（租约） ----
  // 同一台机器上可能同时跑多个 DSH 实例；每个实例把自己占用的路由以“租约”写进共享文件，
  // 选路时把别人的占用也算进来。租约靠心跳续期，进程异常退出后由 TTL 自然过期。
  const sharedPath = runtime.sharedFile;
  const lockPath = `${sharedPath}.lock`;
  const ownPrefix = `${process.pid}:`;

  const sleepSync = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      /* 环境不支持时退化为忙等 */
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* spin */
      }
    }
  };

  const readShared = () => {
    try {
      const data = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
      if (data !== null && typeof data === 'object' && typeof data.leases === 'object') return data;
    } catch {
      /* 文件不存在或损坏，按空处理 */
    }
    return { leases: {} };
  };

  const pruneLeases = (data, now) => {
    let changed = false;
    for (const [id, lease] of Object.entries(data.leases ?? {})) {
      if (
        lease === null ||
        typeof lease !== 'object' ||
        typeof lease.renewedAt !== 'number' ||
        now - lease.renewedAt > runtime.leaseTtlMs
      ) {
        delete data.leases[id];
        changed = true;
      }
    }
    return changed;
  };

  const writeSharedAtomic = (data) => {
    const temp = `${sharedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, sharedPath);
  };

  /** 极短临界区的文件锁；持锁进程异常退出时按 mtime 清理陈旧锁。 */
  const withSharedLock = (fn) => {
    const deadline = Date.now() + 800;
    let locked = false;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.closeSync(fd);
        locked = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') break;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 5000) fs.rmSync(lockPath, { force: true });
        } catch {
          /* 锁刚被释放 */
        }
        sleepSync(5);
      }
    }
    if (!locked) return undefined;
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  };

  /** 其他实例（排除本进程）在各路由上的占用数。 */
  const externalCounts = () => {
    const data = readShared();
    const now = Date.now();
    const counts = new Map();
    let stale = false;
    for (const [id, lease] of Object.entries(data.leases ?? {})) {
      if (
        lease === null ||
        typeof lease !== 'object' ||
        typeof lease.renewedAt !== 'number' ||
        now - lease.renewedAt > runtime.leaseTtlMs
      ) {
        stale = true;
        continue;
      }
      if (id.startsWith(ownPrefix)) continue;
      counts.set(lease.routeId, (counts.get(lease.routeId) ?? 0) + 1);
    }
    if (stale) {
      withSharedLock(() => {
        const fresh = readShared();
        if (pruneLeases(fresh, Date.now())) writeSharedAtomic(fresh);
      });
    }
    return counts;
  };

  /**
   * 采样一个子代理的活跃度，并判断它此刻是否真的在占用上游。
   *
   * 占位依据不是“会话存在”，而是“此刻是否真的在推进”：
   *   - running 且会话序号在 staleSubagentMs 内推进过 -> 在跑，占位；
   *   - running 但序号久不推进（工具调用悬挂 / 轮次永远不结束）-> 卡死，停止占位；
   *   - idle -> 按 idleSubagentHoldsSlot 决定（默认不占位）。
   *
   * 为什么只能用会话序号：agent/request 是“组装请求参数”的瀑布，在网络调用前就返回了，
   * 不能用来表示请求在飞；流式推理期间会话不写事件，所以序号是唯一可靠的公开推进信号。
   * 因此 staleSubagentMs 必须显著大于上游 streamIdleTimeoutMs（默认 10 分钟），
   * 否则会把一次正常的长推理误判成卡死。误判的代价只是暂时少算一个占位（新子代理可能
   * 与它同路由），不会丢消息、不会改绑定，恢复推进后自动重新占位。
   *
   * @param agent - 已绑定路由的子代理 Agent。
   * @returns 是否需要占位，以及判定依据。
   */
  const sampleSlot = (agent) => {
    const now = Date.now();
    const running = agent?.status === 'running';
    let seq;
    try {
      seq = Number(agent.session?.seq ?? 0);
    } catch {
      seq = 0;
    }
    const previous = runtime.liveness.get(agent.id);
    if (previous === undefined || previous.seq !== seq) {
      runtime.liveness.set(agent.id, { seq, running, changedAt: now });
    } else if (previous.running !== running) {
      previous.running = running;
      previous.changedAt = now;
    }
    const stamp = runtime.liveness.get(agent.id);
    if (!running) {
      return { holding: runtime.idleSubagentHoldsSlot !== false, stale: false, silentFor: 0 };
    }
    const silentFor = now - stamp.changedAt;
    const stale = Number(runtime.staleSubagentMs) > 0 && silentFor > Number(runtime.staleSubagentMs);
    return { holding: !stale, stale, silentFor };
  };

  /** 按路由统计当前真正占位的子代理数（每次现算，卡死判定随时间自然生效）。 */
  const subagentOccupancy = () => {
    const map = new Map();
    const holding = new Set();
    const stale = new Set();
    for (const [agentId, routeId] of runtime.active) {
      const agent = safeAgent(agentId);
      // Agent 已不在注册表里（正常结算或进程重建），不再占位
      if (agent === undefined) continue;
      const slot = sampleSlot(agent);
      if (slot.stale) stale.add(agentId);
      if (!slot.holding) continue;
      holding.add(agentId);
      map.set(routeId, (map.get(routeId) ?? 0) + 1);
    }
    return { map, holding, stale };
  };

  const safeAgent = (agentId) => {
    try {
      return ctx.agents.get(agentId);
    } catch {
      return undefined;
    }
  };

  /** 主 Agent（Leader）当前使用的路由，若在池内则返回路由 id。 */
  const leadRouteId = (agent) => {
    let provider;
    let model;
    try {
      const config = agent.session.requestHeader()?.config;
      provider = config?.provider ?? agent.options?.provider;
      model = config?.model ?? agent.options?.model;
    } catch {
      provider = agent.options?.provider;
      model = agent.options?.model;
    }
    if (provider === undefined || model === undefined) return undefined;
    const route = runtime.routes.find((candidate) => candidate.provider === provider && candidate.model === model);
    return route?.id;
  };

  /** 把本进程的占用（真正占位的子代理 + 在跑的主 Agent）写进共享文件，并清理自己过期的租约。 */
  const publishLeases = () => {
    const now = Date.now();
    const { holding } = subagentOccupancy();
    withSharedLock(() => {
      const data = readShared();
      pruneLeases(data, now);
      for (const id of Object.keys(data.leases ?? {})) {
        if (id.startsWith(ownPrefix)) delete data.leases[id];
      }
      // 只为真正占位的子代理续租：空闲子代理按配置决定，卡死子代理从这一刻起停止占位
      for (const agentId of holding) {
        const routeId = runtime.active.get(agentId);
        if (routeId === undefined) continue;
        data.leases[`${ownPrefix}subagent:${agentId}`] = {
          kind: 'subagent',
          routeId,
          sessionId: agentId,
          renewedAt: now,
        };
      }
      if (runtime.countLead !== false) {
        for (const agent of ctx.agents.list()) {
          if (agent.session?.header?.parentSession !== undefined) continue;
          const routeId = leadRouteId(agent);
          if (routeId === undefined) continue;
          if (!leadHoldsSlot(agent)) continue;
          data.leases[`${ownPrefix}lead:${agent.id}`] = {
            kind: 'lead',
            routeId,
            sessionId: agent.id,
            renewedAt: now,
          };
        }
      }
      writeSharedAtomic(data);
    });
  };

  /** 主 Agent 是否计负载：在跑时必计；闲置时按 countLeadWhenIdle（默认不计）。 */
  const leadHoldsSlot = (agent) => {
    if (runtime.countLead === false) return false;
    if (agent?.status === 'running') return true;
    return runtime.countLeadWhenIdle === true;
  };

  /** 本进程内所有主 Agent（Leader）在池内的路由占用。 */
  const leadOccupancy = () => {
    const map = new Map();
    if (runtime.countLead === false) return map;
    let agents = [];
    try {
      agents = ctx.agents.list();
    } catch {
      return map;
    }
    for (const agent of agents) {
      if (agent.session?.header?.parentSession !== undefined) continue;
      if (!leadHoldsSlot(agent)) continue;
      const routeId = leadRouteId(agent);
      if (routeId === undefined) continue;
      map.set(routeId, (map.get(routeId) ?? 0) + 1);
    }
    return map;
  };

  /**
   * 加权最少在跑 + 同负载按 priority 先后 + 仍并列取最久未分配。
   * 占用 = 本进程占位子代理 + 在跑主 Agent + 其他实例租约。
   *
   * 比较顺序：score（越小越好）→ priority（越小越优先）→ lastAssigned（越早越优先）。
   * priority 只在 score 完全相等时生效，因此它表达的是「负载一样时先给谁」，
   * 不会压过权重：weight 仍然决定容量比例，只是同一负载档位内多了一把次序尺。
   */
  const pickRoute = (excludeId) => {
    const now = Date.now();
    const external = externalCounts();
    const leads = leadOccupancy();
    const { map: members } = subagentOccupancy();
    const candidates = [];
    for (const route of runtime.routes) {
      if (route.id === excludeId) continue;
      if (!isAvailable(route, now)) continue;
      const local = members.get(route.id) ?? 0;
      const total = local + (leads.get(route.id) ?? 0) + (external.get(route.id) ?? 0);
      candidates.push({
        route,
        score: total / route.weight,
        priority: route.priority ?? 0,
        last: runtime.lastAssigned.get(route.id) ?? 0,
      });
    }
    return pickByLoad(candidates);
  };

  /**
   * 子代理真正结算时（agent/disposed）才走到这里：释放绑定、停掉请求拦截、清掉活跃度采样。
   *
   * 注意：若智能体团队仍开着，团队成员常常永远不会走到这里——roster 条目是永久的，
   * 主 Agent 没有销毁 API，一个成员如果一直卡在悬挂的轮次里，它的 Agent 就一直活着。
   * 所以占位不能只依赖这个回调，另有 sampleSlot 的卡死判定兜底。
   */
  const releaseAgent = (agentId) => {
    const routeId = runtime.active.get(agentId);
    runtime.liveness.delete(agentId);
    runtime.switches.delete(agentId);
    liveSelections.delete(agentId);
    if (routeId === undefined) return;
    runtime.active.delete(agentId);
    const next = (runtime.counts.get(routeId) ?? 1) - 1;
    if (next > 0) runtime.counts.set(routeId, next);
    else runtime.counts.delete(routeId);
  };

  let warnedNoSelect = false;

  /**
   * agentId -> 本步 `decision.selection` 的**活对象引用**。
   *
   * 为什么需要持有它：`preStep()` 里 `const selection = this.model.current()` 得到一个
   * 可变对象，原样作为 `agent/pre-step` 的 `modelSelection` 传进 waterfall，随后又原样
   * 放进 `decision.selection`；`step()` 的整个重试循环都只用这一个对象。池换路要影响
   * 「本步内的下一次重试」，就必须改这个对象本身，而不是再调一次 `select()`。
   *
   * 监听器注册在根 ctx 上、按 agent id 记账：这是 `subagent-watch` 已经实测可用的
   * 同一条分发路径（`agentEvents().waterfall` 走 `ctx.waterfall(carrier, ...)`），
   * 比赌「子代理自己的 scope 能否收到该事件」可靠。
   */
  const liveSelections = new Map();

  const disposeSelectionWatch = ctx.on('agent/pre-step', (payload, next) => {
    try {
      const id = payload?.agent?.id;
      const selection = payload?.modelSelection;
      if (typeof id === 'string' && selection !== null && typeof selection === 'object') {
        liveSelections.set(id, selection);
      }
    } catch {
      /* 记账失败不影响步进 */
    }
    return next();
  });

  /**
   * 用官方持久选择把子智能体钉到一条路由上。
   * 这是宿主支持的唯一寻路入口：selection 在 preStep 之前定下，请求层自然一致。
   * @returns 是否成功落上；失败时调用方不得记账。
   */
  const applyRoute = (agent, route) => {
    const select = agent.model?.select;
    if (typeof select !== 'function') {
      if (!warnedNoSelect) {
        warnedNoSelect = true;
        log(ctx, 'warn', '[subagent-model-pool] Agent 不提供 model.select()，本次不分派路由（宿主版本不支持持久选择）');
      }
      return false;
    }
    try {
      select.call(agent.model, {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      });
      return true;
    } catch (error) {
      log(ctx, 'warn', `[subagent-model-pool] 子代理 ${agent.id.slice(0, 8)} 选择 ${route.id} 失败：${String(error)}`);
      return false;
    }
  };

  /**
   * 把「换路」推给**正在进行的这一步**。
   *
   * 为什么单靠 `agent.model.select()` 不够（2026-11-10 实测，会话 ff29020d）：
   * `agent-loop` 的 `step()` 在进入重试循环前就把 selection 固定成 `decision.selection`
   * （= `preStep()` 里 `this.model.current()` 的返回值），循环内每次 `prepareRequest()`
   * 读的都是**那个对象**，不再读 `model.current()`。所以 `select()` 只影响下一个
   * step/turn；而本步若最终失败，整个 turn 直接以 error 结束，下一个 step 根本不存在。
   * 结果是：池换了路、冷却了路由、烧掉了 maxSwitches，重试却仍然打在同一条死路由上
   * （日志：model/selection 已切到 minimax-global，随后 5 次 llm/retry 全部 FAIL Qoder）。
   *
   * 官方 waterfall 把 `modelSelection` 原对象传给了 `agent/pre-step`，而 `preStep()`
   * 之后把**同一个对象**放进 `decision.selection`。因此在这里持有该对象引用，失败时
   * 就地改写它，下一次 `prepareRequest()` 就会用新路由；`select()` 负责持久化，
   * 两者配合才对「本步内」和「后续步」都生效。
   *
   * 安全边界：只在对象确实是「当前 selection」时改写；任何异常都吞掉并退回
   * 「只靠 select 下一步生效」的旧行为，绝不因为寻路失败而打断子代理。
   */
  const forceLiveSelection = (agent, failed, alternative) => {
    const live = liveSelections.get(agent.id);
    if (live === undefined || live === null || typeof live !== 'object') return false;
    if (live.provider !== failed.provider || live.model !== failed.model) return false;
    try {
      live.provider = alternative.provider;
      live.model = alternative.model;
      if (alternative.reasoningEffort === undefined) delete live.reasoningEffort;
      else live.reasoningEffort = alternative.reasoningEffort;
      return true;
    } catch (error) {
      log(ctx, 'warn', `[subagent-model-pool] 改写在飞 selection 失败：${String(error)}`);
      return false;
    }
  };

  /**
   * 监听该子智能体的请求终态失败：失败路由打入冷却，并给它换一条。
   *
   * 换路要同时做两件事，缺一不可：
   *   1. `agent.model.select()` —— 持久化，决定后续 step/turn 与冷恢复后的路由；
   *   2. 改写 `decision.selection` 那个活对象 —— 决定**本步内**官方 llm-retry 的
   *      下一次尝试打哪条上游。只有 1 而没有 2 时，重试仍会打旧路由直到把
   *      retryPolicy 的 5 次全部耗光（每次可能是 600s 空闲超时）。
   *
   * 本监听仍然不产出重试决定：重试次数与退避属于官方 llm-retry，我们只负责
   * 「下一次尝试换一条上游」。
   */
  const observeAgent = (agent, route) => {
    const live = { route };

    const dispose = agent.ctx.on(
      'agent/request-error',
      async (payload, next) => {
        const failure = payload?.failure;
        const failed = live.route;
        if (failure === undefined || failed === undefined) return next();
        if (!SWITCHABLE_CODES.has(failure.code)) return next();
        if (payload?.signal?.aborted === true) return next();

        // ---- 无论还能不能换路，失败证据都必须记账 ----
        //
        // 旧实现只在「还能换路」时冷却路由并改写绑定；一旦 maxSwitches 用尽就
        // 直接 return，把**那条刚失败的绑定原样留着**。后果（2026-11-10 实测，
        // 会话 469f40af）：子代理死后被 autoRevive 冷恢复，`stickyRoute()` 命中
        // 仍指向死路由的绑定，于是复活第一件事就是再撞一次 Qoduck，又卡在
        // step/start 直到 600s 空闲超时——续命等于白救。
        //
        // 所以现在：冷却与「拆掉失败绑定」是**无条件**的，换路才是可选的。
        // 绑定一拆，下一次 assign（含冷恢复）就按最少占用重新选，不会再回死路由。
        runtime.cooldown.set(failed.id, Date.now() + runtime.cooldownMs);
        const hadBinding = runtime.bindings.has(agent.id);
        if (hadBinding) {
          runtime.bindings.delete(agent.id);
          persistState();
        }

        if ((runtime.switches.get(agent.id) ?? 0) >= runtime.maxSwitches) {
          if (hadBinding) {
            log(
              ctx,
              'warn',
              `[subagent-model-pool] 子代理 ${agent.id.slice(0, 8)} 在 ${failed.id} 上失败(${failure.code})，换路次数已用尽；已拆掉指向该路由的粘滞绑定，下一次分配将重新选路`,
            );
          }
          return next();
        }

        const alternative = pickRoute(failed.id);
        if (alternative === undefined) return next();

        runtime.switches.set(agent.id, (runtime.switches.get(agent.id) ?? 0) + 1);
        if (!applyRoute(agent, alternative)) return next();
        // 改写本步在飞的 selection：否则官方 llm-retry 的下一次尝试仍打旧路由
        const liveRewritten = forceLiveSelection(agent, failed, alternative);
        live.route = alternative;
        // 换路即改占位：旧路由计数让位，新路由接手，保证负载账本与真实占用一致
        const previousId = runtime.active.get(agent.id);
        if (previousId !== undefined && previousId !== alternative.id) {
          const left = (runtime.counts.get(previousId) ?? 1) - 1;
          if (left > 0) runtime.counts.set(previousId, left);
          else runtime.counts.delete(previousId);
        }
        runtime.active.set(agent.id, alternative.id);
        runtime.counts.set(alternative.id, (runtime.counts.get(alternative.id) ?? 0) + 1);
        // 切换后同步粘滞绑定：下次唤醒沿用切换后的路由，而不是又跳回失败的那条
        rememberBinding(agent.id, alternative.id);
        persistState();
        publishLeases();
        log(
          ctx,
          'warn',
          `[subagent-model-pool] 子代理 ${agent.id.slice(0, 8)} 在 ${failed.id} 上失败(${failure.code})，该路由冷却 ${Math.round(runtime.cooldownMs / 1000)}s；已改用 ${alternative.id}（第 ${runtime.switches.get(agent.id)} 次${liveRewritten ? '，本步重试即生效' : '，下一步生效'}）`,
        );
        return next();
      },
      { prepend: true },
    );

    return {
      dispose() {
        try {
          dispose();
        } catch {
          /* 已释放 */
        }
      },
    };
  };

  const bound = new Map(); // agentId -> { routeId, dispose }

  /** 粘滞绑定命中：同一会话沿用上次路由，前提是该路由当前可用。 */
  const stickyRoute = (agentId) => {
    if (runtime.sticky === false) return undefined;
    const binding = runtime.bindings.get(agentId);
    if (binding === undefined) return undefined;
    const route = runtime.routes.find((candidate) => candidate.id === binding.routeId);
    if (route === undefined || !isAvailable(route, Date.now())) return undefined;
    return route;
  };

  const rememberBinding = (agentId, routeId) => {
    if (runtime.sticky === false) return;
    runtime.bindings.set(agentId, { routeId, updatedAt: Date.now() });
  };

  const persistState = () => {
    writeStateFile(stateFile, {
      disabled: runtime.manualDisabled,
      bindings: Object.fromEntries(
        [...runtime.bindings].map(([sessionId, binding]) => [
          sessionId,
          { routeId: binding.routeId, updatedAt: binding.updatedAt },
        ]),
      ),
    });
  };

  const assign = (agent) => {
    if (bound.has(agent.id)) return;
    if (!isEligible(ctx, agent, runtime.scope)) return;
    const sticky = stickyRoute(agent.id);
    const route = sticky ?? pickRoute(undefined);
    if (route === undefined) {
      log(ctx, 'warn', '[subagent-model-pool] 池内没有可用路由，该子代理继承父 Agent 的模型');
      return;
    }
    if (!applyRoute(agent, route)) return;
    const handle = observeAgent(agent, route);
    bound.set(agent.id, { routeId: route.id, dispose: handle.dispose });
    runtime.active.set(agent.id, route.id);
    runtime.counts.set(route.id, (runtime.counts.get(route.id) ?? 0) + 1);
    runtime.lastAssigned.set(route.id, Date.now());
    // 立刻建立活跃度基线：从这一刻起算“多久没推进会话”
    runtime.liveness.delete(agent.id);
    sampleSlot(agent);
    if (sticky === undefined) {
      rememberBinding(agent.id, route.id);
      persistState();
    }
    publishLeases();
    log(
      ctx,
      'info',
      `[subagent-model-pool] 子代理 ${agent.id.slice(0, 8)} -> ${route.id} (${route.provider}/${route.model})${sticky === undefined ? '' : '（粘滞沿用）'}`,
    );
  };

  const release = (agent) => {
    const entry = bound.get(agent.id);
    if (entry === undefined) return;
    entry.dispose();
    bound.delete(agent.id);
    releaseAgent(agent.id);
    publishLeases();
  };

  ctx.on('agent/created', ({ agent }) => assign(agent));
  ctx.on('agent/disposed', ({ agent }) => release(agent));

  for (const agent of ctx.agents.list()) assign(agent);

  // ---- 池文件热加载 ----
  const applyFileConfig = (data) => {
    if (data === null || typeof data !== 'object') return false;
    for (const key of TUNABLES) {
      if (data[key] !== undefined) runtime[key] = data[key];
    }
    const routes = normalizeRoutes(data.routes);
    if (routes.length === 0) return false;
    runtime.routes = routes;
    return true;
  };

  const reload = async (reason) => {
    try {
      const data = await readPoolFile(poolFile);
      if (!applyFileConfig(data)) {
        runtime.loadError = `${poolFile} 没有有效 routes`;
        log(ctx, 'warn', `[subagent-model-pool] ${runtime.loadError}，忽略本次加载`);
        return;
      }
      runtime.loadError = null;
      log(
        ctx,
        'info',
        `[subagent-model-pool] 已加载 ${runtime.routes.length} 条路由${reason === undefined ? '' : `（${reason}）`}`,
      );
    } catch (error) {
      // 池读不出来时 routes 会恒为 0，界面上只是「没有路由」，看不出原因。
      // 把原因留在 runtime 上，由 snapshot 带出去，别只写一行日志。
      runtime.loadError = String(error?.message ?? error);
      log(ctx, 'warn', `[subagent-model-pool] 读取 ${poolFile} 失败，继续使用上一次配置：${runtime.loadError}`);
    }
  };

  await reload('启动');

  ctx.effect(() => {
    fs.watchFile(poolFile, { interval: runtime.watchIntervalMs }, () => {
      void reload('热加载');
    });
    return () => fs.unwatchFile(poolFile);
  }, 'subagent-model-pool: watch pool file');

  // ---- 模型面工具 ----
  const describe = () => {
    const now = Date.now();
    const external = externalCounts();
    const leads = leadOccupancy();
    const { map: subagentCounts } = subagentOccupancy();
    const lines = [];
    lines.push(
      `subagent-model-pool  路由 ${runtime.routes.length} 条  scope=${runtime.scope}  sticky=${runtime.sticky !== false}  countLead=${runtime.countLead !== false}(闲置${runtime.countLeadWhenIdle === true ? '计' : '不计'})  空闲子代理${runtime.idleSubagentHoldsSlot === false ? '不' : ''}占位  cooldown=${Math.round(runtime.cooldownMs / 1000)}s  maxSwitches=${runtime.maxSwitches}`,
    );
    lines.push('id\tprovider\tmodel\tw\tp\t子代理\tLeader\t其他实例\t冷却\t状态');
    for (const route of runtime.routes) {
      const until = runtime.cooldown.get(route.id) ?? 0;
      const cooling = until > now ? `${Math.ceil((until - now) / 1000)}s` : '-';
      const state = !route.enabled
        ? '停用'
        : isManuallyDisabled(route.id, now)
          ? '人工禁用'
          : until > now
            ? '冷却'
            : 'ok';
      lines.push(
        `${route.id}\t${route.provider}\t${route.model}\t${route.weight}\t${route.priority ?? 0}\t${subagentCounts.get(route.id) ?? 0}\t${leads.get(route.id) ?? 0}\t${external.get(route.id) ?? 0}\t${cooling}\t${state}`,
      );
    }
    lines.push('');
    lines.push('当前子代理分配（占位=此刻计入负载；卡死=在跑但会话久不推进，已停止占位）：');
    if (runtime.active.size === 0) lines.push('(无)');
    for (const [agentId, routeId] of runtime.active) {
      const agent = safeAgent(agentId);
      const slot = agent === undefined ? { holding: false, stale: false } : sampleSlot(agent);
      const label = agent === undefined ? '已结算' : slot.stale ? '卡死' : slot.holding ? '占位' : '空闲未占位';
      const age = runtime.liveness.get(agentId);
      const silent = age === undefined ? '-' : `${Math.round((now - age.changedAt) / 1000)}s`;
      lines.push(`- ${agentId.slice(0, 8)} -> ${routeId}  [${label}] 距上次会话推进 ${silent}`);
    }
    if (runtime.sticky !== false && runtime.bindings.size > 0) {
      lines.push('');
      lines.push(`粘滞绑定（同一会话再次唤醒沿用；不占位，共 ${runtime.bindings.size} 条）：`);
      for (const [sessionId, binding] of runtime.bindings) {
        lines.push(`- ${sessionId.slice(0, 8)} => ${binding.routeId}`);
      }
    }
    return lines.join('\n');
  };

  /** 清理过期绑定，避免状态文件无限增长。 */
  const gcBindings = () => {
    if (runtime.sticky === false) return;
    const cutoff = Date.now() - runtime.bindingTtlMs;
    let changed = false;
    for (const [sessionId, binding] of runtime.bindings) {
      if (binding.updatedAt < cutoff) {
        runtime.bindings.delete(sessionId);
        changed = true;
      }
    }
    if (changed) persistState();
  };

  const handleTool = (args) => {
    const action = args?.action;
    if (action === 'list') return describe();
    if (action === 'reload') {
      void reload('工具触发');
      return `已触发重新加载：${poolFile}`;
    }
    if (action === 'reset_bindings') {
      const count = runtime.bindings.size;
      runtime.bindings.clear();
      persistState();
      return `已清空 ${count} 条粘滞绑定；之后唤醒的子代理会重新分配路由。`;
    }
    if (action === 'prune') {
      const now = Date.now();
      const before = runtime.bindings.size;
      for (const [sessionId, binding] of [...runtime.bindings]) {
        // 绑定所属会话已经不在注册表里：不算活跃子代理，清掉可减少状态文件噪声
        if (safeAgent(sessionId) === undefined) runtime.bindings.delete(sessionId);
      }
      for (const [routeId, value] of Object.entries(runtime.manualDisabled)) {
        if (typeof value === 'number' && value <= now) delete runtime.manualDisabled[routeId];
      }
      gcBindings();
      persistState();
      return `已清理失效绑定 ${before - runtime.bindings.size} 条，剩余 ${runtime.bindings.size} 条；已过期的定时禁用一并移除。`;
    }
    const routeId = typeof args?.route === 'string' ? args.route.trim() : '';
    if (routeId.length === 0) throw new Error('该操作需要 route（路由 id）');
    if (!runtime.routes.some((route) => route.id === routeId)) {
      throw new Error(`未知路由 "${routeId}"；可用：${runtime.routes.map((route) => route.id).join(', ')}`);
    }
    if (action === 'disable') {
      const minutes = Number(args?.minutes);
      runtime.manualDisabled[routeId] =
        Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60000 : true;
      persistState();
      return `已禁用 ${routeId}${Number.isFinite(minutes) && minutes > 0 ? `（${minutes} 分钟）` : '（直到手动启用）'}；已绑定的子代理保持原路由直到结束。`;
    }
    if (action === 'enable') {
      delete runtime.manualDisabled[routeId];
      runtime.cooldown.delete(routeId);
      persistState();
      return `已启用 ${routeId}。`;
    }
    throw new Error(`未知 action "${String(action)}"；可用：list, disable, enable, reload, reset_bindings, prune`);
  };

  const disposeTool = ctx.tools.register({
    name: 'model_pool',
    description:
      '查看或临时调整所有子智能体的全局模型池：list 看路由、真实占位数、冷却、占位判定与粘滞绑定；disable 临时禁用某条路由（可给分钟数）；enable 恢复；reload 重新读取池文件；reset_bindings 清空全部粘滞绑定；prune 只清理失效绑定与过期定时禁用。只影响之后派发的子代理。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'disable', 'enable', 'reload', 'reset_bindings', 'prune'],
          description: '要执行的操作。',
        },
        route: {
          type: 'string',
          description: '路由 id，disable/enable 必填。',
        },
        minutes: {
          type: 'number',
          description: 'disable 的持续分钟数；省略表示一直禁用直到手动启用。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    execute: (args) => Promise.resolve(handleTool(args)),
  });

  // ---- 管理面服务：供 subagent-pool-ui 插件消费 ----
  // 之所以由本插件提供而不是 UI 插件自己读文件：运行态（占位、冷却、粘滞绑定、人工禁用）
  // 只存在于本进程内存里，外部读文件看不到真实状态；写回也必须经热加载才会立即生效。
  /**
   * 写回池文件需要保留注释的文档模式解析器（`yaml` 的 parseDocument）。
   *
   * 同样不能裸 import：本包 link 安装，模块按真实路径解析，仓库里没有
   * node_modules。走 loadYamlLibrary 的 profile 基准解析，与读取路径同一口径。
   */
  const loadYaml = async () => {
    const loaded = await loadYamlLibrary('parseDocument');
    return loaded.lib;
  };

  /** 原子改写池文件：保留注释与既有结构，只动被指定的节点；写完立即热加载。 */
  const writePool = async (mutate, reason) => {
    const yaml = await loadYaml();
    const text = await fs.promises.readFile(poolFile, 'utf8');
    const doc = yaml.parseDocument(text);
    mutate(doc);
    const next = doc.toString({ lineWidth: 0, indent: 2 });
    const temp = `${poolFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, next, 'utf8');
    await fs.promises.rename(temp, poolFile);
    await reload(reason ?? '管理界面保存');
  };

  const routeIndex = (routeId) => {
    const index = runtime.routes.findIndex((candidate) => candidate.id === routeId);
    if (index < 0) throw new Error(`未知路由 "${String(routeId)}"`);
    return index;
  };

  const providerCatalog = () => {
    let llm;
    try {
      llm = ctx.get?.('llm');
    } catch {
      llm = undefined;
    }
    if (llm === undefined || typeof llm.listProviders !== 'function') return [];
    try {
      return llm.listProviders().map((provider) => ({
        id: String(provider.id),
        name: String(provider.name ?? provider.id),
      }));
    } catch {
      return [];
    }
  };

  const snapshot = () => {
    const now = Date.now();
    const external = externalCounts();
    const leads = leadOccupancy();
    const { map: subagents } = subagentOccupancy();
    const routes = runtime.routes.map((route) => {
      const until = runtime.cooldown.get(route.id) ?? 0;
      return {
        id: route.id,
        provider: route.provider,
        model: route.model,
        weight: route.weight,
        priority: route.priority ?? 0,
        reasoningEffort: route.reasoningEffort ?? null,
        enabled: route.enabled,
        manualDisabled: isManuallyDisabled(route.id, now),
        cooldownUntil: until > now ? until : null,
        subagents: subagents.get(route.id) ?? 0,
        leads: leads.get(route.id) ?? 0,
        external: external.get(route.id) ?? 0,
        lastAssignedAt: runtime.lastAssigned.get(route.id) ?? null,
      };
    });
    const agents = [];
    for (const [agentId, routeId] of runtime.active) {
      const agent = safeAgent(agentId);
      const slot = agent === undefined ? { holding: false, stale: false } : sampleSlot(agent);
      const live = runtime.liveness.get(agentId);
      agents.push({
        id: agentId,
        routeId,
        status: agent === undefined ? 'settled' : slot.stale ? 'stale' : slot.holding ? 'holding' : 'idle',
        silentForMs: live === undefined ? null : now - live.changedAt,
      });
    }
    const settings = {};
    for (const key of TUNABLES) settings[key] = runtime[key];
    return {
      poolFile,
      stateFile,
      sharedFile: runtime.sharedFile,
      /** 最近一次加载失败的原因；null 表示池文件读取正常。UI 用它解释「为什么没有路由」。 */
      loadError: runtime.loadError ?? null,
      settings,
      routes,
      agents,
      bindings: [...runtime.bindings].map(([sessionId, binding]) => ({
        sessionId,
        routeId: binding.routeId,
        updatedAt: binding.updatedAt,
      })),
      providers: providerCatalog(),
      now,
    };
  };

  const patchRoute = async (routeId, patch = {}) => {
    const index = routeIndex(routeId);
    const weight = patch.weight === undefined ? undefined : Number(patch.weight);
    if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) throw new Error('weight 必须是正数');
    const priority = patch.priority === undefined ? undefined : Number(patch.priority);
    if (priority !== undefined && !Number.isFinite(priority)) throw new Error('priority 必须是整数');
    await writePool((doc) => {
      const items = doc.get('routes')?.items ?? [];
      const item = items[index];
      if (item === undefined) throw new Error(`池文件中第 ${index + 1} 条路由缺失`);
      if (weight !== undefined) item.set('weight', weight);
      if (priority !== undefined) item.set('priority', Math.trunc(priority));
      if (patch.reasoningEffort !== undefined) {
        const effort = String(patch.reasoningEffort ?? '').trim();
        if (effort === '') item.delete('reasoningEffort');
        else item.set('reasoningEffort', effort);
      }
      if (patch.provider !== undefined) {
        const provider = String(patch.provider).trim();
        if (provider === '') throw new Error('provider 不能为空');
        item.set('provider', provider);
      }
      if (patch.model !== undefined) {
        const model = String(patch.model).trim();
        if (model === '') throw new Error('model 不能为空');
        item.set('model', model);
      }
      if (patch.enabled !== undefined) item.set('enabled', patch.enabled === true);
    }, `更新路由 ${routeId}`);
  };

  const addRoute = async (input = {}) => {
    const provider = String(input.provider ?? '').trim();
    const model = String(input.model ?? '').trim();
    if (provider === '' || model === '') throw new Error('provider 与 model 必填');
    const id = String(input.id ?? '').trim() || `${provider}/${model}`;
    if (runtime.routes.some((route) => route.id === id)) throw new Error(`路由 id "${id}" 已存在`);
    const weight = Number(input.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('weight 必须是正数');
    const priority = Number(input.priority ?? 0);
    if (!Number.isFinite(priority)) throw new Error('priority 必须是整数');
    const effort = String(input.reasoningEffort ?? '').trim();
    await writePool((doc) => {
      const entry = { id, provider, model, weight, priority: Math.trunc(priority), enabled: true };
      if (effort !== '') entry.reasoningEffort = effort;
      doc.addIn(['routes'], doc.createNode(entry));
    }, `新增路由 ${id}`);
  };

  const removeRoute = async (routeId) => {
    const index = routeIndex(routeId);
    await writePool((doc) => {
      doc.deleteIn(['routes', index]);
    }, `删除路由 ${routeId}`);
  };

  const patchSettings = async (patch = {}) => {
    const next = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (!TUNABLES.includes(key)) continue;
      const fallback = DEFAULTS[key];
      if (typeof fallback === 'boolean') {
        if (typeof raw !== 'boolean') throw new Error(`${key} 必须是布尔值`);
        next[key] = raw;
        continue;
      }
      if (typeof fallback === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 必须是非负数`);
        next[key] = value;
        continue;
      }
      if (key === 'scope') {
        if (raw !== 'all-subagents' && raw !== 'team') throw new Error('scope 只能是 all-subagents 或 team');
      }
      next[key] = raw;
    }
    if (Object.keys(next).length === 0) throw new Error('没有可保存的参数');
    await writePool((doc) => {
      for (const [key, value] of Object.entries(next)) doc.set(key, value);
    }, '更新全局参数');
  };

  const disableRoute = (routeId, minutes) => {
    routeIndex(routeId);
    const span = Number(minutes);
    runtime.manualDisabled[routeId] = Number.isFinite(span) && span > 0 ? Date.now() + span * 60000 : true;
    persistState();
    return runtime.manualDisabled[routeId];
  };

  const enableRoute = (routeId) => {
    routeIndex(routeId);
    delete runtime.manualDisabled[routeId];
    runtime.cooldown.delete(routeId);
    persistState();
    return true;
  };

  const clearBindings = () => {
    const count = runtime.bindings.size;
    runtime.bindings.clear();
    persistState();
    return count;
  };

  const pruneBindings = () => {
    const now = Date.now();
    const before = runtime.bindings.size;
    for (const sessionId of [...runtime.bindings.keys()]) {
      if (safeAgent(sessionId) === undefined) runtime.bindings.delete(sessionId);
    }
    for (const [routeId, value] of Object.entries(runtime.manualDisabled)) {
      if (typeof value === 'number' && value <= now) delete runtime.manualDisabled[routeId];
    }
    gcBindings();
    persistState();
    return { before, after: runtime.bindings.size };
  };

  try {
    ctx.provide('subagentModelPool', {
      version: 1,
      poolFilePath: poolFile,
      snapshot,
      patchRoute,
      addRoute,
      removeRoute,
      patchSettings,
      disableRoute,
      enableRoute,
      clearBindings,
      pruneBindings,
      reload: () => reload('管理界面触发'),
      describe,
    });
  } catch (error) {
    log(ctx, 'warn', `[subagent-model-pool] 管理面服务注册失败：${String(error)}`);
  }

  // 租约心跳：周期性续期本进程占用（真正占位的团队成员 + 在跑的主 Agent），并清理其他实例的过期租约。
  const warnedStale = new Set();
  const leaseTimer = setInterval(() => {
    try {
      publishLeases();
      // 卡死成员只告警一次，避免刷屏；它恢复推进后重新可告警
      const { stale } = subagentOccupancy();
      for (const agentId of stale) {
        if (warnedStale.has(agentId)) continue;
        warnedStale.add(agentId);
        log(
          ctx,
          'warn',
          `[subagent-model-pool] 子代理 ${agentId.slice(0, 8)} 在跑但会话已 ${Math.round(Number(runtime.staleSubagentMs) / 60000)} 分钟无推进，判定卡死并停止占位（路由绑定保留，恢复推进后自动重新占位）`,
        );
      }
      for (const agentId of [...warnedStale]) if (!stale.has(agentId)) warnedStale.delete(agentId);
    } catch (error) {
      log(ctx, 'warn', `[subagent-model-pool] 租约续期失败：${String(error)}`);
    }
  }, Math.max(3000, Number(runtime.leaseRenewMs) || 15000));
  if (typeof leaseTimer.unref === 'function') leaseTimer.unref();

  ctx.effect(() => () => {
    disposeTool();
    clearInterval(leaseTimer);
    try {
      disposeSelectionWatch?.();
    } catch {
      /* 已释放 */
    }
    liveSelections.clear();
    for (const agentId of [...bound.keys()]) {
      const entry = bound.get(agentId);
      entry?.dispose();
      bound.delete(agentId);
    }
    runtime.active.clear();
    runtime.counts.clear();
    fs.unwatchFile(poolFile);
    // 退场时把自己的租约删掉，别让其他实例等 TTL
    try {
      withSharedLock(() => {
        const data = readShared();
        for (const id of Object.keys(data.leases ?? {})) {
          if (id.startsWith(ownPrefix)) delete data.leases[id];
        }
        writeSharedAtomic(data);
      });
    } catch {
      /* 清理失败由 TTL 兜底 */
    }
  }, 'subagent-model-pool: teardown');

  gcBindings();
  publishLeases();

  log(
    ctx,
    'info',
    `[subagent-model-pool] mounted：${runtime.routes.length} 条路由，粘滞=${runtime.sticky !== false}，计 Leader=${runtime.countLead !== false}（闲置${runtime.countLeadWhenIdle === true ? '计' : '不计'}），空闲子代理${runtime.idleSubagentHoldsSlot === false ? '不' : ''}占位，卡死阈值 ${Math.round(Number(runtime.staleSubagentMs) / 60000)} 分钟，绑定 ${runtime.bindings.size} 条，共享文件 ${runtime.sharedFile}`,
  );

  // 挂载心跳：用于验证插件是否真的被加载（应用没有文件日志）。
  try {
    fs.writeFileSync(
      path.join(home, 'subagent-model-pool.mounted'),
      `${new Date().toISOString()} v=4 scope=all-subagents routes=${runtime.routes.length} pid=${process.pid}\n`,
      'utf8',
    );
  } catch {
    /* 心跳失败不影响插件 */
  }
}
