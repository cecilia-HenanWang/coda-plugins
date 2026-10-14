import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

const manifest = JSON.parse(readFileSync(join(pluginDir('grok'), 'package.json')));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

test('Grok mode selection takes effect in the same process, preserving options; active turns cannot change mode', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-entry-')), messages = [];
  mkdirSync(join(dir, '.grok/bin'), { recursive: true });
  writeFileSync(join(dir, '.grok/bin/grok'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const p = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: dir, env: { ...process.env, HOME: dir,
    CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('grok') }, onMessage: m => messages.push(m) });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (method, params) => {
    const r = await p.request(method, params, { timeout: 5000 }); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.result;
  };
  const prompt = text => request('session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text }] });
  const report = async () => { await prompt('report'); return JSON.parse(messages.filter(m => m.params?.update?.content).at(-1).params.update.content.text); };
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  for (const method of ['session/new', 'session/load']) {
    const r = await request(method, { cwd: dir, mcpServers: [], ...(method === 'session/load' ? { sessionId: 'native' } : {}) });
    assert.deepEqual(r.modes.availableModes.map(m => m.id), ['auto', 'always-approve']);
    assert.equal(r.modes.currentModeId, '', 'no explicit mode overrides the machine configuration');
  }
  const before = await report(); assert.equal(before.mode, 'machine');
  await request('session/set_config_option', { sessionId: 'native', configId: 'reasoning_effort', value: 'high' });
  for (const modeId of ['auto', 'always-approve', 'auto']) {
    await request('session/set_mode', { sessionId: 'native', modeId });
    assert.equal(messages.at(-1).params.update.currentModeId, modeId);
    assert.deepEqual(await report(), { mode: modeId, effort: 'high', pid: before.pid });
  }
  const held = prompt('hold');
  for (let i = 0; i < 100 && messages.at(-1)?.params?.update?.content?.text !== 'holding'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.at(-1).params.update.content.text, 'holding');
  const refused = await p.request('session/set_mode', { sessionId: 'native', modeId: 'always-approve' }, { timeout: 5000 });
  assert.match(refused.error.message, /当前轮次/);
  p.notify('session/cancel', { sessionId: 'native' }); assert.equal((await held).stopReason, 'cancelled');
  assert.equal((await report()).mode, 'auto');
  for (const params of [{ sessionId: 'native', modeId: 'missing' }, { sessionId: 'missing', modeId: 'auto' }]) {
    assert.equal((await p.request('session/set_mode', params, { timeout: 5000 })).error.code, -32602);
  }
});
