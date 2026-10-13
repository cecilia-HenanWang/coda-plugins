// From Coda's backend/test/claude-sign-in.test.mjs at 9ffb9911, as plain node:test: its logins through Coda's panels driven
// here as Coda drives the panel's `signIn` command (start it, read the link it prints, write the code to its input once).
// That the CLI is found beside the plugin's own SDK is in plugins.test.mjs.
// The「Claude」panel's login (scripts/login.mjs): the CLI beside the plugin's own Claude SDK, its official link passed on, and
// only a code bound to that link handed to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { authorization, bound } from '../../../plugins/claude/scripts/login.mjs';
import { declaredPanel, installed, pluginEnv, signIn } from '../command.mjs';
import { substituted } from '../substitute.mjs';

// SDK 0.3.293 / CLI 2.1.293 prints the manual-code URL even with a local callback listener.
const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=test-challenge&state=test-state';
const output = `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;

test('Claude reads only complete official authorization URLs, including terminal hyperlinks, and only a code bound to it', () => {
  assert.equal(authorization(output)?.href, url);
  assert.equal(authorization(output.slice(0, output.indexOf('state=') + 8)), null);
  assert.equal(authorization(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`)?.href, url);
  for (const bad of [url.replace('https:', 'http:'), url.replace('claude.com/', 'claude.com.evil/'),
    url.replace('/cai/oauth/authorize', '/unrelated'), url.replace('response_type=code', 'response_type=token')]) {
    assert.equal(authorization(bad + '\n'), null);
  }
  assert.equal(bound('one-time-code#test-state', new URL(url)), true);
  for (const code of ['one-time-code', 'secret#other-state', 'one-time-code#test-state\nextra']) assert.equal(bound(code, new URL(url)), false);
});

// An SDK standing in for the plugin's own, with a Claude CLI beside it that prints as the real one does, in pieces, notes how
// it was started, and keeps a credential once it is given a code (unless TEST_FAIL).
async function sdk(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-sign-in-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  const binary = join(dir, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  await mkdir(dirname(entry), { recursive: true }); await writeFile(entry, '');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2),
  browser: process.env.BROWSER, refresh: process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ?? null }));
const output = ${JSON.stringify(output)};
process.stdout.write(output.slice(0, output.indexOf('state=') + 8));
setImmediate(() => process.stdout.write(output.slice(output.indexOf('state=') + 8)));
createInterface({ input: process.stdin }).on('line', code => {
  if (process.env.TEST_FAIL) { console.error('private-upstream-secret ' + code); process.exit(1); }
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'credential'), 'test-private-token', { mode: 0o600 });
  process.exit(0);
});
`, { mode: 0o755 });
  // The machine's own environment, with a refresh token that must not be imported instead of a fresh login.
  const env = extra => pluginEnv('claude', { ...substituted({ '@anthropic-ai/claude-agent-sdk': entry }),
    CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'old-refresh', ...extra });
  return { dir, env };
}
const declared = declaredPanel('claude').signIn;
const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);

test('Claude passes on only its official link, hands only the bound code to its CLI, and keeps no credential of its own', async t => {
  const { dir, env } = await sdk(t);
  assert.equal(declared.input, 'authorizationCode');
  assert.equal(installed(declared.installed, env()), true, 'the SDK has its CLI');
  const login = signIn(t, declared.command, env());
  await login.printed(/\n/);
  assert.equal(login.output, `${url}\n`, 'the link alone, on a line of its own');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'invocation.json'), 'utf8')), { args: ['auth', 'login', '--claudeai'], browser: '/usr/bin/true', refresh: null },
    'no browser opens on the machine, and a refresh token in the environment is not imported instead');
  // Coda writes the code as pasted, trimmed, once.
  login.write('one-time-code#test-state\n');
  assert.equal(await login.ended, 0);
  assert.equal(await readFile(join(dir, 'credential'), 'utf8'), 'test-private-token');
  assert.equal(/one-time-code|test-private-token/.test(login.output), false);
});

test('a code for another login, or a CLI that refuses it, ends the login with a line of its own, the credential before untouched', async t => {
  for (const [extra, code, error] of [[{}, 'one-time-code#other-state', '授权码不对：要贴这次登录的网页给出的完整授权码，请重新登录。'],
    [{ TEST_FAIL: '1' }, 'one-time-code#test-state', 'Claude 登录没有完成，请重新登录。']]) {
    const { dir, env } = await sdk(t);
    await writeFile(join(dir, 'credential'), 'previous-token');
    const login = signIn(t, declared.command, env(extra));
    await login.printed(/\n/);
    login.write(`${code}\n`);
    assert.equal(await login.ended, 1);
    assert.equal(lastLine(login.output), error, 'the line Coda shows');
    assert.equal(await readFile(join(dir, 'credential'), 'utf8'), 'previous-token');
    assert.equal(/one-time-code|private-upstream-secret/.test(login.output), false);
  }
});

test('without the SDK\'s CLI the login says it is not installed', async t => {
  const { dir, env } = await sdk(t);
  await rm(join(dir, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`), { recursive: true });
  assert.equal(installed(declared.installed, env()), false);
});
