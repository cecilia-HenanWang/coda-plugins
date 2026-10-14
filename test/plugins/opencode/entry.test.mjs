// The OpenCode entry (plugins/opencode/agent/): `opencode acp` relayed, Coda's session instructions in front of a new
// session's first prompt; the setup's decision (scripts/setup.mjs) against a stand-in `--version`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM, needed } from '../../../plugins/opencode/scripts/setup.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays opencode acp from ~/.opencode/bin and gives it the session instructions on the first prompt only', t =>
  relaysInstructions(t, 'opencode', '.opencode/bin/opencode', ['acp']));

test('setup installs a missing or broken OpenCode, upgrades one without `opencode acp`, and keeps a newer one', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(MINIMUM, '0.15.10');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/opencode', run(1)).action, 'install');
  assert.deepEqual(needed('/bin/opencode', run(0, '0.15.9\n')), { action: 'upgrade', reason: 'OpenCode CLI 0.15.9 低于所需的 0.15.10' });
  assert.equal(needed('/bin/opencode', run(0, 'dev\n')).action, 'upgrade');
  assert.deepEqual(needed('/bin/opencode', run(0, '0.15.10\n')), { action: 'none', version: '0.15.10' });
  assert.deepEqual(needed('/bin/opencode', run(0, '1.19.0\n')), { action: 'none', version: '1.19.0' });
});
