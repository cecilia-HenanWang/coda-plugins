import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { read, scan, sources } from '../../../plugins/memory/scripts/sources.mjs';
import { fixture } from './fixture.mjs';

test('native adapters only index allowed Markdown, label runtime/project/scope, and cache metadata without bodies', context => {
  const data = fixture(context), configured = sources(data.settings);
  const claude = scan(configured[0]), codex = scan(configured[1]);
  assert.equal(claude.length, 2);
  assert.equal(codex.length, 4);
  assert.equal(codex.find(entry => entry.role === 'summary').scope, 'global');
  assert.ok(codex.every(entry => entry.projectMapping === 'user' && entry.project === data.project));
  const chosen = data.memory.select({ runtime: 'opencode', project: data.project, ids: ['claude', 'codex'], includeGlobal: true });
  assert.equal(chosen.count, 6);
  assert.equal(chosen.previews.length, 2);
  assert.match(chosen.previews[1].text, /Codex 原生短索引/);
  assert.match(chosen.notice, /不是当前 Agent/);
  const cache = readdirSync(data.state).map(file => readFileSync(join(data.state, file), 'utf8')).join('');
  assert.ok(!cache.includes('CLAUDE_BODY_UNIQUE') && !cache.includes('CODEX_BODY_UNIQUE') && !cache.includes('参见 topic'));
  assert.ok(!cache.includes('credentials.json') && !cache.includes('raw_memories.md') && !cache.includes('conversation.md'));
});

test('selection is off by default but explicit selection allows other projects, unknown scopes and the current runtime', context => {
  const data = fixture(context);
  assert.throws(() => data.memory.search({ query: 'pnpm' }), /尚未选择/);
  assert.throws(() => data.memory.files(), /尚未选择/);
  const own = data.memory.select({ runtime: 'claude-sdk', project: data.otherProject, ids: ['claude'] });
  assert.equal(own.currentRuntime, 'claude');
  assert.match(own.warnings[0], /重复/);
  assert.equal(own.index[0].project, data.project);
  assert.equal(own.project, data.otherProject);
  const global = data.memory.select({ runtime: 'codex', project: data.otherProject, ids: ['codex'], includeGlobal: false, confirmProject: false });
  assert.ok(global.index.every(item => item.scope === 'global' && item.project === data.project));
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project, ids: ['unknown'] }), /未配置/);
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project, ids: ['claude', 'claude'] }), /不重复/);
  data.memory.select({ runtime: 'codex', project: data.project, ids: ['claude'] });
  assert.equal(data.memory.search({ query: 'pnpm' }).matches.length, 1);
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project, ids: ['unknown'] }));
  assert.throws(() => data.memory.search({ query: 'pnpm' }), /尚未选择/);
  data.memory.select({ runtime: 'codex', project: data.project, ids: [] });
  assert.throws(() => data.memory.search({ query: 'pnpm' }), /尚未选择/);
});

test('all sources and every file beyond the initial preview can be explicitly selected, listed and read', context => {
  const data = fixture(context);
  for (let index = 0; index < 35; index++) writeFileSync(join(data.claude, `topic-${index}.md`), `CROSS_PROJECT_TOPIC_${index}`);
  const selected = data.memory.select({ runtime: 'codex', project: data.otherProject, all: true });
  assert.equal(selected.selectedSources.length, 2);
  assert.equal(selected.index.length, 20);
  assert.equal(selected.count, 41);
  assert.equal(selected.nextOffset, 20);
  const files = [];
  let offset = 0;
  do {
    const page = data.memory.files({ offset, limit: 7 });
    assert.equal(page.total, 41);
    assert.ok(page.files.every(file => !Object.hasOwn(file, 'text')));
    files.push(...page.files);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(files.map(file => file.id)).size, 41);
  assert.ok(files.every(file => file.project === data.project));
  for (const file of files) assert.ok(data.memory.read({ id: file.id }).text.length);
  assert.deepEqual(data.memory.files({ offset: 100 }).files, []);
  assert.throws(() => data.memory.files({ offset: -1 }), /offset/);
  assert.throws(() => data.memory.files({ limit: 101 }), /limit/);
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project, ids: [], all: true }), /不能同时/);
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project }), /ids/);
  assert.throws(() => data.memory.select({ runtime: 'codex', project: data.project, all: 'yes' }), /布尔值/);
  data.memory.select({ runtime: 'codex', project: data.project, ids: [] });
  assert.throws(() => data.memory.files(), /尚未选择/);
});

test('source project labels are optional and do not require an existing project checkout', context => {
  const data = fixture(context);
  const configured = sources({ 'memory.sources': {
    optional: { runtime: 'claude', path: data.claude },
    archived: { runtime: 'codex', project: join(data.root, 'removed-project'), path: data.codex }
  } });
  assert.equal(configured[0].project, null);
  assert.equal(configured[0].projectMapping, 'unconfirmed');
  assert.equal(configured[1].project, join(data.root, 'removed-project'));
  assert.throws(() => sources({ 'memory.sources': { bad: { runtime: 'claude', project: 'relative', path: data.claude } } }), /绝对路径/);
});

test('search refreshes metadata, read returns live original text, and unchanged catalogs are not rewritten', context => {
  const data = fixture(context);
  data.memory.select({ runtime: 'codex', project: data.project, ids: ['claude'] });
  const cache = join(data.state, readdirSync(data.state)[0]);
  utimesSync(cache, new Date(1000), new Date(1000));
  const before = statSync(cache).mtimeMs;
  const original = data.memory.search({ query: 'pnpm' }).matches[0];
  assert.equal(statSync(cache).mtimeMs, before);
  writeFileSync(join(data.claude, 'topic.md'), '最新原文：现在使用 npm。');
  assert.equal(data.memory.read({ id: original.id }).text, '最新原文：现在使用 npm。');
  assert.notEqual(statSync(cache).mtimeMs, before);
  assert.equal(data.memory.search({ query: 'pnpm' }).matches.length, 0);
  writeFileSync(join(data.claude, 'new.md'), '新增的 memory keyword。');
  const added = data.memory.search({ query: 'keyword' }).matches[0];
  assert.ok(added);
  rmSync(join(data.claude, 'new.md'));
  assert.equal(data.memory.search({ query: 'keyword' }).matches.length, 0);
  assert.throws(() => data.memory.read({ id: added.id }), /已经删除/);
  assert.ok(!readFileSync(cache, 'utf8').includes('new.md'));
  rmSync(cache);
  assert.match(data.memory.read({ id: original.id }).text, /最新原文/);
  assert.ok(readdirSync(data.state).length);
});

test('only selected IDs are readable and symlinks or a replaced source ancestor cannot escape the source', context => {
  const data = fixture(context), source = sources(data.settings)[0];
  const entry = scan(source).find(item => item.path.endsWith('topic.md'));
  const outside = join(data.root, 'outside.md');
  writeFileSync(outside, 'EXTERNAL_FILE_MUST_NOT_BE_READ');
  symlinkSync(outside, join(data.claude, 'linked.md'));
  assert.equal(scan(source).length, 2);
  assert.throws(() => read(source, { ...entry, path: outside }), /不属于/);
  rmSync(entry.path);
  symlinkSync(outside, entry.path);
  assert.throws(() => read(source, entry), /符号链接/);
  assert.throws(() => data.memory.read({ id: '../../outside.md' }), /索引/);
  renameSync(data.claude, `${data.claude}-moved`);
  symlinkSync(`${data.claude}-moved`, data.claude);
  assert.throws(() => scan(source), /符号链接/);
  const nestedParent = join(data.root, 'parent'), nestedRoot = join(nestedParent, 'memory');
  mkdirSync(nestedRoot, { recursive: true });
  const nested = sources({ 'memory.sources': { test: { runtime: 'claude', project: data.project, path: nestedRoot } } })[0];
  renameSync(nestedParent, `${nestedParent}-moved`);
  symlinkSync(`${nestedParent}-moved`, nestedParent);
  assert.throws(() => scan(nested), /已改变/);
});

test('native previews have a shared character budget and missing indexes do not block search', context => {
  const data = fixture(context);
  writeFileSync(join(data.claude, 'MEMORY.md'), '原'.repeat(6000));
  const selected = data.memory.select({ runtime: 'opencode', project: data.project, ids: ['claude', 'codex'], includeGlobal: true });
  assert.equal(selected.previews.reduce((sum, item) => sum + [...item.text].length, 0), 4000);
  assert.ok(selected.previews.every(item => item.truncated));
  rmSync(join(data.claude, 'MEMORY.md'));
  assert.equal(data.memory.select({ runtime: 'codex', project: data.project, ids: ['claude'] }).previewMissing.length, 1);
  assert.equal(data.memory.search({ query: 'pnpm' }).matches.length, 1);
  assert.throws(() => data.memory.search({ query: '' }), /检索词/);
  assert.throws(() => data.memory.search({ query: 'x', limit: 0 }), /limit/);
  assert.throws(() => data.memory.read({ id: '0'.repeat(64) }), /所选来源/);
});

test('oversized files report errors without exposing content or blocking other results', context => {
  const data = fixture(context);
  writeFileSync(join(data.claude, 'oversized.md'), 'x'.repeat(256 * 1024 + 1));
  data.memory.select({ runtime: 'codex', project: data.project, ids: ['claude'] });
  const found = data.memory.search({ query: 'pnpm' });
  assert.equal(found.matches.length, 1);
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0].error, /字节/);
});
