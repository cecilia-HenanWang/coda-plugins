// 本仓库的插件都写了分类，且是 Coda 自己的插件用的那几个之一：Coda 的插件页与商店按它分组（Coda 的 docs/plugins.md「商店」）。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../check/manifest.mjs';

test('every plugin of this repository names one of the categories Coda lists first', () => {
  const root = fileURLToPath(new URL('../plugins', import.meta.url));
  for (const id of readdirSync(root)) {
    const manifest = JSON.parse(readFileSync(join(root, id, 'package.json'), 'utf8'));
    assert.ok(CATEGORIES.includes(manifest.categories?.[0]), `${id}：${manifest.categories}`);
  }
});
