// From Coda's backend/test/kimi-entry.test.mjs at ef1d2311, as plain node:test. Its case through the entry and Coda's
// backend stays in Coda.
// The Kimi entry (plugins/kimi/agent/): what Kimi's own files say of its tasks is told to Coda as waits. A task ending during
// Coda's prompt ends there; one ending outside a prompt is handled until the main agent ends a later turn of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { kimiSession } from '../../../plugins/kimi/agent/observe.mjs';
import { KimiWaits } from '../../../plugins/kimi/agent/waits.mjs';
import { KimiRelay } from '../../../plugins/kimi/agent/relay.mjs';
import { MINIMUM, needed } from '../../../plugins/kimi/scripts/setup.mjs';

const SESSION = 'session-test';
async function layout(t, sessionId = SESSION, cwd) {
  const root = await mkdtemp(join(tmpdir(), 'coda-kimi-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi'), session = join(home, 'sessions', 'workspace', sessionId), tasks = join(session, 'agents', 'main', 'tasks');
  cwd ??= join(root, 'work');
  await mkdir(tasks, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir: session, workDir: cwd }) + '\n');
  const state = { version: 2, id: sessionId, cwd, agents: { main: {} } };
  await writeFile(join(session, 'state.json'), JSON.stringify(state));
  const wire = join(session, 'agents/main/wire.jsonl');
  await writeFile(wire, [{ type: 'metadata', protocol_version: '1.5' }, { type: 'agent.turn.started', turnId: 0, time: 1 },
    { type: 'turn.ended', turnId: 0, agentId: 'main', reason: 'completed', time: 2 }].map(e => JSON.stringify(e) + '\n').join(''));
  const task = (taskId, value) => writeFile(join(tasks, `${taskId}.json`), JSON.stringify({ taskId, kind: 'process', detached: true, ...value }));
  const turn = (turnId, from, to, kind = 'agent.turn.started') => appendFile(wire, JSON.stringify(kind === 'turn.prompt' ? { type: kind, agentId: 'main', turnId, time: from } : { type: kind, turnId, time: from }) + '\n' +
    (to ? JSON.stringify({ type: 'turn.ended', turnId, agentId: 'main', reason: 'completed', time: to }) + '\n' : ''));
  return { root, home, cwd, session, tasks, wire, state, task, turn };
}
// The entry's look: what it tells Coda, as `[waitId, state]`.
function looker(f, { version = '2.1.1', startedAt = 0 } = {}) {
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { KIMI_CODE_HOME: f.home }, version, startedAt });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? waits.read(facts) : waits.lost()).filter(m => m.method === '_coda/wait').map(m => [m.params.waitId, m.params.state]);
  };
  return Object.assign(look, { session });
}

test('a command Kimi ran in the background is waited on, handled once it ended, and done once a main turn ended after it', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('bash-1', { status: 'running', startedAt: 1, description: 'npm test' });
  assert.deepEqual(await look(), [['bash-1', 'waiting']]);
  await f.task('bash-1', { status: 'completed', startedAt: 1, endedAt: 3 });
  assert.deepEqual(await look(), [['bash-1', 'handling']]);
  await f.turn(1, 4);
  assert.deepEqual(await look(), []);
  await appendFile(f.wire, JSON.stringify({ type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 5 }) + '\n');
  assert.deepEqual(await look(), [['bash-1', 'done']]);
});

test('each way a task ends is told as such; one Kimi is not told of ends as it ends; a child agent\'s command is the session\'s too', async t => {
  const f = await layout(t), look = looker(f);
  f.state.agents.child = {};
  await writeFile(join(f.session, 'state.json'), JSON.stringify(f.state));
  await mkdir(join(f.session, 'agents/child/tasks'), { recursive: true });
  await writeFile(join(f.session, 'agents/child/tasks/nested.json'), JSON.stringify({ taskId: 'nested', kind: 'process', status: 'running', startedAt: 1 }));
  for (const id of ['killed', 'lost', 'timed_out']) await f.task(id, { status: 'running', startedAt: 1 });
  await f.task('quiet', { status: 'running', startedAt: 1 });
  assert.equal((await look()).length, 5);
  for (const id of ['killed', 'lost', 'timed_out']) await f.task(id, { status: id, startedAt: 1, endedAt: 1 });
  await f.task('quiet', { status: 'failed', startedAt: 1, endedAt: 3, terminalNotificationSuppressed: true });
  assert.deepEqual((await look()).sort(), [['killed', 'cancelled'], ['lost', 'failed'], ['quiet', 'failed'], ['timed_out', 'failed']]);
});

test('every way a main turn starts and ends counts as the turn that takes up what ended before it', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('one', { status: 'running', startedAt: 1 });
  await look();
  await f.task('one', { status: 'completed', startedAt: 1, endedAt: 3 });
  assert.deepEqual(await look(), [['one', 'handling']]);
  await appendFile(f.wire, [{ type: 'turn.prompt', agentId: 'main', turnId: 1, time: 4 }, { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'blocked', time: 5 }]
    .map(e => JSON.stringify(e) + '\n').join(''));
  assert.deepEqual(await look(), [['one', 'done']]);
});

test('what cannot be read now is looked at again; what is not laid out as understood ends what was waited on', async t => {
  const f = await layout(t), look = looker(f);
  await f.task('one', { status: 'running', startedAt: 1 });
  await look();
  await f.task('one', { status: 'completed', startedAt: 1, endedAt: 3 });
  // A wire still being written is no answer.
  await appendFile(f.wire, '{"type":"turn.prompt","agentId":"main",');
  await assert.rejects(look());
  await appendFile(f.wire, '"turnId":1,"time":4}\n');
  assert.deepEqual(await look(), [['one', 'handling']]);
  // An ending that names no agent, or another, is not the layout understood.
  await appendFile(f.wire, JSON.stringify({ type: 'turn.ended', turnId: 1, agentId: 'child', reason: 'completed', time: 5 }) + '\n');
  assert.deepEqual(await look(), [['one', 'failed']]);
});

test('foreign sessions, links, oversized files and other versions tell nothing; unrelated index lines do not stop it', async t => {
  const f = await layout(t);
  await f.task('one', { status: 'running', startedAt: 1 });
  assert.deepEqual(await looker(f, { version: '2.2.0' })(), []);
  await appendFile(join(f.home, 'session_index.jsonl'), 'null\n{partial\n');
  assert.deepEqual(await looker(f)(), [['one', 'waiting']]);
  await writeFile(join(f.session, 'state.json'), JSON.stringify({ ...f.state, id: 'another' }));
  assert.deepEqual(await looker(f)(), []);
  await writeFile(join(f.session, 'state.json'), JSON.stringify(f.state));
  await rm(join(f.tasks, 'one.json')); const foreign = join(f.cwd, 'foreign.json');
  await writeFile(foreign, JSON.stringify({ taskId: 'one', kind: 'process', status: 'running', startedAt: 1 })); await symlink(foreign, join(f.tasks, 'one.json'));
  assert.deepEqual(await looker(f)(), []);
  await rm(join(f.tasks, 'one.json')); await writeFile(join(f.tasks, 'one.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(looker(f)());
  assert.equal(await kimiSession({ version: 'future', env: { KIMI_CODE_HOME: '/does/not/exist' } }).observe({ signal: new AbortController().signal }), null);
});

test('tasks from before this agent process are not told', async t => {
  const f = await layout(t);
  await f.task('old', { status: 'running', startedAt: 1 });
  assert.deepEqual(await looker(f, { startedAt: 10 })(), []);
});

// The relay, with Kimi and its files stood in for.
function relay({ env = {}, facts = () => null } = {}) {
  const said = [], told = [];
  const session = { observe: async () => facts(), watch: () => ({ close() {} }) };
  const r = new KimiRelay({ say: m => said.push(m), tell: m => told.push(m), env, startedAt: 0, every: 50, hold: 200, session: () => session });
  const ready = async () => {
    r.fromCoda({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    r.fromAgent({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } } });
    r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work', mcpServers: [] } });
    r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
    await r.drained(); await delay(10);
  };
  return { r, said, told, ready };
}
const running = { tasks: [{ taskId: 'job', kind: 'process', status: 'running', startedAt: 1 }], turnEndedAt: 2 };

for (const plain of [false, true]) test(`the relay ${plain ? 'passes through' : 'classifies'} a five-hour quota failure without retrying`, async t => {
  const { r, said, told, ready } = relay({ env: plain ? { CODA_DISABLE_RUNTIME_PATCHES: 'kimi' } : {} });
  t.after(() => r.close());
  await ready();
  const reason = "403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
  const reply = { jsonrpc: '2.0', id: 2, error: { code: -32000, message: `Authentication required: ${reason}` } };
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: '继续' }] } });
  r.fromAgent(reply);
  await r.drained();
  if (plain) assert.equal(said.at(-1), reply);
  else {
    assert.equal(said.at(-1).id, 2);
    assert.equal(said.at(-1).error.code, -32603);
    assert.match(said.at(-1).error.message, /^额度不足：/);
    assert.ok(said.at(-1).error.message.endsWith(reason));
    assert.deepEqual(said.at(-1).error.data._meta.coda.failure, { kind: 'quota_exhausted' });
  }
  assert.equal(told.filter(message => message.method === 'session/prompt').length, 1);
});

test('quota adaptation leaves session creation errors and content notifications unchanged', async t => {
  const { r, said } = relay();
  t.after(() => r.close());
  const reason = "Authentication required: 403 You've reached your 5-hour usage limit.";
  r.fromCoda({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: { cwd: '/work', mcpServers: [] } });
  const reply = { jsonrpc: '2.0', id: 'new', error: { code: -32000, message: reason } };
  const notification = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reason } } } };
  r.fromAgent(reply); r.fromAgent(notification);
  await r.drained();
  assert.equal(said[0], reply);
  assert.equal(said[1], notification);
});

test('the relay says it reports waits, and before Kimi\'s answer to a prompt is passed on, what that turn took up is told', async t => {
  let facts = running;
  const { r, said, told, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready();
  assert.deepEqual(said[0].result.agentCapabilities, { sessionCapabilities: { systemPrompt: {} }, _meta: { coda: { waits: {} } } });
  assert.deepEqual(said.filter(m => m.method === '_coda/wait').map(m => m.params.state), ['waiting']);
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [] } });
  assert.equal(told.at(-1).id, 2);
  facts = { tasks: [{ ...running.tasks[0], status: 'completed', endedAt: 3 }], turnEndedAt: 4 };
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.deepEqual(said.slice(-2).map(m => m.method ?? m.result.stopReason), ['_coda/wait', 'end_turn']);
  assert.equal(said.at(-2).params.state, 'done');
});

test('a subagent ending during a Coda prompt is done while the parent keeps working', async t => {
  const child = { taskId: 'child', kind: 'agent', agentId: 'agent-1', status: 'running', startedAt: 1 };
  let facts = { tasks: [child], turnEndedAt: 2 };
  const { r, said, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready();
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [] } });
  facts = { tasks: [{ ...child, status: 'completed', endedAt: 3 }], turnEndedAt: 2 };
  await r.look({ fresh: true });
  assert.deepEqual(said.filter(m => m.method === '_coda/wait').map(m => m.params.state), ['waiting', 'done']);
});

test('outside a prompt, with nothing handled, what Kimi says waits for a look: what it handles is told first', async t => {
  let facts = running;
  const { r, said, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready(); await delay(60);
  facts = { tasks: [{ ...running.tasks[0], status: 'completed', endedAt: 3 }], turnEndedAt: 2 };
  r.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '接着做' } } } });
  await r.drained();
  assert.deepEqual(said.slice(-2).map(m => m.method), ['_coda/wait', 'session/update']);
  assert.equal(said.at(-2).params.state, 'handling');
});

test('CODA_DISABLE_RUNTIME_PATCHES=kimi leaves a plain relay, but for the session instructions', async t => {
  let looked = 0;
  const { r, said, ready } = relay({ env: { CODA_DISABLE_RUNTIME_PATCHES: 'kimi' }, facts: () => { looked++; return running; } });
  t.after(() => r.close());
  await ready();
  assert.deepEqual([said.length, said[0].result.agentCapabilities, looked], [2, { sessionCapabilities: { systemPrompt: {} } }, 0]);
});

test('Coda\'s session instructions go in front of a new session\'s first prompt only, never to Kimi as a parameter', async t => {
  const { r, said, told } = relay();
  t.after(() => r.close());
  const systemPrompt = { mode: 'append', content: [{ type: 'text', text: '# Coda client' }] };
  const prompt = (id, sessionId, text) => { r.fromCoda({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }); return told.at(-1).params.prompt; };
  r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work', mcpServers: [], systemPrompt } });
  assert.deepEqual(told.at(-1).params, { cwd: '/work', mcpServers: [] });
  r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
  // A slash command is Kimi's to read as one: the instructions wait.
  assert.deepEqual(prompt(2, SESSION, '/compact'), [{ type: 'text', text: '/compact' }]);
  const [instructions, input] = prompt(3, SESSION, '你好');
  assert.equal(instructions.type, 'text');
  assert.match(instructions.text, /^<coda-session-instructions>\n[^]*\n\n# Coda client\n<\/coda-session-instructions>\n$/);
  assert.deepEqual(input, { type: 'text', text: '你好' });
  assert.deepEqual(prompt(4, SESSION, '再来'), [{ type: 'text', text: '再来' }]);
  // A loaded session has had them.
  r.fromCoda({ jsonrpc: '2.0', id: 5, method: 'session/load', params: { sessionId: 'other', cwd: '/work', mcpServers: [], systemPrompt } });
  assert.deepEqual(told.at(-1).params, { sessionId: 'other', cwd: '/work', mcpServers: [] });
  r.fromAgent({ jsonrpc: '2.0', id: 5, result: {} });
  assert.deepEqual(prompt(6, 'other', '继续'), [{ type: 'text', text: '继续' }]);
  // What cannot be applied opens no session.
  const count = told.length;
  r.fromCoda({ jsonrpc: '2.0', id: 7, method: 'session/new', params: { cwd: '/work', mcpServers: [], systemPrompt: { mode: 'override', content: [] } } });
  await r.drained();
  assert.equal(told.length, count);
  assert.deepEqual([said.at(-1).id, said.at(-1).error.code], [7, -32602]);
});

test('a title Kimi took from the instructions in front of the first prompt is not passed on; its own titles are', async t => {
  const { r, said } = relay();
  t.after(() => r.close());
  const info = update => r.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'session_info_update', ...update } } });
  info({ title: '<coda-session-instructions> Instructions from Coda, the client this session runs in', updatedAt: '2026-10-14T00:00:00Z' });
  info({ title: '修好登录页' });
  await r.drained();
  const titles = said.filter(m => m.params?.update?.sessionUpdate === 'session_info_update').map(m => m.params.update);
  assert.deepEqual(titles, [{ sessionUpdate: 'session_info_update', updatedAt: '2026-10-14T00:00:00Z' }, { sessionUpdate: 'session_info_update', title: '修好登录页' }]);
});

test('setup installs a missing or broken Kimi CLI, upgrades one older than the file layout the relay reads, and keeps a newer one', () => {
  const run = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(MINIMUM, '2.1.1');
  assert.deepEqual(needed(null), { action: 'install', reason: '这台机器上没有 Kimi CLI' });
  assert.equal(needed('/bin/kimi', run(1)).action, 'install');
  assert.deepEqual(needed('/bin/kimi', run(0, 'kimi, version 1.6.0\n')), { action: 'upgrade', reason: 'Kimi CLI 1.6.0 低于所需的 2.1.1' });
  assert.deepEqual(needed('/bin/kimi', run(0, '', 'kimi 2.1.1\n')), { action: 'none', version: '2.1.1' });
  assert.deepEqual(needed('/bin/kimi', run(0, 'kimi 2.10.0\n')), { action: 'none', version: '2.10.0' });
  assert.equal(needed('/bin/kimi', run(0, 'kimi\n')).action, 'upgrade');
});
