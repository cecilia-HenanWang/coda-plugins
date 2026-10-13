// From Coda's backend/test/codex-subagents.test.mjs at ef1d2311, as plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { continuedCodexSubagents } from '../../../plugins/codex/agent/subagents.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
// The adapter's subagent router, from its path helpers to the next module, run against a recording session.
const subagentRouter = source => {
  const start = source.indexOf('// src/subagents/CodexAgentPath.ts'), end = source.indexOf('// src/', source.indexOf('var CodexSubagentEventRouter'));
  const updates = [], session = { update: async update => { updates.push(update); } };
  const Router = vm.runInNewContext(`const logger = { log() {} };\n${source.slice(start, end)}\nCodexSubagentEventRouter`);
  return { router: new Router('root', true, session), updates };
};
const activity = kind => ({ method: 'item/started', params: { threadId: 'root',
  item: { type: 'subAgentActivity', id: `activity-${kind}`, agentThreadId: 'child', agentPath: '/root/echo_check', kind } } });
const turn = (method, status) => ({ method, params: { threadId: 'child', turn: { id: 'turn', status } } });

test('a finished codex subagent reopens when its thread starts a turn, not when a message is only queued', async () => {
  const { router, updates } = subagentRouter(continuedCodexSubagents(bundle));
  await router.handle(activity('started'));
  await router.handle(turn('turn/completed', 'completed'));
  // send_message queues without running the subagent.
  await router.handle(activity('interacted'));
  assert.deepEqual(updates.map(u => [u.sessionUpdate, u.subagentSessionId]), [['subagent_spawned', 'child'], ['subagent_state_update', 'child']]);
  // followup_task starts a turn in the subagent's thread.
  assert.equal(await router.handle(turn('turn/started', 'inProgress')), true);
  assert.deepEqual({ ...updates.at(-1), capabilities: { ...updates.at(-1).capabilities } }, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child:generation:2', name: 'Echo check', task: 'Delegated task for Echo check', capabilities: {} });
  assert.equal(router.notificationSessionId({ params: { threadId: 'child' } }), 'child:generation:2');
});

test('the subagent patch fails loudly when the locked adapter changes', () => {
  assert.throws(() => continuedCodexSubagents(bundle.replace('if (notification.method === "turn/started") {', 'if (changed) {')), /no longer matches/);
});
