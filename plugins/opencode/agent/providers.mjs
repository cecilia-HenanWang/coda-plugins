// Coda's chosen model service becomes a separate native OpenCode provider, through the child process's inline config.
// OpenCode lists, selects and resumes its models itself; the machine's own providers and config files stay as they are.
import { readFileSync } from 'node:fs';

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

export async function providerEnvironment(env = process.env, fetcher = fetch) {
  const service = chosenService(env);
  if (!service) return env;
  let models;
  try { models = await serviceModels(service, fetcher); }
  catch (error) { log(`模型服务 ${service.ref} 列不出模型：${error.message}`); return env; }
  if (!models.length) return env;
  // Do not discard an existing inline override. An invalid one still fails at startup instead of being silently lost.
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OPENCODE_CONFIG_CONTENT 必须是 JSON 对象');
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config,
    provider: { ...config.provider, [providerId(service.ref)]: serviceProvider(service, models) } }) };
}
