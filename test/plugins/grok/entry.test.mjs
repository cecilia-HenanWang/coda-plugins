import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda.mjs';
import { pluginDir } from '../plugin.mjs';

const manifest = JSON.parse(readFileSync(join(pluginDir('grok'), 'package.json')));
const command = manifest.contributes.agents[0].command;
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const timeout = 5000;

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-entry-'));
  mkdirSync(join(dir, '.grok/bin'), { recursive: true });
  writeFileSync(join(dir, '.grok/bin/grok'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`, { mode: 0o755 });
  const messages = [], processes = [];
  const start = () => {
    const p = new AgentProcess({ command, cwd: dir, env: { ...process.env, HOME: dir, GROK_HOME: join(dir, '.grok'), FAKE_GROK_STATE: dir,
      CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('grok') }, onMessage: m => messages.push(m) });
    processes.push(p); return p;
  };
  t.after(async () => { for (const p of processes) { await p.terminate(1500); p.kill(); } rmSync(dir, { recursive: true, force: true }); });
  const request = async (p, method, params = {}) => {
    const r = await p.request(method, params, { timeout }); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.result;
  };
  const open = async (p, load = false) => {
    await request(p, 'initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
    return request(p, load ? 'session/load' : 'session/new', { cwd: dir, mcpServers: [{ name: 'tools', command: '/tools', args: [], env: [] }],
      _meta: { rules: 'project rules' }, ...(load ? { sessionId: 'native-session' } : {}) });
  };
  const mode = (p, modeId) => request(p, 'session/set_mode', { sessionId: 'native-session', modeId });
  const prompt = (p, text = 'report') => request(p, 'session/prompt', { sessionId: 'native-session', prompt: [{ type: 'text', text }] });
  const report = async p => { await prompt(p); return JSON.parse(messages.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').at(-1).params.update.content.text); };
  return { dir, start, request, open, mode, prompt, report, messages };
}

test('approval modes reach Grok, resume history and options, and can return to machine configuration', async t => {
  const f = setup(t), p = f.start();
  const opened = await f.open(p);
  assert.deepEqual(opened.modes.availableModes.map(m => m.id), ['default', 'auto', 'always-approve']);
  assert.equal(opened.modes.currentModeId, 'default');
  assert.equal(opened._meta.untouched, true);
  assert.equal(manifest.contributes.agents[0].modes.auto, 'auto');
  assert.equal(manifest.contributes.agents[0].modes.full, 'always-approve');
  await f.request(p, 'session/set_config_option', { sessionId: 'native-session', configId: 'model', value: 'large' });
  await f.request(p, 'session/set_config_option', { sessionId: 'native-session', configId: 'reasoning_effort', value: 'high' });
  let previous = await f.report(p);
  for (const [index, chosen] of ['auto', 'always-approve', 'auto', 'default'].entries()) {
    const before = f.messages.length;
    await f.mode(p, chosen);
    const switched = f.messages.slice(before);
    assert.equal(switched.some(m => ['user_message_chunk', 'agent_message_chunk'].includes(m.params?.update?.sessionUpdate)), false, 'load history is not duplicated');
    assert.equal(switched.at(-1).params.update.currentModeId, chosen);
    assert.ok(switched.some(m => m.params?.update?.sessionUpdate === 'available_commands_update'));
    const actual = await f.report(p);
    assert.deepEqual([actual.mode, actual.model, actual.effort, actual.turns], [chosen, 'large', 'high', index * 2 + 2]);
    assert.notEqual(actual.pid, previous.pid);
    assert.equal(actual.opened.sessionId, 'native-session');
    assert.equal(actual.opened.cwd, f.dir);
    assert.equal(actual.opened.mcpServers[0].name, 'tools');
    assert.equal(actual.opened._meta.rules, 'project rules');
    if (chosen === 'default') assert.deepEqual(actual.opened._meta, { rules: 'project rules' });
    else assert.deepEqual(actual.opened._meta, { rules: 'project rules', autoMode: chosen === 'auto', yoloMode: chosen === 'always-approve' });
    await f.mode(p, chosen);
    assert.equal((await f.report(p)).pid, actual.pid, 'selecting the same mode keeps the process');
    previous = actual;
  }
});

test('a failed load or option restore keeps the working connection and reports the upstream error', async t => {
  const f = setup(t), p = f.start(); await f.open(p);
  await f.mode(p, 'auto');
  await f.request(p, 'session/set_config_option', { sessionId: 'native-session', configId: 'model', value: 'large' });
  const before = await f.report(p);
  for (const [file, code, message] of [['fail-load', -32002, 'load refused'], ['fail-config', -32602, 'config refused']]) {
    writeFileSync(join(f.dir, file), '');
    const r = await p.request('session/set_mode', { sessionId: 'native-session', modeId: 'always-approve' }, { timeout });
    assert.equal(r.error.code, code); assert.equal(r.error.message, message);
    if (file === 'fail-load') assert.deepEqual(r.error.data, { reason: 'fixture' });
    rmSync(join(f.dir, file));
    const after = await f.report(p);
    assert.deepEqual([after.mode, after.model, after.pid], ['auto', 'large', before.pid]);
  }
});

test('running turns keep their permissions; cancel and permission replies pass through', async t => {
  const f = setup(t), p = f.start(); await f.open(p);
  const held = f.prompt(p, 'hold');
  await until(() => f.messages.some(m => m.params?.update?.content?.text === 'holding'));
  const r = await p.request('session/set_mode', { sessionId: 'native-session', modeId: 'always-approve' }, { timeout });
  assert.equal(r.error.code, -32600);
  p.notify('session/cancel', { sessionId: 'native-session' });
  assert.equal((await held).stopReason, 'cancelled');
  const asked = f.prompt(p, 'ask');
  await until(() => f.messages.some(m => m.method === 'session/request_permission'));
  p.respond('grok-question', { outcome: { outcome: 'selected', optionId: 'no' } });
  await asked;
  const text = f.messages.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').at(-1).params.update.content.text;
  assert.deepEqual(JSON.parse(text), { outcome: { outcome: 'selected', optionId: 'no' } });
  await f.mode(p, 'auto'); assert.equal((await f.report(p)).mode, 'auto');
});

test('a new entry loads the same native session and applies the selected mode before its next prompt', async t => {
  const f = setup(t), first = f.start(); await f.open(first); await f.mode(first, 'always-approve'); await f.report(first);
  await first.terminate(1500); first.kill();
  const resumed = f.start(); const loaded = await f.open(resumed, true);
  assert.equal(loaded.modes.currentModeId, 'default');
  await f.mode(resumed, 'auto');
  const actual = await f.report(resumed);
  assert.deepEqual([actual.mode, actual.turns], ['auto', 2]);
  const invalid = await resumed.request('session/set_mode', { sessionId: 'native-session', modeId: 'missing' }, { timeout });
  assert.equal(invalid.error.code, -32602);
});

test('a prompt sent during a mode switch waits for the new connection', async t => {
  const f = setup(t), p = f.start(); await f.open(p);
  const switched = f.mode(p, 'auto'), prompted = f.report(p);
  await switched;
  assert.equal((await prompted).mode, 'auto');
});

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('timed out waiting for agent update');
}
