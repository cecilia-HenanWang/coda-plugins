// From Coda's backend/test/codex-process-exit.test.mjs at ef1d2311, as plain node:test. Its case of an app-server dying
// mid-turn, through Coda's backend, stays in Coda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { followCodexProcessExit } from '../../../plugins/codex/agent/process-exit.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');

test('the patch fails loudly once the locked adapter changes', () => {
  assert.match(followCodexProcessExit(bundle), /ending the adapter with it/);
  assert.throws(() => followCodexProcessExit(bundle.replace('void this.finishAllAsyncTasks("failed", "after the Codex process exited");', 'changed();')), /no longer matches/);
});
