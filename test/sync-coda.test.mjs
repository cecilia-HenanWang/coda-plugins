import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applied, bumps, overridesOf } from '../scripts/sync-coda.mjs';

// Coda's backend/package.json, as sync-coda finds it on Coda's main.
const coda = () => ({
  name: 'coda-backend',
  overrides: { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.162.1' }, 'bpmn-elements': '$bpmn-elements' },
  dependencies: { '@coda-console/claude': '1.3.1', '@coda-console/codex': '1.6.1', '@coda-console/review': '2.4.3', 'bpmn-elements': 'git+https://x#y' },
  devDependencies: { '@coda-console/plugin-check': '0.4.4' },
});
const codex = (version, codexCli, overrides = { '@agentclientprotocol/codex-acp': { '@openai/codex': '$@openai/codex' } }) =>
  ({ name: '@coda-console/codex', version, dependencies: { '@agentclientprotocol/codex-acp': '1.12.0', '@openai/codex': codexCli }, ...(overrides ? { overrides } : {}) });
const available = (...manifests) => new Map(manifests.map(m => [m.name, m]));

test('overrides are written out as the root needs them: $name is the version of its own dependency', () => {
  assert.deepEqual(overridesOf(codex('1.6.2', '0.163.0')), { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.163.0' } });
  assert.deepEqual(overridesOf({ name: 'x' }), {});
});

test('only the packages of ours Coda uses are raised, and only to a later version', () => {
  const here = available(codex('1.6.2', '0.163.0'), { name: '@coda-console/claude', version: '1.3.1' }, { name: '@coda-console/review', version: '2.4.2' },
    { name: '@coda-console/cursor', version: '1.1.2' }, { name: '@coda-console/plugin-check', version: '0.4.5' });
  assert.deepEqual(bumps(coda(), here), [
    { name: '@coda-console/codex', field: 'dependencies', from: '1.6.1', to: '1.6.2' },
    { name: '@coda-console/plugin-check', field: 'devDependencies', from: '0.4.4', to: '0.4.5' }]);
  assert.deepEqual(bumps(coda(), available({ name: '@coda-console/claude', version: '1.3.1' })), [], 'the same version is no change');
});

test("Coda's package.json gets the versions and the overrides they ask for; its own overrides stay where they are", () => {
  const here = available(codex('1.6.2', '0.163.0'));
  const changes = bumps(coda(), here), next = applied(coda(), changes, here, available(codex('1.6.1', '0.162.1')));
  assert.equal(next.dependencies['@coda-console/codex'], '1.6.2');
  assert.deepEqual(next.overrides, { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.163.0' }, 'bpmn-elements': '$bpmn-elements' });
  assert.deepEqual(Object.keys(next.overrides), ['@agentclientprotocol/codex-acp', 'bpmn-elements'], 'in the same order');
  // A version that no longer asks for one drops it; Coda's own is left alone.
  const dropped = available(codex('1.7.0', '0.164.0', null));
  assert.deepEqual(applied(coda(), bumps(coda(), dropped), dropped, available(codex('1.6.1', '0.162.1'))).overrides, { 'bpmn-elements': '$bpmn-elements' });
  // Without the manifest it was published from, nothing it asked for before is known to drop.
  assert.deepEqual(Object.keys(applied(coda(), bumps(coda(), dropped), dropped, new Map()).overrides), ['@agentclientprotocol/codex-acp', 'bpmn-elements']);
  assert.equal(coda().dependencies['@coda-console/codex'], '1.6.1', 'what it was given is not changed');
});
