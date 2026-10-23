// OpenCode's models grouped by provider as they reach Coda (plugins/opencode/agent/groups.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupedModels } from '../../../plugins/opencode/agent/groups.mjs';

const model = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opencode/big-pickle', options: [
  { value: 'opencode/beam-free', name: 'OpenCode/Beam Free' }, { value: 'opencode/big-pickle', name: 'OpenCode/Big Pickle' },
  { value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek/DeepSeek V4 Pro' },
  { value: 'coda-space.s-magpie-openai-4795cd5415/codex/gpt-6.1-sol', name: 'macmini · Magpie · OpenAI Chat/codex/gpt-6.1-sol' }] };
const mode = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build/plan' }] };

test('the model option is grouped by provider, by its ID and name, each model named alone; its IDs and other options are as they were', () => {
  const groups = [
    { group: 'opencode', name: 'OpenCode', options: [{ value: 'opencode/beam-free', name: 'Beam Free' }, { value: 'opencode/big-pickle', name: 'Big Pickle' }] },
    { group: 'deepseek', name: 'DeepSeek', options: [{ value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    { group: 'coda-space.s-magpie-openai-4795cd5415', name: 'macmini · Magpie · OpenAI Chat',
      options: [{ value: 'coda-space.s-magpie-openai-4795cd5415/codex/gpt-6.1-sol', name: 'codex/gpt-6.1-sol' }] }];
  assert.deepEqual(groupedModels({ jsonrpc: '2.0', id: 3, result: { sessionId: 's', configOptions: [mode, model] } }),
    { jsonrpc: '2.0', id: 3, result: { sessionId: 's', configOptions: [mode, { ...model, options: groups }] } });
  // An update of OpenCode's own says them grouped too.
  const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'config_option_update', configOptions: [model] } } };
  assert.deepEqual(groupedModels(update).params.update.configOptions[0].options, groups);
});

test('a service whose title has a slash of its own is a group by its whole title, its models named alone', () => {
  const option = { ...model, options: [{ value: 'opencode/beam-free', name: 'OpenCode/Beam Free' },
    { value: 'coda-space.s-proxy-1/vendor/model', name: '研发/Proxy/vendor/model' }] };
  const [, service] = groupedModels({ id: 1, result: { configOptions: [option] } }, { 'coda-space.s-proxy-1': '研发/Proxy' }).result.configOptions[0].options;
  assert.deepEqual(service, { group: 'coda-space.s-proxy-1', name: '研发/Proxy', options: [{ value: 'coda-space.s-proxy-1/vendor/model', name: 'vendor/model' }] });
  // Not told its title, a provider's name ends at its first slash.
  assert.equal(groupedModels({ id: 1, result: { configOptions: [option] } }).result.configOptions[0].options[1].name, '研发');
});

test('what it cannot tell a provider of, and anything else, is as it was', () => {
  const unnamed = { ...model, options: [...model.options, { value: 'loose', name: 'Loose' }] };
  assert.deepEqual(groupedModels({ id: 1, result: { configOptions: [unnamed] } }), { id: 1, result: { configOptions: [unnamed] } });
  const already = { ...model, options: [{ group: 'x', name: 'X', options: [] }] };
  assert.deepEqual(groupedModels({ id: 1, result: { configOptions: [already] } }).result.configOptions[0], already);
  for (const message of [{ id: 2, result: { stopReason: 'end_turn' } }, { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } }])
    assert.equal(groupedModels(message), message);
});
