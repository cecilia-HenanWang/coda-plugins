#!/usr/bin/env node
// The public copy of Coda's agent protocol (docs/agent-protocol.md): Coda's own repository is private, and its
// docs/agent-protocol.md is the one text of the protocol. The copy is taken from the commit the checker's rules were copied
// from (CODA_COMMIT in check/coda.mjs), so that the two say the same thing; `--check` (CI) holds them together.
//
//   node scripts/sync-protocol.mjs --coda <Coda 仓库目录>   写 docs/agent-protocol.md（也可用环境变量 CODA_REPO）
//   node scripts/sync-protocol.mjs --check                  只核对副本：头部声明的提交、协议与 SDK 版本和检查包一致，正文没被手改
//
// Moving to a newer Coda: update the rules in check/ and CODA_COMMIT first, then sync. The copy is public: what it would
// carry out that looks private (a host, a path on someone's machine, a token, a link to the private repository) stops the
// sync until it is dealt with in Coda's text, or replaced here (REDACT) with a reason.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ACP_PROTOCOL_VERSION, CODA_COMMIT } from '../check/coda.mjs';

const COPY = new URL('../docs/agent-protocol.md', import.meta.url);
const SOURCE = 'docs/agent-protocol.md';
const SDK = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['@agentclientprotocol/sdk'];
// Replacements made in the copy, each with why: `{ pattern, replacement, why }`.
const REDACT = [];
// What a public copy must not carry out of the private repository.
const PRIVATE = [
  [/\/(Users|home)\/[^\s/)]+/g, '本机用户目录'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'IP 地址'],
  [/\b[\w-]+\.(?:ts\.net|internal|lan|local|corp)\b/gi, '内网主机名'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}|\bsk-[A-Za-z0-9-]{16,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '令牌'],
  [/github\.com[/:]coda-console\/(?!coda-plugins\b)[\w.-]+/gi, '私有仓库链接'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '邮箱'],
];

const header = ({ commit, body }) => `<!--
  副本：由 scripts/sync-protocol.mjs 从 Coda 主仓库的 ${SOURCE} 同步，不要直接改；改协议先改 Coda 的正文，再同步。
  coda-commit: ${commit}
  acp-protocol-version: ${ACP_PROTOCOL_VERSION}
  acp-sdk: ${SDK}
  body-sha256: ${createHash('sha256').update(body).digest('hex')}
-->
`;
// Links to Coda's other documents, which are not public, keep their words; links within the text and to the web stay.
export const publicText = text => text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (link, words, target) => /^(#|https?:)/.test(target) ? link : words);

export function findPrivate(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const [pattern, what] of PRIVATE) for (const match of line.matchAll(pattern)) found.push({ line: i + 1, what, text: match[0] });
  });
  return found;
}

// What is wrong with the copy, or [].
export function checkCopy(text = readFileSync(COPY, 'utf8')) {
  const head = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!head) return ['副本开头没有同步脚本写的声明'];
  const fields = Object.fromEntries([...head[1].matchAll(/^\s*([a-z0-9-]+): (\S+)$/gm)].map(m => [m[1], m[2]]));
  const body = text.slice(head[0].length), problems = [];
  if (fields['coda-commit'] !== CODA_COMMIT) problems.push(`副本同步自 Coda ${fields['coda-commit']}，检查包的规则抄自 ${CODA_COMMIT}：两边对不上`);
  if (fields['acp-protocol-version'] !== String(ACP_PROTOCOL_VERSION)) problems.push(`副本声明 ACP 协议版本 ${fields['acp-protocol-version']}，检查包讲的是 ${ACP_PROTOCOL_VERSION}`);
  if (fields['acp-sdk'] !== SDK) problems.push(`副本声明 SDK ${fields['acp-sdk']}，检查包依赖的是 ${SDK}`);
  if (fields['body-sha256'] !== createHash('sha256').update(body).digest('hex')) problems.push('副本正文被改过：重新同步，不要直接改');
  return problems;
}

function sync(coda) {
  const git = (...args) => execFileSync('git', ['-C', coda, ...args], { encoding: 'utf8' });
  const commit = git('rev-parse', '--verify', `${CODA_COMMIT}^{commit}`).trim();
  let body = publicText(git('show', `${commit}:${SOURCE}`));
  for (const { pattern, replacement } of REDACT) body = body.replace(pattern, replacement);
  const found = findPrivate(body);
  if (found.length) {
    console.error(`副本会公开，这些看着像私有信息，没有写入：\n${found.map(f => `  第 ${f.line} 行 ${f.what}：${f.text}`).join('\n')}\n先在 Coda 的正文里处理，或在 REDACT 里写明替换与理由。`);
    process.exit(1);
  }
  const note = `> 这是 Coda 接入协议正文的公开副本（Coda 主仓库不公开），同步自它的 ${SOURCE}。指向 Coda 其他文档的链接在副本里只留文字。`;
  body = body.replace(/^(# .*\n)?\n*/, (_, title = '') => `${title}${title ? '\n' : ''}${note}\n\n`);
  writeFileSync(COPY, header({ commit, body }) + body);
  console.log(`已从 Coda ${commit.slice(0, 7)} 同步 ${SOURCE}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { coda: { type: 'string' }, check: { type: 'boolean' } } });
  if (values.check) {
    const problems = checkCopy();
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log(`副本与检查包一致：Coda ${CODA_COMMIT.slice(0, 7)}，ACP 协议版本 ${ACP_PROTOCOL_VERSION}，SDK ${SDK}`);
  } else {
    const coda = values.coda ?? process.env.CODA_REPO;
    if (!coda) { console.error('需要 Coda 仓库目录：--coda <目录> 或环境变量 CODA_REPO'); process.exit(2); }
    sync(coda);
  }
}
