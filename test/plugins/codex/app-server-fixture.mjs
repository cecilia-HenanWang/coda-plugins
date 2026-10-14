// Coda's backend/test/codex-app-server-fixture.mjs at ef1d2311, for the Codex entry's contract check here.
// A minimal Codex app-server for driving the real codex-acp. The first turn of a state
// directory dies mid-turn with exit code 0, as a terminated app-server does; later turns complete.
// FAKE_CODEX_MODEL_ERROR instead returns a model-service error of that kind (`codexErrorInfo`) on that first turn.
// FAKE_CODEX_RPC_ERROR_METHOD fails that native method before it starts, with FAKE_CODEX_RPC_ERROR as its explanation.
// A later turn whose input names `subagent` runs a subagent that answers and ends; one that names `background` leaves a
// command in the background, listed until it is terminated.
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const died = join(process.env.FAKE_CODEX_STATE, 'died');
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const thread = { id: 'fake-thread', turns: [], historyMode: 'paginated' };
const model = { id: 'fake', model: 'fake', displayName: 'Fake', description: '', isDefault: true, hidden: false,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], inputModalities: ['text'] };
const models = process.env.FAKE_CODEX_MODELS ? JSON.parse(process.env.FAKE_CODEX_MODELS) : [model];
const session = { thread, model: models[0].model, reasoningEffort: 'medium', modelProvider: 'openai', serviceTier: process.env.FAKE_CODEX_SERVICE_TIER ?? null };
const results = {
  'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: false },
  'model/list': { data: models, nextCursor: null },
  'skills/list': { data: [], nextCursor: null },
  'thread/start': session,
  'thread/resume': { ...session, turnsBackwardsCursor: null },
};
const command = { type: 'commandExecution', id: 'command-1', command: 'sleep 100', cwd: '/', processId: '4242', status: 'inProgress', commandActions: [], source: 'agent' };
let terminals = [];
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id === undefined || !message.method) continue;
    if (message.method === 'turn/start') appendFileSync(join(process.env.FAKE_CODEX_STATE, 'prompts.ndjson'), JSON.stringify(message.params) + '\n');
    if (message.method === process.env.FAKE_CODEX_RPC_ERROR_METHOD && (message.method !== 'turn/start' || !existsSync(died))) {
      writeFileSync(died, '');
      send({ id: message.id, error: { code: -32603, message: process.env.FAKE_CODEX_RPC_ERROR } }); continue;
    }
    if (message.method === 'thread/backgroundTerminals/list') { send({ id: message.id, result: { data: terminals, nextCursor: null } }); continue; }
    if (message.method === 'thread/backgroundTerminals/terminate') {
      const terminated = terminals.some(t => t.processId === message.params.processId);
      terminals = terminals.filter(t => t.processId !== message.params.processId);
      send({ id: message.id, result: { terminated } }); continue;
    }
    if (message.method !== 'turn/start') { send({ id: message.id, result: results[message.method] ?? {} }); continue; }
    const turn = { id: `turn-${Date.now()}`, items: [], status: 'inProgress', error: null };
    send({ id: message.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: thread.id, turn } });
    if (!existsSync(died)) {
      writeFileSync(died, '');
      if (process.env.FAKE_CODEX_MODEL_ERROR) {
        const error = { message: process.env.FAKE_CODEX_MODEL_MESSAGE ?? JSON.stringify({ type: 'error', error: { message: "model 'gpt-6.1-sol' is not enabled in rustponsesapi",
          type: 'invalid_request_error', param: null, code: null }, status: 400 }),
        codexErrorInfo: process.env.FAKE_CODEX_MODEL_ERROR.startsWith('{') ? JSON.parse(process.env.FAKE_CODEX_MODEL_ERROR) : process.env.FAKE_CODEX_MODEL_ERROR, additionalDetails: null };
        if (!process.env.FAKE_CODEX_TERMINAL_ONLY) send({ method: 'error', params: { threadId: thread.id, turnId: turn.id, willRetry: false, error } });
        send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'failed', error } } });
      } else setTimeout(() => process.exit(0), 100);
      continue;
    }
    const input = JSON.stringify(message.params.input ?? '');
    if (input.includes('subagent')) {
      const child = 'fake-child', childTurn = { id: `child-${turn.id}`, items: [], status: 'inProgress', error: null };
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { type: 'subAgentActivity', id: 'activity-1', agentThreadId: child, agentPath: '/root/echo_check', kind: 'started' } } });
      send({ method: 'turn/started', params: { threadId: child, turn: childTurn } });
      send({ method: 'item/agentMessage/delta', params: { threadId: child, turnId: childTurn.id, itemId: 'child-message', delta: '子 Agent 的回答' } });
      send({ method: 'turn/completed', params: { threadId: child, turn: { ...childTurn, status: 'completed' } } });
    }
    if (input.includes('background')) {
      terminals = [{ itemId: command.id, processId: command.processId, command: command.command }];
      send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: command } });
    }
    send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
  }
});
