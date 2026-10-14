// Grok's wire for the entry tests: modes only in the opening metadata, history replay on load, and options reset on a
// new connection. Each process holds one native session. The saved turn count proves switches resume that session.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.FAKE_GROK_STATE, file = join(dir, 'session.json');
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = update => send({ method: 'session/update', params: { sessionId: 'native-session', update } });
const say = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const options = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: ['small', 'large'].map(value => ({ value, name: value })) },
  { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: ['low', 'high'].map(value => ({ value, name: value })) },
];
let model = 'small', effort = 'low', mode, opened, saved, held, question;
appendFileSync(join(dir, 'processes'), `${process.pid}\n`);
const methods = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
  'session/new': params => {
    opened = params; mode = params._meta?.yoloMode ? 'always-approve' : params._meta?.autoMode ? 'auto' : 'default';
    saved = { turns: 0 }; writeFileSync(file, JSON.stringify(saved));
    return { sessionId: 'native-session', configOptions: options(), _meta: { untouched: true } };
  },
  'session/load': params => {
    opened = params; mode = params._meta?.yoloMode ? 'always-approve' : params._meta?.autoMode ? 'auto' : 'default';
    if (existsSync(join(dir, 'fail-load'))) throw { code: -32002, message: 'load refused', data: { reason: 'fixture' } };
    saved = JSON.parse(readFileSync(file, 'utf8'));
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old user message' } });
    say('old assistant message');
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] });
    return { configOptions: options() };
  },
  'session/set_config_option': ({ configId, value }) => {
    if (existsSync(join(dir, 'fail-config'))) throw { code: -32602, message: 'config refused' };
    if (configId === 'model') { model = value; effort = 'low'; }
    else if (configId === 'reasoning_effort') effort = value;
    const configOptions = options(); update({ sessionUpdate: 'config_option_update', configOptions });
    return { configOptions };
  },
  'session/prompt': async ({ prompt }) => {
    if (prompt[0]?.text === 'hold') {
      say('holding'); await new Promise(resolve => { held = resolve; });
      return { stopReason: 'cancelled' };
    }
    if (prompt[0]?.text === 'ask') {
      const reply = new Promise(resolve => { question = resolve; });
      send({ id: 'grok-question', method: 'session/request_permission', params: { sessionId: 'native-session',
        toolCall: { toolCallId: 'edit', title: 'Edit file' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      const answer = await reply; say(JSON.stringify(answer));
      return { stopReason: 'end_turn' };
    }
    saved.turns++; writeFileSync(file, JSON.stringify(saved));
    say(JSON.stringify({ mode, model, effort, turns: saved.turns, opened, pid: process.pid }));
    return { stopReason: 'end_turn' };
  },
};
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  if (!m.method) { if (m.id === 'grok-question') question?.(m.result); return; }
  if (!('id' in m)) { if (m.method === 'session/cancel') held?.(); return; }
  try {
    if (!methods[m.method]) throw { code: -32601, message: `Unknown method ${m.method}` };
    send({ id: m.id, result: await methods[m.method](m.params ?? {}) });
  } catch (error) { send({ id: m.id, error }); }
}).on('close', () => process.exit(0));
