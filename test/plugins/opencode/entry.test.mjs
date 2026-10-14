// The OpenCode entry (plugins/opencode/agent/): `opencode acp` relayed, Coda's session instructions in front of a new
// session's first prompt; the setup's decision (scripts/setup.mjs) against a stand-in `--version`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM, needed } from '../../../plugins/opencode/scripts/setup.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays opencode acp from ~/.opencode/bin and gives it the session instructions on the first prompt only', t =>
  relaysInstructions(t, 'opencode', '.opencode/bin/opencode', ['acp']));

test('setup installs a missing or broken OpenCode, upgrades one older than Coda\'s contract needs, and keeps a newer one', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(MINIMUM, '1.0.151');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/opencode', run(1)).action, 'install');
  // 0.15.10 has `opencode acp` but reports no model; 1.0.150 loads a session without keeping it.
  assert.deepEqual(needed('/bin/opencode', run(0, '0.15.10\n')), { action: 'upgrade', reason: 'OpenCode CLI 0.15.10 低于所需的 1.0.151' });
  assert.deepEqual(needed('/bin/opencode', run(0, '1.0.150\n')), { action: 'upgrade', reason: 'OpenCode CLI 1.0.150 低于所需的 1.0.151' });
  assert.equal(needed('/bin/opencode', run(0, 'dev\n')).action, 'upgrade');
  assert.deepEqual(needed('/bin/opencode', run(0, '1.0.151\n')), { action: 'none', version: '1.0.151' });
  assert.deepEqual(needed('/bin/opencode', run(0, '1.19.0\n')), { action: 'none', version: '1.19.0' });
});
