// From Coda's backend/test/kimi-entry.test.mjs at ef1d2311, as plain node:test. Its case through the entry and Coda's
// backend stays in Coda.
// The Kimi entry (plugins/kimi/agent/): what Kimi's own files say of its tasks is told to Coda as waits, and a task Kimi is told
// of when it ends is handled until its main agent ends a turn after it, which Coda then holds as a turn of the session's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { kimiSession } from '../../../plugins/kimi/agent/observe.mjs';
import { KimiWaits } from '../../../plugins/kimi/agent/waits.mjs';
import { KimiRelay } from '../../../plugins/kimi/agent/relay.mjs';

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

test('the relay says it reports waits, and before Kimi\'s answer to a prompt is passed on, what that turn took up is told', async t => {
  let facts = running;
  const { r, said, told, ready } = relay({ facts: () => facts });
  t.after(() => r.close());
  await ready();
  assert.deepEqual(said[0].result.agentCapabilities, { _meta: { coda: { waits: {} } } });
  assert.deepEqual(said.filter(m => m.method === '_coda/wait').map(m => m.params.state), ['waiting']);
  r.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: SESSION, prompt: [] } });
  assert.equal(told.at(-1).id, 2);
  facts = { tasks: [{ ...running.tasks[0], status: 'completed', endedAt: 3 }], turnEndedAt: 4 };
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.deepEqual(said.slice(-2).map(m => m.method ?? m.result.stopReason), ['_coda/wait', 'end_turn']);
  assert.equal(said.at(-2).params.state, 'done');
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

test('CODA_DISABLE_RUNTIME_PATCHES=kimi leaves a plain relay', async t => {
  let looked = 0;
  const { r, said, ready } = relay({ env: { CODA_DISABLE_RUNTIME_PATCHES: 'kimi' }, facts: () => { looked++; return running; } });
  t.after(() => r.close());
  await ready();
  assert.deepEqual([said.length, said[0].result.agentCapabilities, looked], [2, {}, 0]);
});
