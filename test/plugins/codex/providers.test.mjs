// The model service chosen for Codex (plugins/codex/agent/providers.mjs): which one, what it lists, and a turn on one of its
// models running on the session moved to the service as codex-acp moves it for `providers/set`. The patch is held against
// the locked codex-acp, and the real entry runs against the fixture app-server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceModels, chosenService, servedCodexModels, serviceModels } from '../../../plugins/codex/agent/providers.mjs';
import { resolveFrom } from '../plugin.mjs';
import { pluginEnv } from '../command.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const magpie = { plugin: 'magpie', title: 'Magpie · OpenAI Responses', api: 'openai-responses', url: 'http://127.0.0.1:3425/v1' };
const provided = (services, ref = 'magpie/responses') => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'codex.modelProvider': ref }), CODA_MODEL_PROVIDERS: JSON.stringify(services) });

test('the service chosen is the one of this machine that speaks the Responses API, with its key read from its file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'coda-codex-providers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(chosenService({}), null, 'none chosen');
  assert.deepEqual(chosenService(provided({ 'magpie/responses': magpie })), { ref: 'magpie/responses', title: 'Magpie · OpenAI Responses', url: 'http://127.0.0.1:3425/v1', key: undefined });
  writeFileSync(join(dir, 'key'), 'sk-service\n');
  assert.equal(chosenService(provided({ 'magpie/responses': { ...magpie, keyFile: join(dir, 'key') } })).key, 'sk-service');
  assert.equal(chosenService(provided({})), null, 'not on this machine');
  // Codex no longer speaks Chat Completions (`wire_api = "chat"` is refused).
  assert.equal(chosenService(provided({ 'cliproxy/cliproxy': { ...magpie, api: 'openai-completions' } }, 'cliproxy/cliproxy')), null);
});

test('its models are listed as Codex\'s model list has them, named by the model and the service', async () => {
  const asked = [];
  const fetcher = async (url, { headers }) => { asked.push([url, headers]); return Response.json({ data: [{ id: 'deepseek/deepseek-v4-pro' }, { id: '' }] }); };
  assert.deepEqual(await serviceModels({ ref: 'magpie/responses', title: 'Magpie · OpenAI Responses', url: 'http://127.0.0.1:3425/v1/' }, fetcher), [{
    id: 'magpie/responses/deepseek/deepseek-v4-pro', model: 'deepseek/deepseek-v4-pro', displayName: 'deepseek/deepseek-v4-pro (Magpie · OpenAI Responses)',
    description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], serviceTiers: [] }]);
  await serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com/v1', key: 'sk' }, fetcher);
  assert.deepEqual(asked, [['http://127.0.0.1:3425/v1/models', {}], ['https://example.com/v1/models', { Authorization: 'Bearer sk' }]]);
  // Listed once a process; one that cannot list now adds none.
  const services = new ServiceModels({ ref: 'x/y', title: 'X', url: 'http://127.0.0.1:1' });
  assert.deepEqual(await services.list(), []);
  assert.equal(services.list(), services.list());
});

test('what Codex says of the service\'s models it does not know is not said in the session; the rest is', async () => {
  const services = new ServiceModels({ ref: 'magpie/responses', title: 'M', url: 'http://x' }, async () => Response.json({ data: [{ id: 'fake/alpha' }] }));
  await services.list();
  assert.equal(services.wire('magpie/responses/fake/alpha'), 'fake/alpha');
  assert.equal(services.wire('gpt-5.5'), 'gpt-5.5');
  assert.equal(services.quiet({ message: 'Model metadata for `fake/alpha` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' }), true);
  assert.equal(services.quiet({ message: 'This session was recorded with model `fake/alpha` but is resuming with `gpt-6.1-sol`. Consider switching back.' }), true);
  assert.equal(services.quiet({ message: 'This session was recorded with model `gpt-5.5` but is resuming with `fake/alpha`. Consider switching back.' }), true);
  assert.equal(services.quiet({ message: 'Model metadata for `gpt-9` not found.' }), false);
  assert.equal(services.quiet({ message: 'Falling back from WebSockets to HTTPS transport.' }), false);
});

test('the patch applies to the locked codex-acp, and fails loudly once it changes', () => {
  const served = servedCodexModels(bundle);
  assert.ok(served.startsWith('import { services as codaServices } from '), 'its own executable header gone');
  for (const added of ['return [...models, ...await codaServices.list()];', 'if (await codaServices.route(this, params)) return { stopReason: "cancelled" };',
    'codaServices.cancel(params.sessionId);', 'model: codaServices.wire(modelId.model),',
    'if (codaServices.quiet(notification.params)) return null;']) assert.equal(served.split(added).length, 2, added);
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: served, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => servedCodexModels(bundle.replace('      model: modelId.model,\n      serviceTier\n', '      model: modelId.model,\n')), /no longer matches/);
});

// The real entry against the fixture app-server, with the service (listing `fake/alpha`, a key of its own) chosen.
async function entryOnService(t, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((_, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fake/alpha' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(root, 'key'), 'sk-service');
  // The fixture's first turn in a state directory dies; here it has died already.
  writeFileSync(join(root, 'died'), '');
  const codex = join(root, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(codex, 0o755);
  const entry = fileURLToPath(new URL('../../../plugins/codex/agent/entry.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'],
    env: pluginEnv('codex', { CODEX_PATH: codex, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home'),
      ...provided({ 'magpie/responses': { ...magpie, url, keyFile: join(root, 'key') } }), ...env }) });
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
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const opened = (await request('session/new', { cwd: root, mcpServers: [], systemPrompt: { mode: 'append', content: [{ type: 'text', text: '# Coda' }] } })).result;
  return { url, root, opened, request,
    cancel: () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: opened.sessionId } })}\n`),
    set: value => request('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value }),
    prompt: text => request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] }),
    // The session's own: not the ephemeral thread and structured turn codex-acp titles the session with.
    threads: () => read('threads.ndjson').filter(t => !t.params.ephemeral), turns: () => read('prompts.ndjson').filter(p => !p.outputSchema) };
}

test('through the real entry: a turn on the service\'s model runs on the session moved to the service, and one on Codex\'s own moves it back', async t => {
  const { url, opened, set, prompt, threads, turns } = await entryOnService(t);
  const models = opened.configOptions.find(o => o.category === 'model');
  assert.deepEqual(models.options.map(o => [o.value, o.name]), [['fake', 'Fake'], ['magpie/responses/fake/alpha', 'fake/alpha (Magpie · OpenAI Responses)']]);
  const chosen = (await set('magpie/responses/fake/alpha')).result.configOptions;
  assert.equal(chosen.find(o => o.category === 'model').currentValue, 'magpie/responses/fake/alpha');
  assert.equal(chosen.find(o => o.category === 'thought_level'), undefined, 'no effort to choose');
  assert.deepEqual(threads().map(t => t.method), ['thread/start'], 'chosen, nothing moves yet');
  // Nothing said in the thread yet: it is named by what it is first told, then resumed on the service, with Coda's instructions.
  assert.equal((await prompt('  hello\nthere ')).result.stopReason, 'end_turn');
  const [named, moved] = threads().slice(1);
  assert.deepEqual([named.method, named.params.name], ['thread/name/set', 'hello there']);
  assert.deepEqual([moved.method, moved.params.threadId, moved.params.modelProvider, moved.params.developerInstructions], ['thread/resume', opened.sessionId, 'custom-gateway', '# Coda']);
  assert.deepEqual(moved.params.config.model_providers['custom-gateway'], { name: 'User-provided gateway', base_url: url, wire_api: 'responses',
    http_headers: { 'X-Client-Feature-ID': 'codex', Authorization: 'Bearer sk-service' } });
  assert.equal(turns().at(-1).model, 'fake/alpha', 'named as the service names it');
  // Another turn on it moves nothing; Codex's own model moves the session back to Codex's provider.
  await prompt('again');
  assert.equal(threads().length, 3);
  await set('fake');
  await prompt('native');
  const back = threads().at(-1);
  assert.deepEqual([threads().length, back.method, back.params.modelProvider, back.params.developerInstructions, back.params.config.model_providers],
    [4, 'thread/resume', 'openai', '# Coda', undefined]);
  assert.equal(turns().at(-1).model, 'fake');
});

test('through the real entry: a turn stopped while the session moves to the service ends cancelled, its input not given', async t => {
  // The move is held where it reads the thread, until the stop has come.
  const { root, request, set, prompt, cancel, turns } = await entryOnService(t, { FAKE_CODEX_HOLD: 'thread/read' });
  await set('magpie/responses/fake/alpha');
  const stopped = prompt('hello');
  for (let i = 0; i < 400 && !existsSync(join(root, 'held')); i++) await delay(5);
  // The entry reads what it is sent in order: a request answered after the stop says the stop was read before it.
  cancel();
  assert.equal((await request('coda/barrier', {})).error?.code, -32601);
  writeFileSync(join(root, 'release'), '');
  assert.equal((await stopped).result?.stopReason, 'cancelled');
  assert.equal(turns().length, 0, 'the input of a stopped turn is not given');
  assert.equal((await prompt('again')).result?.stopReason, 'end_turn');
  assert.equal(turns().at(-1).model, 'fake/alpha', 'the next turn runs on the service');
});

test('through the real entry: a move whose resume fails fails its turn, and the next turn moves the session again', async t => {
  const { set, prompt, threads, turns } = await entryOnService(t, { FAKE_CODEX_FAIL_ONCE: 'thread/resume' });
  await set('magpie/responses/fake/alpha');
  const failed = await prompt('hello');
  assert.match(failed.error?.message ?? '', /Failed to resume 1 session/);
  assert.equal(turns().length, 0, 'no turn on a thread not resumed');
  assert.equal((await prompt('again')).result?.stopReason, 'end_turn');
  assert.deepEqual(threads().filter(t => t.method === 'thread/resume').map(t => t.params.modelProvider), ['custom-gateway', 'custom-gateway']);
  assert.equal(turns().at(-1).model, 'fake/alpha');
  // Back on Codex's own after it: moved back as well.
  await set('fake'); await prompt('native');
  assert.deepEqual([threads().at(-1).params.modelProvider, turns().at(-1).model], ['openai', 'fake']);
});

test('through the real entry: a move whose restarted Codex does not start fails its turn, and the next moves the session on a Codex that does', async t => {
  // The second initialize: that of the app-server started again for the move.
  const { set, prompt, threads, turns } = await entryOnService(t, { FAKE_CODEX_FAIL_ONCE: 'initialize#2' });
  await set('magpie/responses/fake/alpha');
  const failed = await prompt('hello');
  assert.match(failed.error?.message ?? '', /initialize failed/);
  assert.equal(turns().length, 0, 'no turn on a Codex that did not start');
  // Back on Codex's own, as well as on to the service again.
  await set('fake');
  assert.equal((await prompt('native')).result?.stopReason, 'end_turn');
  assert.deepEqual([threads().at(-1).method, threads().at(-1).params.modelProvider, turns().at(-1).model], ['thread/resume', 'openai', 'fake']);
  await set('magpie/responses/fake/alpha');
  assert.equal((await prompt('service')).result?.stopReason, 'end_turn');
  assert.deepEqual([threads().at(-1).params.modelProvider, turns().at(-1).model], ['custom-gateway', 'fake/alpha']);
});
