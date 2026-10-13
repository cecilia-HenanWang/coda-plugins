import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';
import { explainCodexError } from '../../../plugins/codex/agent/errors.mjs';

const fixture = fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('error adaptation preserves the response identity, code and data and only uses textual explanations once', () => {
  const reply = { jsonrpc: '2.0', id: 'prompt-1', error: { code: -32603, message: 'Internal error',
    data: { message: '  请求失败  ', details: '请求失败', context: { diagnostic: 'not user-facing' } } } };
  const explained = explainCodexError(reply);
  assert.deepEqual(explained, { ...reply, error: { ...reply.error, message: 'Internal error\n\n请求失败' } });
  assert.equal(explainCodexError(explained), explained);
  assert.equal(reply.error.message, 'Internal error');
  for (const unchanged of [
    { jsonrpc: '2.0', id: 'ok', result: { stopReason: 'end_turn' } },
    { jsonrpc: '2.0', method: 'session/update', params: { text: 'Internal error' } },
    { jsonrpc: '2.0', id: 'bad', error: { code: -32602, message: 'Invalid params', data: { message: {}, details: ['diagnostic'], field: 'test' } } },
  ]) assert.equal(explainCodexError(unchanged), unchanged);
});

// A plain ACP client only needs error.message. Exercise the locked adapter's actual data.message, data.details and
// string data failures through the plugin entry, including the failure before a session exists.
for (const [method, reason, env] of [
  ['session/prompt', "model 'gpt-6.1-sol' is not enabled in rustponsesapi", { FAKE_CODEX_MODEL_ERROR: 'usageLimitExceeded' }],
  ['session/prompt', 'Account source unavailable before starting the turn', { FAKE_CODEX_RPC_ERROR_METHOD: 'turn/start' }],
  ['session/new', 'Failed to load config: invalid test configuration', { FAKE_CODEX_RPC_ERROR_METHOD: 'thread/start' }],
]) test(`Codex entry puts ${env.FAKE_CODEX_RPC_ERROR_METHOD ?? 'model-service'} failures in ACP error.message`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-errors-')), codex = join(root, 'codex');
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
  await chmod(codex, 0o700);
  const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...process.env, ...env, FAKE_CODEX_RPC_ERROR: reason, FAKE_CODEX_STATE: root, CODEX_PATH: codex, CODEX_HOME: join(root, 'home') } });
  t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(root, { recursive: true, force: true }); });
  const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.error, undefined);
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  if (method === 'session/prompt') assert.equal(session.error, undefined);
  const reply = method === 'session/new' ? session : await request(method, { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'original task' }] });
  assert.equal(reply.error?.code, -32603);
  assert.ok(reply.error.message.includes(reason), reply.error.message);
  if (method === 'session/new') assert.ok(reply.error.message.includes('Check '), reply.error.message);
  if (env.FAKE_CODEX_RPC_ERROR_METHOD === 'turn/start') {
    const again = await request(method, { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'continue' }] });
    assert.equal(again.result?.stopReason, 'end_turn', JSON.stringify(again));
  }
});
