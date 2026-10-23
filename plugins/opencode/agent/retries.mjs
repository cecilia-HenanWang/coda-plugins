// A model service's wait OpenCode would sit out in silence. OpenCode waits as long as a provider's Retry-After says (its
// session/retry.ts, up to setTimeout's limit) and says so only as its session's status `retry`, which its ACP does not pass
// on: a usage window that resets tomorrow keeps Coda's turn running, saying nothing, until then. Coda ends a turn on an
// agent's failure and keeps why (docs/agent-protocol.md「执行失败」), and retries a service's failures itself over at most a
// minute; so a wait longer than LONG_WAIT ends the turn here: the entry stops OpenCode's (`session/cancel`) and answers
// Coda's prompt with OpenCode's reason, whatever OpenCode answers it with once stopped (it may say `end_turn`). A shorter
// wait is OpenCode's to sit out.
export const LONG_WAIT = 60_000;

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const span = ms => Math.ceil(ms / 60_000) >= 60 ? `约 ${Math.round(ms / 3_600_000)} 小时` : `约 ${Math.ceil(ms / 60_000)} 分钟`;

export class LongRetries {
  // `cancel(sessionId)`: stops OpenCode's turn in an ACP session.
  constructor(cancel, now = Date.now) {
    this.cancel = cancel; this.now = now;
    // Coda's prompt under way in each session, by its id; the reason each prompt being stopped here ends with.
    this.prompts = new Map(); this.ending = new Map();
  }
  // What the entry tells OpenCode.
  toAgent(message) {
    if (message?.method === 'session/prompt' && 'id' in message && typeof message.params?.sessionId === 'string') this.prompts.set(message.params.sessionId, message.id);
  }
  // One of OpenCode's events (events.mjs).
  event(event) {
    if (event?.type !== 'session.status' || !record(event.properties)) return;
    const { sessionID, status } = event.properties;
    if (status?.type !== 'retry' || typeof status.next !== 'number' || !this.prompts.has(sessionID)) return;
    const wait = status.next - this.now(), id = this.prompts.get(sessionID);
    if (wait <= LONG_WAIT || this.ending.has(id)) return;
    const reason = typeof status.message === 'string' && status.message.trim() ? status.message.trim() : '模型服务要求稍后再试';
    this.ending.set(id, `${reason}\n\nOpenCode 要等${span(wait)}才会重试，这一轮先结束。`);
    this.cancel(sessionID);
  }
  // What OpenCode says, as said to Coda: its answer to a prompt stopped here is the reason it was.
  fromAgent(message) {
    if (!record(message) || !('id' in message) || 'method' in message) return message;
    for (const [session, id] of this.prompts) if (id === message.id) this.prompts.delete(session);
    if (!this.ending.has(message.id)) return message;
    const reason = this.ending.get(message.id);
    this.ending.delete(message.id);
    return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: reason } };
  }
}
