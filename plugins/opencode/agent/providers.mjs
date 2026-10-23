// Coda's chosen model service becomes a separate native OpenCode provider, through the child process's inline config.
// OpenCode lists, selects and resumes its models itself; the machine's own providers and config files stay as they are.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseTree } from 'jsonc-parser';

export const SETTING = 'opencode.modelProvider';
const packages = { 'openai-completions': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', 'anthropic-messages': '@ai-sdk/anthropic' };
const log = text => process.stderr.write(`[opencode-agent] ${text}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

export function chosenService(env = process.env) {
  const ref = parse(env.CODA_PLUGIN_SETTINGS)?.[SETTING];
  if (!ref) return null;
  const service = parse(env.CODA_MODEL_PROVIDERS)?.[ref];
  if (!service?.url) { log(`模型服务 ${ref} 在这台机器上没有`); return null; }
  if (!Object.hasOwn(packages, service.api)) { log(`模型服务 ${ref} 的接口 ${service.api} 不受 OpenCode 插件支持`); return null; }
  let key;
  try { key = service.keyFile ? readFileSync(service.keyFile, 'utf8').trim() || undefined : undefined; }
  catch { log(`读不到模型服务 ${ref} 的 Key`); return null; }
  return { ref, title: service.title || ref, api: service.api, url: service.url, key };
}

// Provider IDs cannot contain '/', which OpenCode uses to split a provider from a model. Coda refs have two components
// made of letters, digits and hyphens, so '.' preserves their identity without colliding with a native provider name.
export const providerId = ref => `coda-${ref.replaceAll('/', '.')}`;

// Same endpoint and authentication as Coda's model check. Keep slash-containing model IDs intact and follow Anthropic's
// pagination, bounded by a single timeout and ten pages. Nothing from the machine's own API credentials is sent here.
export async function serviceModels({ api, url, key }, fetcher = fetch) {
  const at = `${url.replace(/\/+$/, '')}/models`, anthropic = api === 'anthropic-messages';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key ? { Authorization: `Bearer ${key}` } : {};
  const models = new Map(), signal = AbortSignal.timeout(8000);
  let after;
  for (let page = 0; page < 10; page++) {
    const query = anthropic ? `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}` : '';
    const response = await fetcher(at + query, { headers, signal });
    if (!response.ok) throw new Error(`模型列表回答 ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error('回答不是模型列表');
    for (const model of body.data) if (typeof model?.id === 'string' && model.id) models.set(model.id, model);
    if (!anthropic || !body.has_more || typeof body.last_id !== 'string' || !body.last_id || body.last_id === after) break;
    after = body.last_id;
  }
  return [...models.values()];
}

const positive = value => Number.isSafeInteger(value) && value > 0;
export function serviceProvider(service, models) {
  const url = service.url.replace(/\/+$/, '');
  return {
    name: service.title, npm: packages[service.api], env: [],
    // The Anthropic SDK takes a /v1 base, whereas Coda's Anthropic service address may be the API root.
    // An explicit placeholder prevents the SDK falling back to OPENAI_API_KEY / ANTHROPIC_API_KEY for a keyless service.
    options: { baseURL: service.api === 'anthropic-messages' && !url.endsWith('/v1') ? `${url}/v1` : url, apiKey: service.key ?? 'none' },
    models: Object.fromEntries(models.map(model => [model.id, {
      name: model.id,
      // /models commonly has no limits. OpenCode's default of zero would compact immediately; use conservative limits
      // unless the service supplies them. Do not guess image support or reasoning settings from a model's name.
      limit: { context: positive(model.context_length) ? model.context_length : 32768,
        output: positive(model.max_output_tokens) ? model.max_output_tokens : 4096 },
    }])),
  };
}

// OpenCode expands {env:...} and {file:...} on the config text BEFORE parsing JSON. Only the generated data is quoted this
// way: escaping '{' within JSON string tokens preserves their literal value without exposing an interpolation template.
const literalJSON = value => JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, token => token.replaceAll('{', '\\u007b'));

function inlineTree(text, envExpanded = false) {
  // Unquoted user templates may become booleans or numbers only when OpenCode expands them. Give those complete nodes
  // quoted placeholders of the same length for parsing, keeping offsets into the original text. Strings and comments are
  // consumed first so their templates retain the existing semantics. This parser does not read environment or files.
  const templates = new Map();
  const syntax = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\{(?:env|file):[^}]+\}/g, (token, offset) => {
    if (!token.startsWith('{')) return token;
    // OpenCode substitutes environment variables once, then files. An env value cannot introduce another unquoted env
    // template; leaving it unmasked lets the parser reject it just as OpenCode would.
    if (envExpanded && token.startsWith('{env:')) return token;
    templates.set(offset, token);
    return `"${' '.repeat(token.length - 2)}"`;
  });
  const errors = [], root = parseTree(syntax, errors, { allowTrailingComma: true });
  if (errors.length) throw new SyntaxError(`OPENCODE_CONFIG_CONTENT 不是有效的 JSONC（位置 ${errors[0].offset}）`);
  if (root?.type !== 'object') throw new SyntaxError('OPENCODE_CONFIG_CONTENT 必须是 JSONC 对象');
  // Remove JSONC trivia for older OpenCode releases, preserving the user's string tokens and restoring unquoted templates
  // for OpenCode itself to evaluate. Re-stringifying strings would activate the user's deliberately escaped \u007b.
  const render = node => node.type === 'string' && templates.has(node.offset) ? templates.get(node.offset)
    : node.type === 'object' ? `{${node.children.map(render).join(',')}}`
    : node.type === 'array' ? `[${node.children.map(render).join(',')}]`
    : node.type === 'property' ? node.children.map(render).join(':') : text.slice(node.offset, node.offset + node.length);
  return { root, render, templates };
}

function inlineProvider(text, id, provider, env) {
  const { root, render, templates } = inlineTree(text);
  const named = (node, key) => node.children[0].value === key;
  // Like JSON parsing, the last duplicate property wins. Replace only the selected provider, leaving other providers'
  // source strings (including their intentional templates) unchanged.
  let existing = root.children.findLast(node => named(node, 'provider'))?.children[1], renderProvider = render;
  const variable = existing && /^\{env:([^}]+)\}$/.exec(templates.get(existing.offset) ?? '');
  if (variable) {
    // Only the provider object's structure is needed for the merge. Keep other templates and the user's config file/dir
    // entry points unchanged, and do not modify the original variable (it may be referenced elsewhere in the config).
    const expanded = inlineTree(env[variable[1]] || '', true);
    existing = expanded.root;
    renderProvider = expanded.render;
  }
  if (existing && existing.type !== 'object') throw new SyntaxError('OPENCODE_CONFIG_CONTENT 的 provider 必须是对象');
  const providers = (existing?.children ?? []).filter(node => !named(node, id)).map(renderProvider);
  providers.push(`${literalJSON(id)}:${literalJSON(provider)}`);
  let value = `{${providers.join(',')}}`;
  const additions = {};
  if (variable) {
    // Keep this object behind a child-only env template. OpenCode's one env pass must NOT expand templates introduced by
    // the original variable; its subsequent file pass still resolves their paths in the native session directory.
    // A fresh name also leaves every other reference to the original variable unchanged.
    const name = `CODA_OPENCODE_PROVIDER_${randomUUID().replaceAll('-', '_')}`;
    additions[name] = value;
    value = `{env:${name}}`;
  }
  return { ...additions, OPENCODE_CONFIG_CONTENT:
    `{${[...root.children.filter(node => !named(node, 'provider')).map(render), `"provider":${value}`].join(',')}}` };
}

export async function providerEnvironment(env = process.env, fetcher = fetch) {
  const service = chosenService(env);
  if (!service) return env;
  let models;
  try { models = await serviceModels(service, fetcher); }
  catch (error) { log(`模型服务 ${service.ref} 列不出模型：${error.message}`); return env; }
  if (!models.length) return env;
  // Invalid user configuration still fails clearly, without echoing config contents (which may include credentials).
  return { ...env, ...inlineProvider(env.OPENCODE_CONFIG_CONTENT || '{}',
    providerId(service.ref), serviceProvider(service, models), env) };
}
