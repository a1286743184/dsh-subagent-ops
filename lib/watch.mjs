/**
 * subagent-watch — 子代理健康探针
 *
 * 解决什么问题：
 *   主 Agent 派出的子代理（subagent / subagent_fork / workflow）如果卡住或静默失败，
 *   主 Agent 侧只能看到 "running"，无法知道它是否：
 *     - 一步都没走（模型侧根本没响应）
 *     - 走了一半但会话序号长时间不推进（工具悬挂 / 流卡死）
 *     - 已经因为上游 ERROR 结束（例如 stream idle timeout），但状态还没刷新
 *   实测事故（2026-11-05）：两个子代理一个跑满 73 步后被父侧中断、另一个在第一
 *   模型请求上等 600 秒后收到 pi-ai stream idle timeout，主 Agent 全程只看到
 *   "running"，连续空等约 50 分钟。
 *
 * 本插件做什么（四层，按对系统的副作用从小到大）：
 *
 *   1. 体检工具 subagent_watch：给当前会话派出过的子代理做一次体检，输出
 *      状态 / 会话序号 / 距上次推进秒数 / 最后事件 / 结论 / 可续性。
 *      纯读，随时可调；waitSeconds 可阻塞等到「有人停止或卡住」，替代 sleep 轮询。
 *
 *   2. 卡住催办（nudgeStalled）：对 running 且超阈值无推进的子代理，用
 *      agent.steer() 往它的 next-step 队列插一条「先落盘、别硬扛」。
 *      作用边界（2026-11-05 实测）：投递发生在回合边界，打断不了正在执行的
 *      命令，也救不了模型侧卡死；净效果是让「还算清醒、只是忘了落盘」的收口。
 *
 *   3. 提醒主 Agent：告警落 JSONL（跨会话可读），同时经 agent/pre-step 把
 *      「谁的子代理卡了 / 死了、该怎么处置」折进主 Agent 的下一批消息。
 *      只走「拉」不行——主 Agent 不查就永远不知道；这条「推」的通道是
 *      「插件真的负责提醒」的落点。
 *
 *   4. 死亡续命（2026-11-07，见 SUBAGENT-WATCH.md 第九节）：
 *      子代理因上游故障停止后，用 ctx.subagents.sendMessage 在**原上下文**里
 *      把它续起来，而不是让主 Agent 重派一个从零开始的——重派会丢掉它已经
 *      做完的全部工作。
 *      - 先 classifyDeath() 四层判定「能不能续」：停止意图优先于故障码，
 *        用户/父代理主动停的、已正常收尾的、路由坏的，一律不续。
 *      - 复活前过四道闸：非 running、descriptor 可续、provider 是本地
 *        spawn/fork、日志静默够久。一次只救一个（不撞 maxActiveSubagents）。
 *      - 全局预算：maxRevives + 墙钟上限，防止「死一次吐一点、再死」的循环。
 *      - autoRevive 可关：关掉时只推提示、不投递，留给人工判断。
 *
 * 设计约束：
 *   - 只用 Node 内置模块，不引入依赖。
 *   - 全部通过公开扩展点（ctx.agents / ctx.subagents / ctx.tools / ctx.on）
 *     实现，不改官方代码。
 *   - 默认不自动杀：watchdogKill 关闭，因为自动终止可能误杀正在等长命令的
 *     子代理，而未落盘的工作会一起丢。要不要放弃由主 Agent 显式决定。
 *   - 「卡住」与「死亡」是两条独立判定链：前者用 session.seq 推进 + 日志时间，
 *     口径与 subagent-model-pool 的 sampleSlot 一致；后者用 turn/end 与
 *     本 epoch 的 failure chunk，不使用 seq 差值（扫盘路径的 seq 曾恒为 0）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

export const name = 'subagent-watch';
// **subagents 必须声明**：cordis 的 get trap（cordis:1254-1281）对未注入的服务属性
// 直接抛 `cannot get property "subagents" without inject`，审核报告已实机复现。
// 复活只能走 `ctx.subagents.sendMessage`（agent.steer() 对已停止的子代理没有回合
// 落点，递不进去），所以这个依赖是硬依赖，不是可选能力。
export const inject = ['agents', 'tools', 'subagents'];

const DEFAULTS = {
  enabled: true,
  /** 距上次会话推进超过此秒数判 stalled（默认 300s = 5 分钟）。 */
  stallSeconds: 300,
  /** 看护轮询间隔（毫秒）。 */
  watchIntervalMs: 30000,
  /** 是否自动终止 stalled 子代理（默认否：只告警）。 */
  watchdogKill: false,
  /**
   * 判 stalled 时是否向子代理注入催促消息（默认**是**）。
   *
   * 这是本插件最有用的一项：通过 `agent.steer()` 把一条「你卡了，立刻落盘并
   * 汇报」塞进它的 next-step。比 kill 温和（不丢工作），比只告警有效
   * （真的能让它动起来）。
   */
  nudgeStalled: true,
  /** stalled 超过此秒数才允许 watchdogKill 动手（默认 900s = 15 分钟）。 */
  killAfterSeconds: 900,
  /** 是否解析本地会话日志取最后事件（默认是；失败时静默降级）。 */
  readSessionLog: true,
  /** 每个子代理最多回读多少条会话记录（从尾部取）。 */
  tailRecords: 40,
  /** 扫盘时只看最近多少分钟内改动过的会话（默认 240 分钟）。 */
  scanMaxAgeMinutes: 240,
  /**
   * 告警落盘文件（JSONL，一行一条）。
   *
   * **为什么必须落盘**：`ctx.logger` 的输出只活在应用进程的内存日志里，
   * 会话结束就没了。下一个会话（或换人接手）看不到「昨天有个子代理卡死了
   * 27 分钟」这件事——而那正是本插件存在的理由。
   *
   * 用 JSONL 而不是 markdown：便于被脚本读、便于按 agentId 去重、便于追加。
   */
  alertFile: null, // null => <dshHome>/subagent-watch.alerts.jsonl

  /**
   * 是否自动复活「可续」的死掉子代理（默认**开**）。
   *
   * 关掉时退化为「只推提示给主代理」——这是审核确认的降级路径：插件不再
   * 有副作用，但仍把「这个子代理其实能续、别急着重派」告诉主代理。
   * 为什么要这个开关：复活会花 token、会拉起已结束的任务，出错代价比判定层
   * 高一个量级，必须留一条一键退路。
   */
  autoRevive: true,
  /**
   * 日志静默多少秒才算「死透了」。
   *
   * 这是复活准入的**第二条**确认（第一条是 `agent.status !== 'running'`）。
   * 为什么要 90s：`job/registered` 之后跑长命令的子代理可能几十分钟没有新
   * 事件（实测最长单条 job 5353s），但它**还活着**；注册表查不到的已 dispose
   * 子代理只能靠日志静默时长兜底。90s 是「比最快的一次上游超时重试还短、
   * 又比正常思考停顿长」的折中，宁可晚一点复活也不要打断在跑的子代理。
   */
  reviveQuietSeconds: 90,
  /** 全局最多自动复活几次（跨所有子代理累计）。 */
  maxRevives: 3,
  /** 首次复活起算的墙钟预算：超过就再也不自动复活（毫秒）。 */
  maxReviveWallClockMs: 30 * 60 * 1000,
};

/** 可触发提醒的状态。 */
const SEVERITY = { healthy: 0, idle: 0, slow: 1, stalled: 2, dead: 3 };

/**
 * 向卡住的子代理插一条催促消息（**本插件最有用的能力**）。
 *
 * ## 信道是真实的，不是猜的
 *
 * `dsh-agent-loop` 的 `Agent` 实现里（asar 内实测）：
 * ```js
 * send(message, target, wakeup) { inbox.splice(target, Infinity, 0, [message]); if (wakeup) wakeDriver(...) }
 * followup(input) { send(input, 'next-turn', true) }   // 下一轮
 * steer(input)    { send(input, 'next-step', true) }   // 下一步，插队并唤醒
 * inject(input)   { send(input, 'next-step', false) }  // 下一步，不唤醒
 * ```
 *
 * 用 `steer` 而不是 `inject`：子代理卡住时往往停在「等一个永不返回的东西」，
 * `inject` 不 `wakeDriver()` 就永远递不进去。
 *
 * ## 为什么 nudge 优先于 kill
 *
 * kill 丢掉它未落盘的工作；nudge 是「提醒它还被盯着、立刻汇报当前状态」。
 * 实测那类「想太久不落盘」的子代理（72 条消息只有 18 字符正文）会因此收口。
 *
 * @returns {{nudged: boolean, method?: string, error?: string}}
 */
function tryNudge(ctx, cfg, row) {
  if (cfg.nudgeStalled === false) return { nudged: false };
  try {
    const agent = safeAgent(ctx, row.id);
    if (agent === undefined) return { nudged: false };
    // **措辞必须区分「可能正常」与「真的卡住」。**
    //
    // 实测教训（2026-11-05）：第一版写的是「立刻放弃当前命令」「直接回复卡住
    // 并结束」，测试子代理指出这会误伤——工程里合法的长命令很容易超过 300s
    // （`flutter build apk` 约 220s、全量测试约 145s、真机 install 更久），
    // 而探针**无法区分「卡死」与「正在跑长命令」**（两者都是「有 job 在跑、
    // 没有新会话事件」）。
    //
    // 所以现在的措辞有三条纪律：
    // 1. 先问「你是不是在跑一个合法的长命令」——是就明确允许继续；
    // 2. 「落盘」是无害动作，任何情况下都值得做（这是唯一无条件建议）；
    // 3. 只有「确认卡住」才报告卡点，且明说**不要结束会话**——主代理会发消息
    //    让它带着原上下文继续，主动结束才是真正的损失。
    const text =
      `[系统提醒 · 非用户消息] 你的会话已 ${row.silentFor}s 没有产生新事件` +
      `（最后事件：${row.lastEvent ?? '未知'}，会话序号 ${row.seq}）。\n\n` +
      `这不一定是故障——你可能正在跑一个合法的长命令（编译、全量测试、安装包）。` +
      `**如果你确实在等一个正常的长操作，请忽略本提醒继续等，不要中断它。**\n\n` +
      `如果你不是在等长操作，请做两件事：\n` +
      `1. **把你已经完成的成果落盘**（写文件）——这一条任何情况下都值得做，` +
      `不要等到全部做完才落盘；\n` +
      `2. 如果某个调用可能永远不返回，换成更小的步骤先验证。\n\n` +
      `如果你确实无法推进，请把卡点写清楚（回复「卡住：<原因>」也可以），` +
      `但**不要直接结束会话**——主代理会给你发消息继续，你的上下文都还在。`;
    const message = {
      // **必须有 id**：Agent 的 inbox 与 user/message 事件都要求消息带稳定身份
      // （官方 createMessage() 就是 randomUUID）。缺 id 的消息一旦被采纳为
      // user/message，会话日志就会在重载时校验失败、整个会话打不开。
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'system-reminder', form: 'subagent-watch' },
    };
    // 优先 steer（插队 + 唤醒），退而求其次 inject / followup。
    const method =
      typeof agent.steer === 'function'
        ? 'steer'
        : typeof agent.inject === 'function'
          ? 'inject'
          : typeof agent.followup === 'function'
            ? 'followup'
            : undefined;
    if (method === undefined) return { nudged: false };
    agent[method](message);
    return { nudged: true, method };
  } catch (error) {
    return { nudged: false, error: String(error) };
  }
}

/** Promise 版 sleep（节点内置 setTimeout）。 */
function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** 告警文件的绝对路径（配置优先，否则落在 DSH home 下）。 */
function alertPath(cfg) {
  const configured = typeof cfg.alertFile === 'string' ? cfg.alertFile.trim() : '';
  if (configured.length > 0) return configured;
  return path.join(home, 'subagent-watch.alerts.jsonl');
}

/**
 * 追加一条告警（JSONL）。
 *
 * **失败绝不抛**：告警是诊断的副产品，不能因为它坏了就影响主流程。
 * 但如果写不进去，必须至少在内存日志里留一句——静默失败是排查的敌人
 * （`docs/STATE.md` §0.25.4 的教训）。
 */
function appendAlert(cfg, record) {
  try {
    const file = alertPath(cfg);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
  } catch (error) {
    try {
      console.warn(`[subagent-watch] 告警落盘失败：${String(error)}`);
    } catch {
      /* 连 console 都没有就放弃 */
    }
  }
}

function log(ctx, level, message) {
  const sink = ctx?.logger?.[level];
  if (typeof sink === 'function') {
    try {
      sink.call(ctx.logger, message);
      return;
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

function resolveHome(ctx) {
  try {
    const fn = ctx.get?.('dshHomePath');
    if (typeof fn === 'function') {
      const v = fn();
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* 回落到 ~/.dsh */
  }
  return path.join(os.homedir(), '.dsh');
}

function safeAgent(ctx, id) {
  try {
    return ctx.agents.get(id);
  } catch {
    return undefined;
  }
}

/** 从一个 agent 对象里尽力取值，取不到给 undefined（不同版本字段可能不同）。 */
function pick(obj, pathList) {
  let cur = obj;
  for (const key of pathList) {
    if (cur === null || cur === undefined) return undefined;
    try {
      cur = cur[key];
    } catch {
      return undefined;
    }
  }
  return cur;
}

/**
 * 从一行 JSONL 里取事件类型，尽量不解析正文。
 *
 * **为什么要这个快路径**：判定链要把整个 epoch 扫一遍，最长子代理会话
 * 1900+ 条记录，全量 `JSON.parse` 是几十毫秒级的浪费。`type` 恒是记录的
 * 第一个键（全库 293120 条实测无例外），前缀匹配就够；解析失败或格式变了
 * 退回 `JSON.parse`——不靠这个假设硬扛。
 */
function recordType(line) {
  if (line.startsWith('{"type":"')) {
    const end = line.indexOf('"', 9);
    if (end > 9) return line.slice(9, end);
  }
  try {
    const o = JSON.parse(line);
    return typeof o?.type === 'string' ? o.type : '?';
  } catch {
    return '?';
  }
}

/**
 * 从一行 JSONL 里取 `seq`，取不到返回 undefined。
 *
 * 落盘格式里 `seq` 恒紧跟在 `type` 之后（`{"type":"x","seq":12,...`），
 * 所以前缀匹配就够。会话头那条 `session` 记录没有 seq，这里返回 undefined，
 * 调用方负责跳过——它本来也不该参与「最后一条 seq」的计算。
 */
function seqPrefix(line) {
  if (line.startsWith('{"type":"')) {
    const at = line.indexOf('","seq":', 9);
    if (at > 9) {
      const stop = line.indexOf(',', at + 8);
      const raw = line.slice(at + 8, stop < 0 ? undefined : stop);
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  try {
    const n = Number(JSON.parse(line)?.seq);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 取一条 `assistant/attempt` 里最后一个 failure 的 code 与 message。 */
function attemptFailure(record) {
  const stream = record?.data?.stream;
  if (!Array.isArray(stream)) return {};
  let code;
  let message;
  for (const s of stream) {
    const failure = s?.chunk?.reason?.failure;
    if (failure !== undefined && failure !== null) {
      code = typeof failure.code === 'string' ? failure.code : 'ERROR';
      // message 与 code 必须同源：只取「决定了 code 的那一条 failure」的 message，
      // 否则会出现 code=TIMEOUT 而 message 属于另一条失败的错配。
      message = typeof failure.message === 'string' ? failure.message : undefined;
    }
  }
  return { code, message };
}

/**
 * 读会话日志，取最后一条事件类型、时间，以及续命判定需要的整段证据。
 *
 * 会话文件是 zstd 压缩的「多帧」JSONL：**不能用一次性 decompress**，
 * 必须逐帧解（实测 360 帧 / 1.1MB）。这里用 zlib.zstdDecompressSync 逐帧试解。
 *
 * 返回字段是**两套口径**，不能混用：
 *
 * - `lastType` / `lastTime` / `counts` / `reason`：只看尾部 `tailRecords` 条。
 *   这是 stalled 判定与诊断显示的窗口，语义保持不变。
 * - `lastSeq` / `epochStartSeq` / `failureCode` / `lastTurnEnd*` / `epochToolCalls`：
 *   走「epoch 窗口」= 最后一个 `session/end-seed`（无则最后一个 `turn/start`）
 *   **之后的全部记录**。为什么不能沿用尾部 40 条：58 个含 failure 的子代理
 *   会话里 40 个的末次 failure 距末尾 ≥40 条，小窗口既漏读真故障
 *   （192da3ee 的 TRANSPORT 在 529 条之外），又会把「已正常收尾但中途出过错」
 *   的会话读成故障（df6cc48b 的 EMPTY_RESPONSE 就在末条前 11 条）。
 */
function readSessionTail(home, sessionId, tailRecords) {
  const candidates = [
    path.join(home, 'sessions'),
    path.join(home, 'storages', 'session_projcache', 'sessions'),
  ];
  let target;
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    try {
      const hit = findSessionFile(root, sessionId);
      if (hit !== undefined) {
        target = hit;
        break;
      }
    } catch {
      /* 继续下一个根 */
    }
  }
  if (target === undefined) return undefined;

  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch {
    return undefined;
  }
  const text = decodeMultiFrameZstd(buf);
  if (text === undefined) return undefined;

  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  // ---- 一次扫描定位：epoch 起点、最后一条 seq、子代理描述符 ----
  //
  // 只扫 type，不解析正文：最长子代理会话 1917 条，整条解析两遍不值得。
  let lastSeedIdx = -1;
  let lastTurnStartIdx = -1;
  let lastSeq = 0;
  let descriptorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const type = recordType(lines[i]);
    if (type === 'session/end-seed') lastSeedIdx = i;
    else if (type === 'turn/start') lastTurnStartIdx = i;
    else if (type === 'subagent/descriptor') descriptorIdx = i;
    // seq 是记录的第二个键，前缀里就能取到；取不到再退回解析。
    const seq = seqPrefix(lines[i]);
    if (seq !== undefined) lastSeq = seq;
  }
  // 描述符决定「这个子代理能不能被冷恢复」：`mode !== 'continuable'` 是 one-shot，
  // 外部后端（acp/codex/…）不能被本进程 resum。插件看不到 activation.kind，
  // 只能读这份落盘描述符做前置短路——不然每次复活都会撞一次 NOT_RESUMABLE/
  // NOT_CONTINUABLE，白白浪费一次拒绝预算。
  // 全库 200 个含描述符的子代理会话里 mode 全为 continuable、provider 全为 spawn，
  // 这条过滤当前不会拦掉任何真实样本，它是给未来 one-shot / 外部后端留的闸门。
  let descriptorMode;
  let descriptorProvider;
  if (descriptorIdx >= 0) {
    try {
      const data = JSON.parse(lines[descriptorIdx])?.data;
      descriptorMode = typeof data?.mode === 'string' ? data.mode : undefined;
      descriptorProvider = typeof data?.provider === 'string' ? data.provider : undefined;
    } catch {
      /* 坏行当作没有描述符 */
    }
  }
  // session/end-seed 是冷恢复的切点：它之前的 turn/end / failure 属于上一段
  // 生命周期，拿来做本段判定会读错（4364c8a8 有 3 个切点 4 段）。
  const epochIdx = lastSeedIdx >= 0 ? lastSeedIdx : lastTurnStartIdx;
  const epochStart = epochIdx + 1;

  let epochStartSeq = 0;
  if (epochIdx >= 0) {
    try {
      epochStartSeq = Number(JSON.parse(lines[epochIdx])?.seq ?? 0);
    } catch {
      epochStartSeq = 0;
    }
  }

  // ---- 尾部窗口：lastType / lastTime / counts / reason 的既有口径，不动 ----
  const start = Math.max(0, lines.length - tailRecords);
  let last;
  const counts = {};
  /** 最近一次「上游报错」事件（比 turn/end 更能说明死因）。 */
  let upstreamFailure;
  for (let i = start; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      const type = typeof o?.type === 'string' ? o.type : '?';
      counts[type] = (counts[type] ?? 0) + 1;
      last = { type, time: Number(o?.time ?? 0), record: o };

      // 逐条找 finish/error：turn/end 只记 aborted，真正原因是藏在
      // assistant/attempt 的 stream chunk 里的 failure（例如 600s 空闲超时）。
      const stream = o?.data?.stream;
      if (Array.isArray(stream)) {
        for (const s of stream) {
          const failure = s?.chunk?.reason?.failure;
          if (failure !== undefined && failure !== null) {
            upstreamFailure = `${failure.code ?? 'ERROR'}: ${failure.message ?? ''}`.trim();
          }
        }
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  if (last === undefined) return undefined;

  // 从最后一条事件里提取人可读的失败原因（这是最有价值的一条信息）。
  let reason;
  const rec = last.record;
  if (last.type === 'turn/end') {
    const r = rec?.data?.reason;
    if (r?.kind === 'aborted') reason = `aborted:${r?.reason?.kind ?? '?'}`;
    else if (r?.kind === 'error') reason = `error:${r?.error?.code ?? r?.error ?? '?'}`;
    else reason = `end:${r?.kind ?? '?'}`;
  } else if (last.type === 'assistant/attempt') {
    const stream = rec?.data?.stream;
    if (Array.isArray(stream)) {
      for (const s of stream) {
        const failure = s?.chunk?.reason?.failure;
        if (failure?.message) reason = `${failure.code ?? 'ERR'}: ${failure.message}`;
      }
    }
  }
  // 上游真错优先于「被谁中断」：aborted 只是结果，根因在 upstreamFailure。
  //
  // **这段只服务于诊断显示，不要拿它做「要不要复活」的判据。**
  // 57628660 的 reason 是 `aborted:user <- TIMEOUT: ...`，按「有上游错就可续」
  // 会去复活一个用户亲手停掉的子代理。复活判据走 classifyDeath()，
  // 它读的是下面这批独立字段。
  if (upstreamFailure !== undefined) {
    reason = reason === undefined ? upstreamFailure : `${reason} <- ${upstreamFailure}`;
  }

  // ---- epoch 窗口内的判定证据 ----
  // 窗口 = epochStart 之后的全部记录（不是尾部 40 条）。
  let failureCode;
  /** 本 epoch 内最后一个 failure 的 message，与 failureCode 同口径同源。 */
  let failureMessage;
  let epochToolCalls = 0;
  let lastTurnEnd;
  for (let i = epochStart; i < lines.length; i++) {
    const type = recordType(lines[i]);
    if (type === 'tool/call') epochToolCalls += 1;
    else if (type === 'turn/end') {
      // **turn/end 也必须限定在本 epoch 内。**
      //
      // 实测反例 c6afc70e：第 1 段 turn/end 是 error:PI_AI_ERROR，紧随其后
      // session/end-seed 冷恢复，第 2 段正在跑、还没结束。若不限 epoch，
      // 会读到上一段的 error，把一个活着的子代理判成「死且可续」。
      // 冷恢复切点的存在本身就说明上一段已经结束了，它的终态没有信息量。
      try {
        lastTurnEnd = JSON.parse(lines[i]);
      } catch {
        /* 坏行当作没有 */
      }
    } else if (type === 'assistant/attempt') {
      try {
        const { code, message } = attemptFailure(JSON.parse(lines[i]));
        if (code !== undefined) {
          failureCode = code;
          failureMessage = message;
        }
      } catch {
        /* 跳过坏行 */
      }
    } else if (type === 'llm/retry') {
      // llm/retry 的 data.failure 是「同一条失败」的另一份落盘（全库 112 条，
      // 码集是 chunk 那侧的严格子集）。合并进来只是因为拿得到，不是为了补漏。
      try {
        const f = JSON.parse(lines[i])?.data?.failure;
        if (f !== undefined && f !== null) {
          failureCode = typeof f.code === 'string' ? f.code : 'ERROR';
          failureMessage = typeof f.message === 'string' ? f.message : undefined;
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  }

  let lastTurnEndKind;
  let lastTurnEndReasonKind;
  let lastTurnEndErrorCode;
  if (lastTurnEnd !== undefined) {
    const r = lastTurnEnd?.data?.reason;
    lastTurnEndKind = typeof r?.kind === 'string' ? r.kind : undefined;
    if (lastTurnEndKind === 'aborted') {
      lastTurnEndReasonKind = typeof r?.reason?.kind === 'string' ? r.reason.kind : undefined;
    }
    if (lastTurnEndKind === 'error') {
      lastTurnEndErrorCode =
        typeof r?.error?.code === 'string'
          ? r.error.code
          : typeof r?.error === 'string'
            ? r.error
            : undefined;
    }
  }

  return {
    file: target,
    lastType: last.type,
    lastTime: last.time,
    counts,
    reason,
    lastSeq,
    epochStartSeq,
    failureCode,
    // 与 failureCode 同源同口径（本 epoch 内最后一条 failure），供 classifyDeath
    // 区分「PI_AI_ERROR 里哪条是路由不支持模型」——只看 code 分不出来。
    failureMessage,
    lastTurnEndKind,
    lastTurnEndReasonKind,
    lastTurnEndErrorCode,
    epochToolCalls,
    descriptorMode,
    descriptorProvider,
  };
}

function findSessionFile(root, sessionId) {
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, sessionId);
    if (fs.existsSync(candidate)) {
      const inner = fs.readdirSync(candidate);
      const hit = inner.find((f) => f.startsWith('session.v4.'));
      if (hit !== undefined) return path.join(candidate, hit);
    }
  }
  return undefined;
}

/** 从会话文件第一条记录里读描述符（parentSession / origin / createdAt）。 */
function readSessionDescriptor(file) {
  try {
    const buf = fs.readFileSync(file);
    const text = decodeMultiFrameZstd(buf, 1);
    if (text === undefined) return undefined;
    const first = text.split('\n').find((l) => l.trim().length > 0);
    if (first === undefined) return undefined;
    const o = JSON.parse(first);
    if (o?.type !== 'session') return undefined;
    return {
      sessionId: o.id,
      parentSession: o.parentSession,
      origin: o.origin,
      createdAt: Number(o.createdAt ?? 0),
      cwd: o.cwd,
    };
  } catch {
    return undefined;
  }
}

/**
 * 扫盘：列出本机所有 origin=subagent 的会话。
 *
 * **为什么必须扫盘**：子代理被 dispose 后就不在 `ctx.agents` 注册表里了，
 * 只查注册表会「死掉的看不见」——实测事故中两个子代理死透后主 Agent 侧
 * 完全没有任何对象可查。会话文件是持久的，能留下死因。
 */
function scanSubagentSessions(maxAgeMs) {
  const roots = [path.join(home, 'sessions')];
  const found = [];
  const now = Date.now();
  for (const root of roots) {
    let groups;
    try {
      groups = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      const groupDir = path.join(root, g.name);
      let ids;
      try {
        ids = fs.readdirSync(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of ids) {
        if (!d.isDirectory()) continue;
        const dir = path.join(groupDir, d.name);
        let files;
        try {
          files = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const hit = files.find((f) => f.startsWith('session.v4.'));
        if (hit === undefined) continue;
        const file = path.join(dir, hit);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (maxAgeMs > 0 && now - st.mtimeMs > maxAgeMs) continue;
        const desc = readSessionDescriptor(file);
        if (desc === undefined || desc.origin !== 'subagent') continue;
        found.push({ ...desc, file, mtimeMs: st.mtimeMs });
      }
    }
  }
  return found;
}

/** 逐帧解 zstd（多帧拼接，一次性 decompress 会失败）。返回文本或 undefined。 */
function decodeMultiFrameZstd(buf, maxFrames = 5000) {
  const out = [];
  let off = 0;
  let guard = 0;
  while (off < buf.length && guard++ < maxFrames) {
    const slice = buf.subarray(off);
    let chunk;
    try {
      chunk = zlib.zstdDecompressSync(slice);
    } catch {
      // 单帧解码失败：尝试用流式解码拿已解出的部分
      break;
    }
    if (chunk === undefined || chunk.length === 0) break;
    out.push(chunk);
    // zstdDecompressSync 不告诉我们消费了多少字节；用帧魔数找下一帧起点
    const next = findNextFrameMagic(slice, 4);
    if (next < 0) break;
    off += next;
  }
  if (out.length === 0) return undefined;
  try {
    return Buffer.concat(out).toString('utf8');
  } catch {
    return undefined;
  }
}

/** 找 zstd 帧魔数 0x28 0xB5 0x2F 0xFD 的下一个出现位置（从 start 开始）。 */
function findNextFrameMagic(buf, start) {
  for (let i = start; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      return i;
    }
  }
  return -1;
}

/**
 * 判断一条 failure message 是否表达「这条路由压根不支持这个模型」。
 *
 * 为什么要靠字符串：`PI_AI_ERROR` 是上游 LLM 层把各种失败统一成一个 code，
 * 里面混着瞬时故障（可续）和配置事实（不可续），而落盘里没有任何结构化字段
 * 能区分——只有 message 原文。这里的模式全部来自实测原文，例如
 * `AMD: Requested model DeepSeek-V4.1-Flash not supported`。
 * 宁可漏判（退回可续，最多白续一次）也不要误判成 route-broken（会永久放弃）。
 */
function isRouteBrokenMessage(message) {
  if (typeof message !== 'string' || message.length === 0) return false;
  const text = message.toLowerCase();
  return (
    text.includes('not supported') ||
    text.includes('no configured model') ||
    text.includes('not configured') ||
    text.includes('model_not_found') ||
    text.includes('does not exist')
  );
}

/**
 * 判定「这个已经停下来的子代理值不值得续命」。
 *
 * 这是续命机制的**唯一判据入口**（`probe` 与扫盘分支都必须走这里）。
 * 四层顺序不可交换——**停止意图永远优先于故障码**：
 *
 * - 第 0 层 正常收尾（completed / max-tokens）→ 不续。
 *   这一层拦住「中途出过错但最终跑完了」的会话：df6cc48b 末尾 11 条前有
 *   EMPTY_RESPONSE，078d131c / 192da3ee 的 TIMEOUT / TRANSPORT 在 139 / 529
 *   条之外。不拦的话，一个已经交付的子代理会被当成「刚死」再催一遍。
 * - 第 1 层 主动停止（aborted:user / aborted:parent）→ 永不续。
 *   57628660 是用户停掉的、049b9dbe 是父代理 interrupt_agent 停掉的，两个
 *   都同时带着 TIMEOUT failure chunk。按故障码优先的读法会复活它们，那是
 *   最严重的一类错误：用户亲手停止的任务被插件自己拉起来。
 * - 第 2 层 路由/配置类错误（UNKNOWN_MODEL / UNKNOWN）→ 不续，改路由再重派。
 *   全库 8 个会话是这一类（7 个 UNKNOWN 是「agent/request 提议的模型与 step
 *   preparation 固定的模型不一致」，1 个 UNKNOWN_MODEL 是模型没配）。
 *   续多少次都是同一个错，只会白烧 token。
 * - 第 3 层 本 epoch 内的可恢复上游故障 → 可续。
 *   RATE_LIMIT 单独给 60s 退避：它是账号窗口限流，分钟级可恢复（12 个含
 *   RATE_LIMIT 的会话里 9 个最终 completed）。IMAGE_OFFLOAD_REQUIRED 是
 *   确定性条件（图片超出路由预算，重试必败），必须归入不可续。
 *
 * @returns {{revivable: boolean, code?: string, why: string, action?: string, backoffMs?: number}}
 */
function classifyDeath(tail) {
  if (tail === undefined) return { revivable: false, why: 'no-log', action: 'inspect-log' };

  const kind = tail.lastTurnEndKind;
  const sub = tail.lastTurnEndReasonKind;

  // 第 0 层：已经正常收尾的，不管中途出过什么故障，都不续
  if (kind === 'completed' || kind === 'max-tokens') {
    return { revivable: false, why: 'already-ended' };
  }
  // 第 1 层：停止意图优先于任何故障码
  if (kind === 'aborted' && (sub === 'user' || sub === 'parent')) {
    return { revivable: false, why: `stopped-by-${sub}` };
  }
  // 第 2 层：配置/路由类错误，续也没用
  if (
    kind === 'error' &&
    (tail.lastTurnEndErrorCode === 'UNKNOWN_MODEL' || tail.lastTurnEndErrorCode === 'UNKNOWN')
  ) {
    return { revivable: false, why: 'route-broken', action: 'reassign-route' };
  }
  // 第 3 层：本 epoch 的可恢复上游故障
  const code = tail.failureCode;
  if (code === 'IMAGE_OFFLOAD_REQUIRED') return { revivable: false, why: 'deterministic' };
  // **PI_AI_ERROR 必须按 message 细分**（决策 1）。
  //
  // 同一个 code 下混着两种完全不同的成因：
  //   - `Provider finish_reason: error`（3 例）：上游瞬时故障，可续。
  //   - `AMD: Requested model DeepSeek-V4.1-Flash not supported`（7baa6e72）：
  //     路由不支持该模型，与 UNKNOWN_MODEL 同类，重试必然再失败——白烧一次
  //     续命预算。只看 code 分不开，只能看 message。
  // 命中以下任一模式即降级为 route-broken。这些都是「配置事实」而非「瞬时状态」，
  // 不会自己好转，所以不给 backoff、不给重试。
  if (code === 'PI_AI_ERROR' && isRouteBrokenMessage(tail.failureMessage)) {
    return { revivable: false, why: 'route-broken', action: 'reassign-route' };
  }
  if (code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'SERVER' || code === 'PI_AI_ERROR') {
    return { revivable: true, code, why: 'upstream-failure' };
  }
  if (code === 'RATE_LIMIT') return { revivable: true, code, why: 'rate-limited', backoffMs: 60000 };

  // 其余一律只提示。这一支包含两类真实情形：
  // - 会话根本没有 turn/end（全库 18 个，末条停在 agent/inbox/spliced 等）：
  //   判不出它是在跑、被停、还是刚崩，不能替主代理决定。
  // - 只有不可恢复的 failure（EMPTY_RESPONSE / ELIGIBILITY 等）。
  return { revivable: false, why: kind === undefined ? 'no-turn-end' : 'unknown' };
}

/** 给一个 agent 做一次体检。 */
function probe(ctx, agent, config, now) {
  const id = agent?.id ?? '?';
  const status = typeof agent?.status === 'string' ? agent.status : '?';
  let seq = 0;
  try {
    seq = Number(agent?.session?.seq ?? 0);
  } catch {
    seq = 0;
  }
  const parentSession = pick(agent, ['session', 'header', 'parentSession']);
  const title = pick(agent, ['session', 'header', 'title']) ?? pick(agent, ['session', 'title']);

  const prev = liveness.get(id);
  if (prev === undefined || prev.seq !== seq || prev.status !== status) {
    liveness.set(id, { seq, status, changedAt: now });
  }
  const stamp = liveness.get(id) ?? { seq, status, changedAt: now };
  const silentFor = Math.max(0, Math.round((now - stamp.changedAt) / 1000));

  let tail;
  if (config.readSessionLog) {
    try {
      tail = readSessionTail(home, id, Number(config.tailRecords) || 40);
    } catch {
      tail = undefined;
    }
  }

  // **以会话日志的最后事件时间为准，而不是内存里的 seq 变化时刻。**
  //
  // 为什么必须这样：内存采样只在「本插件被调用/轮询」时更新 `changedAt`，
  // 若主 Agent 长时间不调工具（例如在跑一个长命令），`changedAt` 会一直停在
  // 上一次采样，算出假的 `silentFor`——实测把「34 秒没推进」报成「400 秒卡死」，
  // 差点误杀一个正在正常工作的子代理。
  //
  // 会话日志是子代理真实活动的持久记录：它的 `time` 字段就是最后一次真实推进。
  const logSilentFor =
    tail?.lastTime !== undefined && tail.lastTime > 0
      ? Math.max(0, Math.round((now - tail.lastTime) / 1000))
      : undefined;
  const effectiveSilentFor = logSilentFor ?? silentFor;

  // 续命判定只对「已经停下来」的行有意义：还在跑的没死因可判，硬算会把
  // 每一行都写成 no-log，反而污染表格。`verdict` 回答「现在要不要关注」，
  // `deathClass` 回答「如果它停了，能不能续、为什么」，两者分开是为了
  // 不动 SEVERITY 排序与 waitSeconds 轮询的既有语义。
  const death = status === 'running' ? undefined : classifyDeath(tail);

  let verdict;
  if (status !== 'running') {
    // 不在跑：区分「正常收尾」与「异常结束」。
    //
    // 映射刻意与旧的 `/TIMEOUT|error|aborted/` 正则保持等价（旧代码：reason
    // 命中就算 dead，否则 idle）。旧实现里「没有 reason」也算 idle——18 个
    // 没有 turn/end 的会话正是这一类，不能因为换了判据就把它们变成 dead。
    // `interrupted` 是恢复边界上 openTurnClosers 补的合成 turn/end（0cd73c63
    // seq 998、448a1151 seq 891），紧跟其后就是 session/end-seed，不是死亡。
    const endedNormally =
      death.why === 'already-ended' ||
      death.why === 'no-turn-end' ||
      death.why === 'no-log' ||
      tail?.lastTurnEndKind === 'interrupted';
    verdict = endedNormally ? 'idle' : 'dead';
  } else if (effectiveSilentFor >= Number(config.stallSeconds)) {
    verdict = 'stalled';
  } else if (effectiveSilentFor >= Math.round(Number(config.stallSeconds) / 2)) {
    verdict = 'slow';
  } else {
    verdict = 'healthy';
  }

  return {
    id,
    shortId: id.slice(0, 8),
    status,
    seq,
    silentFor: effectiveSilentFor,
    isSubagent: parentSession !== undefined,
    parentSession,
    title: typeof title === 'string' ? title : undefined,
    lastEvent: tail?.lastType,
    lastEventAgeSec: tail?.lastTime ? Math.max(0, Math.round((now - tail.lastTime) / 1000)) : undefined,
    reason: tail?.reason,
    verdict,
    deathClass: death,
    sessionFile: tail?.file,
    // 复活层的准入证据：与表格显示无关，单独放一个对象，免得污染 probe 的返回形状。
    reviveEvidence:
      tail === undefined
        ? undefined
        : {
            epochStartSeq: tail.epochStartSeq,
            epochToolCalls: tail.epochToolCalls,
            descriptorMode: tail.descriptorMode,
            descriptorProvider: tail.descriptorProvider,
            failureCode: tail.failureCode,
          },
  };
}

/** 读告警文件的行数（失败返回 0，不抛）。 */
function countAlerts(cfg) {
  try {
    const file = alertPath(cfg);
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * 格式化最近的历史告警。
 *
 * **跨会话可见是这个功能的全部意义**：主 Agent 换人（新会话）时，
 * 第一件事应该是「上一个人遇到过什么坑」，而不是重新踩一遍。
 *
 * 表按 `kind` 分支：stalled/nudged/killed 那批关心「无推进秒数 + 最后事件」，
 * revive/giveup 那批根本没有 silentFor，但有 attempt/totalRevives/failureCode。
 * 硬塞进同一组列会让复活记录整行都是 `-`，等于没记。
 */
function formatAlerts(cfg, limit = 30) {
  try {
    const file = alertPath(cfg);
    if (!fs.existsSync(file)) return `没有历史告警（文件 ${file} 不存在）。`;
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return `没有历史告警（文件 ${file} 为空）。`;
    const recent = lines.slice(-limit);
    const out = [`历史告警（最近 ${recent.length} / 共 ${lines.length} 条，文件 ${file}）`, ''];
    const parsed = [];
    for (const line of recent) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        parsed.push({ __broken: line.slice(0, 60) });
      }
    }

    // ---- 第一段：stalled / nudged / killed（探针告警）----
    const probeKinds = new Set(['stalled', 'nudged', 'killed']);
    const probeRows = parsed.filter((o) => o.__broken !== undefined || probeKinds.has(o.kind));
    if (probeRows.length > 0) {
      out.push('| 时间 | 类型 | 子代理 | 无推进 | 最后事件 | 原因 |');
      out.push('|---|---|---|---|---|---|');
      for (const o of probeRows) {
        if (o.__broken !== undefined) {
          out.push(`| （无法解析的行） | | | | | ${o.__broken} |`);
          continue;
        }
        out.push(
          `| ${o.at ?? '-'} | ${o.kind ?? '-'} | ${o.shortId ?? '-'} | ${o.silentFor ?? '-'}s | ${o.lastEvent ?? '-'} | ${o.reason ?? '-'} |`,
        );
      }
      out.push('');
    }

    // ---- 第二段：revive / giveup（续命动作与放弃）----
    const reviveRows = parsed.filter((o) => o.kind === 'revive' || o.kind === 'giveup');
    if (reviveRows.length > 0) {
      out.push('| 时间 | 类型 | 子代理 | 第几次 | 累计 | 失败码 | 父会话 | 原因 |');
      out.push('|---|---|---|---|---|---|---|---|');
      for (const o of reviveRows) {
        out.push(
          `| ${o.at ?? '-'} | ${o.kind} | ${o.shortId ?? o.agentId ?? '-'} | ${o.attempt ?? '-'} | ${o.totalRevives ?? '-'} | ${o.failureCode ?? '-'} | ${o.parentSession ?? '-'} | ${o.reason ?? '-'} |`,
        );
      }
      out.push('');
    }

    // ---- 第三段：其余未知 kind 保底显示，避免新类型彻底消失 ----
    const known = new Set([...probeKinds, 'revive', 'giveup']);
    const otherRows = parsed.filter((o) => o.__broken === undefined && !known.has(o.kind));
    if (otherRows.length > 0) {
      out.push('| 时间 | 类型 | 子代理 | 原因 |');
      out.push('|---|---|---|---|');
      for (const o of otherRows) {
        out.push(`| ${o.at ?? '-'} | ${o.kind ?? '-'} | ${o.shortId ?? o.agentId ?? '-'} | ${o.reason ?? '-'} |`);
      }
      out.push('');
    }

    return out.join('\n').trimEnd();
  } catch (error) {
    return `读告警文件失败：${String(error)}`;
  }
}

/**
 * 把 classifyDeath 的结论压成表格里一列能读的短句。
 *
 * 为什么要有这一列：`verdict` 只说「它停了」，不说「这个停法值不值得救」。
 * 主代理看到 dead 之后要判断的正是后者——而两件事的关键信息完全不同：
 * `aborted:user` 是用户亲手停的（绝对不要动），`TIMEOUT` 是上游超时
 * （续一次大概率能接着干）。把结论直接摆在表里，避免主代理再去翻日志。
 */
function formatDeathClass(death) {
  if (death === undefined) return '-';
  if (death.revivable === true) {
    const backoff = death.backoffMs === undefined ? '' : `，退避 ${Math.round(death.backoffMs / 1000)}s`;
    return `可续（${death.code ?? '?'}${backoff}）`;
  }
  const WHY = {
    'already-ended': '正常收尾，不续',
    'stopped-by-user': '用户停止，不续',
    'stopped-by-parent': '父代理中断，不续',
    // 「修路由后**换一个**重派」而不是「修路由后重派」：这一格只说明
    // **这一个**子代理为什么不能续（它挂的路由不支持该模型），
    // 不代表所有 dead 都该重派。措辞去掉歧义，免得被读成通用处置。
    'route-broken': '路由不支持此模型，续没用；换路由另派',
    deterministic: '确定性失败，重试必败',
    'no-turn-end': '无 turn/end，判不出',
    'no-log': '读不到日志',
    unknown: '不可续',
    // 复活层自己的拒绝原因（不属于 classifyDeath，但同一列要能读）。
    'not-continuable': '非 continuable，不能冷恢复',
    'top-level': '不是子代理',
  };
  return WHY[death.why] ?? death.why;
}

function formatTable(rows) {
  if (rows.length === 0) return '没有正在跟踪的子代理（本会话未派出或已全部结算）。';
  const out = [];
  out.push(
    '| id | 状态 | 会话序号 | 距上次推进 | 最后事件 | 判定 | 可续性 |',
    '|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const age = r.lastEventAgeSec === undefined ? '-' : `${r.lastEventAgeSec}s 前`;
    out.push(
      `| ${r.shortId} | ${r.status} | ${r.seq} | ${r.silentFor}s | ${r.lastEvent ?? '-'}（${age}） | ${r.verdict} | ${formatDeathClass(r.deathClass)} |`,
    );
  }
  const notes = rows.filter((r) => r.reason !== undefined);
  if (notes.length > 0) {
    out.push('', '失败原因：');
    for (const r of notes) out.push(`- ${r.shortId}: ${r.reason}`);
  }
  const stalled = rows.filter((r) => r.verdict === 'stalled' || r.verdict === 'slow');
  if (stalled.length > 0) {
    out.push('', '**怎么读 stalled**：会话序号长时间不推进，有两种可能——');
    out.push('① 真的卡死（工具悬挂 / 上游流卡死）；② **正在跑一个合法的长命令**（编译、全量测试、安装包）。');
    out.push('探针分不出这两者（两者都是「有 job 在跑、没有新会话事件」）。所以：');
    out.push('- 先看「最后事件」：若是 `job/registered`，很可能是在跑长命令，**等它自己结束**；');
    out.push('- 若是 `step/start` 且无 job，更可能是模型侧卡住：先 `send_message` 让它在原上下文里继续；');
    out.push('  `interrupt_agent` 只停当前回合、agent 仍可续；确实续不上才重派。');
    out.push('- `slow` 可再看一轮，仍无推进即按 stalled 处理。');
    out.push('');
    out.push('**nudge 的真实边界**（实测 2026-11-05）：`agent.steer()` 确实能把消息送进子代理，');
    out.push('但投递发生在**回合边界**（工具结果之后），**打断不了正在执行中的命令**。');
    out.push('真正卡在模型侧（stream idle timeout）时，回合边永远不出现，nudge 也递不进去。');
    out.push('所以 nudge 的净效果是「让还算清醒、只是忘了落盘的子代理收口」，不是「救活死透的」。');
    out.push('死透（已停止、日志也不再动）的那批不由 nudge 负责，走「死亡续命」：插件用');
    out.push('`ctx.subagents.sendMessage` 冷恢复，在主代理侧表现为它自己回来了。');
  }
  return out.join('\n');
}

let liveness = new Map();
let home = path.join(os.homedir(), '.dsh');

/**
 * 待告知主代理的事件（**跨会话也会累积**）。
 *
 * 为什么需要它：告警写进 `ctx.logger` 和 JSONL 都只是「记录」，主代理不主动
 * 查就永远看不见。而本插件的目标是「让主代理知道」——所以必须有一条**推**的通道。
 *
 * 通道：`agent/pre-step` 钩子里，把待发事件折进主代理的 inbox。
 * 这是 DSH 官方的「工作区指令注入」用的同一套机制（`<system-reminder>`）。
 */
const pendingLeadNotes = [];

/**
 * 复活状态机：`${parentSession}::${agentId}` → 状态对象。
 *
 * 形状与含义：
 * ```
 * {
 *   attempts,          // 真正投递成功的续命次数（被拒绝的投递不算）
 *   totalRevives,      // 全局累计（与 attempts 同值，保留独立字段便于与告警对齐）
 *   epochStartSeq,     // 本次复活前的 epoch 起点 seq，用于事后审计
 *   revivedAt,         // 上次复活成功的时间戳
 *   noOutputStreak,    // 连续「续了但本 epoch 一次 tool/call 都没有」的次数
 *   terminal,          // true = 永不自动复活（giveup 后再进来直接跳过）
 *   lastFailureCode,   // 上次死亡判定码，写进告警便于按码统计
 *   firstReviveAt,     // 首次复活时间，墙钟预算从这里起算
 *   lastAttemptAt,     // 上次投递尝试时间（冷却队列用）
 *   rejections,        // 连续被拒绝次数（NOT_RESUMABLE 等，三次才 giveup）
 *   lastEpochToolCalls,// 上次核对产出时读到的 epochToolCalls
 * }
 * ```
 *
 * **为什么 key 要带 parentSession**：告警 JSONL 跨会话可见，重建计数时必须能
 * 判断某条记录属于哪个父会话（审核报告 §2.7-6）。只按 agentId 做键，在
 * 「不同父会话派出的子代理恰好同 id」时会串（虽然概率极低，但代价是复活
 * 别人的子代理，不能接受）。
 */
let reviveState = new Map();

/**
 * 冷却队列：投递被拒绝（NOT_RESUMABLE / NOT_CONTINUABLE /
 * ACTIVATION_LIMIT_REACHED / DRAINING）时，记录「何时可以再试」。
 *
 * 为什么不直接放弃：这四种拒绝都是**环境暂时不允许**，不是「这个子代理不能续」。
 * 冷恢复本身有实测 14-17s 的瞬时失败窗口（6001b6b4 / 352c7db3），批量复活还会
 * 撞 maxActiveSubagents=8 的上限。计成 attempts 就会白吃掉 1/3 预算。
 */
let reviveQueue = new Map();

/**
 * 全进程累计的续命预算。
 *
 * **为什么必须是全局而不是每目标**：决策书与审核报告都写「`maxRevives` = 3
 * （全局）」。按目标各给 3 次会有一个致命后果——死掉 5 个子代理就是 15 次
 * 续命，每一轮都烧真金白银的 token。所以这里单独记一份跨目标的总量，
 * `reviveState` 里的 `attempts` 只用于该目标自身的审计与告警字段。
 *
 * `recent` 是**滑动窗口**用的时间戳列表，不是「首次复活时刻」那种一次性闩锁——
 * 后者会让一次历史动作永久堵死后续所有子代理（见 reviveBudgetLeft 的注释）。
 * `firstReviveAt` 仅保留给告警/审计显示。
 */
let reviveGlobal = { attempts: 0, firstReviveAt: undefined, recent: [] };

/** revive/giveup 告警里一定会带的字段：补全 schema，让跨会话重建有依据。 */
function reviveAlertRecord(cfg, base) {
  return {
    at: new Date().toISOString(),
    // kind 必须显式带上：formatAlerts 按 kind 分支，漏了它会掉进「其余未知」段。
    kind: base.kind ?? 'revive',
    parentSession: base.parentSession ?? null,
    agentId: base.agentId ?? null,
    shortId: base.shortId ?? null,
    attempt: base.attempt ?? null,
    totalRevives: base.totalRevives ?? null,
    failureCode: base.failureCode ?? null,
    // failureCode 同时写进 reason：formatAlerts 的既有六列表格只显示 reason，
    // 不写的话这张表上复活记录的原因是空的。
    reason: base.reason ?? base.failureCode ?? null,
    sessionFile: base.sessionFile ?? null,
  };
}

/** 复活状态与 JSONL 告警共用的键。 */
function reviveKey(parentSession, agentId) {
  return `${parentSession ?? '-'}::${agentId}`;
}

/**
 * 冷恢复的「拒绝码」——这些失败**不计 attempts**。
 *
 * 它们表示「现在这个环境不让你投递」，不表示「这个子代理不能续」：
 * - `NOT_RESUMABLE` / `NOT_CONTINUABLE`：one-shot 或外部后端，本进程无法 resum。
 * - `ACTIVATION_LIMIT_REACHED`：撞了 maxActiveSubagents（本 profile 为 8），
 *   等别的子代理退场就能成功。
 * - `DRAINING` / `ACTIVATION_CLOSING`：插件卸载、应用退出、或该 activation
 *   正在被 dispose——实测 6001b6b4 与 352c7db3 都是 14-17s 后重试就成功。
 *
 * 把它们算进 3 次预算，等于让一次瞬时抖动吃掉三分之一的续命机会。
 */
const REVIVE_REJECT_CODES = new Set([
  'NOT_RESUMABLE',
  'NOT_CONTINUABLE',
  'ACTIVATION_LIMIT_REACHED',
  'DRAINING',
  'ACTIVATION_CLOSING',
  'CONTINUATION_UNAVAILABLE',
  'PERSISTENCE_UNAVAILABLE',
  'INPUT_CLOSED',
  'UNAUTHORIZED',
  'PARENT_UNAVAILABLE',
]);

/** 从 reject 链里尽量挖出稳定 code（SubagentError 有 .code，外层可能包 cause）。 */
function errorCodeOf(error) {
  let cur = error;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    if (typeof cur.code === 'string' && cur.code.length > 0) return cur.code;
    if (typeof cur.error?.code === 'string' && cur.error.code.length > 0) return cur.error.code;
    cur = cur.cause;
  }
  return undefined;
}

/**
 * 放弃自动复活时推给主代理的文案，**按 why 区分**（决策 3）。
 *
 * 为什么必须分开写：四种原因对应四种完全不同的处置动作，一句通用文案会让
 * 主代理做反事——route-broken 再重派到同一个路由会再撞一次；deterministic
 * 不先处理图片就重派也必败；upstream-failure 超限则要避开这条路由。
 *
 * 表里没有的 why（`stopped-by-user` / `stopped-by-parent` / `already-ended`）
 * 一律**静默**：那是用户或父代理自己决定的停止，或本来就正常收尾，插件插话
 * 只会训练人忽略这些提醒。
 */
const GIVEUP_NOTES = {
  'route-broken': '该子代理绑定的路由不支持此模型，续命无用。请换路由重派。',
  'upstream-failure': '该子代理连续 3 次上游故障且无产出。请重派并避开此路由。',
  deterministic: '该子代理因图片超预算失败，属确定性条件，续命无用。需先处理图片再重派。',
};

/**
 * 一次复活的准入判定（前置过滤链）。
 *
 * 顺序固定，且**任何一条不过都返回原因**——原因要写进告警，否则事后无从判断
 * 为什么没救。四道闸门的理由分别是：
 *
 * 1. `status !== 'running'`：唯一的硬安全线。复活一个正在跑的子代理会打断它
 *    正在执行的工作，比不复活糟得多。
 * 2. `descriptor.mode === 'continuable'` 且 `provider ∈ {spawn, fork}`：
 *    one-shot 与外部后端（acp / codex / …）在 `coldResume` 里必然抛
 *    NOT_RESUMABLE / NOT_CONTINUABLE。插件看不到 `activation.kind`，只能从
 *    落盘描述符预判，省掉一次注定失败的投递。
 * 3. `classifyDeath(tail).revivable === true`：判定层已经在这里排除了
 *    `stopped-by-user` / `stopped-by-parent` / `already-ended` / 路由类 /
 *    确定性失败。**这一条是「绝不复活用户亲手停掉的子代理」的落点。**
 * 4. 日志静默 ≥ `reviveQuietSeconds`：给扫盘分支用的兜底确认。子代理被
 *    dispose 后查不到 status，只能靠「日志多久没动」判断它是不是真死透了。
 *    没有这一条，一个正在跑长命令（实测最长单条 job 5353s）的子代理会被
 *    当成尸体拉起来。
 */
function reviveGate(row, cfg, now) {
  if (row === undefined || row.isSubagent !== true) return { ok: false, why: 'top-level' };
  if (row.status === 'running') return { ok: false, why: 'still-running' };

  const ev = row.reviveEvidence;
  if (ev?.descriptorMode !== 'continuable') return { ok: false, why: 'not-continuable' };
  if (ev.descriptorProvider !== 'spawn' && ev.descriptorProvider !== 'fork') {
    return { ok: false, why: 'external-provider' };
  }

  const death = row.deathClass;
  if (death?.revivable !== true) return { ok: false, why: death?.why ?? 'not-revivable' };
  // no-turn-end 这一类在复活层保持不救（决策 2）：末条是 step/start 或
  // job/registered 的样本看着像「正在跑」，救它风险大于收益。主代理需要时可
  // 用 subagent_watch(id) 主动查。
  if (death.why === 'no-turn-end') return { ok: false, why: 'no-turn-end' };

  const quiet = Number(cfg.reviveQuietSeconds) || 90;
  if (Number(row.silentFor) < quiet) return { ok: false, why: 'not-quiet-enough' };

  return { ok: true, death, ev };
}

/**
 * 给被复活的子代理的一句话。
 *
 * **不能写「[系统提醒 · 非用户消息]」**：走 `ctx.subagents.sendMessage` 时，
 * 消息由 `submitAdmitted` → `createAgentMessage` 生成，落盘形状是
 * `role:'user'`、`source.kind:'agent-message'`、正文前缀
 * `Agent <父id> sent a message:`。对子代理来说这就是父代理发来的一条用户消息，
 * 谎称「非用户消息」只会让它困惑。
 *
 * 也不写「从头开始」：目标是让它**接着**做，已完成的工作在会话历史里。
 */
function reviveContent(row, death) {
  const code = death?.code ?? '未知';
  return [
    {
      type: 'text',
      text:
        `你的父代理让你继续刚才中断的工作。\n\n` +
        `中断原因：${code}（上游故障，不是你的问题，也不是任务被取消）。\n` +
        `你的会话历史都还在，请接着之前的进度做，**不要重头再来，也不要重复已完成的步骤**。\n\n` +
        `如果之前有已经做完但还没落盘的成果，先把它们写下来（写文件），再继续下一步。`,
    },
  ];
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (config[key] !== undefined) cfg[key] = config[key];
  }
  if (cfg.enabled === false) return;

  home = resolveHome(ctx);
  liveness = new Map();
  reviveState = new Map();
  reviveQueue = new Map();
  reviveGlobal = { attempts: 0, firstReviveAt: undefined, recent: [] };

  const collect = () => {
    const now = Date.now();
    let list = [];
    try {
      list = ctx.agents.list();
    } catch {
      list = [];
    }
    const rows = list
      .map((agent) => probe(ctx, agent, cfg, now))
      .filter((row) => row.isSubagent);

    // ---- 合并扫盘结果：已 dispose 的子代理不在注册表里，只能从会话文件看到 ----
    const known = new Set(rows.map((r) => r.id));
    let disk = [];
    try {
      disk = scanSubagentSessions(Number(cfg.scanMaxAgeMinutes || 240) * 60 * 1000);
    } catch {
      disk = [];
    }
    for (const d of disk) {
      if (known.has(d.sessionId)) continue;
      const tail = cfg.readSessionLog ? readSessionTail(home, d.sessionId, cfg.tailRecords) : undefined;
      const reason = tail?.reason ?? '';
      // **这条分支才是「死掉的子代理」的唯一可见路径**：子代理被 dispose 后
      // 就从 `ctx.agents` 消失，`probe()` 永远碰不到它。改 `probe` 而漏这里，
      // 最需要续命的那批仍然走旧判据。
      const death = classifyDeath(tail);
      const endedNormally =
        death.why === 'already-ended' ||
        death.why === 'no-turn-end' ||
        death.why === 'no-log' ||
        tail?.lastTurnEndKind === 'interrupted';
      const verdict = endedNormally ? 'idle' : 'dead';
      rows.push({
        id: d.sessionId,
        shortId: d.sessionId.slice(0, 8),
        status: 'gone',
        // 取日志里真实的最后一条 seq。旧代码硬编码 0，导致「复活后有没有产出」
        // 这类差值判定在扫盘路径上恒为负数（审核报告 P0-4）。
        seq: Number(tail?.lastSeq ?? 0),
        silentFor: Math.max(0, Math.round((now - d.mtimeMs) / 1000)),
        isSubagent: true,
        parentSession: d.parentSession,
        title: undefined,
        lastEvent: tail?.lastType,
        lastEventAgeSec: tail?.lastTime ? Math.max(0, Math.round((now - tail.lastTime) / 1000)) : undefined,
        reason: reason.length > 0 ? reason : undefined,
        verdict,
        deathClass: death,
        sessionFile: d.file,
        reviveEvidence:
          tail === undefined
            ? undefined
            : {
                epochStartSeq: tail.epochStartSeq,
                epochToolCalls: tail.epochToolCalls,
                descriptorMode: tail.descriptorMode,
                descriptorProvider: tail.descriptorProvider,
                failureCode: tail.failureCode,
              },
      });
    }

    return rows.sort((a, b) => (SEVERITY[b.verdict] ?? 0) - (SEVERITY[a.verdict] ?? 0));
  };

  // ========================================================================
  // 复活层
  // ========================================================================
  //
  // **为什么必须放在 timer 里，不能放 pre-step**：`collect()` 实测单次 256ms
  // （23 文件 / 21.9MB），主会话平均 272 步、最长 1293 步。放进 pre-step 会
  // 累计阻塞数分钟，而冷恢复还要 `query.observeSession` 全量重放 + `agents.resume`，
  // 更贵。pre-step 只负责把已经算好的结论折成消息（见文件末尾）。

  /** 已提示过的不可续原因（按 key），避免每 30s 重推同一条提示。 */
  const reviveHinted = new Set();

  /**
   * 复活前的总预算检查。
   *
   * 两条上限缺一不可：
   * - `maxRevives`：**全局**累计（跨所有子代理），防「死一次吐一点、再死」的循环，
   *   也防「同时死 5 个 → 救 15 次」。
   * - `maxReviveWallClockMs`：单条 job 实测最长 5353s（2304133f 的 bash），只靠次数
   *   限制管不住总时长消耗。
   *
   * **墙钟预算必须是滑动窗口，不能是一次性闩锁。**（2026-11-10 修正）
   *
   * 旧实现从「进程内第一次复活」起算，超过 30 分钟就**永久** giveup。实测后果：
   * 会话 ff29020d / 469f40af / e841cbeb 三个子代理的 giveup 原因全是
   * `预算耗尽（wall-clock=30min）`，而它们各自的 `attempt: 0` —— 一次都没续过就被
   * 判死。原因是同一天早些时候有别的子代理用掉过一次复活，那一次把全局时钟点亮，
   * 30 分钟后所有后来者全部失去资格，直到进程重启。这不是「控制成本」，是「一天
   * 只能救一次」。
   *
   * 现在的口径：只统计**最近一个窗口内**的复活次数。窗口内用满次数才拒绝；窗口
   * 滑过去之后自动恢复资格。既保留了「短时间批量复活会烧 token」的防护，又不会
   * 让一次历史动作永久堵死后续所有子代理。
   *
   * 为什么单目标自身的上限仍然保留：读起来直观，且能防配置改小后的历史状态。
   */
  const reviveBudgetLeft = (state, now) => {
    const max = Number(cfg.maxRevives);
    if (Number.isFinite(max) && max >= 0 && Number(reviveGlobal.attempts) >= max) {
      return { ok: false, why: `max-revives=${max}(全局已用 ${reviveGlobal.attempts})` };
    }
    // 滑动窗口：只保留窗口内的复活时间戳，窗口外的自动失效。
    const window = Number(cfg.maxReviveWallClockMs);
    const stamps = Array.isArray(reviveGlobal.recent) ? reviveGlobal.recent : [];
    const live = Number.isFinite(window) && window > 0 ? stamps.filter((at) => now - at < window) : stamps;
    reviveGlobal.recent = live;
    if (Number.isFinite(window) && window > 0 && live.length >= Math.max(1, Number(max) || 1)) {
      const oldest = live[0];
      const wait = Math.max(0, Math.ceil((window - (now - oldest)) / 60000));
      return { ok: false, why: `窗口内已复活 ${live.length} 次，约 ${wait} 分钟后恢复` };
    }
    const own = Number(state?.attempts ?? 0);
    if (Number.isFinite(max) && max >= 0 && own >= max) {
      return { ok: false, why: `max-revives=${max}(本目标已用 ${own})` };
    }
    return { ok: true };
  };

  /** 拿状态对象（不存在就建一个）。 */
  const ensureState = (key, row) => {
    let state = reviveState.get(key);
    if (state !== undefined) return state;
    state = {
      /** 真正投递成功的续命次数；被拒绝的投递不计。 */
      attempts: 0,
      /** 与 attempts 同值，独立保留以便与告警字段对齐、并使日志可读。 */
      totalRevives: 0,
      /** 当前 epoch 的起点 seq（session/end-seed 的 seq），只作审计记录。 */
      epochStartSeq: row?.reviveEvidence?.epochStartSeq ?? 0,
      /** 上次投递成功的时间戳；undefined = 还没续过。 */
      revivedAt: undefined,
      /** 连续「续了但本 epoch 一次 tool/call 都没有」的次数。 */
      noOutputStreak: 0,
      /** true = 永不自动复活。 */
      terminal: false,
      /** 放弃原因，写进 giveup 告警。 */
      terminalWhy: undefined,
      /** 上次死亡判定码。 */
      lastFailureCode: row?.deathClass?.code,
      /** 首次复活时间，墙钟预算从这里起算。 */
      firstReviveAt: undefined,
      /** 连续被拒次数（NOT_RESUMABLE 等），满 3 次才 giveup。 */
      rejections: 0,
      /** 连续「投递本身抛异常」的次数（非拒绝码），满 3 次才 giveup。 */
      deliveryFailures: 0,
      /** 上次投递尝试时间（审计用）。 */
      lastAttemptAt: undefined,
      /** 上次核对产出时读到的 epochToolCalls（审计用）。 */
      lastEpochToolCalls: 0,
      /** 复活前的 epoch 起点；用来判断「新段有没有落盘」，从而给产出归因。 */
      revivedFromEpochSeq: undefined,
      /** true = 上次复活后还没核对过产出。 */
      pendingEval: false,
    };
    reviveState.set(key, state);
    return state;
  };

  /**
   * 读 JSONL 告警恢复状态（HMR / 重启后 count 不归零）。
   *
   * **为什么必须能从告警重建**：插件每次加载都新建 `reviveState` Map，不重建
   * 就等于每次热重载都白送 3 次续命预算——一个反复崩的子代理可以被无限救。
   * 只读 `revive`/`giveup` 两类记录，且必须按 `parentSession + agentId` 过滤：
   * 告警文件是所有父会话共用的，不带作用域会把别人的次数算到自己头上。
   */
  const restoreReviveState = () => {
    try {
      const file = alertPath(cfg);
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o?.kind !== 'revive' && o?.kind !== 'giveup') continue;
        if (typeof o.agentId !== 'string' || o.agentId.length === 0) continue;
        const key = reviveKey(o.parentSession, o.agentId);
        const state = ensureState(key, undefined);
        if (o.kind === 'revive') {
          const n = Number(o.attempt ?? 0);
          if (Number.isFinite(n) && n > state.attempts) state.attempts = n;
          state.totalRevives = state.attempts;
          const at = Date.parse(String(o.at ?? ''));
          if (Number.isFinite(at)) {
            state.revivedAt = at;
            if (state.firstReviveAt === undefined) state.firstReviveAt = at;
            // **全局计数也要重建**，否则每次 HMR 都白送 3 次全局预算。
            // 次数取「revive 记录条数」作为下界——偏保守（宁可少数，也不要多数）。
            // recent 只收进当前窗口内的记录：窗口外的历史复活不该继续占预算，
            // 那正是一次性闩锁的 bug（见 reviveBudgetLeft）。
            if (reviveGlobal.firstReviveAt === undefined || at < reviveGlobal.firstReviveAt) {
              reviveGlobal.firstReviveAt = at;
            }
            const window = Number(cfg.maxReviveWallClockMs);
            const inWindow = Number.isFinite(window) && window > 0 ? Date.now() - at < window : true;
            if (inWindow) {
              if (!Array.isArray(reviveGlobal.recent)) reviveGlobal.recent = [];
              reviveGlobal.recent.push(at);
              reviveGlobal.recent.sort((a, b) => a - b);
            }
          }
          reviveGlobal.attempts = Number(reviveGlobal.attempts ?? 0) + 1;
          if (typeof o.failureCode === 'string') state.lastFailureCode = o.failureCode;
        } else {
          // **预算耗尽不是终态，重建时不能当终态。**
          //
          // 历史告警里有 3 条 `giveup:upstream-failure (预算耗尽（wall-clock=30min）)`，
          // 而它们对应的子代理 attempt 都是 0——一次都没续过就被判死。若原样恢复成
          // terminal，热重载后它们仍然永不复活，等于把旧 bug 固化进状态。
          // 这类记录只算「当时没额度」，跳过即可；真正的终态原因照常恢复。
          const reason = typeof o.reason === 'string' ? o.reason : 'restored';
          if (reason.includes('预算耗尽') || reason.includes('暂不复活')) continue;
          state.terminal = true;
          state.terminalWhy = reason;
        }
      }
    } catch {
      /* 读不到就从头计数——降级方向是「多给一次机会」，不是崩溃 */
    }
  };

  /**
   * 记录一次 giveup（放弃自动复活），并推一条提示给主代理。
   *
   * **文案必须按 why 区分**（决策 3）：四种放弃原因对应四种完全不同的处置，
   * 一句通用的「已放弃」会让主代理做错事——route-broken 再重试只会再撞一次，
   * deterministic 不先处理图片就重派也必败。
   *
   * `stopped-by-*` / `already-ended` 不写提示也不写告警：那是用户或父代理自己
   * 决定的停止，或者本来就正常收尾，插件在这里插话纯属噪音。
   */
  const giveUp = (state, row, why, detail) => {
    if (state !== undefined) {
      state.terminal = true;
      state.terminalWhy = detail === undefined ? why : `${why}: ${detail}`;
    }
    if (why === 'stopped-by-user' || why === 'stopped-by-parent' || why === 'already-ended') return;
    const note = GIVEUP_NOTES[why];
    if (note !== undefined) {
      // 主控指定的文案是**固定口径**（「连续 3 次上游故障」），但实际触发点可能
      // 更早：状态机规则是「连续 2 次续命后 epochToolCalls=0」就 giveup，
      // 而 maxRevives 上限也可能在更少的次数上先到。所以固定文案后面补一句
      // 真实计数，避免主代理按文案误判「它已经被救了 3 次」。
      // 一次都没续过时（route-broken / deterministic 这类事前拦截）不补——
      // 那种情况下「已续命 0 次」只是噪音。
      const attempts = Number(state?.attempts ?? 0);
      const actual =
        attempts > 0
          ? `（实际：已续命 ${attempts} 次，本轮连续无产出 ${Number(state?.noOutputStreak ?? 0)} 次）`
          : '';
      pendingLeadNotes.push({
        at: Date.now(),
        kind: 'revive-giveup',
        shortId: row.shortId,
        agentId: row.id,
        parentSession: row.parentSession ?? null,
        text: `${note}${actual}`,
      });
      if (pendingLeadNotes.length > 20) pendingLeadNotes.splice(0, pendingLeadNotes.length - 20);
    }
    appendAlert(
      cfg,
      reviveAlertRecord(cfg, {
        kind: 'giveup',
        parentSession: row.parentSession,
        agentId: row.id,
        shortId: row.shortId,
        attempt: state?.attempts,
        totalRevives: state?.totalRevives,
        failureCode: state?.lastFailureCode,
        reason: `giveup:${why}${detail === undefined ? '' : ` (${detail})`}`,
        sessionFile: row.sessionFile,
      }),
    );
    log(ctx, 'warn', `[subagent-watch] 放弃复活 ${row.shortId}：${why}${detail === undefined ? '' : ` ${detail}`}`);
  };

  /**
   * 核对「上次复活到底有没有产出」，并据此推进状态机。
   *
   * 产出判据**只有一条**：本 epoch 内 `tool/call >= 1`。
   * - 不用 seq 差值：磁盘路径的 seq 曾是硬编码 0（审核报告 P0-4），且恢复本身
   *   就会产生 6-8 条记账事件，seq 涨不等于有产出。
   * - 不用 text 段数：4364c8a8 的第 3、4 段只剩一段收尾话，按 text 判会无限续命。
   *
   * **调用时机**：只在「它重新成为一个可复活候选」时评（即 reviveGate 通过）。
   * 那一刻的含义正是「上上次续完它又死了」，才谈得上「那一次续命有没有用」。
   * 刚续完就评会把「还没来得及调工具」误判成零产出，进而误判 giveup。
   *
   * **归因要跨过 epoch 切点**：冷恢复会写一条新的 `session/end-seed`，所以复活后
   * 的 epochStartSeq 必然不同于复活前。若两者相同，说明新段还没落盘，产出证据
   * 无处可归因——这一轮跳过，且**不记 streak**（宁可不判，不要误判）。
   *
   * 连续 2 次「续了但零产出」→ terminal。比「三次」更省：两次都拿不出一次工具调用，
   * 第三次也不会突然干活。
   */
  const settleRevive = (state, row) => {
    if (state.pendingEval !== true) return;
    const epochStart = Number(row?.reviveEvidence?.epochStartSeq ?? 0);
    const before = state.revivedFromEpochSeq;
    if (typeof before === 'number' && epochStart === before) return;
    state.pendingEval = false;
    const calls = Number(row?.reviveEvidence?.epochToolCalls ?? 0);
    state.lastEpochToolCalls = calls;
    if (calls >= 1) {
      // 有产出：只清连败计数，**不清 attempts**——attempts 是全局预算，清掉就
      // 退化成「有产出即可无限续」（审核报告 P1-6 的原始缺陷）。
      state.noOutputStreak = 0;
      return;
    }
    state.noOutputStreak = Number(state.noOutputStreak ?? 0) + 1;
    log(
      ctx,
      'warn',
      `[subagent-watch] ${row?.shortId ?? '?'} 上次复活后本 epoch 无工具调用（连续第 ${state.noOutputStreak} 次）`,
    );
    if (state.noOutputStreak >= 2) {
      giveUp(state, row, 'upstream-failure', `连续 ${state.noOutputStreak} 次续命后 epochToolCalls=0`);
    }
  };

  /** 串行闸：一次只允许一个复活流程在跑（避免撞 maxActiveSubagents: 8）。 */
  let reviving = false;

  /**
   * 执行一次复活。**所有异常都在这里吃掉**，绝不让 timer 抛。
   *
   * sender 纪律：每次都 `ctx.agents.get(parentSessionId)` 现取，**绝不缓存**。
   * `sendMessage` 第一句是
   * `if (this.ctx.agents.get(sender.id) !== sender) throw UNAUTHORIZED`
   * ——冷恢复会把 agent 重新物化，旧对象一旦失效就是这个错。
   *
   * 失败分类（决定「计不计预算」）：
   * - 拒绝码（REVIVE_REJECT_CODES）：环境暂时不允许，**不计 attempts**，
   *   进 60s 冷却队列，累计 3 次才 giveup。
   * - 其他异常（超时、未知 UNAUTHORIZED 变体等）：也**不计 attempts**，
   *   但单独记 `deliveryFailures`，累计 3 次才 giveup。为什么要分开：
   *   attempts 是「已经花了多少次续命机会」的预算，投递没成功就没花出去；
   *   但如果一次都不计，一个永远投不进去的目标会被每 30s 重试到天荒地老。
   *   两个计数各管一头，互不污染。
   */
  const doRevive = async (row, state) => {
    const parentSession = row.parentSession;
    if (typeof parentSession !== 'string' || parentSession.length === 0) return;

    // ---- 复活前写 alert（便于事后审计：谁在什么时候被救了、第几次）----
    appendAlert(
      cfg,
      reviveAlertRecord(cfg, {
        kind: 'revive',
        parentSession,
        agentId: row.id,
        shortId: row.shortId,
        attempt: Number(state.attempts) + 1,
        totalRevives: state.totalRevives,
        failureCode: row.deathClass?.code,
        reason: `revive:${row.deathClass?.code ?? '?'}`,
        sessionFile: row.sessionFile,
      }),
    );

    state.lastAttemptAt = Date.now();
    state.lastFailureCode = row.deathClass?.code;

    // 投递。首败延迟 15s 重试一次——冷恢复有实测 14-17s 的瞬时失败窗口
    // （6001b6b4 17s 后成功、352c7db3 14s 后成功）。
    let accepted = false;
    let lastError;
    for (let i = 0; i < 2 && !accepted; i++) {
      try {
        // **必须现取 sender**：禁止缓存旧 agent 对象（冷恢复后旧对象失效会 UNAUTHORIZED）。
        const sender = ctx.agents.get(parentSession);
        if (sender === undefined) {
          const error = new Error(`父会话 ${parentSession} 不在注册表里`);
          error.code = 'PARENT_UNAVAILABLE';
          throw error;
        }
        // sendMessage 路径**不传 id**：由 submitAdmitted → createAgentMessage 自动补。
        await ctx.subagents.sendMessage(sender, row.id, reviveContent(row, row.deathClass), {
          signal: AbortSignal.timeout(120000),
        });
        accepted = true;
      } catch (error) {
        lastError = error;
        if (i === 0) await delay(15000);
      }
    }

    if (!accepted) {
      const code = errorCodeOf(lastError);
      const isReject = code !== undefined && REVIVE_REJECT_CODES.has(code);
      const key = reviveKey(parentSession, row.id);
      if (isReject) {
        // **拒绝码不计 attempts**：只累 rejections，60s 后再试，三次才放弃。
        state.rejections = Number(state.rejections ?? 0) + 1;
        reviveQueue.set(key, Date.now() + 60000);
        log(
          ctx,
          'warn',
          `[subagent-watch] 复活 ${row.shortId} 被拒（${code}，第 ${state.rejections} 次），60s 后再试`,
        );
        if (state.rejections >= 3) giveUp(state, row, 'upstream-failure', `投递连续被拒：${code}`);
        return;
      }
      // 其他异常：同样不计 attempts，但单独计 deliveryFailures，避免无限重试。
      state.deliveryFailures = Number(state.deliveryFailures ?? 0) + 1;
      reviveQueue.set(key, Date.now() + 60000);
      log(
        ctx,
        'warn',
        `[subagent-watch] 复活 ${row.shortId} 投递失败（${code ?? String(lastError)}，第 ${state.deliveryFailures} 次），60s 后再试`,
      );
      if (state.deliveryFailures >= 3) {
        giveUp(state, row, 'upstream-failure', `投递连续失败：${code ?? String(lastError)}`);
      }
      return;
    }

    // ---- 投递成功 ----
    state.attempts = Number(state.attempts) + 1;
    state.totalRevives = state.attempts;
    reviveGlobal.attempts = Number(reviveGlobal.attempts ?? 0) + 1;
    if (reviveGlobal.firstReviveAt === undefined) reviveGlobal.firstReviveAt = Date.now();
    // 滑动窗口：记下这一次复活，窗口滑过后自动失效（不是永久闩锁）。
    if (!Array.isArray(reviveGlobal.recent)) reviveGlobal.recent = [];
    reviveGlobal.recent.push(Date.now());
    state.revivedAt = Date.now();
    state.rejections = 0;
    state.deliveryFailures = 0;
    // 记下复活前的 epoch 起点：下次核对产出时，只有读到**不同的** epoch 起点
    // 才说明新段已经落盘、产出证据可归因（冷恢复本身就会写一条 session/end-seed）。
    state.revivedFromEpochSeq = Number(row.reviveEvidence?.epochStartSeq ?? 0);
    state.pendingEval = true;
    if (state.firstReviveAt === undefined) state.firstReviveAt = state.revivedAt;
    reviveQueue.delete(reviveKey(parentSession, row.id));

    log(
      ctx,
      'warn',
      `[subagent-watch] 已复活 ${row.shortId}（第 ${state.attempts} 次，原因 ${row.deathClass?.code ?? '?'}）`,
    );

    // **推给主代理**：必须明确禁止「为此新派一个子代理」——那会丢掉它已完成的
    // 全部工作，正是本功能存在的理由。
    pendingLeadNotes.push({
      at: Date.now(),
      kind: 'revived',
      shortId: row.shortId,
      agentId: row.id,
      parentSession,
      text:
        `${row.shortId} 因 ${row.deathClass?.code ?? '上游故障'} 中断，已自动续命（第 ${state.attempts} 次），` +
        `它会带着原有上下文继续。**不要为此新派子代理——那会丢掉它已完成的全部工作。**` +
        `先用 subagent_watch(id) 看它有没有新进展，别急着 interrupt_agent。`,
    });
    if (pendingLeadNotes.length > 20) pendingLeadNotes.splice(0, pendingLeadNotes.length - 20);
  };

  /**
   * 复活主循环：检测 → 前置过滤 → 串行复活。
   *
   * **串行**的理由是硬约束：`maxActiveSubagents: 8`（cordis.patch.yml:205）。
   * 一次批量冷恢复 N 个会直接撞 `ACTIVATION_LIMIT_REACHED`，而这个失败又被
   * 上层映射成「delivery-unavailable」，看起来像「子代理不能续」。
   */
  const runRevive = async (rows) => {
    if (reviving) return; // 上一轮还没跑完：本轮直接跳过，绝不并发
    reviving = true;
    try {
      // 有界清理：一个长会话里死过的子代理会持续累积，不裁剪的话 Map 只增不减。
      // 只删「早已终态且很久没动」的条目；未终态的一律留着（预算不能丢）。
      if (reviveState.size > 200) {
        const now = Date.now();
        for (const [k, s] of reviveState) {
          if (s.terminal !== true) continue;
          const last = Number(s.lastAttemptAt ?? s.revivedAt ?? 0);
          if (last > 0 && now - last > 6 * 60 * 60 * 1000) reviveState.delete(k);
        }
      }
      for (const row of rows) {
        if (row.isSubagent !== true) continue;
        const key = reviveKey(row.parentSession, row.id);
        const state = ensureState(key, row);
        if (state.terminal === true) continue;

        const gate = reviveGate(row, cfg, Date.now());
        if (gate.ok !== true) {
          // 「不该救」的终态原因要告诉主代理一次（route-broken / deterministic），
          // 但只推一次，避免每 30s 刷屏。stopped-by-* / already-ended 静默。
          if (
            (gate.why === 'route-broken' || gate.why === 'deterministic' || gate.why === 'external-provider') &&
            !reviveHinted.has(key)
          ) {
            reviveHinted.add(key);
            giveUp(state, row, gate.why === 'external-provider' ? 'route-broken' : gate.why);
          }
          continue;
        }

        // ---- 上次续过、现在又落回「可复活」：核对上一轮续命的产出 ----
        //
        // 顺序刻意放在 gate 之后：gate 通过本身就是「它又死了」的证据，
        // 这时才谈得上「刚才那次续命有没有用」。刚续完时 gate 不会通过
        // （status 变回 running，或日志还新鲜），所以不会误判零产出。
        settleRevive(state, row);
        if (state.terminal === true) continue;

        // ---- autoRevive 关闭：只推提示，不投递（审核确认的降级路径）----
        if (cfg.autoRevive === false) {
          if (reviveHinted.has(key)) continue;
          reviveHinted.add(key);
          pendingLeadNotes.push({
            at: Date.now(),
            kind: 'revive-hint',
            shortId: row.shortId,
            agentId: row.id,
            parentSession: row.parentSession ?? null,
            text:
              `${row.shortId} 因 ${row.deathClass?.code ?? '上游故障'} 中断，可续命（autoRevive 已关闭，插件未自动执行）。` +
              `用 send_message 让它带上下文继续；**不要为此新派子代理——那会丢掉它已完成的全部工作。**`,
          });
          if (pendingLeadNotes.length > 20) pendingLeadNotes.splice(0, pendingLeadNotes.length - 20);
          continue;
        }

        // 冷却队列：被拒绝后 60s 内不再试同一个
        const cooldownUntil = reviveQueue.get(key);
        if (cooldownUntil !== undefined && Date.now() < cooldownUntil) continue;

        // 刚续过同一个子代理：至少等一个 reviveQuietSeconds 再考虑第二次投递。
        //
        // 为什么需要：冷恢复（observeSession 全量重放 + agents.resume）是异步的，
        // 投递成功到子代理真正出现在注册表里有几百毫秒到几秒的空档。这段空档里
        // 扫盘分支仍然认为它「不在跑、日志很旧」，下一 tick 会再投一次，把
        // maxRevives 白烧在同一个还没起来的子代理上。
        const sinceRevive = state.revivedAt === undefined ? Infinity : Date.now() - state.revivedAt;
        if (sinceRevive < (Number(cfg.reviveQuietSeconds) || 90) * 1000) continue;

        // 预算
        //
        // **预算耗尽是暂时状态，不是终态。** 旧实现直接 giveUp → `state.terminal = true`，
        // 于是「今天额度用完了」被写成「这个子代理永不复活」，即使窗口滑过去、别的
        // 子代理退场腾出额度，它也再没有机会。这正是 2026-11-10 三个子代理
        // （ff29020d / 469f40af / e841cbeb，全部 attempt:0）的实际死法。
        //
        // 现在只记一条节流日志，不置 terminal、不写 giveup 告警：下一个 tick 预算
        // 恢复后它会自动重新进入候选。真正的终态只由「用户/父代理停止」「正常收尾」
        // 「路由不支持」「确定性失败」「连续续命无产出」这几类决定。
        const budget = reviveBudgetLeft(state, Date.now());
        if (!budget.ok) {
          const stamp = `${key}:${budget.why}`;
          if (reviveHinted.has(stamp) === false) {
            reviveHinted.add(stamp);
            log(
              ctx,
              'warn',
              `[subagent-watch] ${row.shortId} 暂不复活：${budget.why}（预算恢复后自动重试，不判死）`,
            );
          }
          continue;
        }
        // 预算通过时清掉该目标的预算节流标记，下次额度耗尽能再提醒一次。
        for (const stamp of [...reviveHinted]) {
          if (stamp.startsWith(`${key}:`) && stamp !== key) reviveHinted.delete(stamp);
        }

        // **一次只处理一个**：投递完就退出本轮，下一个等下一个 tick。
        await doRevive(row, state);
        break;
      }
    } catch (error) {
      log(ctx, 'warn', `[subagent-watch] 复活流程异常：${String(error)}`);
    } finally {
      reviving = false;
    }
  };

  // 热重载后从告警文件重建续命计数：不重建等于每次重载白送 3 次预算。
  restoreReviveState();

  const disposeTool = ctx.tools.register({
    name: 'subagent_watch',
    description:
      '子代理健康探针：列出本会话派出过的子代理，给出状态、会话序号、距上次推进秒数、' +
      '最后一条会话事件与判定（healthy / slow / stalled / idle / dead）。' +
      '用于发现「派出去但没有任何进展」或「上游超时静默失败」的子代理，避免主 Agent 空等。' +
      'stalled = 会话序号长时间不推进。先看最后事件：`job/registered` 多半在跑长命令，等它；' +
      '模型侧卡住则先尝试续命，续不上再重派。dead = 已异常结束（附失败原因，可续性见表格前的说明）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeIdle: {
          type: 'boolean',
          description: '是否包含已不在运行的子代理（默认 true，便于看死因）。',
        },
        id: {
          type: 'string',
          description: '只看某一个子代理（给完整 id 或前 8 位）。',
        },
        waitSeconds: {
          type: 'number',
          description:
            '阻塞等待：最多等多少秒，直到指定的子代理（或任一所跟踪的子代理）离开 running 或判定为 stalled/dead。' +
            '**替代主 Agent 用 sleep 轮询**——一次调用就能等到结果或确知卡死；等到的 stalled/dead 一律先按「续命优先」处置，不是重派信号。上限 600。',
        },
        alerts: {
          type: 'string',
          enum: ['none', 'recent'],
          description:
            'recent = 读告警文件里最近的历史告警（跨会话可见的 stalled/killed 记录）。' +
            '**换会话接手时先查这个**：能看到上一个会话有哪些子代理卡死、卡了多久、什么原因。',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const filter = () => {
        let rows = collect();
        if (args?.includeIdle === false) rows = rows.filter((r) => r.status === 'running');
        const want = typeof args?.id === 'string' ? args.id.trim() : '';
        if (want.length > 0) {
          rows = rows.filter((r) => r.id === want || r.shortId === want || r.id.startsWith(want));
        }
        return rows;
      };

      const waitSec = Number(args?.waitSeconds ?? 0);
      if (Number.isFinite(waitSec) && waitSec > 0) {
        const deadline = Date.now() + Math.min(600, waitSec) * 1000;
        const pollMs = 2000;
        while (Date.now() < deadline) {
          const rows = filter();
          // 等到「没有任何 running 行」或「出现 stalled/dead」就返回。
          const hasRunning = rows.some((r) => r.status === 'running');
          const hasBad = rows.some((r) => r.verdict === 'stalled' || r.verdict === 'dead');
          if (!hasRunning || hasBad) break;
          await delay(pollMs);
        }
      }

      const rows = filter();
      const header = `子代理探针（阈值 ${cfg.stallSeconds}s，日志回读 ${cfg.readSessionLog ? '开' : '关'}）`;
      // `alerts: 'recent'`：只读历史告警，不列当前探针表。
      if (args?.alerts === 'recent') {
        return `${header}\n\n${formatAlerts(cfg)}`;
      }

      const table = formatTable(rows);
      // 常规输出末尾附一行「历史告警有多少条」，否则没人会想到去查。
      let hint = '';
      try {
        const n = countAlerts(cfg);
        if (n > 0) hint = `\n\n历史告警：${n} 条（带 alerts:'recent' 查看；文件 ${alertPath(cfg)}）`;
      } catch {
        /* 读不到就不提示 */
      }
      return `${header}\n\n${table}${hint}`;
    },
  });

  const warned = new Map();
  const timer = setInterval(() => {
    let rows = [];
    try {
      rows = collect();
      for (const row of rows) {
        if (row.verdict !== 'stalled') {
          warned.delete(row.id);
          continue;
        }
        if (warned.has(row.id)) continue;
        warned.set(row.id, Date.now());
        const alertLine =
          `[subagent-watch] 子代理 ${row.shortId} 会话 ${row.silentFor}s 无推进` +
          `（seq=${row.seq}，最后事件 ${row.lastEvent ?? '?'}），判定 stalled`;
        log(ctx, 'warn', alertLine);
        // **落盘一份**：内存日志离开会话就没了，而「昨天谁卡了多久」这件事
        // 必须跨会话可见（否则每个新会话都要重新踩一遍）。
        appendAlert(cfg, {
          at: new Date().toISOString(),
          kind: 'stalled',
          agentId: row.id,
          shortId: row.shortId,
          silentFor: row.silentFor,
          seq: row.seq,
          lastEvent: row.lastEvent ?? null,
          reason: row.reason ?? null,
          sessionFile: row.sessionFile ?? null,
        });

        // ---- 第一步：nudge（插一条消息进去）----
        //
        // 这是本插件最关键的能力，比告警有用得多。
        //
        // **信道来源**（`dsh-agent-loop` 的 `Agent` 实现，asar 内实测）：
        // ```
        // send(message, target, wakeup) { inbox.splice(target, Infinity, 0, [message]); if (wakeup) wakeDriver() }
        // followup(input) { send(input, 'next-turn', true) }   // 下一轮
        // steer(input)    { send(input, 'next-step', true) }   // 下一步（插队，会唤醒）
        // inject(input)   { send(input, 'next-step', false) }  // 下一步（不唤醒）
        // ```
        //
        // 为什么用 `steer` 而不是 `inject`：子代理卡住时往往停在「等一个
        // 永不返回的东西」，`inject` 不唤醒驱动就永远递不进去；`steer`
        // 会 `wakeDriver()`，能真正打断它的等待。
        //
        // 为什么要 nudge 而不是直接 kill：kill 会丢掉它未落盘的工作。
        // nudge 是「提醒它还在被盯着、立刻汇报当前状态」，多数情况下
        // 卡在「想太久没落盘」的子代理会因此立刻收口。
        const nudged = tryNudge(ctx, cfg, row);
        if (nudged.nudged) {
          log(ctx, 'warn', `[subagent-watch] 已向 ${row.shortId} 注入催促消息（${nudged.method}）`);
          appendAlert(cfg, {
            at: new Date().toISOString(),
            kind: 'nudged',
            agentId: row.id,
            shortId: row.shortId,
            silentFor: row.silentFor,
            method: nudged.method,
          });
        }

        // **推给主代理**：主 Agent 下一次 pre-step 时会看到这条提醒。
        //
        // 为什么要有这一步：告警落盘 + 工具查询都是「拉」，主 Agent 不查就
        // 永远不知道。而卡死的子代理占着并发位、拖着整个任务，主 Agent
        // **必须**知道。这条推送是「让插件真的负责提醒」的落点。
        pendingLeadNotes.push({
          at: Date.now(),
          shortId: row.shortId,
          agentId: row.id,
          // **必须带上父会话 id**：推送时只发给「自己的父会话」。
          //
          // 实测事故（2026-11-05）：第一版不带作用域，把另一个会话的子代理
          // （0173b27b，父会话 b3298b0f）卡死提醒推给了我（会话 1d6d368f）。
          // 那条提醒对收到它的人毫无用处——他既管不到那个子代理，也不知道
          // 它是什么任务。跨会话污染比不提醒更糟：它会训练人忽略这类提醒。
          parentSession: row.parentSession ?? null,
          silentFor: row.silentFor,
          lastEvent: row.lastEvent ?? null,
          seq: row.seq,
        });
        if (pendingLeadNotes.length > 20) pendingLeadNotes.splice(0, pendingLeadNotes.length - 20);

        if (cfg.watchdogKill === true && row.silentFor >= Number(cfg.killAfterSeconds)) {
          try {
            const agent = safeAgent(ctx, row.id);
            const stop = agent?.interrupt ?? agent?.abort ?? agent?.cancel;
            if (typeof stop === 'function') {
              Promise.resolve(stop.call(agent)).catch(() => {});
              log(ctx, 'warn', `[subagent-watch] 已请求终止 ${row.shortId}`);
              appendAlert(cfg, {
                at: new Date().toISOString(),
                kind: 'killed',
                agentId: row.id,
                shortId: row.shortId,
                silentFor: row.silentFor,
              });
            }
          } catch (error) {
            log(ctx, 'warn', `[subagent-watch] 终止 ${row.shortId} 失败：${String(error)}`);
          }
        }
      }
    } catch (error) {
      log(ctx, 'warn', `[subagent-watch] 看护轮询失败：${String(error)}`);
    }

    // ---- 复活层：检测与投递都在这里，pre-step 只读缓存 ----
    //
    // 单独 catch：复活有任何异常都不能影响上面的 stalled 告警链，更不能让
    // setInterval 回调抛出去（那会静默停掉后续所有轮次）。
    // 用 .then 而不是 await：doRevive 内部有 15s 的冷恢复重试窗口，不能阻塞
    // 下一个 tick 的 stalled 检查；`reviving` 闸保证不会有两轮同时投递。
    Promise.resolve()
      .then(() => runRevive(rows))
      .catch((error) => log(ctx, 'warn', `[subagent-watch] 复活轮次失败：${String(error)}`));
  }, Math.max(5000, Number(cfg.watchIntervalMs) || 30000));
  if (typeof timer.unref === 'function') timer.unref();

  // ---- 推向主代理：`agent/pre-step` 钩子 ----
  //
  // 这是「插件负责提醒」的落点。DSH 官方的 workspace-instructions 插件也用
  // 同一个钩子往 inbox 折消息（见 asar 内 `@deepseek-ai/dsh-workspace-instructions`
  // 的 `agent/pre-step` 监听器），所以这是**官方支持的注入点**，不是 hack。
  //
  // 只在「主代理」的 pre-step 上注入：`session.header.parentSession` 有值的是
  // 子代理，跳过——否则子代理会收到「别人卡住了」这种与它无关的提醒。
  const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (pendingLeadNotes.length === 0) return decision;
      const agent = payload?.agent;
      // 只给主代理（无 parentSession）。
      const parentSession = agent?.session?.header?.parentSession;
      if (parentSession !== undefined) return decision;
      if (decision?.kind === 'reject') return decision;

      // **按父会话过滤**（实测事故：不带作用域会把别人的子代理推给我）。
      //
      // 取值顺序（前两个是同一份数据的两种可能形态，第三个是兜底）：
      // 1. `agent.session.id`
      // 2. `agent.session.header.id`
      // 3. **反向匹配**：主代理自己的 `session.header.parentSession` 必然为空，
      //    所以若某条 note 的 parentSession 与「本会话下某个 agent 的 id」相等，
      //    它就不是我的 —— 这条兜底不依赖 id 格式。
      //
      // 三者都取不到时**拒绝推送**：宁可这条提醒不出现，也不要推给错的人。
      const selfId =
        (typeof agent?.session?.id === 'string' ? agent.session.id : undefined) ??
        (typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : undefined);
      if (selfId === undefined) {
        log(ctx, 'warn', '[subagent-watch] 取不到本会话 id，跳过推送（避免跨会话污染）');
        return decision;
      }

      // 只取属于本会话的提醒，其余**留在队列里**等它们自己的父会话来取。
      const mine = [];
      for (let i = pendingLeadNotes.length - 1; i >= 0; i--) {
        const n = pendingLeadNotes[i];
        if (n.parentSession === selfId) {
          mine.unshift(n);
          pendingLeadNotes.splice(i, 1);
        }
      }
      if (mine.length === 0) return decision;
      const notes = mine;
      // 两种 note 混在同一个队列里，但版式不同：
      // - 探针告警（无 kind）说「它卡了多久」；
      // - 复活事件（kind=revived / revive-hint / revive-giveup）说的是「插件替
      //   你做了什么、你接下来不该做什么」，自带完整句子，不能再套探针模板，
      //   否则会渲染成「已 undefineds 无推进（最后事件 ?，seq undefined）」。
      const probeNotes = notes.filter((n) => n.kind === undefined);
      const reviveNotes = notes.filter((n) => n.kind !== undefined);
      const lines = ['<system-reminder kind="subagent-watch">'];
      if (probeNotes.length > 0) {
        lines.push('子代理健康提醒（插件自动推送，不是用户消息）：');
        for (const n of probeNotes) {
          lines.push(`- ${n.shortId} 已 ${n.silentFor}s 无推进（最后事件 ${n.lastEvent ?? '?'}，seq ${n.seq}）`);
        }
        lines.push('');
        lines.push('处置：若是跑长命令则等它；若是模型侧卡住，先 send_message 续命（会带完整上下文重开一轮，已做的功课不丢）；续不上才重派。');
      }
      if (reviveNotes.length > 0) {
        lines.push('子代理续命结果（插件自动推送，不是用户消息）：');
        for (const n of reviveNotes) lines.push(`- ${n.text}`);
        lines.push('');
        lines.push('详情：subagent_watch(alerts:"recent")。本条提醒只发一次。');
      }
      lines.push('</system-reminder>');
      const message = {
        // 同上：缺 id 的提醒被采纳后会写出非法 user/message，重载即会话损坏。
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'system-reminder', form: 'subagent-watch' },
      };
      // 折进「进入批次」——与官方 workspace-instructions 同形态。
      if (Array.isArray(decision?.messages)) {
        return { ...decision, messages: [...decision.messages, message] };
      }
      return decision;
    } catch (error) {
      log(ctx, 'warn', `[subagent-watch] 推送主代理失败：${String(error)}`);
      return decision;
    }
  });

  ctx.effect(() => () => {
    disposeTool();
    try {
      disposePreStep?.();
    } catch {
      /* ignore */
    }
    clearInterval(timer);
    liveness.clear();
    warned.clear();
    pendingLeadNotes.length = 0;
    // ---- 续命状态的清理 ----
    //
    // **不在卸载时补写告警**：每次投递前已经写过 `kind:revive` 记录，再补一条
    // 会让 `restoreReviveState` 把同一次复活数成两次，凭空吃掉 reload 后的预算。
    // 已落盘的那批记录就是重载后的重建依据（按 parentSession + agentId 过滤）。
    reviveState.clear();
    reviveQueue.clear();
    reviveHinted.clear();
    reviveGlobal = { attempts: 0, firstReviveAt: undefined, recent: [] };
  });

  log(ctx, 'info', '[subagent-watch] 已装载');
}
