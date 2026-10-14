// Grok's modes are changed by a notification, not by ACP set_mode. Report what subsequent prompts actually use.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const say = text => send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let mode = 'machine', effort = 'low', held;
const options = () => [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'grok', options: [{ value: 'grok', name: 'Grok' }] }];
createInterface({ input: process.stdin }).on('line', m => {
  m = JSON.parse(m);
  if (!m.method) return;
  if (m.method === '_x.ai/yolo_mode_changed') { mode = m.params.yolo_mode ? 'always-approve' : m.params.auto_mode ? 'auto' : 'machine'; return; }
  if (m.method === 'session/cancel') { if (held) send({ id: held, result: { stopReason: 'cancelled' } }); held = null; return; }
  if (!('id' in m)) return;
  const result = m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    : m.method === 'session/new' ? { sessionId: 'native', configOptions: options() }
    : m.method === 'session/load' ? { configOptions: options() }
    : m.method === 'session/set_config_option' ? (effort = m.params.value, { configOptions: options() }) : null;
  if (result) { send({ id: m.id, result }); return; }
  if (m.method === 'session/prompt') {
    if (m.params.prompt[0].text === 'hold') { held = m.id; say('holding'); return; }
    // The checker's question about the session instructions, answered from what came in front of it as a model would.
    const given = m.params.prompt.map(block => block.text ?? '').join('\n');
    if (given.includes('What is the Coda check word?')) {
      say(/reply with exactly (\S+) and nothing else/.exec(given)?.[1] ?? '不知道'); send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
    }
    say(JSON.stringify({ mode, effort, pid: process.pid })); send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
  }
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
}).on('close', () => process.exit(0));
