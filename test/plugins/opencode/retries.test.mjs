// A model service's long wait, which the OpenCode entry ends the turn on (plugins/opencode/agent/retries.mjs), and OpenCode's
// events it reads it from (plugins/opencode/agent/events.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { LONG_WAIT, LongRetries } from '../../../plugins/opencode/agent/retries.mjs';
import { followEvents } from '../../../plugins/opencode/agent/events.mjs';

const NOW = 1_000_000;
const prompt = (id, sessionId = 'ses_a') => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
const status = (sessionID, status) => ({ type: 'session.status', properties: { sessionID, status } });
const retry = (wait, message = 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置') => ({ type: 'retry', attempt: 1, message, next: NOW + wait });
const answer = id => ({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
const retries = () => {
  const cancelled = [];
  return { cancelled, waits: new LongRetries(sessionId => cancelled.push(sessionId), () => NOW) };
};

test('a wait past a minute stops OpenCode\'s turn, and its answer, whatever it is, is the reason', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(7));
  waits.event(status('ses_a', retry(76_184_000)));
  assert.deepEqual(cancelled, ['ses_a']);
  // Told again as OpenCode goes on, it is stopped once.
  waits.event(status('ses_a', retry(76_183_000)));
  assert.deepEqual(cancelled, ['ses_a']);
  assert.deepEqual(waits.fromAgent(answer(7)), { jsonrpc: '2.0', id: 7, error: { code: -32603,
    message: 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置\n\nOpenCode 要等约 21 小时才会重试，这一轮先结束。' } });
  // The next prompt is answered as OpenCode answers it.
  waits.toAgent(prompt(8));
  assert.deepEqual(waits.fromAgent(answer(8)), answer(8));
});

test('a wait of a minute or less is OpenCode\'s; so are a session with no prompt under way, and anything but a retry', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  waits.event(status('ses_a', retry(LONG_WAIT)));
  waits.event(status('ses_b', retry(3_600_000)));
  waits.event(status('ses_a', { type: 'busy' }));
  waits.event({ type: 'message.part.updated', properties: { sessionID: 'ses_a' } });
  assert.deepEqual(cancelled, []);
  assert.deepEqual(waits.fromAgent(answer(1)), answer(1));
  // Answered, the prompt is no longer under way.
  waits.event(status('ses_a', retry(3_600_000)));
  assert.deepEqual(cancelled, []);
});

test('the wait is said in minutes under an hour, and a reason OpenCode gives none of is said for it', () => {
  const { waits } = retries();
  waits.toAgent(prompt(1));
  waits.event(status('ses_a', retry(LONG_WAIT + 1, '')));
  assert.equal(waits.fromAgent(answer(1)).error.message, '模型服务要求稍后再试\n\nOpenCode 要等约 2 分钟才会重试，这一轮先结束。');
  waits.toAgent(prompt(2));
  waits.event(status('ses_a', retry(3_599_500)));
  assert.equal(waits.fromAgent(answer(2)).error.message.split('\n\n')[1], 'OpenCode 要等约 1 小时才会重试，这一轮先结束。');
});

test('OpenCode\'s events are read with the password, each payload once, and read again once the stream ends', async t => {
  const asked = [];
  const server = createServer((request, response) => {
    asked.push([request.url, request.headers.authorization]);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = { type: 'session.status', properties: { sessionID: `ses_${asked.length}`, status: { type: 'idle' } } };
    response.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
    response.write(`: comment\nevent: message\ndata: ${JSON.stringify({ directory: '/w', payload })}\r\n\r\n`);
    response.end('data: not json\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const events = [];
  const { stop } = followEvents(`http://127.0.0.1:${server.address().port}`, 'secret', event => events.push(event), 10);
  t.after(stop);
  for (let i = 0; i < 200 && events.length < 4; i++) await delay(10);
  stop();
  assert.deepEqual(asked.slice(0, 2), Array(2).fill(['/global/event', `Basic ${Buffer.from('opencode:secret').toString('base64')}`]));
  assert.deepEqual(events.slice(0, 4).map(e => e.properties.sessionID ?? e.type), ['server.connected', 'ses_1', 'server.connected', 'ses_2']);
});

test('until OpenCode\'s server is up, and on a refusal, it tries again, connected once it reads the stream; stopped, it does not', async t => {
  let answering = false, asked = 0;
  const server = createServer((request, response) => {
    asked++;
    if (!answering) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const events = [];
  const { connected, stop } = followEvents(`http://127.0.0.1:${server.address().port}`, 'secret', event => events.push(event), 10);
  t.after(stop);
  let read = false;
  connected.then(() => { read = true; });
  for (let i = 0; i < 200 && asked < 3; i++) await delay(10);
  assert.deepEqual([events, read], [[], false]);
  answering = true;
  await connected;
  for (let i = 0; i < 200 && !events.length; i++) await delay(10);
  assert.equal(events.length, 1);
  stop();
  const before = asked;
  await delay(100);
  assert.equal(asked, before);
});
