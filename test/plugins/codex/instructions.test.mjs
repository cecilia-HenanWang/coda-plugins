// Coda's session instructions and steering through the Codex entry (docs/agent-protocol.md「会话指令」「插话」): the text reaches
// Codex as the thread's developer instructions, and a steer that finds no turn going is answered `promptRequired`. The
// patches are held against the locked codex-acp, and the real entry runs against the fixture app-server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexWaits } from '../../../plugins/codex/agent/waits.mjs';
import { INSTRUCTIONS, instructedCodexThreads } from '../../../plugins/codex/agent/instructions.mjs';
import { promptRequiredCodexSteering } from '../../../plugins/codex/agent/steering.mjs';
import { resolveFrom } from '../plugin.mjs';
import { pluginEnv } from '../command.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const systemPrompt = text => ({ mode: 'append', content: [{ type: 'text', text }] });

test('the entry hands the instructions over in _meta, which codex-acp\'s schema keeps, and refuses what it cannot apply', () => {
  const waits = new CodexWaits();
  const { agent: [opened] } = waits.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/', mcpServers: [], _meta: { other: 1 }, systemPrompt: systemPrompt('# Coda') } });
  assert.deepEqual(opened.params, { cwd: '/', mcpServers: [], _meta: { other: 1, [INSTRUCTIONS]: '# Coda' } });
  const { agent: [loaded] } = waits.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's', cwd: '/', mcpServers: [], systemPrompt: systemPrompt('# Coda') } });
  assert.deepEqual(loaded.params, { sessionId: 's', cwd: '/', mcpServers: [], _meta: { [INSTRUCTIONS]: '# Coda' } });
  for (const wrong of [{ mode: 'override', content: [{ type: 'text', text: 'x' }] }, { mode: 'append', content: [{ type: 'image', data: '', mimeType: 'image/png' }] }]) {
    const refused = waits.fromCoda({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/', mcpServers: [], systemPrompt: wrong } });
    assert.deepEqual([refused.agent, refused.coda[0].id, refused.coda[0].error.code], [[], 3, -32602]);
  }
});

test('the patches apply to the locked codex-acp, and fail loudly once it changes', () => {
  const instructed = instructedCodexThreads(bundle);
  // thread/start in newSession, thread/resume in loadSession and resumeSession.
  assert.equal(instructed.split('developerInstructions: await codaDeveloperInstructions(this.codexClient, request)').length - 1, 3);
  assert.ok(instructed.startsWith('import { codaDeveloperInstructions } from '), 'its own executable header gone');
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: instructed, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => instructedCodexThreads(bundle.replace('      modelProvider: this.getModelProvider(),\n      cwd: request.cwd\n', '      cwd: request.cwd\n')), /no longer matches/);
  const steering = promptRequiredCodexSteering(bundle);
  assert.match(steering, /return \{ outcome: "promptRequired", reason: "noRunningTurn" \};/);
  assert.throws(() => promptRequiredCodexSteering(bundle.replace('return await this.startNewTurnFromSteering(params);', 'return null;')), /no longer matches/);
  // codex-acp declares steering itself, where Coda reads it.
  assert.match(bundle, /      _meta: \{\n        steering: \{\n          supported: true\n        \},/);
});

test('through the real entry: Codex gets the instructions on thread/start and thread/resume, and an idle steer starts nothing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-instructions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The fixture's first turn in a state directory dies; here it has died already.
  writeFileSync(join(root, 'died'), '');
  const codex = join(root, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(codex, 0o755);
  const entry = fileURLToPath(new URL('../../../plugins/codex/agent/entry.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'],
    env: pluginEnv('codex', { CODEX_PATH: codex, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home') }) });
  t.after(() => child.kill('SIGKILL'));
  const out = [];
  let rest = '', next = 0;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    const lines = (rest + chunk).split('\n'); rest = lines.pop();
    for (const line of lines) out.push(JSON.parse(line));
  });
  const request = async (method, params) => {
    const id = `coda-${++next}`;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 2000; i++) { const answer = out.find(m => m.id === id && !m.method); if (answer) return answer; await delay(5); }
    throw new Error(`${method} 没有回答`);
  };
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  // The session's own: not the ephemeral thread and structured turn codex-acp titles the session with.
  const threads = () => read('threads.ndjson').filter(t => !t.params.ephemeral), turns = () => read('prompts.ndjson').filter(p => !p.outputSchema).length;

  const init = (await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result;
  assert.deepEqual(init.agentCapabilities.sessionCapabilities.systemPrompt, {});
  assert.equal(init._meta.steering.supported, true);
  const opened = (await request('session/new', { cwd: root, mcpServers: [], systemPrompt: systemPrompt('# Coda client\n\nReplies are shown in Coda.') })).result;
  assert.deepEqual(threads().map(t => [t.method, t.params.developerInstructions]), [['thread/start', '# Coda client\n\nReplies are shown in Coda.']]);
  assert.equal((await request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'hi' }] })).result.stopReason, 'end_turn');
  assert.equal(turns(), 1);
  // The turn has ended: the steer is not taken, and no turn is started for it.
  const steered = await request('_session/steering', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: '先别改测试' }], _meta: { steering: { idleBehavior: 'promptRequired' } } });
  assert.deepEqual(steered.result, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  await delay(100);
  assert.equal(turns(), 1);
  assert.equal((await request('session/new', { cwd: root, mcpServers: [], systemPrompt: { mode: 'override', content: [] } })).error.code, -32602);
  assert.equal(threads().length, 1, 'refused before codex-acp');
  // Loaded, the instructions go on thread/resume, as given this time, after those Codex's own configuration gives.
  writeFileSync(join(root, 'developer_instructions.txt'), 'Own instructions.');
  await request('session/load', { sessionId: opened.sessionId, cwd: root, mcpServers: [], systemPrompt: systemPrompt('newer') });
  assert.deepEqual(threads().map(t => [t.method, t.params.developerInstructions]).at(-1), ['thread/resume', 'Own instructions.\n\nnewer']);
  // Without instructions of Coda's, Codex's own are left to Codex.
  await request('session/load', { sessionId: opened.sessionId, cwd: root, mcpServers: [] });
  assert.deepEqual(threads().map(t => [t.method, 'developerInstructions' in t.params]).at(-1), ['thread/resume', false]);
});
