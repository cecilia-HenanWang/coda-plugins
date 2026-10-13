// From Coda's backend/test/kimi-subagents.test.mjs at ef1d2311, as plain node:test. Its cases that hold what is said in
// Coda's store (ProductStore, RuntimeFeed) stay in Coda.
// What the Kimi entry tells Coda of Kimi's subagents (plugins/kimi/agent/): a subagent's run is a wait whose child session is
// its agent id, and what it says in its own wire is that session's updates, each once, in Coda's history apart from the
// main conversation. Only runs started since the agent process did are told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kimiSession } from '../../../plugins/kimi/agent/observe.mjs';
import { KimiWaits } from '../../../plugins/kimi/agent/waits.mjs';
import { KimiSubagentBridge } from '../../../plugins/kimi/agent/subagents.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coda-kimi-subagents-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi'), cwd = join(root, 'work'), sessionId = 'session-sub-test';
  const session = join(home, 'sessions', 'workspace', sessionId);
  const mainTasks = join(session, 'agents', 'main', 'tasks');
  const agent0Dir = join(session, 'agents', 'agent-0');
  await mkdir(mainTasks, { recursive: true });
  await mkdir(agent0Dir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir: session, workDir: cwd }) + '\n');
  const state = {
    version: 2,
    id: sessionId,
    cwd,
    agents: {
      main: { homedir: join(session, 'agents', 'main'), type: 'main' },
      'agent-0': { homedir: agent0Dir, type: 'sub', parentAgentId: 'main', labels: { profileName: 'coder' } },
    },
  };
  await writeFile(join(session, 'state.json'), JSON.stringify(state));

  const task = {
    taskId: 'task-001',
    description: '子任务描述测试',
    status: 'running',
    detached: true,
    startedAt: 1000,
    endedAt: null,
    timeoutMs: 7200000,
    kind: 'agent',
    agentId: 'agent-0',
    subagentType: 'coder',
    parentToolCallId: 'tool_launch_123',
    model: 'kimi-code/k3-256k',
    thinkingEffort: 'high',
  };
  await writeFile(join(mainTasks, `${task.taskId}.json`), JSON.stringify(task));

  const wireLines = [
    JSON.stringify({ type: 'llm.request', agentId: 'agent-0', time: 1001 }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'agent-0',
      event: {
        type: 'content.part',
        uuid: 'uuid-think-1',
        turnId: '0',
        step: 1,
        part: { type: 'think', think: '正在思考如何破解' },
      },
      time: 1002,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'agent-0',
      event: {
        type: 'tool.call',
        uuid: 'uuid-tool-1',
        turnId: '0',
        step: 1,
        toolCallId: 'tool_call_sub_1',
        name: 'Bash',
        args: { command: 'ls -la' },
      },
      time: 1003,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'agent-0',
      event: {
        type: 'tool.result',
        parentUuid: 'uuid-tool-1',
        toolCallId: 'tool_call_sub_1',
        result: { output: 'total 0\nfile.txt' },
      },
      time: 1004,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'agent-0',
      event: {
        type: 'content.part',
        uuid: 'uuid-text-1',
        turnId: '0',
        step: 1,
        part: { type: 'text', text: '文件列表已取得' },
      },
      time: 1005,
    }),
  ];
  await writeFile(join(agent0Dir, 'wire.jsonl'), wireLines.join('\n') + '\n');

  // Main wire for patch observe
  const mainWire = join(session, 'agents', 'main', 'wire.jsonl');
  await writeFile(mainWire, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\n' +
    JSON.stringify({ type: 'agent.turn.started', turnId: 0, time: 1 }) + '\n' +
    JSON.stringify({ type: 'turn.ended', turnId: 0, agentId: 'main', reason: 'completed', time: 2 }) + '\n');

  return { home, cwd, session, mainTasks, agent0Dir, state, task, wireLines };
}

const SESSION = 'session-sub-test';
// The entry's look at the session's files: what it says to Coda.
function kimi({ home, cwd }, startedAt = 0) {
  const session = kimiSession({ sessionId: SESSION, cwd, env: { KIMI_CODE_HOME: home }, version: '2.1.1', startedAt });
  const waits = new KimiWaits({ sessionId: SESSION, startedAt }), content = [];
  return async () => {
    const facts = await session.observe({ signal: new AbortController().signal, emit: (update, sessionId, taskId) => content.push({ update, sessionId, taskId }) });
    return facts ? waits.read(facts, content.splice(0)) : waits.lost();
  };
}
const waitsOf = messages => messages.filter(m => m.method === '_coda/wait').map(m => m.params);
const updatesOf = messages => messages.filter(m => m.method === 'session/update').map(m => m.params);
const loop = (time, event) => JSON.stringify({ type: 'context.append_loop_event', agentId: 'agent-0', event, time });
const text = (time, uuid, value) => loop(time, { type: 'content.part', uuid, turnId: '0', step: 1, part: { type: 'text', text: value } });
const ended = (task, endedAt, status = 'completed') => JSON.stringify({ ...task, status, endedAt });

test('a subagent run is a wait of its agent\'s session: what it says is that session\'s, and it is handled until a main turn ends after it', async t => {
  const f = await fixture(t), look = kimi(f);
  const said = await look();
  assert.deepEqual(waitsOf(said), [{ sessionId: SESSION, waitId: 'task-001', state: 'waiting', kind: 'subagent', title: '子任务描述测试', stoppable: false,
    childSessionId: 'agent-0', model: 'kimi-code/k3-256k' }]);
  assert.deepEqual(updatesOf(said).map(p => [p.sessionId, p.update.sessionUpdate]),
    [['agent-0', 'agent_thought_chunk'], ['agent-0', 'tool_call'], ['agent-0', 'tool_call_update'], ['agent-0', 'agent_message_chunk']]);
  assert.equal(updatesOf(said)[2].update.content[0].content.text, 'total 0\nfile.txt');
  assert.ok(said.indexOf(said.find(m => m.method === '_coda/wait')) < said.indexOf(said.find(m => m.method === 'session/update')), 'the wait is told before what its session says');
  // Ended, its result is still Kimi's to take up: the main agent works on it until a turn of its ends after it.
  await writeFile(join(f.mainTasks, 'task-001.json'), ended(f.task, 2000));
  assert.deepEqual(waitsOf(await look()), [{ sessionId: SESSION, waitId: 'task-001', state: 'handling' }]);
  await appendFile(join(f.session, 'agents/main/wire.jsonl'), JSON.stringify({ type: 'agent.turn.started', turnId: 1, time: 2100 }) + '\n');
  assert.deepEqual(await look(), []);
  await appendFile(join(f.session, 'agents/main/wire.jsonl'), JSON.stringify({ type: 'turn.ended', turnId: 1, agentId: 'main', reason: 'completed', time: 2200 }) + '\n');
  assert.deepEqual(waitsOf(await look()), [{ sessionId: SESSION, waitId: 'task-001', state: 'done' }]);
  assert.deepEqual(await look(), []);
});

test('what a subagent appends is told once, as it is appended', async t => {
  const f = await fixture(t), look = kimi(f);
  const first = updatesOf(await look()).length;
  assert.ok(first > 0);
  assert.deepEqual(await look(), []);
  await appendFile(join(f.agent0Dir, 'wire.jsonl'), loop(2001, { type: 'content.part', uuid: 'uuid-think-2', turnId: '0', step: 2, part: { type: 'think', think: '第二步思考' } }) + '\n');
  const more = updatesOf(await look());
  assert.deepEqual(more.map(p => p.update.content.text), ['第二步思考']);
});

test('a subagent that said nothing in its wire is told by its output.log as it ends', async t => {
  const f = await fixture(t);
  await writeFile(join(f.agent0Dir, 'wire.jsonl'), '');
  await mkdir(join(f.mainTasks, f.task.taskId), { recursive: true });
  await writeFile(join(f.mainTasks, f.task.taskId, 'output.log'), '任务完成摘要报告内容');
  await writeFile(join(f.mainTasks, 'task-001.json'), ended(f.task, 2000));
  const said = await kimi(f)();
  assert.deepEqual(updatesOf(said).map(p => [p.sessionId, p.update.content.text]), [['agent-0', '任务完成摘要报告内容']]);
});


test('runs from before this agent process are not told: a new process says nothing of them', async t => {
  const f = await fixture(t);
  // The first process told all of it; a restarted agent (a new entry) starts after it.
  await kimi(f)();
  assert.deepEqual(await kimi(f, 5000)(), []);
  await writeFile(join(f.mainTasks, 'task-001.json'), ended(f.task, 6000));
  assert.deepEqual(await kimi(f, 5000)(), []);
});









// The bridge alone, over the main wire only (no task files), with a read of the main wire that can fail.
async function wireOnly(t, { startedAt = 0 } = {}) {
  const f = await fixture(t);
  await rm(f.mainTasks, { recursive: true, force: true });
  const { readFile } = await import('node:fs/promises');
  let failing = false;
  const read = async path => { if (failing && path.includes('agents/main/wire.jsonl')) throw new Error('File changed during observation'); return readFile(path, 'utf8'); };
  const bridge = new KimiSubagentBridge({ session: f.session, root: f.session, readBounded: read, contained: (r, p) => p, startedAt });
  const state = { version: 2, id: SESSION, cwd: f.cwd, agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main' } } };
  const said = [];
  const sync = () => bridge.sync({ agents: ['agent-0'], state, signal: new AbortController().signal, emit: update => { if (update.content?.type === 'text') said.push(update.content.text); } });
  const main = events => writeFile(join(f.session, 'agents/main/wire.jsonl'), [{ type: 'metadata', protocol_version: '1.5' }, ...events].map(e => JSON.stringify(e)).join('\n') + '\n');
  const spawn = (taskId, time) => [{ type: 'subagent.spawned', subagentId: 'agent-0', subagentName: 'coder', taskId, description: taskId, runInBackground: false, time },
    { type: 'subagent.started', subagentId: 'agent-0', time }];
  const done = time => ({ type: 'subagent.completed', subagentId: 'agent-0', time });
  return { ...f, said, sync, main, spawn, done, fail: value => { failing = value; } };
}

test('what a subagent said after its known runs waits, through a failed read, until the run it belongs to is known', async t => {
  const w = await wireOnly(t);
  await w.main([...w.spawn('g1', 1000), w.done(2000)]);
  await writeFile(join(w.agent0Dir, 'wire.jsonl'), [text(1500, 'a', '第一代回复'), text(2200, 'b', '第二代早期回复')].join('\n') + '\n');
  await w.sync();
  assert.deepEqual(w.said, ['第一代回复'], 'not yet a known run\'s');
  await w.main([...w.spawn('g1', 1000), w.done(2000), ...w.spawn('g2', 2150)]);
  w.fail(true);
  await assert.rejects(w.sync(), /File changed during observation/);
  assert.deepEqual(w.said, ['第一代回复']);
  w.fail(false);
  await w.sync();
  assert.deepEqual(w.said, ['第一代回复', '第二代早期回复']);
});

test('a run\'s words before its spawn is logged, and those at its predecessor\'s very end, are each told once', async t => {
  const w = await wireOnly(t);
  await w.main([...w.spawn('g1', 1000), w.done(2000), ...w.spawn('g2', 3050)]);
  await mkdir(w.mainTasks, { recursive: true });
  await writeFile(join(w.mainTasks, 'g2.json'), JSON.stringify({ taskId: 'g2', agentId: 'agent-0', kind: 'agent', status: 'running', startedAt: 3000 }));
  await writeFile(join(w.agent0Dir, 'wire.jsonl'), [text(1500, 'a', '第一代中间'), text(2000, 'b', '第一代结束时刻'), text(3010, 'c', '第二代早到'), text(3100, 'd', '后续有效回复')].join('\n') + '\n');
  await w.sync();
  assert.deepEqual(w.said, ['第一代中间', '第一代结束时刻', '第二代早到', '后续有效回复']);
  await w.sync();
  assert.equal(w.said.length, 4);
});

test('an interrupted run from before this process does not swallow what the next run says', async t => {
  const w = await wireOnly(t, { startedAt: 8000 });
  await w.main([...w.spawn('g1', 1000), ...w.spawn('g2', 10000)]);
  await writeFile(join(w.agent0Dir, 'wire.jsonl'), [text(1500, 'a', '第一代中断前回复'), text(10500, 'b', '第二代正常回复')].join('\n') + '\n');
  await w.sync();
  assert.deepEqual(w.said, ['第二代正常回复']);
});
