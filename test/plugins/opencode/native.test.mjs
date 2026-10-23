// Opt-in real CLI check, using only a local HTTP fixture and isolated OpenCode directories:
// OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test test/plugins/opencode/native.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

const binary = process.env.OPENCODE_TEST_BINARY;
const manifest = JSON.parse(readFileSync(join(pluginDir('opencode'), 'package.json'), 'utf8'));

// Both streaming turns and non-streaming background requests get valid, deterministic answers. No tools are requested.
function answer(response, path, body) {
  const text = 'Fixture answer', model = body.model;
  const message = { id: 'msg_test', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
  const output = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model, output: [output],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(path.endsWith('/messages') ? message : path.endsWith('/responses') ? result
      : { id: 'chat_test', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    return;
  }
  response.setHeader('content-type', 'text/event-stream');
  const event = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (path.endsWith('/messages')) {
    event({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    event({ type: 'message_stop' });
  } else if (path.endsWith('/responses')) {
    event({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } });
    event({ type: 'response.content_part.added', item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event({ type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: text });
    event({ type: 'response.output_text.done', item_id: output.id, output_index: 0, content_index: 0, text });
    event({ type: 'response.output_item.done', output_index: 0, item: output });
    event({ type: 'response.completed', response: result });
  } else {
    for (const choice of [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }])
      response.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model, choices: [choice] })}\n\n`);
    response.write('data: [DONE]\n\n');
  }
  response.end();
}

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) for (const keyed of [true, false])
  test(`real OpenCode: ${api} (${keyed ? 'service key' : 'keyless'}) models, turn, native model switch and process resume`, { skip: !binary, timeout: 120_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'coda-opencode-native-')), agents = [], requests = [];
    t.after(async () => { for (const agent of agents) { await agent.terminate(1000); agent.kill(); } rmSync(root, { recursive: true, force: true }); });
    mkdirSync(join(root, '.opencode/bin'), { recursive: true });
    symlinkSync(binary, join(root, '.opencode/bin/opencode'));
    writeFileSync(join(root, 'key'), 'fixture-service-key');
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: request.url, headers: request.headers, body });
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'vendor/test-model' }] })); return;
      }
      answer(response, request.url, body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`, id = 'coda-fixture.service/vendor/test-model';
    const nativeConfig = { $schema: 'https://opencode.ai/config.json', model: 'fixture/native', small_model: 'fixture/native', autoupdate: false,
      provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${url}/native/v1`, apiKey: 'fixture-native-key' },
        models: { native: { name: 'Native fixture', limit: { context: 32768, output: 4096 } } } } } };
    writeFileSync(join(root, 'opencode.json'), JSON.stringify(nativeConfig));
    const open = () => {
      const updates = [];
      const agent = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: root,
        env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENAI_API_KEY: 'unrelated-native-secret', ANTHROPIC_API_KEY: 'unrelated-native-secret', ANTHROPIC_AUTH_TOKEN: 'unrelated-native-secret',
          CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('opencode'),
          CODA_PLUGIN_SETTINGS: JSON.stringify({ 'opencode.modelProvider': 'fixture/service' }),
          CODA_MODEL_PROVIDERS: JSON.stringify({ 'fixture/service': { api, title: 'Service fixture', url: api === 'anthropic-messages' ? url : `${url}/v1`, ...(keyed ? { keyFile: join(root, 'key') } : {}) } }) },
        onMessage: m => updates.push(m) });
      agents.push(agent);
      const request = async (method, params) => {
        const reply = await agent.request(method, params, { timeout: 45_000 });
        assert.equal(reply.error, undefined, JSON.stringify(reply.error) + agent.stderr);
        return reply.result;
      };
      return { agent, request, updates };
    };
    const first = open();
    await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await first.request('session/new', { cwd: root, mcpServers: [] });
    const modelOption = session.configOptions?.find(option => option.category === 'model');
    const flatten = options => options.flatMap(option => option.options ? flatten(option.options) : [option.value]);
    const models = modelOption ? flatten(modelOption.options) : session.models?.availableModels.map(model => model.modelId);
    assert.ok(models?.includes(id), JSON.stringify(session));
    assert.ok(models.includes('fixture/native'));
    const prompt = async (client, modelId) => {
      await client.request(modelOption ? 'session/set_config_option' : 'session/set_model', modelOption
        ? { sessionId: session.sessionId, configId: modelOption.id, value: modelId } : { sessionId: session.sessionId, modelId });
      const start = client.updates.length;
      assert.equal((await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Say hello.' }] })).stopReason, 'end_turn');
      // 1.0.151 forwards updates on a separate event stream, which may drain just after the prompt reply.
      const answered = () => client.updates.slice(start).some(m => m.params?.update?.content?.text?.includes('Fixture answer'));
      for (let i = 0; i < 100 && !answered(); i++) await delay(10);
      assert.ok(answered(), JSON.stringify(client.updates.slice(start)) + client.agent.stderr);
    };
    await prompt(first, id);
    await prompt(first, 'fixture/native');
    await first.agent.terminate(1000); first.agent.kill();
    const resumed = open();
    await resumed.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await resumed.request('session/load', { sessionId: session.sessionId, cwd: root, mcpServers: [] });
    await prompt(resumed, id);
    const turns = requests.filter(r => r.body.model === 'vendor/test-model');
    assert.equal(turns.length, 2);
    const endpoint = api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
    assert.ok(turns.every(r => r.path === endpoint), JSON.stringify(turns.map(r => r.path)));
    const key = keyed ? 'fixture-service-key' : 'none';
    for (const turn of turns) {
      assert.equal(api === 'anthropic-messages' ? turn.headers['x-api-key'] : turn.headers.authorization,
        api === 'anthropic-messages' ? key : `Bearer ${key}`);
      assert.ok(!JSON.stringify(turn.headers).includes('unrelated-native-secret'));
    }
    assert.ok(requests.some(r => r.path === '/native/v1/chat/completions' && r.body.model === 'native'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')), nativeConfig);
  });
