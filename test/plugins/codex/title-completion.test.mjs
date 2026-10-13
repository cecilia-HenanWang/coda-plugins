// From Coda's backend/test/title-completion.test.mjs at ef1d2311, as plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { settleTitle, orderedCodexTitles } from '../../../plugins/codex/agent/titles.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const patched = orderedCodexTitles(bundle);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('patched adapter remains valid ESM including its original executable header', () => {
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  const launched = spawnSync(process.execPath, [new URL('../../../plugins/codex/agent/entry.mjs', import.meta.url).pathname, '--version'], { encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /(?:^|\/)codex-acp \S+/);
});

test('Codex fallback cannot replace an explicit title or publish the whole user prompt', async () => {
  const start = patched.indexOf('  async publishFallbackSessionTitle(sessionState, title) {');
  const method = patched.slice(start, patched.indexOf('  async publishAgentFileChangeReport(', start));
  const updates = [];
  const context = vm.createContext({ ACPSessionConnection: class { async update(value) { updates.push(value); } } });
  const owner = vm.runInContext(`({ ${method} })`, context);
  const state = { sessionId: 'main', sessionTitleSource: 'unset' };
  await owner.publishFallbackSessionTitle(state, '  多行\n\n 消息 ' + '😀'.repeat(200));
  assert.equal(Array.from(updates[0].title).length, 80);
  assert.ok(updates[0].title.startsWith('多行 消息 '));
  await owner.publishFallbackSessionTitle({ ...state, sessionTitleSource: 'explicit' }, 'cannot replace summary');
  assert.equal(updates.length, 1);
});

test('locked Codex adapter publishes the generated title before returning completion', async () => {
  // Exercise the actual pinned generator and completion block, not a second implementation.
  const generator = patched.slice(patched.indexOf('var TitleGenerator = class'), patched.indexOf('// src/CodexAcpServer.ts', patched.indexOf('var TitleGenerator = class')));
  const block = patched.slice(patched.indexOf('      if (sessionState.titleGen) {\n        const promptText'),
    patched.indexOf('      return {\n        stopReason: "end_turn",', patched.indexOf('      if (sessionState.titleGen) {\n        const promptText')));
  let release;
  const events = [], controller = new AbortController();
  const context = vm.createContext({ settleTitle, events, activePrompt: { signal: controller.signal },
    cancelledPromptResponse: () => 'cancelled', params: { sessionId: 'main', prompt: [{ type: 'text', text: 'a long user prompt' }] } });
  const client = {
    async threadStart() { return { thread: { id: 'title' } }; },
    async runTurn() { events.push('generating'); return new Promise(resolve => { release = () => resolve({ turn: { items: [{ type: 'agentMessage', text: '{"title":"简短标题"}' }] } }); }); },
    async threadSetName({ name }) { events.push(name); },
  };
  Object.assign(context, { client, TITLE_OUTPUT_SCHEMA: {}, TITLE_MODEL: 'fixture', SYSTEM_PROMPT: 'title' });
  vm.runInContext(generator + '\nglobalThis.sessionState = { titleGen: new TitleGenerator(client, "main", "/tmp", () => "unset") };', context);
  const run = vm.runInContext(`(async function() { ${block}; events.push('complete'); })`, context);
  const owner = { codexAcpClient: { async waitForSessionNotifications() { events.push('published'); } },
    createPromptFallbackTitle: () => 'fallback', async publishFallbackSessionTitle() {} };
  const result = run.call(owner);
  await flush(); assert.deepEqual(events, ['generating']);
  release(); await result;
  assert.deepEqual(events, ['generating', '简短标题', 'published', 'complete']);
  assert.throws(() => orderedCodexTitles(bundle.replace('sessionState.titleGen.onTurnCompleted(promptText);', 'changed();')), /no longer matches/);
});

test('title failure, timeout and cancellation cannot hold completion indefinitely', async () => {
  await settleTitle(() => { throw new Error('title unavailable'); });
  await settleTitle(() => new Promise(() => {}), { timeout: 5 });
  const controller = new AbortController();
  const waiting = settleTitle(() => new Promise(() => {}), { signal: controller.signal });
  controller.abort(); await waiting;
  let called = false;
  await settleTitle(() => { called = true; }, { signal: controller.signal });
  assert.equal(called, false);
});

test('a completed prompt keeps its result when the title wait is stopped', async () => {
  const source = orderedCodexTitles(bundle);
  const start = source.indexOf('      codaExecutionCompleted = true;');
  const completion = source.slice(start, source.indexOf('    } catch (err) {', start));
  const reportStart = source.indexOf('      if (agentFileChangeReportRequest !== null && agentFileChangeWorkspace !== null) {', start);
  const report = source.slice(reportStart, source.indexOf('      logger.log("Prompt completed"', reportStart));
  const controller = new AbortController(), events = [], reports = [];
  const context = vm.createContext({ settleTitle, activePrompt: { signal: controller.signal },
    params: { sessionId: 'main', prompt: [{ type: 'text', text: 'prompt' }] },
    sessionState: { titleGen: { onTurnCompleted() { events.push('generating'); return new Promise(() => {}); } } },
    promptWasCancelled: false, codaExecutionCompleted: false,
    agentFileChangeReportRequest: {}, agentFileChangeWorkspace: {}, agentFileChangeReportTurnId: 'finished-turn',
    agentFileChangeReportUnavailableReason: 'providerError', eventHandler: { isTurnDiffOversized: () => false, getTurnDiff: () => 'diff' },
  });
  const owner = {
    codexAcpClient: { async waitForSessionNotifications() {} }, sessionIsClosing: () => false,
    createPromptFallbackTitle: () => 'fallback', async publishFallbackSessionTitle() { events.push('fallback'); },
    buildPromptUsage() {}, buildQuotaMeta() {},
    async publishAgentFileChangeReport(_state, turn, _request, reason, diff) { reports.push({ turn, reason, diff }); },
  };
  const run = vm.runInContext(`(async function() { try { ${completion} } finally { ${report} } })`, context);
  const result = run.call(owner);
  await flush();
  assert.deepEqual(events, ['generating']); controller.abort();
  assert.equal((await result).stopReason, 'end_turn');
  assert.deepEqual(events, ['generating', 'fallback']);
  assert.equal(reports[0].turn, 'finished-turn'); assert.equal(reports[0].diff, 'diff');
  // A cancellation before execution finishes still invalidates the report.
  context.codaExecutionCompleted = false; controller.abort();
  await vm.runInContext(`(async function() { ${report} })`, context).call(owner);
  assert.equal(reports[1].turn, null); assert.equal(reports[1].reason, 'cancelled');
});
