// The model service chosen in Coda (`claude.modelProvider`, Coda's docs/plugins.md「模型服务」): another plugin's service that
// speaks Anthropic Messages, from CODA_MODEL_PROVIDERS. The models its address lists (`<地址>/models`) join Claude's own, each
// named by the service and the model; a session on one runs Claude Code with the service as its API (`serviceEnv`), set for
// that session's process only.
import { readFileSync } from 'node:fs';

export const SETTING = 'claude.modelProvider';
const log = text => process.stderr.write(`[claude-agent] ${text}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const LIST_TIMEOUT = 8000;

// The chosen service: its address, title and key (read from the file Coda keeps it in). Null when none is chosen, or the
// one chosen is not on this machine or speaks another API.
export function chosenService(env = process.env) {
  const ref = parse(env.CODA_PLUGIN_SETTINGS)[SETTING];
  if (!ref) return null;
  const provided = parse(env.CODA_MODEL_PROVIDERS)[ref];
  if (!provided?.url) { log(`模型服务 ${ref} 在这台机器上没有`); return null; }
  if (provided.api !== 'anthropic-messages') { log(`模型服务 ${ref} 讲 ${provided.api}，Claude 只接 anthropic-messages 的`); return null; }
  let key;
  try { key = provided.keyFile ? readFileSync(provided.keyFile, 'utf8').trim() || undefined : undefined; }
  catch (e) { log(`读不到模型服务 ${ref} 的 Key：${e.message}`); }
  return { ref, title: provided.title || ref, url: provided.url, key };
}

// The models the service lists, asked as an Anthropic client asks (Coda's「检查可用模型」): `<服务>/<模型>`, named by the
// model and the service. They have no effort to choose.
export async function serviceModels({ ref, title, url, key }, fetcher = fetch) {
  const at = `${url.replace(/\/+$/, '')}/models?limit=1000`;
  const response = await fetcher(at, { headers: key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {}, signal: AbortSignal.timeout(LIST_TIMEOUT) });
  if (!response.ok) throw new Error(`${at} 回答 ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.data) ? body.data : []).filter(model => typeof model?.id === 'string' && model.id)
    .map(model => ({ id: `${ref}/${model.id}`, name: `${model.id} (${title})`, efforts: [], model: model.id }));
}

// What Claude Code runs a service's model with, as flag settings' `env` (above the machine's and the project's settings):
// the service as its API, a token of the service's own (`none` without one, so that the machine's Claude login is not
// sent there), and the model for every role, subagents' and background work's included.
export function serviceEnv({ url, key }, model) {
  return { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key ?? 'none', ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model };
}

// The service's models, listed with Claude's own: none when it cannot list them now.
export async function listedModels(service) {
  if (!service) return [];
  try { return await serviceModels(service); }
  catch (e) { log(`模型服务 ${service.ref} 列不出模型：${e.message}`); return []; }
}
