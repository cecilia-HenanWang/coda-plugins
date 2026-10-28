import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pluginDir, resolveFrom } from '../plugin.mjs';
import { fixture } from './fixture.mjs';

const { Client } = await import(pathToFileURL(resolveFrom('memory', '@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(resolveFrom('memory', '@modelcontextprotocol/sdk/client/stdio.js')));

async function connected(context, data) {
  const client = new Client({ name: 'coda-memory-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginDir('memory'), 'scripts/server.mjs')], cwd: data.project,
    env: { HOME: data.home, CLAUDE_CONFIG_DIR: join(data.home, '.claude'), CODEX_HOME: join(data.home, '.codex'),
      CODA_PLUGIN_SETTINGS: JSON.stringify(data.settings), CODA_PLUGIN_STATE: data.state }, stderr: 'pipe' });
  context.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('stdio initialize/tools/list/tools/call use session-local opt-in, preserve errors and reopen with no selection', async context => {
  const data = fixture(context), first = await connected(context, data), second = await connected(context, data);
  const listed = await first.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['memory_sources', 'memory_select', 'memory_search', 'memory_read']);
  assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint));
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
  assert.equal((await call(first, 'memory_search', { query: 'pnpm' })).isError, true);
  const sources = await call(first, 'memory_sources');
  assert.equal(JSON.parse(sources.content[0].text).sources.length, 2);
  const selected = await call(first, 'memory_select', { runtime: 'codex', project: data.project, ids: ['claude'] });
  assert.equal(selected.isError, undefined);
  assert.match(JSON.parse(selected.content[0].text).previews[0].text, /Claude 原生索引/);
  const found = JSON.parse((await call(first, 'memory_search', { query: 'pnpm' })).content[0].text);
  assert.equal(found.matches.length, 1);
  assert.equal((await call(second, 'memory_read', { id: found.matches[0].id })).isError, true);
  assert.equal((await call(first, 'memory_read', { id: found.matches[0].id, path: '/etc/passwd' })).isError, true);
  const original = await call(first, 'memory_read', { id: found.matches[0].id });
  assert.match(JSON.parse(original.content[0].text).text, /CLAUDE_BODY_UNIQUE/);
  assert.equal((await call(first, 'unknown_tool')).isError, true);
  assert.equal((await call(first, 'memory_search', { query: 42 })).isError, true);
  assert.equal((await call(first, 'memory_search', { query: 'pnpm' })).isError, undefined);
  await first.close();
  const reopened = await connected(context, data);
  assert.equal((await call(reopened, 'memory_search', { query: 'pnpm' })).isError, true);
});

test('stdio discovers native sources without settings and loads only after explicit source and project confirmation', async context => {
  const data = fixture(context), native = join(data.home, '.claude', 'projects', 'unconfirmed-project', 'memory');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'MEMORY.md'), 'INDEX_SHOULD_NOT_APPEAR_DURING_DISCOVERY');
  data.settings = {};
  const client = await connected(context, data);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const listed = await call('memory_sources');
  assert.ok(!listed.content[0].text.includes('INDEX_SHOULD_NOT_APPEAR'));
  const sources = JSON.parse(listed.content[0].text);
  assert.equal(sources.sources.length, 1);
  assert.deepEqual(sources.selected, []);
  const args = { runtime: 'codex', project: data.project, ids: [sources.sources[0].id] };
  assert.equal((await call('memory_select', args)).isError, true);
  const selected = await call('memory_select', { ...args, confirmProject: true });
  assert.ok(!selected.isError);
  assert.match(JSON.parse(selected.content[0].text).previews[0].text, /INDEX_SHOULD_NOT_APPEAR/);
});
