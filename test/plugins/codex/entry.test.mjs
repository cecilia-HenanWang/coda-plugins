// From Coda's backend/test/codex-entry.test.mjs at ef1d2311, as plain node:test. Its case through the real codex-acp and
// Coda's backend stays in Coda.
// The Codex entry (plugins/codex/agent/): what codex-acp says in AIR of its subagents and background commands is said to Coda
// as waits (docs/agent-protocol.md「_coda/wait」), a continued subagent stays one session, and Coda's stop of a wait is asked
// of codex-acp the AIR way. End to end, the real codex-acp with its patches talks to a fixture app-server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexWaits } from '../../../plugins/codex/agent/waits.mjs';

const update = (sessionId, u) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const waitsSaid = messages => messages.filter(m => m.method === '_coda/wait').map(m => m.params);

test('Coda is told the entry reports its waits, and codex-acp is asked for subagent sessions and background commands', () => {
  const waits = new CodexWaits();
  const [initialize] = waits.fromCoda({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { _meta: { coda: { waits: {} } } } } }).agent;
  assert.deepEqual(initialize.params.clientCapabilities._meta, { coda: { waits: {} }, jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } } });
  const [answer] = waits.fromAgent({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  assert.deepEqual(answer.result.agentCapabilities, { loadSession: true, sessionCapabilities: { systemPrompt: {} }, _meta: { coda: { waits: {} } } });
});

test('subagents and background commands are waits; a continued subagent is a new wait of the same child session', () => {
  const waits = new CodexWaits();
  waits.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/', mcpServers: [] } });
  waits.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: 'root' } });
  const said = [
    update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: '检查', task: '检查目录', capabilities: {} }),
    update('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '在查' } }),
    update('root', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }),
    update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child:generation:2', name: '检查', task: '再查', capabilities: {} }),
    update('child:generation:2', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'ls', status: 'in_progress' }),
    update('root', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child:generation:2', state: 'disconnected' }),
    update('root', { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } } }),
    update('root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'cmd', name: 'npm test', taskType: 'shell', showInTranscript: false, canStop: true, toolCallId: 'cmd' }),
    update('root', { sessionUpdate: 'async_task_progress', asyncTaskId: 'cmd', summary: '…' }),
    update('root', { sessionUpdate: 'async_task_state_update', asyncTaskId: 'cmd', state: 'running' }),
    update('root', { sessionUpdate: 'async_task_state_update', asyncTaskId: 'cmd', state: 'stopped' }),
  ].flatMap(message => waits.fromAgent(message));
  assert.deepEqual(waitsSaid(said), [
    { sessionId: 'root', waitId: 'child', kind: 'subagent', state: 'waiting', title: '检查', detail: '检查目录', childSessionId: 'child', stoppable: false },
    { sessionId: 'root', waitId: 'child', state: 'done' },
    { sessionId: 'root', waitId: 'child:generation:2', kind: 'subagent', state: 'waiting', title: '检查', detail: '再查', childSessionId: 'child', stoppable: false },
    { sessionId: 'root', waitId: 'child:generation:2', state: 'failed' },
    { sessionId: 'root', waitId: 'cmd', kind: 'task', state: 'waiting', title: 'npm test', stoppable: true, toolCallId: 'cmd' },
    { sessionId: 'root', waitId: 'cmd', state: 'cancelled' },
  ]);
  // Nothing of AIR reaches Coda, and every session it names is the one Coda knows.
  const updates = said.filter(m => m.method === 'session/update');
  assert.deepEqual(updates.map(m => [m.params.sessionId, m.params.update.sessionUpdate]), [['child', 'agent_message_chunk'], ['child', 'tool_call'], ['root', 'tool_call_update']]);
  assert.deepEqual(updates[2].params.update._meta, { jetbrains: { air: { version: 1 } } });
  const asked = waits.fromAgent({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 'child:generation:2', toolCall: { toolCallId: 't' }, options: [] } });
  assert.equal(asked[0].params.sessionId, 'child');
});

test('a stop of a command is asked of the session that keeps it; one of nothing stoppable is refused', () => {
  const waits = new CodexWaits();
  waits.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 'root', cwd: '/', mcpServers: [] } });
  waits.fromAgent(update('child', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'child:cmd', name: 'sleep', taskType: 'shell', showInTranscript: false, canStop: true }));
  waits.fromAgent(update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'kept', name: 'k', task: 't', capabilities: { cancel: true } }));
  const stop = waits.fromCoda({ jsonrpc: '2.0', id: 'stop-1', method: '_coda/wait/stop', params: { sessionId: 'child', waitId: 'child:cmd' } });
  assert.deepEqual(stop, { agent: [{ jsonrpc: '2.0', id: 'stop-1', method: '_session/async_task/stop', params: { sessionId: 'root', asyncTaskId: 'child:cmd' } }], coda: [] });
  assert.deepEqual(waits.fromAgent({ jsonrpc: '2.0', id: 'stop-1', result: { stopped: true } }), [{ jsonrpc: '2.0', id: 'stop-1', result: {} }]);
  assert.deepEqual(waits.fromCoda({ jsonrpc: '2.0', id: 'stop-2', method: '_coda/wait/stop', params: { sessionId: 'root', waitId: 'kept' } }),
    { agent: [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'kept' } }], coda: [{ jsonrpc: '2.0', id: 'stop-2', result: {} }] });
  const refused = waits.fromCoda({ jsonrpc: '2.0', id: 'stop-3', method: '_coda/wait/stop', params: { sessionId: 'root', waitId: 'unknown' } });
  assert.deepEqual([refused.agent, refused.coda[0].error.code], [[], -32602]);
});
