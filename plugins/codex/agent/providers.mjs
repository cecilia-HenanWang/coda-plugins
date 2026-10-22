// The model service chosen in Coda (`codex.modelProvider`, Coda's docs/plugins.md「模型服务」): another plugin's service that
// speaks the OpenAI Responses API (Codex no longer speaks Chat Completions), from CODA_MODEL_PROVIDERS. The models its address
// lists (`<地址>/models`) join Codex's own, each named by the service and the model. Codex binds a thread to one model
// provider, so a turn on another provider's model first moves the session there the way codex-acp moves it for ACP's
// `providers/set` and `providers/disable`: its app-server starts again with the service as the provider of its OpenAI slot
// (or without it), and the session's thread is resumed on it. The machine's Codex configuration is not touched.
import { existsSync, readFileSync } from 'node:fs';
import { carriedInstructions } from './instructions.mjs';

export const SETTING = 'codex.modelProvider';
const log = text => process.stderr.write(`[codex-agent] ${text}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const LIST_TIMEOUT = 8000;

// The chosen service: its address, title and key (read from the file Coda keeps it in). Null when none is chosen, or the
// one chosen is not on this machine or speaks another API.
export function chosenService(env = process.env) {
  const ref = parse(env.CODA_PLUGIN_SETTINGS)[SETTING];
  if (!ref) return null;
  const provided = parse(env.CODA_MODEL_PROVIDERS)[ref];
  if (!provided?.url) { log(`模型服务 ${ref} 在这台机器上没有`); return null; }
  if (provided.api !== 'openai-responses') { log(`模型服务 ${ref} 讲 ${provided.api}，Codex 只接 openai-responses 的`); return null; }
  let key;
  try { key = provided.keyFile ? readFileSync(provided.keyFile, 'utf8').trim() || undefined : undefined; }
  catch (e) { log(`读不到模型服务 ${ref} 的 Key：${e.message}`); }
  return { ref, title: provided.title || ref, url: provided.url, key };
}

// The models the service lists, as Codex's model list has them (app-server `model/list`): `<服务>/<模型>`, named by the
// model and the service, with no effort or speed to choose.
export async function serviceModels({ ref, title, url, key }, fetcher = fetch) {
  const at = `${url.replace(/\/+$/, '')}/models`;
  const response = await fetcher(at, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(LIST_TIMEOUT) });
  if (!response.ok) throw new Error(`${at} 回答 ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.data) ? body.data : []).filter(model => typeof model?.id === 'string' && model.id).map(model => ({
    id: `${ref}/${model.id}`, model: model.id, displayName: `${model.id} (${title})`, description: '', hidden: false, isDefault: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], serviceTiers: [] }));
}

// One service a process (Coda runs one session a process), listed once, as its session opens.
export class ServiceModels {
  // `on`: the service's address the session runs on, null on Codex's own (where it opens), undefined when a move to one or
  // the other failed partway: codex-acp sets its gateway before the thread is resumed on it, so that is no sign of either.
  constructor(service = chosenService(), fetcher = fetch) { Object.assign(this, { service, fetcher }); this.models = []; this.on = null; }
  list() {
    return this.listed ??= (!this.service ? Promise.resolve([]) : serviceModels(this.service, this.fetcher)
      .catch(e => { log(`模型服务 ${this.service.ref} 列不出模型：${e.message}`); return []; })).then(models => (this.models = models));
  }
  served(model) { return this.models.find(m => m.id === model) ?? null; }
  // What a turn names to Codex: the service's own name for one of its models.
  wire(model) { return this.served(model)?.model ?? model; }
  // Before a turn of codex-acp's `server`: the session on the provider of its model, its thread resumed with Coda's
  // instructions as it was opened. A thread nothing was said in yet is not written down, and would not be resumed after the
  // restart: naming it, by what it is first told, writes it.
  async route(server, { sessionId, prompt }) {
    const state = server.sessions.get(sessionId);
    if (!state) return;
    const served = this.served(state.currentModelId.replace(/\[[^\]]*\]$/, '')), wanted = served ? this.service.url : null;
    if (this.on === wanted) return;
    const client = server.codexAcpClient.appServerClient;
    const { thread } = await client.threadRead({ threadId: sessionId });
    if (thread.path && !existsSync(thread.path)) await client.threadSetName({ threadId: sessionId, name: firstWords(prompt) });
    this.on = undefined;
    await carriedInstructions(() => served ? server.setProvider({ providerId: 'openai', apiType: 'openai', baseUrl: this.service.url,
      headers: this.service.key ? { Authorization: `Bearer ${this.service.key}` } : {} }) : server.disableProvider({ providerId: 'openai' }));
    this.on = wanted;
  }
  // Codex knows nothing of the service's models: that it runs one on fallback metadata, or resumes a session last on one
  // with another model (Coda sets the session's model before each turn), is no news to say in the session.
  quiet({ message } = {}) {
    const named = /^Model metadata for `(.+?)` not found|^This session was recorded with model `(.+?)` but is resuming with `(.+?)`/.exec(message ?? '');
    return !!named && named.slice(1).some(model => model && this.models.some(m => m.model === model));
  }
}
const firstWords = prompt => Array.from((prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join('') || 'Coda';

export const services = new ServiceModels();
const patches = [
  // Codex's models, then the service's.
  ['    } while (cursor);\n    return models;\n  }', '    } while (cursor);\n    return [...models, ...await codaServices.list()];\n  }', 1],
  // A turn first moves the session to the provider of its model, and names the model as that provider does.
  ['  async prompt(params, signal, onTurnStarted) {\n    if (this.providerUpdate !== null) {',
    '  async prompt(params, signal, onTurnStarted) {\n    await codaServices.route(this, params);\n    if (this.providerUpdate !== null) {', 1],
  ['      model: modelId.model,\n      serviceTier\n    }, onTurnStarted);', '      model: codaServices.wire(modelId.model),\n      serviceTier\n    }, onTurnStarted);', 1],
  ['      case "warning":\n        return this.createWarningEvent(notification.params);',
    '      case "warning":\n        if (codaServices.quiet(notification.params)) return null;\n        return this.createWarningEvent(notification.params);', 1],
];
// Fails loudly once the locked adapter changes.
export function servedCodexModels(source) {
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp model service patch no longer matches the locked adapter');
    source = source.replaceAll(before, after);
  }
  return `import { services as codaServices } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
