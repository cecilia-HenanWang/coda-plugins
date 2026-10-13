// What the checker copies from Coda, in one place. Coda is the authority: its「读取来源」(PluginSources.readSource) reads a
// plugin with the same rules, and wins where the two differ. Each rule names where it came from in the Coda repository at
// CODA_COMMIT; a Coda PR that changes one of them changes this file too (docs/agent-protocol.md here is synced from the same
// commit, and test/protocol-copy.test.mjs keeps the two together).
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// The Coda commit these rules were copied from (coda-console/coda main, PR #1148).
export const CODA_COMMIT = '2ba612048c7acec63969c3ac91264ed437cb320f';
// The ACP version Coda speaks: the SDK's (backend/package.json pins @agentclientprotocol/sdk 1.4.0, as package.json here).
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ---- ACP (backend/src/adapters/acp.mjs) ----
// `initialize` as Coda sends it (AcpSession.initialize): no clientInfo, these capabilities.
export const clientCapabilities = () => ({
  elicitation: { form: {}, url: {} },
  session: { compaction: {}, configOptions: { boolean: {} } },
  _meta: { coda: { waits: {} } },
});
// The agent refuses until it is signed in: ACP's auth_required (signedOut).
export const SIGNED_OUT = -32000;
// What Coda answers an agent request it has no handler for (the SDK's): Coda handles only approvals and forms.
export const METHOD_NOT_FOUND = -32601;
// What an agent may say of a wait of its own (validWait, verbatim); anything else Coda drops unread.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const WAIT_STATES = new Set(['waiting', 'handling', 'done', 'failed', 'cancelled']);
const fits = (value, limit) => value === undefined || (typeof value === 'string' && value.length <= limit);
export const validWait = p => record(p) && typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length <= 200
  && typeof p.waitId === 'string' && p.waitId.length > 0 && p.waitId.length <= 200 && WAIT_STATES.has(p.state)
  && fits(p.kind, 50) && fits(p.title, 500) && fits(p.detail, 4000) && fits(p.childSessionId, 200) && fits(p.model, 200) && fits(p.outputFile, 4096)
  && fits(p.toolCallId, 200)
  && [p.stoppable, p.recurring].every(flag => flag === undefined || typeof flag === 'boolean')
  && (p.at === undefined || (typeof p.at === 'string' && Number.isFinite(Date.parse(p.at))));
// The model a session runs with, as Coda reads it (catalog().current.model): every turn Coda configures first, and refuses
// a session whose agent names none (configure: 「适配器未报告实际模型」).
export function currentModel(session) {
  const model = session?.configOptions?.find?.(x => x?.category === 'model');
  return model?.currentValue ?? session?.models?.currentModelId;
}
// docs/agent-protocol.md「规则」3: a turn the user stops ends within this, or Coda closes the agent's process group.
export const CANCEL_LIMIT = 30_000;
// application/service.mjs and option-cache.mjs: opening a session (initialize, session/new or session/load) may take this.
export const OPEN_LIMIT = 60_000;

// ---- How Coda starts an agent (backend/src/domain/agents.mjs launch, adapters/session-host.mjs) ----
// `sh -c` in its own process group, standard error unread, the session's environment plus these.
export const agentEnv = ({ pluginDir, stateDir }) => ({ CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir, CODA_PLUGIN_STATE: stateDir });

// ---- Manifests (backend/src/domain/plugins.mjs, agent-plugins.mjs, panels.mjs, plugin-extensions.mjs) ----
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const PANEL_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const POINT = /^[a-z][a-z0-9-]{0,39}$/;
export const SETTING_KEY = /^[a-z][a-z0-9-]*(\.[a-z][A-Za-z0-9]*)+$/;
export const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;
export const CONTRIBUTES = ['configuration', 'capabilities', 'instructions', 'panels', 'agents', 'extensionPoints', 'extensions', 'groups'];
export const INSTRUCTIONS_LIMIT = 200;
export const ICON_LIMIT = 32 * 1024;
export const AGENT_LIMITS = { displayName: 40, modeTitle: 10, modeUnset: 20, modeNote: 100, modeId: 200, setupHint: 200, command: 4000, configFiles: 16, path: 1000 };
export const PANEL_LIMITS = { title: 40, command: 4000, confirm: 200, note: 200 };

// ---- From a repository (backend/src/domain/plugin-sources.mjs) ----
export const SIZE_LIMIT = 10 * 1024 * 1024;
export const SEGMENT = /^[A-Za-z0-9._-]+$/;
export const DEPTH = 2;
export const NPM = ['dependencies', 'optionalDependencies'];
// The plugins Coda ships (backend/src/resources/plugins/): one from a repository may not take their names.
export const BUILTIN_PLUGINS = ['approve-command', 'claude', 'cliproxy', 'codex', 'codex-accounts', 'develop', 'grok', 'host', 'human-check',
  'kimi', 'machine-stats', 'maintenance', 'opencode', 'review', 'secrets', 'testbed'];
// The agents they declare, by plugin, and `claude`, the agent ID sessions from before #1069 still store (docs/plugins.md「Agent」).
export const BUILTIN_AGENTS = { 'claude-sdk': 'claude', codex: 'codex', grok: 'grok', kimi: 'kimi', opencode: 'opencode', claude: 'claude' };

// ---- Panels (backend/src/domain/panels.mjs, application/panels.mjs) ----
export const ITEM_TYPES = ['card', 'meter', 'stat', 'markdown', 'button', 'error'];
export const OUTPUT_LIMIT = 64 * 1024;
export const ARGS_LIMIT = 4 * 1024;
export const ITEM_LIMITS = { items: 50, cardItems: 20, label: 80, markdown: 4000, error: 500, confirm: 200 };
// A reading is stopped past this (docs/plugins.md「面板」).
export const PANEL_READ_LIMIT = 30_000;
