import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover } from '../../../plugins/memory/scripts/discovery.mjs';
import { Memory } from '../../../plugins/memory/scripts/memory.mjs';
import { fixture } from './fixture.mjs';

function nativeMemories(data, claudeHome = join(data.home, '.claude'), codexHome = join(data.home, '.codex')) {
  const claude = join(claudeHome, 'projects', '-ambiguous-project-name', 'memory'), codex = join(codexHome, 'memories');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(claude, 'MEMORY.md'), 'NATIVE_INDEX_BODY_ONLY_AFTER_SELECT');
  writeFileSync(join(claude, 'topic.md'), 'NATIVE_TOPIC_BODY_ONLY_AFTER_SELECT');
  return { claude, codex };
}

test('default discovery lists metadata only, keeps unknown projects unbound and reports empty Codex libraries', context => {
  const data = fixture(context), native = nativeMemories(data);
  writeFileSync(join(native.claude, 'large.md'), 'PRIVATE_MEMORY_BODY'.repeat(20000));
  writeFileSync(join(native.claude, 'credentials.json'), 'DO_NOT_READ_CREDENTIALS');
  const memory = new Memory({}, data.state, { home: data.home, env: {} });
  const listed = memory.list();
  assert.equal(listed.sources.length, 2);
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.selected, []);
  const claude = listed.sources.find(source => source.runtime === 'claude');
  assert.equal(claude.path, native.claude);
  assert.equal(claude.project, null);
  assert.equal(claude.projectMapping, 'unconfirmed');
  assert.equal(claude.files, 3);
  assert.equal(listed.sources.find(source => source.runtime === 'codex').files, 0);
  assert.ok(!JSON.stringify(listed).includes('PRIVATE_MEMORY_BODY'));
  assert.ok(!JSON.stringify(listed).includes('credentials.json'));
  assert.deepEqual(readdirSync(data.state), []);
  assert.throws(() => memory.search({ query: 'NATIVE' }), /尚未选择/);
});

test('native home overrides replace default roots and expand home-relative paths', context => {
  const data = fixture(context);
  nativeMemories(data);
  const overridden = nativeMemories(data, join(data.home, 'custom-claude'), join(data.home, 'custom-codex'));
  const options = { home: data.home, env: { CLAUDE_CONFIG_DIR: '~/custom-claude', CODEX_HOME: join(data.home, 'custom-codex') } };
  const found = discover(options);
  assert.equal(found.sources.length, 2);
  assert.deepEqual(found.errors, []);
  assert.deepEqual(new Set(found.sources.map(source => source.path)), new Set(Object.values(overridden)));
});

test('missing roots are normal, symlinks are not followed and a bad root does not hide the other runtime', context => {
  const data = fixture(context);
  assert.deepEqual(discover({ home: data.home, env: {} }), { sources: [], errors: [] });
  const native = nativeMemories(data), projects = join(data.home, '.claude', 'projects');
  symlinkSync(join(projects, '-ambiguous-project-name'), join(projects, 'linked-project'));
  mkdirSync(join(projects, 'linked-memory'));
  symlinkSync(native.claude, join(projects, 'linked-memory', 'memory'));
  const found = discover({ home: data.home, env: {} });
  assert.equal(found.sources.length, 2);
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0].error, /符号链接/);
  const invalid = join(data.home, 'invalid-claude');
  writeFileSync(invalid, 'not a directory');
  const partial = discover({ home: data.home, env: { CLAUDE_CONFIG_DIR: invalid } });
  assert.deepEqual(partial.sources.map(source => source.runtime), ['codex']);
  assert.equal(partial.errors.length, 1);
});

test('configured mappings retain their names and override the same automatically discovered path', context => {
  const data = fixture(context), native = nativeMemories(data);
  const settings = { 'memory.sources': { confirmed: { runtime: 'claude', project: data.project, path: native.claude } } };
  const memory = new Memory(settings, data.state, { home: data.home, env: {} });
  const found = memory.list();
  assert.equal(found.sources.length, 2);
  assert.equal(found.sources.find(source => source.path === native.claude).id, 'confirmed');
  assert.equal(found.sources.find(source => source.id === 'confirmed').projectMapping, 'user');
  const selected = memory.select({ runtime: 'codex', project: data.project, ids: ['confirmed'] });
  assert.equal(selected.count, 2);
  assert.throws(() => memory.select({ runtime: 'codex', project: data.otherProject, ids: ['confirmed'], confirmProject: true }), /不属于当前项目/);
});

test('discovered Claude sources require project confirmation per session and Codex requires global acceptance', context => {
  const data = fixture(context);
  nativeMemories(data);
  const options = { home: data.home, env: {} }, memory = new Memory({}, data.state, options);
  const found = memory.list(), claude = found.sources.find(source => source.runtime === 'claude'), codex = found.sources.find(source => source.runtime === 'codex');
  assert.throws(() => memory.select({ runtime: 'codex', project: data.project, ids: [claude.id] }), /confirmProject/);
  assert.throws(() => memory.select({ runtime: 'claude-sdk', project: data.project, ids: [claude.id], confirmProject: true }), /当前 Agent/);
  const chosen = memory.select({ runtime: 'codex', project: data.project, ids: [claude.id], confirmProject: true });
  assert.equal(chosen.previews[0].projectMapping, 'session-confirmed');
  assert.match(chosen.previews[0].text, /NATIVE_INDEX/);
  const hit = memory.search({ query: 'NATIVE_TOPIC' }).matches[0];
  assert.match(memory.read({ id: hit.id }).text, /NATIVE_TOPIC/);
  assert.equal(memory.list().sources.find(source => source.id === claude.id).project, null);
  const reopened = new Memory({}, data.state, options);
  assert.throws(() => reopened.select({ runtime: 'codex', project: data.project, ids: [claude.id] }), /confirmProject/);
  assert.throws(() => memory.select({ runtime: 'opencode', project: data.project, ids: [codex.id] }), /includeGlobal/);
  assert.equal(memory.select({ runtime: 'opencode', project: data.project, ids: [codex.id], includeGlobal: true }).count, 0);
  assert.equal(memory.selected[0].projectMapping, 'session-global');
  assert.throws(() => memory.select({ runtime: 'codex', project: data.project, ids: [claude.id], confirmProject: 'yes' }), /布尔值/);
});

test('source IDs stay stable while new or removed directories are reflected on the next listing', context => {
  const data = fixture(context), native = nativeMemories(data);
  const memory = new Memory({}, data.state, { home: data.home, env: {} });
  const before = memory.list(), original = before.sources.find(source => source.path === native.claude);
  writeFileSync(join(native.claude, 'new.md'), 'a newly written native memory');
  const next = memory.list().sources.find(source => source.path === native.claude);
  assert.equal(next.id, original.id);
  assert.equal(next.files, original.files + 1);
  const another = join(data.home, '.claude', 'projects', 'new-project', 'memory');
  mkdirSync(another, { recursive: true });
  assert.equal(memory.list().sources.length, before.sources.length + 1);
  rmSync(native.claude, { recursive: true });
  assert.ok(!memory.list().sources.some(source => source.id === original.id));
  assert.throws(() => memory.select({ runtime: 'codex', project: data.project, ids: [original.id], confirmProject: true }), /未发现/);
});
