// An ACP agent that takes no session instructions, standing in for a CLI an entry relays (`grok agent`, `opencode acp`,
// `cursor-agent acp`): it answers at once, and a prompt with what it was given as one message chunk, JSON: its arguments,
// the prompt, and whether any session request reached it with `systemPrompt`.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const options = [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fake', options: [{ value: 'fake', name: 'Fake' }] }];
let leaked = false;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method || !('id' in m)) return;
  if (['session/new', 'session/load'].includes(m.method) && 'systemPrompt' in (m.params ?? {})) leaked = true;
  const result = m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } }
    : m.method === 'session/new' ? { sessionId: 'native', configOptions: options }
    : m.method === 'session/load' ? { configOptions: options } : null;
  if (result) { send({ id: m.id, result }); return; }
  if (m.method === 'session/prompt') {
    const text = JSON.stringify({ argv: process.argv.slice(2), prompt: m.params.prompt, leaked });
    send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
  }
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
}).on('close', () => process.exit(0));
