// The handshake and live levels for one agent: the checker plays Coda (backend/src/adapters/acp.mjs AcpSession), starts the
// agent's command the way Coda does, says what Coda says, and holds what the agent says to ACP's schema and to
// docs/agent-protocol.md. Where Coda would quietly drop or refuse something, the check fails and says what Coda does.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROTOCOL_VERSION, CANCEL_LIMIT, METHOD_NOT_FOUND, OPEN_LIMIT, SIGNED_OUT, agentEnv, clientCapabilities, currentModel } from './coda.mjs';
import { AgentProcess, Exited, Timeout } from './process.mjs';
import { explain, schemas } from './schema.mjs';
import { Waits } from './waits.mjs';

// `pause`: a quiet moment between two turns, as between two messages of a person, for what an agent says after a turn
// to be heard outside it.
export const LIMITS = { open: OPEN_LIMIT, turn: 180_000, settle: 60_000, cancel: CANCEL_LIMIT, exit: 5_000, cancelDelay: 500, pause: 500 };
const secs = ms => (ms / 1000).toFixed(1);
const short = (text, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\s+/g, ' ');

// One process of the agent with the session it opens, and what it says, taken in order.
class Session {
  constructor({ agent, pluginDir, base, say, limits, waits = null }) {
    this.say = say; this.limits = limits;
    this.waits = waits ?? new Waits({ fail: (rule, message) => this.at.fail(rule, message), warn: (rule, message) => this.at.warn(rule, message) });
    this.turn = null; this.autonomous = null; this.autonomousTurns = 0; this.loading = true; this.pendingWaits = [];
    this.kinds = new Map(); this.approvals = 0; this.said = new Set(); this.listeners = new Set();
    // The session's working copy, and the plugin's state directory, which Coda makes for it.
    this.cwd = join(base, 'work');
    for (const dir of [this.cwd, join(base, 'state')]) mkdirSync(dir, { recursive: true });
    this.proc = new AgentProcess({ command: agent.command, cwd: this.cwd,
      env: { ...process.env, ...agentEnv({ pluginDir, stateDir: join(base, 'state') }) },
      onMessage: message => { this.receive(message); this.changed(); }, onNoise: (line, why) => this.noise(line, why) });
    this.proc.exited.then(() => this.changed());
  }
  // The level things are said at now: the live level once a turn has been sent.
  get at() { return this.live ? this.say.live : this.say.handshake; }
  once(key, fn) { if (!this.said.has(key)) { this.said.add(key); fn(); } }
  changed() { for (const listener of this.listeners) listener(); }
  // Resolves true once `condition` holds, false past `ms` or when the process has ended without it holding.
  until(condition, ms) {
    if (condition()) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.listeners.delete(listener); resolve(value); };
      const listener = () => { if (condition()) done(true); else if (this.proc.exit) done(false); };
      const timer = setTimeout(() => done(condition()), Math.max(0, ms));
      this.listeners.add(listener);
    });
  }
  noise(line, why) {
    if (why === 'not-json') this.once('noise', () => this.at.warn('wire.noise', `标准输出里有不是 JSON 的行（「${short(line, 60)}」）：Coda 丢掉它；日志请写标准错误`));
    else this.at.fail('wire.shape', `标准输出里有不是 JSON 对象的消息（「${short(line, 60)}」）：Coda 不收批量消息，整条丢掉`);
  }

  receive(m) {
    if ('id' in m) return this.request(m);
    if (m.method === 'session/update') return this.update(m.params);
    if (m.method === '_coda/wait') {
      // Coda keeps what is said while a session opens until it knows the session (docs/agent-protocol.md 规则 8).
      if (this.loading) this.pendingWaits.push(m.params); else this.wait(m.params);
      return;
    }
    if (m.method === '$/cancel_request') return;
    this.once(`notify:${m.method}`, () => this.at.info('notify.unknown', `Agent 发了 Coda 不认识的通知 ${m.method}：Coda 忽略`));
  }
  update(params) {
    const parsed = schemas.zSessionNotification.safeParse(params);
    if (!parsed.success) { this.at.fail('update.schema', `session/update 不合 ACP schema（SDK 1.4.0）：${explain(parsed.error, params)}`); return; }
    // Of a session being opened Coda keeps only its commands and title; a replayed history it does not want.
    if (this.loading) return;
    if (!this.waits.owns(params.sessionId)) {
      this.at.fail('update.session', `session/update 说的会话 ${params.sessionId} 不是本会话，也不是 _coda/wait 登记过的子会话：Coda 丢弃`);
      return;
    }
    const kind = params.update.sessionUpdate;
    this.kinds.set(kind, (this.kinds.get(kind) ?? 0) + 1);
    const turn = this.turn ?? this.autonomous;
    if (turn) {
      turn.updates++;
      if (kind === 'agent_message_chunk' && params.update.content?.type === 'text') turn.text += params.update.content.text;
    }
  }
  wait(params) {
    this.waits.take(params, { turn: !!this.turn });
    this.track();
  }
  // Coda opens a turn of its own for a wait that goes `handling` outside a turn it sent, and ends it when none is
  // (docs/agent-protocol.md 规则 3); one that went `handling` in a turn it sent goes on in one as that turn ends.
  track() {
    const handling = this.waits.handling.length;
    if (!this.turn && handling && !this.autonomous) { this.autonomous = { started: Date.now(), updates: 0, text: '' }; this.autonomousTurns++; }
    if (this.autonomous && !handling) { this.lastAutonomous = this.autonomous; this.autonomous = null; }
  }
  request(m) {
    const inTurn = !!(this.turn || this.autonomous);
    if (m.method === 'session/request_permission' || m.method === 'elicitation/create') {
      const permission = m.method === 'session/request_permission', what = permission ? '审批' : '提问';
      const refuse = permission ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
      const parsed = (permission ? schemas.zRequestPermissionRequest : schemas.zCreateElicitationRequest).safeParse(m.params);
      if (!parsed.success) { this.at.fail('request.schema', `${m.method} 不合 ACP schema：${explain(parsed.error, m.params)}`); this.proc.respond(m.id, refuse); return; }
      if (typeof m.params.sessionId === 'string' && !this.waits.owns(m.params.sessionId)) this.at.fail('request.session', `${what}说的会话 ${m.params.sessionId} 不是本会话或登记过的子会话`);
      if (!inTurn) {
        this.at.fail('request.outside-turn', `${what}在一轮之外发来（没有进行中的 session/prompt，也没有 handling 的等待项）：Coda 拒绝（${permission ? '回 cancelled' : '回 cancel'}），在会话里记一条说明`);
        this.proc.respond(m.id, refuse);
        return;
      }
      this.approvals++;
      if (permission) {
        const reject = m.params.options.find(o => o.kind === 'reject_once') ?? m.params.options.find(o => o.kind === 'reject_always');
        this.proc.respond(m.id, reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : refuse);
        this.at.info('request.permission', `审批「${short(m.params.toolCall?.title ?? m.params.toolCall?.toolCallId ?? '')}」：检查一律拒绝（${reject ? `选 ${reject.optionId}` : '没有拒绝的选项，回 cancelled'}）`);
      } else {
        this.proc.respond(m.id, { action: 'decline' });
        this.at.info('request.elicitation', `提问「${short(m.params.message ?? '')}」：检查一律回 decline`);
      }
      return;
    }
    // Coda handles nothing else an agent asks: its ACP SDK answers that the method is not found.
    this.proc.respondError(m.id, METHOD_NOT_FOUND, `"Method not found": ${m.method}`);
    this.once(`request:${m.method}`, () => this.at.warn('request.unsupported', `Agent 请求了 ${m.method}：Coda 不提供（没声明 fs、terminal），回 -32601`));
  }

  // initialize, then session/new or session/load as AcpSession.initialize does. Returns 'ok', 'signed-out' or 'failed'.
  async open(sessionId = null) {
    const say = this.say.handshake;
    let reply;
    try { reply = await this.proc.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: clientCapabilities() }, { timeout: this.limits.open }); }
    catch (e) { this.reportedExit = e instanceof Exited; say.fail('handshake.initialize', `initialize 失败：${e.message}`); return 'failed'; }
    if (reply.error?.code === SIGNED_OUT) { say.skip('handshake.signed-out', `initialize 回了 -32000（未登录）：Coda 提示用户去「资源」登录；后面的检查跳过`); return 'signed-out'; }
    if (reply.error) { say.fail('handshake.initialize', `initialize 回了错误 ${reply.error.code}：${reply.error.message}`); return 'failed'; }
    const init = schemas.zInitializeResponse.safeParse(reply.result);
    if (!init.success) { say.fail('handshake.initialize', `initialize 的结果不合 ACP schema：${explain(init.error)}`); return 'failed'; }
    this.init = reply.result;
    if (reply.result.protocolVersion !== ACP_PROTOCOL_VERSION) { say.fail('handshake.protocol', `protocolVersion 是 ${reply.result.protocolVersion}，Coda 讲的是 ${ACP_PROTOCOL_VERSION}`); return 'failed'; }
    const caps = reply.result.agentCapabilities ?? {}, waits = !!caps._meta?.coda?.waits && typeof caps._meta.coda.waits === 'object';
    this.canLoad = caps.loadSession === true;
    if (!sessionId) say.pass('handshake.initialize', `initialize：protocolVersion ${ACP_PROTOCOL_VERSION}，loadSession ${this.canLoad}，${waits
      ? '声明了 _meta.coda.waits' : '没声明 _meta.coda.waits（只是声明，登记照收）'}${caps.sessionCapabilities?.additionalDirectories != null ? '，收 additionalDirectories' : ''}`);
    if (sessionId && !this.canLoad) { say.fail('handshake.load', '新进程的 initialize 不再声明 loadSession：Coda 恢复不了这个会话'); return 'failed'; }
    const method = sessionId ? 'session/load' : 'session/new';
    try { reply = await this.proc.request(method, { cwd: this.cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) }, { timeout: this.limits.open }); }
    catch (e) { this.reportedExit = e instanceof Exited; say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 失败：${e.message}`); return 'failed'; }
    if (reply.error?.code === SIGNED_OUT) { say.skip('handshake.signed-out', `${method} 回了 -32000（未登录）：Coda 提示用户去「资源」登录；后面的检查跳过`); return 'signed-out'; }
    if (reply.error) { say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 回了错误 ${reply.error.code}：${reply.error.message}`); return 'failed'; }
    const parsed = (sessionId ? schemas.zLoadSessionResponse : schemas.zNewSessionResponse).safeParse(reply.result);
    if (!parsed.success) { say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 的结果不合 ACP schema：${explain(parsed.error)}`); return 'failed'; }
    this.sessionId = sessionId ?? reply.result.sessionId; this.waits.sessionId = this.sessionId; this.info = reply.result;
    this.loading = false;
    for (const params of this.pendingWaits.splice(0)) this.wait(params);
    const model = currentModel(reply.result);
    if (typeof model !== 'string') {
      say.fail('handshake.model', `${method} 没报当前模型（configOptions 里 category 为 model 的 currentValue，或 models.currentModelId）：Coda 每轮开始前核对，没有就不发这一轮（「适配器未报告实际模型」）`);
      return 'failed';
    }
    if (!sessionId) say.pass('handshake.new', `session/new：会话 ${this.sessionId}，当前模型 ${model}`);
    return 'ok';
  }
  // One turn of Coda's: `session/prompt` with an ID of Coda's choosing, as AcpSession.prompt sends it. With `cancel`, stopped
  // after the agent first says something, or `cancelDelay` after it was sent.
  async prompt(text, { cancel = false } = {}) {
    const say = this.say.live, id = randomUUID(), turn = this.turn = { started: Date.now(), updates: 0, text: '' };
    const reply = this.proc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      { id, timeout: this.limits.turn, onReply: () => { this.turn = null; this.track(); } });
    reply.catch(() => { if (this.turn === turn) { this.turn = null; this.track(); } });
    let cancelledAt = null;
    if (cancel) {
      await this.until(() => this.turn !== turn || turn.updates > 0, this.limits.cancelDelay);
      if (this.turn === turn) { cancelledAt = Date.now(); this.proc.notify('session/cancel', { sessionId: this.sessionId }); }
    }
    let m;
    try {
      m = cancelledAt ? await Promise.race([reply, new Promise((_, reject) => setTimeout(reject, this.limits.cancel, new Timeout('取消后的 session/prompt', this.limits.cancel)))])
        : await reply;
    } catch (e) {
      this.reportedExit = e instanceof Exited;
      say.fail(cancel ? 'live.cancel' : 'live.turn', e instanceof Timeout && cancelledAt
        ? `session/cancel 后 ${secs(this.limits.cancel)} 秒这一轮还没结束：Coda 会关掉托管连接与它的进程组，结果未知`
        : `这一轮没有结束：${e.message}`);
      return null;
    }
    if (m.error) { say.fail(cancel ? 'live.cancel' : 'live.turn', `session/prompt 回了错误 ${m.error.code}：${m.error.message}（Coda 把这一轮记为失败）`); return null; }
    const parsed = schemas.zPromptResponse.safeParse(m.result);
    if (!parsed.success) { say.fail(cancel ? 'live.cancel' : 'live.turn', `session/prompt 的结果不合 ACP schema：${explain(parsed.error)}`); return null; }
    const stop = m.result.stopReason;
    if (!cancel) {
      say.pass('live.turn', `一轮结束：stopReason ${stop}，${secs(Date.now() - turn.started)} 秒，${turn.updates} 条 session/update${turn.text ? `，回复「${short(turn.text)}」` : ''}`);
      if (!turn.text) say.warn('live.reply', '这一轮没有回复文字（agent_message_chunk）');
    } else if (!cancelledAt) say.info('live.cancel', `第二轮在取消前就结束了（stopReason ${stop}），取消没机会生效`);
    else {
      say.pass('live.cancel', `session/cancel 后 ${secs(Date.now() - cancelledAt)} 秒结束，stopReason ${stop}`);
      if (stop !== 'cancelled') say.warn('live.cancel-reason', `取消后 stopReason 是 ${stop}：ACP 要求回 cancelled`);
    }
    return stop;
  }
  // Waits for every open wait to end, `limit` at most; with `cancel`, stops the first turn of its own the agent takes.
  async settle(limit, { cancel = false } = {}) {
    const say = this.say.live, deadline = Date.now() + limit;
    let stopped = false;
    while (this.waits.open.length && Date.now() < deadline && !this.proc.exit) {
      await this.until(() => !this.waits.open.length || (cancel && !stopped && this.autonomous), deadline - Date.now());
      if (cancel && !stopped && this.autonomous) {
        stopped = true;
        const at = Date.now();
        this.proc.notify('session/cancel', { sessionId: this.sessionId });
        if (await this.until(() => !this.autonomous, this.limits.cancel)) say.pass('live.cancel-autonomous', `自主轮次里发 session/cancel，${secs(Date.now() - at)} 秒后没有项再处于 handling`);
        else say.fail('live.cancel-autonomous', `自主轮次里发 session/cancel 后 ${secs(this.limits.cancel)} 秒还有项在 handling：Coda 会关掉托管连接与它的进程组`);
      }
    }
    return !this.waits.open.length;
  }
  // Closes its standard input; it should be gone within `exit`. One that ended before is said to have, unless that was
  // said already. Its process group goes either way.
  async finish(say) {
    if (this.proc.exit) {
      const { code, signal } = this.proc.exit, words = this.proc.lastWords();
      if (!this.reportedExit) say.fail('handshake.exited', `Agent 进程提前退出了（${signal ? `信号 ${signal}` : `退出码 ${code}`}）${words ? `：${words}` : ''}`);
    } else {
      const took = await this.proc.closeInput(this.limits.exit);
      if (took === null) say.fail('handshake.exit', `关标准输入后 ${secs(this.limits.exit)} 秒还没退出`);
      else say.pass('handshake.exit', `关标准输入后 ${secs(took)} 秒退出`);
    }
    this.proc.kill();
  }
}

async function live(session, prompt, limits, say) {
  session.live = true;
  if (!await session.prompt(prompt)) return;
  const settled = await session.settle(limits.settle), waits = session.waits.registered;
  if (waits.length) {
    const kinds = Object.entries(Object.groupBy(waits, w => w.kind)).map(([kind, list]) => `${kind} ×${list.length}`).join('，');
    say[settled ? 'pass' : 'warn']('live.waits', `等待项：登记 ${waits.length} 个（${kinds}），自主轮次 ${session.autonomousTurns} 次${settled ? '，都已结束'
      : `；${secs(limits.settle)} 秒后还有 ${session.waits.open.length} 个没结束（定时与长任务可以这样，不算失败）`}`);
    if (session.lastAutonomous?.text) say.info('live.autonomous', `自主轮次的回复「${short(session.lastAutonomous.text)}」`);
  } else say.info('live.waits', '这一轮没有登记等待项');
  // A second turn, stopped; and a turn of the agent's own that it brings about, stopped too.
  await new Promise(resolve => setTimeout(resolve, limits.pause));
  await session.prompt(prompt, { cancel: true });
  await session.settle(limits.settle, { cancel: true });
  const kinds = [...session.kinds].map(([kind, n]) => `${kind} ×${n}`).join('，');
  say.pass('live.updates', `session/update 都合 ACP schema（SDK 1.4.0）：${kinds || '无'}`);
}

// Checks one declared agent of the plugin in `pluginDir`; `say(level)` gives the report scope for a level.
export async function checkAgent({ agent, pluginDir, live: running = false, prompt = '只回复 ok', limits: given = {}, say }) {
  const limits = { ...LIMITS, ...given }, base = mkdtempSync(join(tmpdir(), 'coda-plugin-check-'));
  const scopes = { handshake: say('handshake'), live: say('live') };
  try {
    const session = new Session({ agent, pluginDir, base, say: scopes, limits });
    const opened = await session.open();
    if (opened === 'ok' && running) await live(session, prompt, limits, scopes.live);
    else if (running) scopes.live.skip('live.skipped', opened === 'signed-out' ? '未登录，一轮跳过' : '握手没过，一轮跳过');
    else scopes.live.skip('live.skipped', '一轮要 --live（会真的发一条提示词，可能要登录、花额度）');
    await session.finish(scopes.handshake);
    if (opened !== 'ok' || !running) return;
    if (!session.canLoad) { scopes.live.skip('live.load', '没声明 loadSession：Coda 不会要求恢复，session/load 不查'); return; }
    const again = new Session({ agent, pluginDir, base, say: scopes, limits });
    again.live = true;
    if (await again.open(session.sessionId) === 'ok') scopes.live.pass('live.load', `新进程 session/load 接上了会话 ${session.sessionId}`);
    await again.finish(scopes.live);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
