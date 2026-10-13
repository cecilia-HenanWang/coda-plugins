// From Coda's backend/test/codex-network.test.mjs at ef1d2311, as plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { networkedCodexDevelopment } from '../../../plugins/codex/agent/network.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const patched = networkedCodexDevelopment(bundle);

// Execute the pinned adapter's mode definitions and actual outgoing turn path. Merely setting
// CODEX_CONFIG.network_access would miss the turn's sandboxPolicy override that caused this bug.
function adapterTurn(source) {
  const modeStart = source.indexOf('// src/AgentMode.ts'), modeEnd = source.indexOf('// src/CodexAcpClient.ts', modeStart);
  const sendStart = source.indexOf('  async sendPrompt(request, agentMode,'), sendEnd = source.indexOf('  async setCollaborationMode(', sendStart);
  const rootsStart = source.indexOf('function addAdditionalDirectoriesToSandboxPolicy('), rootsEnd = source.indexOf('function arraysEqual(', rootsStart);
  return vm.runInNewContext(`${source.slice(modeStart, modeEnd)}\n${source.slice(rootsStart, rootsEnd)}\n({
    modes: AgentMode,
    ${source.slice(sendStart, sendEnd)}
  })`, { buildPromptItems: prompt => prompt, process: { env: {} } });
}

test('automatic Codex development turns allow networking while retaining workspace and native review boundaries', async () => {
  const adapter = adapterTurn(patched), sent = [];
  const client = { refreshSkills: async () => {}, codexClient: { runTurn: async params => { sent.push(params); } } };
  await adapter.sendPrompt.call(client, { sessionId: 'thread', prompt: [{ type: 'text', text: 'open the PR' }] },
    adapter.modes.Agent, { model: 'fixture', effort: 'medium' }, undefined, false, '/checkout', ['/uploads', '/uploads']);
  const policy = JSON.parse(JSON.stringify(sent[0]));
  assert.equal(policy.approvalPolicy, 'on-request');
  assert.equal(policy.approvalsReviewer, 'auto_review');
  assert.deepEqual(policy.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/uploads'], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(adapter.modes.Agent.sandboxPolicy.writableRoots.length, 0, 'per-turn roots do not widen the mode default');
});

test('switching to explicit approvals restores the network boundary and full access retains its existing policy', async () => {
  const adapter = adapterTurn(patched), sent = [];
  const client = { refreshSkills: async () => {}, codexClient: { runTurn: async params => { sent.push(params); } } };
  for (const mode of [adapter.modes.Agent, adapter.modes.ReadOnly, adapter.modes.AgentFullAccess]) {
    await adapter.sendPrompt.call(client, { sessionId: 'thread', prompt: [] }, mode,
      { model: 'fixture' }, undefined, false, '/checkout', ['/uploads']);
  }
  const policies = JSON.parse(JSON.stringify(sent));
  assert.equal(policies[0].sandboxPolicy.networkAccess, true);
  assert.deepEqual(policies[1].sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/uploads'], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(policies[1].approvalPolicy, 'on-request');
  assert.equal(policies[1].approvalsReviewer, 'user');
  assert.deepEqual(policies[2].sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(policies[2].approvalPolicy, 'never');
  assert.equal(policies[2].approvalsReviewer, 'user');
});

test('the network policy patch rejects an incompatible or already patched adapter', () => {
  assert.throws(() => networkedCodexDevelopment(bundle.replace('"Only ask for actions detected as potentially unsafe"', '"changed"')), /no longer matches/);
  assert.throws(() => networkedCodexDevelopment(patched), /no longer matches/);
});
