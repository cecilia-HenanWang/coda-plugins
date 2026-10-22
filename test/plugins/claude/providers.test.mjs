// The model service chosen for Claude (plugins/claude/agent/providers.mjs): which one, what it lists, what a session on it runs with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chosenService, listedModels, serviceEnv, serviceModels } from '../../../plugins/claude/agent/providers.mjs';

const provided = services => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProvider': 'magpie/anthropic' }), CODA_MODEL_PROVIDERS: JSON.stringify(services) });
const magpie = { plugin: 'magpie', title: 'Magpie · Anthropic', api: 'anthropic-messages', url: 'http://127.0.0.1:3425' };

test('the service chosen is the one of this machine that speaks Anthropic Messages, with its key read from its file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-claude-providers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(chosenService({}), null, 'none chosen');
  assert.equal(chosenService({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProvider': '' }) }), null, '「不用」');
  assert.deepEqual(chosenService(provided({ 'magpie/anthropic': magpie })), { ref: 'magpie/anthropic', title: 'Magpie · Anthropic', url: 'http://127.0.0.1:3425', key: undefined });
  await writeFile(join(dir, 'key'), 'sk-service\n');
  assert.equal(chosenService(provided({ 'magpie/anthropic': { ...magpie, keyFile: join(dir, 'key') } })).key, 'sk-service');
  assert.equal(chosenService(provided({})), null, 'not on this machine');
  assert.equal(chosenService(provided({ 'magpie/anthropic': { ...magpie, api: 'openai-completions' } })), null, 'another API');
});

test('its models are listed as an Anthropic client asks, named by the model and the service', async () => {
  const asked = [];
  const fetcher = async (url, { headers }) => {
    asked.push([url, headers]);
    return Response.json({ data: [{ id: 'deepseek/deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' }, { id: '' }, { name: 'no id' }], has_more: false });
  };
  const models = await serviceModels({ ref: 'magpie/anthropic', title: 'Magpie · Anthropic', url: 'http://127.0.0.1:3425/' }, fetcher);
  assert.deepEqual(models, [{ id: 'magpie/anthropic/deepseek/deepseek-v4-pro', name: 'deepseek/deepseek-v4-pro (Magpie · Anthropic)', efforts: [], model: 'deepseek/deepseek-v4-pro' }]);
  await serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com', key: 'sk' }, fetcher);
  assert.deepEqual(asked, [['http://127.0.0.1:3425/models?limit=1000', {}],
    ['https://example.com/models?limit=1000', { 'x-api-key': 'sk', 'anthropic-version': '2023-06-01' }]]);
  await assert.rejects(serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com' }, async () => new Response('', { status: 401 })), /回答 401/);
  // A service that cannot list now adds none, and the session opens with Claude's own.
  assert.deepEqual(await listedModels({ ref: 'x/y', title: 'X', url: 'http://127.0.0.1:1' }), []);
  assert.deepEqual(await listedModels(null), []);
});

test('a session on a service\'s model runs Claude Code with the service as its API and that model for every role, never with the machine\'s login', () => {
  assert.deepEqual(serviceEnv({ url: 'http://127.0.0.1:3425' }, 'deepseek/deepseek-v4-pro'), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'none',
    ANTHROPIC_MODEL: 'deepseek/deepseek-v4-pro', ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek/deepseek-v4-pro', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek/deepseek-v4-pro', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek/deepseek-v4-pro' });
  assert.equal(serviceEnv({ url: 'https://example.com', key: 'sk' }, 'm').ANTHROPIC_AUTH_TOKEN, 'sk');
});
