// 官方市场的索引：分类在约定的几个里，指向本仓库目录的条目与插件清单的 ID、版本一致。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMarketplace } from '../scripts/check-marketplace.mjs';

test('this repository\'s marketplace is as Coda reads it', () => {
  assert.deepEqual(checkMarketplace(fileURLToPath(new URL('..', import.meta.url))), []);
});

test('a category outside the list, a directory that is not the plugin named, or a version apart from its manifest is refused', t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-marketplace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  write('plugins/kit/package.json', { name: '@coda-console/kit', id: 'kit', version: '1.2.0', contributes: {} });
  write('plugins/bare/package.json', { name: 'bare', version: '1.0.0' });
  const index = plugins => write('.claude-plugin/marketplace.json', { name: 'coda-plugins', plugins });
  index([{ name: 'kit', description: '工具', version: '1.2.0', category: 'Agent', source: './plugins/kit' },
    { name: 'far', description: '别处', category: 'Skills 与工具', source: { source: 'github', repo: 'a/b' } }]);
  assert.deepEqual(checkMarketplace(root), []);
  index([{ name: 'kit', description: '工具', version: '1.1.0', category: '其他', source: './plugins/kit' },
    { name: 'kit', description: '', category: 'Agent', source: 'plugins/kit' },
    { name: 'other', description: '别的', category: 'Agent', version: '1.0.0', source: './plugins/bare' }]);
  assert.deepEqual(checkMarketplace(root), [
    'kit 的分类须是 Agent、模型与账号、工作流程、机器与资源、Skills 与工具 之一，写的是 其他',
    'kit 的版本写的是 1.1.0，清单里是 1.2.0',
    '条目 kit 重复', 'kit 没有介绍', 'kit 的相对路径须以 ./ 开头',
    'other 指向的 ./plugins/bare 不是 Coda 插件（清单没有 contributes）', 'other 指向的插件 ID 是 bare']);
});
