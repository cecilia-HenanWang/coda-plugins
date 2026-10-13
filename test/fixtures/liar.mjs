// A fake agent that gets Coda's protocol wrong on purpose, one way per run: `node liar.mjs <mode>`. Without a mode it
// speaks it right (a plain echo), so each test shows one rule failing and nothing else.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'honest';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (method, params) => send({ method, params });
const say = (sessionId, text) => notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const wait = params => notify('_coda/wait', params);
const MODEL = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'liar', options: [{ value: 'liar', name: '说错话' }] };
const asked = new Map();
let next = 0, turn = null, turns = 0, afterCancel = null;
// What the checker answered a request of ours.
function ask(method, params) {
  const id = `liar-${next++}`;
  send({ id, method, params });
  return new Promise(resolve => asked.set(id, resolve));
}

const methods = {
  initialize: () => ({ protocolVersion: mode === 'protocol-version' ? 2 : 1,
    agentCapabilities: { loadSession: mode === 'load-fails', _meta: { coda: { waits: {} } } }, authMethods: [] }),
  'session/new': () => {
    if (mode === 'signed-out') throw Object.assign(new Error('Authentication required'), { code: -32000 });
    const sessionId = randomUUID();
    if (mode === 'wait-while-loading') wait({ sessionId, waitId: 'early', kind: 'task', state: 'waiting' });
    return mode === 'no-model' ? { sessionId } : { sessionId, configOptions: [MODEL] };
  },
  'session/load': () => { throw Object.assign(new Error('会话不见了'), { code: -32002 }); },
  'session/prompt': async ({ sessionId }) => {
    const me = turn = { cancelled: false }, first = ++turns === 1;
    if (mode === 'service-failure-always' || (mode === 'service-failure-once' && first))
      throw Object.assign(new Error('Service unavailable'), { code: -32603,
        data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } });
    if (mode === 'stdout-noise') process.stdout.write('starting turn...\n');
    if (mode === 'bad-update') notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } });
    if (mode === 'foreign-session') say('someone-else', 'hi');
    if (mode === 'bad-wait') wait({ sessionId, waitId: 'w', state: 'running' });
    if (mode === 'wait-no-params') send({ method: '_coda/wait' });
    if (mode === 'after-terminal') { wait({ sessionId, waitId: 'w', kind: 'task', state: 'waiting' }); wait({ sessionId, waitId: 'w', state: 'done' }); wait({ sessionId, waitId: 'w', state: 'handling' }); }
    if (mode === 'subagent-no-child') { wait({ sessionId, waitId: `w${turns}`, kind: 'subagent', state: 'waiting' }); wait({ sessionId, waitId: `w${turns}`, state: 'done' }); }
    if (mode === 'timer-no-at') { wait({ sessionId, waitId: `t${turns}`, kind: 'timer', state: 'waiting' }); wait({ sessionId, waitId: `t${turns}`, state: 'done' }); }
    if (mode === 'permission') {
      const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'c1', title: 'rm -rf build' },
        options: [{ optionId: 'yes', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] });
      say(sessionId, `审批答复 ${JSON.stringify(answer.result)}`);
    }
    // The second turn, the one the checker stops, never ends.
    if (mode === 'ignore-cancel' && !first) await new Promise(() => {});
    say(sessionId, 'ok');
    // It reads the cancel, and what comes after it: it goes on and says it ended; it waits, and says it ended; or it had done
    // all it had to and says so at once (as Codex does, its reply held back by a title).
    if (['keep-going', 'slow-end-turn', 'late-end-turn'].includes(mode) && !first) {
      await new Promise(resolve => { afterCancel = resolve; });
      if (mode === 'keep-going') say(sessionId, '还在说');
      if (mode === 'slow-end-turn') await new Promise(resolve => setTimeout(resolve, 1500));
      return { stopReason: 'end_turn' };
    }
    // Its answer is written before it reads the cancel the checker sends as it hears the `ok`: it is busy until then.
    if (mode === 'reply-in-flight' && !first) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); return { stopReason: 'end_turn' }; }
    return { stopReason: me.cancelled ? 'cancelled' : 'end_turn' };
  },
};

createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  // Something read after the cancel (the checker's barrier): handled before the stopped turn answers.
  if (turn?.cancelled && message.method !== 'session/cancel') setImmediate(() => afterCancel?.());
  if (!('method' in message)) { asked.get(message.id)?.(message); return; }
  if (!('id' in message)) { if (message.method === 'session/cancel' && turn && mode !== 'ignore-cancel') turn.cancelled = true; return; }
  const method = methods[message.method];
  if (!method) { send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
  try { send({ id: message.id, result: await method(message.params ?? {}) }); }
  catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message, data: error.data } }); }
  // Right after the first turn ended, with nothing being handled: out of any turn.
  if (message.method === 'session/prompt' && mode === 'permission-outside' && turns === 1) void ask('session/request_permission', { sessionId: message.params.sessionId,
    toolCall: { toolCallId: 'c2', title: '之后再问' }, options: [{ optionId: 'no', name: '拒绝', kind: 'reject_once' }] });
}).on('close', () => { if (mode !== 'linger') process.exit(0); });
// Stays after its input ends (until SIGTERM); stays after SIGTERM; goes a while after SIGTERM.
if (mode === 'linger') setInterval(() => {}, 1000);
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});
if (mode === 'slow-sigterm') process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1200));
