#!/usr/bin/env node
// 官方市场的索引（.claude-plugin/marketplace.json，Claude Code 的格式，Coda 的「市场」读它）写得对：
//   node scripts/check-marketplace.mjs
// 名字是 coda-plugins，条目名不重复、都写了介绍和下面几个分类之一；指向本仓库目录的条目，目录里是 Coda 插件，
// 条目名就是它的 ID，条目写的版本就是它清单里的版本（Coda 按条目的版本标「可更新」，忘了改就标不出来）。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Coda 的插件页按分类分组，各市场用同一套名字才分得到一起。
export const CATEGORIES = ['Agent', '模型与账号', '工作流程', '机器与资源', 'Skills 与工具'];

export function checkMarketplace(root = process.cwd()) {
  const problems = [], file = join(root, '.claude-plugin/marketplace.json');
  let index;
  try { index = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return [`读不出 .claude-plugin/marketplace.json：${e.message}`]; }
  if (index.name !== 'coda-plugins') problems.push(`市场的 name 须为 coda-plugins，写的是 ${index.name}`);
  if (!Array.isArray(index.plugins)) return [...problems, 'plugins 须为列表'];
  const seen = new Set();
  for (const entry of index.plugins) {
    const name = entry?.name;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) { problems.push(`条目名 ${name} 须为小写字母、数字和「-」`); continue; }
    if (seen.has(name)) problems.push(`条目 ${name} 重复`);
    seen.add(name);
    if (!CATEGORIES.includes(entry.category)) problems.push(`${name} 的分类须是 ${CATEGORIES.join('、')} 之一，写的是 ${entry.category}`);
    if (typeof entry.description !== 'string' || !entry.description.trim()) problems.push(`${name} 没有介绍`);
    if (typeof entry.source !== 'string') continue;
    if (!entry.source.startsWith('./')) { problems.push(`${name} 的相对路径须以 ./ 开头`); continue; }
    const manifestFile = join(root, entry.source, 'package.json');
    if (!existsSync(manifestFile)) { problems.push(`${name} 指向的 ${entry.source} 没有 package.json`); continue; }
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (!('contributes' in manifest)) problems.push(`${name} 指向的 ${entry.source} 不是 Coda 插件（清单没有 contributes）`);
    if ((manifest.id ?? manifest.name) !== name) problems.push(`${name} 指向的插件 ID 是 ${manifest.id ?? manifest.name}`);
    if (entry.version !== manifest.version) problems.push(`${name} 的版本写的是 ${entry.version}，清单里是 ${manifest.version}`);
  }
  return problems;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const problems = checkMarketplace();
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
