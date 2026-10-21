// The manifest level: what Coda reads of a plugin's directory before anything of it runs. The declaration rules are
// copied from Coda's readPlugin (backend/src/domain/plugins.mjs) and the modules it calls (agent-plugins.mjs, panels.mjs,
// plugin-extensions.mjs), what a plugin from a repository may not be from plugin-sources.mjs (treeProblem, manifestProblem,
// catalogProblem); check/coda.mjs names the
// commit. Coda stops at the first thing it cannot read; here each part is checked on its own, so one run lists them all.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { AGENT_ID, AGENT_LIMITS, BUILTIN_AGENTS, BUILTIN_COMMANDS, BUILTIN_GROUPS, BUILTIN_HERE, BUILTIN_SCOPE, CAPABILITY,
  CODA_COMMANDS, CODA_EVENT_DOMAINS, COMMAND, COMMAND_LIMIT, BUILTIN_ONLY, CONTRIBUTES, EVENT, EVENT_LIMIT, DEPTH, ICON_LIMIT, INSTRUCTIONS_LIMIT, NPM, NPM_LOCK, PANEL_ID, PANEL_LIMITS, PLUGIN_ID, POINT,
  SEGMENT, SERVICE, SETTING_KEY, SETUP_KEYS, SIZE_LIMIT } from './coda.mjs';

class Invalid extends Error {}
const check = (condition, message) => { if (!condition) throw new Invalid(message); };
const object = (value, where) => check(value && typeof value === 'object' && !Array.isArray(value), `${where} 须为对象`);
const keys = (value, allowed, where) => {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
};
const line = (value, max, where) => {
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !/[\0\r\n]/.test(value), `${where} 须为不超过 ${max} 字的一行文本`);
  return value;
};
// panels.mjs `text`: a confirmation or a note may run over lines.
const text = (value, max, where, { line: one = true } = {}) => {
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !value.includes('\0') && (!one || !/[\r\n]/.test(value)),
    `${where} 须为不超过 ${max} 字的${one ? '一行' : ''}文本`);
  return value;
};
// agent-plugins.mjs `inside`: relative, never leaving the directory.
const inside = (value, where, { segments = Infinity } = {}) => {
  line(value, AGENT_LIMITS.path, where);
  const path = normalize(value);
  check(!isAbsolute(value) && path !== '..' && !path.startsWith(`..${sep}`) && path.split(sep).length <= segments,
    `${where} 须为不离开所在目录的相对路径${Number.isFinite(segments) ? `，至多 ${segments} 段` : ''}`);
  return path;
};
// JSON Schema's `format: duration` (Coda reads it with @0dep/piso): an ISO 8601 duration, not negative. Close enough here.
const DURATION = /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/;
const isDuration = value => typeof value === 'string' && value.length <= 200 && DURATION.test(value);

// ---- Settings (plugins.mjs `schema`, `checkValue`) ----
// A choice of several's option (plugin-rules.mjs OPTION).
const OPTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function schema(value, where, entry = false) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${where} 须为 JSON Schema 对象`);
  const known = ['type', 'default', 'description', 'markdownDescription', 'title', 'enum', 'enumDescriptions', 'minimum', 'maximum', 'format', 'order',
    ...(entry ? [] : ['additionalProperties', 'propertyNames', 'items', 'uniqueItems'])];
  check(value.type !== 'array' || !entry, `${where}：多选只能是插件的一项设置，不能放进表格`);
  keys(value, known, where);
  const agent = value.format === 'coda-agent';
  check(['boolean', 'integer', 'number', 'string', 'object', 'array'].includes(value.type), `${where} 的 type 不受支持：${value.type}`);
  check((value.items === undefined && value.uniqueItems === undefined) || value.type === 'array', `${where}：只有多选（type: array）才写 items 与 uniqueItems`);
  check(value.format === undefined || agent || value.format === 'coda-agent-match' || value.format === 'duration', `${where} 的 format 不受支持：${value.format}`);
  check(!agent || value.type === 'object', `${where}：coda-agent 是对象`);
  check(value.format !== 'duration' || value.type === 'string', `${where}：duration 是文本`);
  check(value.enum === undefined || (Array.isArray(value.enum) && value.enum.length && ['string', 'integer', 'number'].includes(value.type)), `${where} 的 enum 无效`);
  const out = { type: value.type, format: value.format, enum: value.enum, minimum: value.minimum, maximum: value.maximum };
  if (value.type === 'array') {
    check(value.format === undefined && value.minimum === undefined && value.maximum === undefined, `${where}：多选不写 format、minimum 与 maximum`);
    check(value.uniqueItems === undefined || value.uniqueItems === true, `${where}：多选的 uniqueItems 只能是 true（每项至多选一次）`);
    const items = value.items, options = items?.anyOf;
    check(items && typeof items === 'object' && !Array.isArray(items) && Object.keys(items).every(k => k === 'anyOf') && Array.isArray(options)
      && options.length >= 1 && options.length <= 50, `${where}：多选写 items: { anyOf: [{ const, title, description }] }，1–50 项`);
    out.options = options.map((option, i) => {
      check(option && typeof option === 'object' && !Array.isArray(option) && Object.keys(option).every(k => ['const', 'title', 'description'].includes(k))
        && typeof option.const === 'string' && OPTION.test(option.const), `${where}.items.anyOf[${i}] 须为 { const, title, description }，const 只用字母、数字和「._-」`);
      check(['title', 'description'].every(k => option[k] === undefined || (typeof option[k] === 'string' && option[k].length <= 400)),
        `${where}.items.anyOf[${i}] 的 title 与 description 须为不超过 400 字的文字`);
      return option.const;
    });
    check(new Set(out.options).size === out.options.length, `${where}：多选的 const 不能重复`);
  }
  if (value.type === 'object' && !agent) {
    check(!entry, `${where}：表格的每一项只能是单个值或 Agent 组合`);
    check(value.additionalProperties !== undefined, `${where} 需要 additionalProperties`);
    out.entries = schema(value.additionalProperties, `${where}.additionalProperties`, true);
    if (value.propertyNames !== undefined) {
      check(value.propertyNames && Object.keys(value.propertyNames).every(k => k === 'format') && value.propertyNames.format === 'coda-agent-match',
        `${where}.propertyNames 只支持 format: coda-agent-match`);
      out.keys = 'coda-agent-match';
    }
  }
  if (value.default !== undefined) { checkValue(out, value.default, `${where} 的默认值`); out.default = value.default; }
  return out;
}
const agentMatch = key => key === '*' || (typeof key === 'string' && (parts => parts.length >= 1 && parts.length <= 3 && AGENT_ID.test(parts[0])
  && parts.every(p => p.length > 0 && p.length <= 200 && !/[\0\n]/.test(p)))(key.split('|')));
function checkValue(spec, value, where) {
  // An agent combination: Coda also checks model, effort, mode and options (domain/commands.mjs settings); here only the agent.
  if (spec.format === 'coda-agent') {
    check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.agent === 'string' && AGENT_ID.test(value.agent), `${where} 须为 Agent 组合，并指明 Agent`);
    return;
  }
  if (spec.type === 'array') {
    check(Array.isArray(value) && value.every(v => typeof v === 'string'), `${where}须为选中的几项`);
    const unknown = value.filter(v => !spec.options.includes(v));
    check(!unknown.length, `${where}只能从这些里选：${spec.options.join('、')}（没有 ${unknown.join('、')}）`);
    return;
  }
  if (spec.type === 'boolean') check(typeof value === 'boolean', `${where}须为开或关`);
  else if (spec.type === 'integer' || spec.type === 'number') {
    check(typeof value === 'number' && Number.isFinite(value) && (spec.type === 'number' || Number.isInteger(value)), `${where}须为${spec.type === 'integer' ? '整数' : '数字'}`);
    check((spec.minimum === undefined || value >= spec.minimum) && (spec.maximum === undefined || value <= spec.maximum), `${where}须在 ${spec.minimum ?? '-∞'}–${spec.maximum ?? '∞'} 之间`);
  } else if (spec.type === 'string') {
    check(typeof value === 'string' && value.length <= 20000 && !value.includes('\0'), `${where}须为文本`);
    check(spec.format !== 'duration' || isDuration(value), `${where}须为 ISO 8601 时长，如 P30D、PT6H`);
  } else if (spec.type === 'object') {
    object(value, where);
    for (const [k, v] of Object.entries(value)) {
      check(spec.keys !== 'coda-agent-match' || agentMatch(k), `${where}的「${k}」不是有效的作者`);
      checkValue(spec.entries, v, `${where}「${k}」`);
    }
    return;
  }
  check(!spec.enum || spec.enum.includes(value), `${where}只能是：${spec.enum?.join('、')}`);
}

// ---- Panels (panels.mjs `declaration`, `signIn`) ----
function panel(raw, where) {
  object(raw, where);
  keys(raw, ['id', 'title', 'command', 'maxAge', 'actions', 'signIn'], where);
  check(typeof raw.id === 'string' && PANEL_ID.test(raw.id), `${where} 的 id 只能用小写字母、数字和「-」，以字母开头`);
  const at = `面板 ${raw.id}`;
  check(raw.maxAge === undefined || isDuration(raw.maxAge), `${at} 的 maxAge 须为 ISO 8601 时长，如 PT5M`);
  const actions = {};
  if (raw.actions !== undefined) {
    object(raw.actions, `${at} 的 actions`);
    for (const [name, action] of Object.entries(raw.actions)) {
      check(PANEL_ID.test(name), `${at} 的动作名只能用小写字母、数字和「-」，以字母开头：${name}`);
      object(action, `${at} 的动作 ${name}`);
      keys(action, ['command', 'confirm'], `${at} 的动作 ${name}`);
      actions[name] = { command: text(action.command, PANEL_LIMITS.command, `${at} 的动作 ${name} 的 command`),
        ...(action.confirm !== undefined ? { confirm: text(action.confirm, PANEL_LIMITS.confirm, `${at} 的动作 ${name} 的 confirm`, { line: false }) } : {}) };
    }
  }
  let signIn;
  if (raw.signIn !== undefined) {
    const s = raw.signIn, w = `${at} 的 signIn`;
    object(s, w);
    keys(s, ['command', 'installed', 'install', 'input', 'note'], w);
    check(s.input === undefined || s.input === 'authorizationCode', `${w} 的 input 只能是 authorizationCode`);
    check(s.install === undefined || s.installed !== undefined, `${w}：写了 install 就要写 installed，Coda 才知道装没装好`);
    signIn = { command: text(s.command, PANEL_LIMITS.command, `${w} 的 command`) };
    if (s.installed !== undefined) signIn.installed = text(s.installed, PANEL_LIMITS.command, `${w} 的 installed`);
    if (s.install !== undefined) signIn.install = text(s.install, PANEL_LIMITS.command, `${w} 的 install`);
    if (s.note !== undefined) text(s.note, PANEL_LIMITS.note, `${w} 的 note`, { line: false });
  }
  return { id: raw.id, title: text(raw.title, PANEL_LIMITS.title, `${at} 的 title`), command: text(raw.command, PANEL_LIMITS.command, `${at} 的 command`),
    actions, ...(signIn ? { signIn } : {}) };
}

// ---- Agents (agent-plugins.mjs `declaration`, `icon`) ----
function icon(dir, value, where) {
  const path = inside(value, where);
  let data;
  try { data = readFileSync(join(dir, path)); } catch (e) { check(false, `${where} 读不到：${e.message}`); }
  check(data.length <= ICON_LIMIT, `${where} 超过 ${ICON_LIMIT / 1024} KiB（现为 ${(data.length / 1024).toFixed(1)} KiB）`);
  check(data.subarray(0, 5).toString('latin1') === '%PDF-', `${where} 须为 PDF`);
  return { path, size: data.length, data };
}
function agent(raw, where, dir) {
  object(raw, where);
  keys(raw, ['id', 'displayName', 'icon', 'command', 'modes', 'skillsDir', 'configFiles', 'setupHint'], where);
  check(typeof raw.id === 'string' && AGENT_ID.test(raw.id), `${where} 的 id 只能用小写字母、数字和「-」，以字母开头，至多 40 个字符`);
  const at = `Agent ${raw.id}`, L = AGENT_LIMITS;
  object(raw.icon, `${at} 的 icon`);
  keys(raw.icon, ['light', 'dark', 'template'], `${at} 的 icon`);
  check(raw.icon.template === undefined || typeof raw.icon.template === 'boolean', `${at} 的 icon.template 须为开或关`);
  const modes = raw.modes ?? {};
  object(modes, `${at} 的 modes`);
  keys(modes, ['title', 'unset', 'note', 'auto', 'full'], `${at} 的 modes`);
  check(raw.configFiles === undefined || (Array.isArray(raw.configFiles) && raw.configFiles.length <= L.configFiles), `${at} 的 configFiles 须为至多 ${L.configFiles} 项的数组`);
  line(raw.displayName, L.displayName, `${at} 的 displayName`);
  const icons = [icon(dir, raw.icon.light, `${at} 的 icon.light`), ...(raw.icon.dark !== undefined ? [icon(dir, raw.icon.dark, `${at} 的 icon.dark`)] : [])];
  line(raw.command, L.command, `${at} 的 command`);
  for (const [key, max] of [['title', L.modeTitle], ['unset', L.modeUnset], ['note', L.modeNote], ['auto', L.modeId], ['full', L.modeId]])
    if (modes[key] !== undefined) line(modes[key], max, `${at} 的 modes.${key}`);
  if (raw.skillsDir !== undefined) inside(raw.skillsDir, `${at} 的 skillsDir`, { segments: 3 });
  (raw.configFiles ?? []).forEach((file, i) => line(file, L.path, `${at} 的 configFiles[${i}]`));
  if (raw.setupHint !== undefined) line(raw.setupHint, L.setupHint, `${at} 的 setupHint`);
  return { id: raw.id, displayName: raw.displayName, command: raw.command, icons, modes };
}
// iOS draws an icon's PDF at 96 points and only ever scales it down: a smaller page comes out as a dot (Coda's own icons are
// 256 points, backend/src/resources/plugins/grok/icons/README.md).
// The page box may sit in a compressed object stream (PDF 1.5 and later, as CairoSVG writes them).
function pageSize(data) {
  const MEDIA_BOX = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/;
  const raw = data.toString('latin1'), texts = [raw];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length, end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try { texts.push(inflateSync(data.subarray(start, end)).toString('latin1')); } catch {}
  }
  for (const text of texts) {
    const box = MEDIA_BOX.exec(text);
    if (box) return { width: Number(box[3]) - Number(box[1]), height: Number(box[4]) - Number(box[2]) };
  }
  return null;
}

// ---- Files, as a repository source sees them (plugin-sources.mjs `treeProblem`, `sourcePath`) ----
// The files Coda would take from a commit: those Git tracks here, and those it would once they are committed. Outside Git,
// every file but `.git`.
function files(dir) {
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let top = null;
  try { top = git(['rev-parse', '--show-toplevel']).trim(); } catch {}
  if (top) {
    const tracked = git(['ls-files', '-s', '-z', '--', '.']).split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t'), [mode] = entry.slice(0, tab).split(' ');
      return { mode, name: entry.slice(tab + 1) };
    });
    const untracked = git(['ls-files', '-o', '--exclude-standard', '-z', '--', '.']).split('\0').filter(Boolean).map(name => ({ name, untracked: true }));
    return { top, entries: [...tracked, ...untracked].map(e => withStat(dir, e)) };
  }
  const entries = [];
  const walk = sub => {
    for (const name of readdirSync(join(dir, sub))) {
      if (!sub && name === '.git') continue;
      const rel = sub ? `${sub}/${name}` : name, stat = lstatSync(join(dir, rel));
      if (stat.isDirectory()) { if (existsSync(join(dir, rel, '.git'))) entries.push({ name: rel, mode: '160000', size: 0 }); else walk(rel); }
      else entries.push(withStat(dir, { name: rel }));
    }
  };
  walk('');
  return { top: null, entries };
}
// Why npm could not install from the lock file next to the manifest (`npm ci` refuses a lock that does not match; Coda's
// manifestProblem refuses it first), or null.
function lockProblem(dir, manifest) {
  let lock;
  try { lock = JSON.parse(readFileSync(join(dir, NPM_LOCK), 'utf8')); } catch (e) { return `${NPM_LOCK} 读不了：${e.message}`; }
  const root = lock?.packages?.[''];
  if (!root) return `${NPM_LOCK} 不是 npm 7 以后的格式（没有 packages[""]）`;
  const differ = NPM.filter(key => JSON.stringify(Object.entries(manifest[key] ?? {}).sort()) !== JSON.stringify(Object.entries(root[key] ?? {}).sort()));
  return differ.length ? `${NPM_LOCK} 与 package.json 的 ${differ.join('、')} 对不上：npm ci 会拒绝，在插件目录里 npm install 重新生成` : null;
}
function withStat(dir, entry) {
  let stat = null;
  try { stat = lstatSync(join(dir, entry.name)); } catch {}
  const mode = entry.mode ?? (stat?.isSymbolicLink() ? '120000' : '100644');
  return { ...entry, mode, size: stat && !stat.isSymbolicLink() && stat.isFile() ? stat.size : 0, missing: !stat && mode !== '160000' };
}

// Checks the manifest in `dir` and reports under `scope` (report.mjs). Returns what the later levels need: the agents and
// panels as declared, and the plugin's settings defaults; null when there is no manifest to read.
export function checkManifest(dir, say) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { say.fail('manifest.read', `没有可读的 package.json：${e.message}`); return null; }
  const part = (rule, fn, passed) => {
    try {
      const value = fn(), message = typeof passed === 'function' ? passed(value) : passed;
      if (message) say.pass(rule, message);
      return value;
    }
    catch (e) { if (!(e instanceof Invalid)) throw e; say.fail(rule, e.message); return undefined; }
  };
  const { top, entries } = files(dir);
  // Git names the top by its real path; so is the directory measured.
  const path = top ? relative(top, realpathSync(dir)).split(sep).filter(Boolean) : null;
  // A built-in plugin as its package is named: Coda ships a version of that package, and a newer one may stand in for it.
  const declaredId = manifest.id !== undefined ? manifest.id : manifest.name;
  const own = BUILTIN_HERE.includes(declaredId) && manifest.name === `${BUILTIN_SCOPE}${declaredId}`;
  const id = part('manifest.name', () => {
    check(typeof declaredId === 'string' && PLUGIN_ID.test(declaredId), `package.json 的 ${manifest.id !== undefined ? 'id' : 'name'} 只能用小写字母、数字和「-」，以字母开头，至多 40 个字符`);
    return declaredId;
  }, name => `package.json 能读，插件 ID ${name}${own ? `（Coda 内置插件 ${name}：Coda 带的是 npm 上 ${manifest.name} 的一个版本，这个包的新版本可以盖过它）` : ''}`);
  const contributes = part('manifest.contributes', () => {
    check(manifest.contributes && typeof manifest.contributes === 'object' && !Array.isArray(manifest.contributes),
      'contributes 须为对象（Coda 只把带 contributes 的目录当插件）');
    const unknown = Object.keys(manifest.contributes).filter(k => !CONTRIBUTES.includes(k));
    check(!unknown.length, `contributes 里有 Coda 不支持的贡献：${unknown.join('、')}`);
    // What is checked here is installed from a repository or npm, never as a copy Coda ships.
    for (const [key, refusal] of Object.entries(BUILTIN_ONLY)) check(manifest.contributes[key] === undefined, `contributes.${key}：${refusal}`);
    return manifest.contributes;
  }) ?? {};
  if (typeof manifest.version !== 'string') say.warn('manifest.version', 'package.json 没有 version：Coda 只认提交，version 只作显示，但安装确认里会空着');
  const name = id ?? String(declaredId);

  const settings = part('manifest.settings', () => {
    const properties = contributes.configuration?.properties ?? {};
    object(properties, 'contributes.configuration.properties');
    return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      check(SETTING_KEY.test(key) && key.split('.')[0] === name, `设置名须以「${name}.」开头，只用字母和数字：${key}`);
      return [key, schema(value, key)];
    }));
  }) ?? {};
  if (Object.keys(settings).length) say.pass('manifest.settings', `设置 ${Object.keys(settings).length} 项`);

  part('manifest.capabilities', () => {
    const list = sub => existsSync(join(dir, sub)) ? [...new Set(readdirSync(join(dir, sub)).map(f => /^(.+)\.bpmn$/.exec(f)?.[1]).filter(Boolean))].sort() : [];
    const workflows = list('.coda/workflows'), listed = contributes.capabilities ?? [];
    check(Array.isArray(listed) && listed.every(n => typeof n === 'string' && CAPABILITY.test(n)) && new Set(listed).size === listed.length,
      'contributes.capabilities 须为能力名的数组（小写字母、数字和「-」，以字母开头），不重复');
    const capabilities = [...listed].sort(), found = list('.coda/capabilities');
    check(capabilities.length === found.length && capabilities.every((n, i) => n === found[i]),
      `contributes.capabilities 与 .coda/capabilities/ 里的文件不一致：列出 ${capabilities.join('、') || '无'}，文件 ${found.join('、') || '无'}`);
    const both = capabilities.filter(n => workflows.includes(n));
    check(!both.length, `${both.join('、')} 既是流程又是能力`);
    if (workflows.length || capabilities.length) say.pass('manifest.capabilities', `流程 ${workflows.join('、') || '无'}，能力 ${capabilities.join('、') || '无'}`);
  });
  part('manifest.instructions', () => {
    const value = contributes.instructions;
    check(value === undefined || (typeof value === 'string' && value.trim() && [...value].length <= INSTRUCTIONS_LIMIT), `contributes.instructions 须为不超过 ${INSTRUCTIONS_LIMIT} 字的说明`);
  });
  // A group and a command are one plugin's, as an agent is (plugin-sources.mjs catalogProblem): those of the built-in plugins
  // are taken.
  const taken = (what, value, builtin) => builtin[value] && builtin[value] !== name ? `${what} ${value} 已由内置插件 ${builtin[value]} 声明，换一个名字` : null;
  const groups = part('manifest.groups', () => {
    const groups = contributes.groups ?? [];
    check(Array.isArray(groups) && groups.every(g => g && typeof g === 'object' && Object.keys(g).every(k => ['name', 'capacity'].includes(k))
      && typeof g.name === 'string' && /^\S{1,100}$/.test(g.name) && settings[g.capacity]?.type === 'integer')
      && new Set(groups.map(g => g.name)).size === groups.length,
    'contributes.groups 须为 { name, capacity } 的数组：name 为 1–100 个非空白字符、不重复，capacity 是本插件声明的整数设置');
    return groups;
  }, groups => groups.length ? `并发组 ${groups.map(g => g.name).join('、')}` : null) ?? [];
  part('manifest.events', () => {
    const events = contributes.events ?? [];
    check(Array.isArray(events) && events.length <= EVENT_LIMIT && events.every(e => e && typeof e === 'object' && Object.keys(e).every(k => ['name', 'starts', 'ends'].includes(k))
      && typeof e.name === 'string' && EVENT.test(e.name) && !CODA_EVENT_DOMAINS.includes(e.name.split('.')[0])
      && ['starts', 'ends'].every(k => e[k] === undefined || typeof e[k] === 'boolean'))
      && new Set(events.map(e => e.name)).size === events.length,
    `contributes.events 须为 { name, starts?, ends? } 的数组，至多 ${EVENT_LIMIT} 个：name 是「<域>.<名>」（小写字母、数字和「_」，以字母开头，不超过 100 个字符，不重复，域不能是 Coda 自己的 ${CODA_EVENT_DOMAINS.join('、')}），starts、ends 是真假值`);
    return events;
  }, events => events.length ? `发布的事件 ${events.map(e => e.name).join('、')}` : null);
  const commands = part('manifest.commands', () => {
    const commands = contributes.commands ?? [];
    check(Array.isArray(commands) && commands.every(c => c && typeof c === 'object' && Object.keys(c).every(k => ['name', 'command'].includes(k))
      && typeof c.name === 'string' && COMMAND.test(c.name) && !CODA_COMMANDS.includes(c.name)
      && typeof c.command === 'string' && c.command.trim() && c.command.length <= COMMAND_LIMIT && !/[\0\r\n]/.test(c.command))
      && new Set(commands.map(c => c.name)).size === commands.length,
    `contributes.commands 须为 { name, command } 的数组：name 是命令名（小写字母、数字和「-」，以字母开头，不重复，不能是 Coda 自己的 ${CODA_COMMANDS.join('、')}），command 是一行命令`);
    return commands;
  }, commands => commands.length ? `会话 PATH 上的命令 ${commands.map(c => c.name).join('、')}` : null) ?? [];
  part('manifest.services', () => {
    const services = contributes.services ?? [];
    check(Array.isArray(services) && services.every(id => typeof id === 'string' && SERVICE.test(id)) && new Set(services).size === services.length,
      'contributes.services 须为服务 ID 的数组，不重复');
    return services;
  }, services => services.length ? `开启随包服务 ${services.join('、')}：没有已安装插件开启的服务不运行` : null);
  part('manifest.setup', () => {
    if (contributes.setup === undefined) return null;
    object(contributes.setup, 'contributes.setup');
    keys(contributes.setup, SETUP_KEYS, 'contributes.setup');
    return text(contributes.setup.command, PANEL_LIMITS.command, 'contributes.setup 的 command');
  }, command => command ? `设置动作（contributes.setup）：一行命令；检查不运行它（可能装软件）` : null);
  for (const g of groups) { const problem = taken('组', g.name, BUILTIN_GROUPS); if (problem) say.fail('manifest.claims', problem); }
  for (const c of commands) { const problem = taken('命令', c.name, BUILTIN_COMMANDS); if (problem) say.fail('manifest.claims', problem); }

  const panels = part('manifest.panels', () => {
    if (contributes.panels === undefined) return [];
    check(Array.isArray(contributes.panels), 'contributes.panels 须为数组');
    const list = contributes.panels.map((p, i) => panel(p, `contributes.panels[${i}]`));
    check(new Set(list.map(p => p.id)).size === list.length, 'contributes.panels 里有重复的 id');
    return list;
  }) ?? [];
  for (const p of panels) say.pass('manifest.panels', `面板 ${p.id}「${p.title}」：动作 ${Object.keys(p.actions).join('、') || '无'}${p.signIn ? '，可从 Coda 登录' : ''}`);

  let agents = [];
  if (contributes.agents !== undefined) {
    if (!Array.isArray(contributes.agents)) say.fail('manifest.agents', 'contributes.agents 须为数组');
    else contributes.agents.forEach((raw, i) => {
      const declared = part('manifest.agents', () => agent(raw, `contributes.agents[${i}]`, dir));
      if (!declared) return;
      if (agents.some(a => a.id === declared.id)) { say.fail('manifest.agents', 'contributes.agents 里有重复的 id'); return; }
      // A version or replacement of a built-in plugin may declare its agents; installation checks whether the name is free.
      // The old Claude ID stays nobody's.
      const owner = BUILTIN_AGENTS[declared.id];
      if (owner && (declared.id === 'claude' || owner !== name)) say.fail('manifest.agent-id', declared.id === 'claude'
        ? 'Agent ID claude 是 Coda 早先的 Claude 会话存的 ID：Coda 的读取来源不拦它，但装上会接管那些旧会话，换一个 ID'
        : `Agent ${declared.id} 已由内置插件 ${owner} 声明，换一个 ID`);
      agents.push(declared);
      const sizes = declared.icons.map(i => `${i.path} ${(i.size / 1024).toFixed(1)} KiB`).join('，');
      say.pass('manifest.agents', `Agent ${declared.id}「${declared.displayName}」：字段齐全，command 一行，图标 PDF（${sizes}）`);
      for (const i of declared.icons) {
        const page = pageSize(i.data);
        if (page && Math.min(page.width, page.height) < 64) say.warn('manifest.icon-page', `${i.path} 的页面只有 ${page.width}×${page.height} pt：iOS 按 96 pt 光栅化图标、只缩不放，页面太小会画成一个点；照 Coda 自带图标按 256 px（192 pt）出图`);
      }
    });
  }

  // Where the plugins it depends on are, as its processes are told (CODA_PLUGIN_DEPENDENCIES): here a directory beside it
  // that is that plugin, as one of the same commit Coda would install with it.
  const dependencies = {};
  part('manifest.extensions', () => {
    const deps = manifest.extensionDependencies;
    check(deps === undefined || (Array.isArray(deps) && deps.every(d => typeof d === 'string' && PLUGIN_ID.test(d)) && new Set(deps).size === deps.length),
      'extensionDependencies 须为插件 ID 的数组，不重复');
    check(!deps?.includes(name), 'extensionDependencies 不能写自己');
    if (contributes.extensionPoints !== undefined) {
      object(contributes.extensionPoints, 'contributes.extensionPoints');
      for (const [point, value] of Object.entries(contributes.extensionPoints)) {
        const where = `contributes.extensionPoints.${point}`;
        check(POINT.test(point), `${where}：扩展点名只能用小写字母、数字和「-」，以字母开头`);
        object(value, where); keys(value, ['description'], where); line(value.description, 200, `${where} 的 description`);
      }
    }
    if (contributes.extensions !== undefined) {
      object(contributes.extensions, 'contributes.extensions');
      for (const [key, value] of Object.entries(contributes.extensions)) {
        const where = `contributes.extensions.${key}`, [plugin, point, ...rest] = key.split('/');
        check(PLUGIN_ID.test(plugin ?? '') && POINT.test(point ?? '') && !rest.length, `${where}：须写成「插件 ID/扩展点名」`);
        check((deps ?? []).includes(plugin), `${where}：只能接所依赖的插件的扩展点，先把 ${plugin} 写进 extensionDependencies`);
        object(value, where); keys(value, ['command'], where); line(value.command, 4000, `${where} 的 command`);
      }
    }
    if (!deps?.length) return;
    for (const dep of deps) {
      const beside = join(dir, '..', dep);
      try {
        const sibling = JSON.parse(readFileSync(join(beside, 'package.json'), 'utf8'));
        if ((sibling.id !== undefined ? sibling.id : sibling.name) === dep) dependencies[dep] = realpathSync(beside);
      } catch {}
    }
    const missing = deps.filter(d => !dependencies[d]);
    say.info('manifest.extensions', `依赖 ${deps.join('、')}：Coda 装它时先装它们（这台机器的插件，或同一提交里的兄弟目录），它的进程从 CODA_PLUGIN_DEPENDENCIES 拿到它们的目录${missing.length
      ? `；${missing.join('、')} 不在旁边，检查时不带` : ''}`);
  });

  // npm dependencies are installed from the lock file Coda takes with the rest of the commit.
  const npm = NPM.filter(key => manifest[key] && typeof manifest[key] === 'object' && Object.keys(manifest[key]).length);
  if (npm.length) {
    const count = npm.reduce((n, key) => n + Object.keys(manifest[key]).length, 0), lock = entries.find(e => e.name === NPM_LOCK && !e.missing);
    const problem = !lock ? `带 npm 依赖（${npm.join('、')}）却没有 ${NPM_LOCK}${existsSync(join(dir, NPM_LOCK)) ? '（有这个文件，但被 .gitignore 忽略了）' : ''}：Coda 在插件的版本目录里 npm ci，没有锁文件就装不了`
      : lockProblem(dir, manifest);
    if (problem) say.fail('source.npm', problem);
    else say.pass('source.npm', `npm 依赖 ${count} 个，带 ${NPM_LOCK}：Coda 在插件的版本目录里 npm ci 装它们`);
  }
  // What a repository source may not hold (plugin-sources.mjs).
  const link = entries.find(e => e.mode === '120000'), module = entries.find(e => e.mode === '160000');
  const size = entries.reduce((sum, e) => sum + e.size, 0);
  if (link) say.fail('source.symlink', `目录里有符号链接：${link.name}`);
  if (module) say.fail('source.submodule', `目录里有子模块：${module.name}`);
  if (size > SIZE_LIMIT) say.fail('source.size', `整个目录超过 ${SIZE_LIMIT / 1024 / 1024} MiB（现为 ${(size / 1024 / 1024).toFixed(1)} MiB）`);
  if (path) {
    if (path.length > DEPTH) say.fail('source.depth', `插件目录 ${path.join('/')} 在仓库根下超过 ${DEPTH} 层：Coda 扫不到`);
    const bad = path.find(p => !SEGMENT.test(p));
    if (bad) say.fail('source.segment', `目录名 ${bad} 只能用字母、数字和「._-」`);
  } else if (!SEGMENT.test(basename(dir))) say.fail('source.segment', `目录名 ${basename(dir)} 只能用字母、数字和「._-」`);
  if (!link && !module && size <= SIZE_LIMIT) say.pass('source.files', `从仓库安装的限制：无符号链接与子模块，整个目录 ${(size / 1024).toFixed(1)} KiB`);
  const untracked = entries.filter(e => e.untracked), missing = entries.filter(e => e.missing);
  if (untracked.length) say.warn('source.untracked', `${untracked.length} 个文件还没提交（如 ${untracked[0].name}）：Coda 只读提交里的文件`);
  if (missing.length) say.warn('source.missing', `${missing.length} 个已跟踪的文件在工作区里不见了（如 ${missing[0].name}）`);
  if (!top) say.info('source.git', '目录不在 Git 仓库里：按目录里的文件检查，提交后以 Coda 读到的为准');

  const defaults = Object.fromEntries(Object.entries(settings).map(([key, spec]) => [key, spec.default ?? (spec.entries ? {} : null)]));
  return { id: name, manifest, agents, panels, settings: defaults, dependencies, path: path?.join('/') ?? null };
}
