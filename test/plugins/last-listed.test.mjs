// What a model service last listed (plugins/<claude|codex|opencode>/agent/last-listed.mjs): kept while it answers, listed
// when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastListed } from '../../plugins/opencode/agent/last-listed.mjs';

const copies = ['claude', 'codex', 'opencode'].map(id => new URL(`../../plugins/${id}/agent/last-listed.mjs`, import.meta.url));

test('the three agent plugins carry the same file', async () => {
  const [first, ...others] = await Promise.all(copies.map(url => readFile(url, 'utf8')));
  for (const other of others) assert.equal(other, first);
});

test('what a service lists is kept under its name; one that cannot list now lists as it last did, and says so', async t => {
  const state = await mkdtemp(join(tmpdir(), 'coda-last-listed-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const said = [], log = text => said.push(text), down = async () => { throw new Error('模型列表回答 503'); };
  await assert.rejects(lastListed('space/s-magpie', down, state, log), /503/, 'never listed: its error stands');
  const models = [{ id: 'vendor/a', context_length: 65536 }, { id: 'vendor/b' }];
  assert.deepEqual(await lastListed('space/s-magpie', async () => models, state, log), models);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'service-models', 'space.s-magpie.json'), 'utf8')), models);
  assert.deepEqual(await lastListed('space/s-magpie', down, state, log), models);
  assert.deepEqual(said, ['模型服务 space/s-magpie 列不出模型（模型列表回答 503），沿用上次列出的 2 个']);
  await assert.rejects(lastListed('space/s-other', down, state, log), /503/, 'another service\'s list is not its');
  // What it lists next replaces it, an empty list too.
  assert.deepEqual(await lastListed('space/s-magpie', async () => [], state, log), []);
  assert.deepEqual(await lastListed('space/s-magpie', down, state, log), []);
  await writeFile(join(state, 'service-models', 'space.s-magpie.json'), '{broken');
  await assert.rejects(lastListed('space/s-magpie', down, state, log), /503/, 'an unreadable one is none');
});

test('without a state directory nothing is kept', async () => {
  assert.deepEqual(await lastListed('magpie/openai', async () => [{ id: 'm' }], undefined, assert.fail), [{ id: 'm' }]);
  await assert.rejects(lastListed('magpie/openai', async () => { throw new Error('down'); }, undefined, assert.fail), /down/);
});
