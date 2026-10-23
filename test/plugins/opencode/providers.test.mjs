import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chosenService, providerEnvironment, providerId, serviceModels, serviceProvider } from '../../../plugins/opencode/agent/providers.mjs';

const service = { ref: 'magpie/openai', title: 'Magpie', api: 'openai-completions', url: 'https://example.com/v1' };
const provided = (extra = {}) => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'opencode.modelProvider': service.ref }),
  CODA_MODEL_PROVIDERS: JSON.stringify({ [service.ref]: { ...service, ...extra } }) });

test('the chosen service supports all three APIs and reads only its own key file; missing services and keys add nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'coda-opencode-provider-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(chosenService({}), null);
  assert.equal(chosenService({ CODA_PLUGIN_SETTINGS: 'null' }), null);
  assert.equal(chosenService({ ...provided(), CODA_MODEL_PROVIDERS: '{}' }), null);
  assert.equal(chosenService(provided({ api: 'unsupported' })), null);
  assert.equal(chosenService(provided({ keyFile: join(dir, 'missing') })), null);
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'sk-service\n');
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'])
    assert.deepEqual(chosenService(provided({ api, keyFile })), { ...service, api, key: 'sk-service' });
});

test('model discovery uses the selected API authentication, preserves slashes, deduplicates and follows Anthropic pages', async () => {
  const asked = [];
  const fetcher = async (url, { headers, signal }) => {
    asked.push({ url, headers });
    assert.ok(signal instanceof AbortSignal);
    return Response.json(url.includes('after_id=') ? { data: [{ id: 'vendor/second' }, { id: 'vendor/first' }] }
      : { data: [{ id: 'vendor/first' }, { id: '' }, {}], has_more: true, last_id: 'vendor/first' });
  };
  assert.deepEqual((await serviceModels({ ...service, key: 'key' }, fetcher)).map(m => m.id), ['vendor/first']);
  await serviceModels({ ...service, api: 'openai-responses' }, fetcher);
  assert.deepEqual((await serviceModels({ ...service, api: 'anthropic-messages', key: 'key' }, fetcher)).map(m => m.id), ['vendor/first', 'vendor/second']);
  assert.deepEqual(asked, [
    { url: 'https://example.com/v1/models', headers: { Authorization: 'Bearer key' } },
    { url: 'https://example.com/v1/models', headers: {} },
    { url: 'https://example.com/v1/models?limit=1000', headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'key' } },
    { url: 'https://example.com/v1/models?limit=1000&after_id=vendor%2Ffirst', headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'key' } },
  ]);
  await assert.rejects(serviceModels(service, async () => new Response('', { status: 401 })), /401/);
  await assert.rejects(serviceModels(service, async () => Response.json({ error: 'not models' })), /不是模型列表/);
});

test('native providers select the correct SDK and use explicit service credentials even for a keyless service', () => {
  for (const [api, npm] of [['openai-completions', '@ai-sdk/openai-compatible'], ['openai-responses', '@ai-sdk/openai'], ['anthropic-messages', '@ai-sdk/anthropic']]) {
    const provider = serviceProvider({ ...service, api }, [{ id: 'vendor/model', context_length: 65536, max_output_tokens: 8192 }]);
    assert.equal(provider.npm, npm);
    assert.deepEqual(provider.env, []);
    assert.deepEqual(provider.options, { baseURL: service.url, apiKey: 'none' });
    assert.deepEqual(provider.models['vendor/model'].limit, { context: 65536, output: 8192 });
    assert.equal(serviceProvider({ ...service, api, key: 'own-key' }, []).options.apiKey, 'own-key');
  }
  assert.equal(serviceProvider({ ...service, api: 'anthropic-messages', url: 'https://example.com/' }, []).options.baseURL, 'https://example.com/v1');
  assert.deepEqual(serviceProvider(service, [{ id: 'm' }]).models.m.limit, { context: 32768, output: 4096 });
  assert.equal(providerId('magpie/openai'), 'coda-magpie.openai');
  assert.notEqual(providerId('a-b/c'), providerId('a/b-c'));
});

test('only the child inline config changes: native providers, default model and other settings survive, including on discovery failure', async () => {
  const original = { provider: { native: { options: { apiKey: 'native-key' } } }, model: 'native/own', permission: { edit: 'ask' } };
  const env = { ...provided(), OPENCODE_CONFIG_CONTENT: JSON.stringify(original), OPENAI_API_KEY: 'must-not-reach-service' };
  const result = await providerEnvironment(env, async () => Response.json({ data: [{ id: 'vendor/model' }] }));
  const config = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.provider.native, original.provider.native);
  assert.equal(config.model, original.model);
  assert.deepEqual(config.permission, original.permission);
  assert.equal(config.provider['coda-magpie.openai'].options.apiKey, 'none');
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(original), 'input is not mutated');
  assert.equal(await providerEnvironment(env, async () => new Response('', { status: 503 })), env);
  assert.equal(await providerEnvironment(env, async () => Response.json({ data: [] })), env);
  const noSelection = { ...env, CODA_PLUGIN_SETTINGS: '{}' };
  assert.equal(await providerEnvironment(noSelection, () => assert.fail('no discovery without a selection')), noSelection);
  await assert.rejects(providerEnvironment({ ...env, OPENCODE_CONFIG_CONTENT: '{broken' }, async () => Response.json({ data: [{ id: 'm' }] })), SyntaxError);
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/opencode/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['opencode.modelProvider'].format, 'coda-model-provider');
});
