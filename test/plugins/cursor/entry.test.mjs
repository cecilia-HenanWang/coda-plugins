// The Cursor entry (plugins/cursor/agent/): `cursor-agent acp` relayed, Coda's session instructions in front of a new
// session's first prompt; the setup's decision (scripts/setup.mjs) against a stand-in `--version`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needed } from '../../../plugins/cursor/scripts/setup.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays cursor-agent acp from ~/.local/bin and gives it the session instructions on the first prompt only', t =>
  relaysInstructions(t, 'cursor', '.local/bin/cursor-agent', ['acp']));

test('setup installs a missing or broken Cursor CLI and keeps any that runs', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/cursor-agent', run(127)).action, 'install');
  assert.deepEqual(needed('/bin/cursor-agent', run(0, '2026.05.09-0afadcc\n')), { action: 'none', version: '2026.05.09-0afadcc' });
});
