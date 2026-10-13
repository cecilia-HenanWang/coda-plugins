// The public copy of Coda's protocol says the same Coda commit, ACP version and SDK as the checker, and nobody edited it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkCopy, findPrivate, publicText } from '../scripts/sync-protocol.mjs';

const copy = readFileSync(new URL('../docs/agent-protocol.md', import.meta.url), 'utf8');

test('the copy agrees with the checker', () => {
  assert.deepEqual(checkCopy(copy), []);
});
test('a copy from another commit, of another version, or edited by hand does not', () => {
  assert.match(checkCopy(copy.replace(/coda-commit: \w+/, `coda-commit: ${'0'.repeat(40)}`)).join('\n'), /两边对不上/);
  assert.match(checkCopy(copy.replace('acp-protocol-version: 1', 'acp-protocol-version: 2')).join('\n'), /ACP 协议版本 2/);
  assert.match(checkCopy(copy.replace('acp-sdk: 1.4.0', 'acp-sdk: 1.5.0')).join('\n'), /SDK 1\.5\.0/);
  assert.match(checkCopy(copy.replace('等待项登记', '等待登记')).join('\n'), /正文被改过/);
  assert.deepEqual(checkCopy('# 没有声明'), ['副本开头没有同步脚本写的声明']);
});
test('links into Coda keep their words; links within the text and to the web stay', () => {
  assert.equal(publicText('见[起因](session-contracts.md#起因)、[规则](#规则)与 [ACP](https://agentclientprotocol.com)'),
    '见起因、[规则](#规则)与 [ACP](https://agentclientprotocol.com)');
});
test('what looks private stops a sync', () => {
  const found = findPrivate('在 /Users/someone/work 里，连 mac-mini.tail1234.ts.net 或 10.0.0.2，令牌 ghp_abcdefghijklmnop，见 https://github.com/coda-console/coda/pull/1');
  assert.deepEqual(found.map(f => f.what), ['本机用户目录', 'IP 地址', '内网主机名', '令牌', '私有仓库链接']);
  assert.deepEqual(findPrivate(copy), []);
  assert.deepEqual(findPrivate('https://github.com/coda-console/coda-plugins'), []);
});
