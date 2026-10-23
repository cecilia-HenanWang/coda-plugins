// An ACP agent that takes no session instructions, standing in for a CLI an entry relays (`grok agent`, `opencode acp`,
// `cursor-agent acp`): it answers at once, and a prompt with what it was given as one message chunk, JSON: its arguments,
// the prompt, and whether any session request reached it with `systemPrompt`. Given `--port`, as `opencode acp` is, it serves
// its events there first, as OpenCode does (none: only that it is connected), behind OPENCODE_SERVER_PASSWORD.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const port = process.argv.indexOf('--port');
if (port >= 0) await new Promise(resolve => createServer((request, response) => {
  const password = Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
  if (request.url !== '/global/event' || request.headers.authorization !== `Basic ${password}`) { response.writeHead(401); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
}).listen(Number(process.argv[port + 1]), '127.0.0.1', resolve).unref());

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
