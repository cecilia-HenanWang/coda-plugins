// Grok 1.0.52 accepts approval flags on session/new and session/load but reports no ACP modes. It keeps those flags
// for the connection: loading an already-open session does not change them. This entry presents standard ACP modes
// and switches by loading the same native session in a new process, before the next prompt. The old process remains
// usable until the new one has loaded and restored its model/options. No machine configuration is written.
import { GrokPeer } from './peer.mjs';

export const MODES = [
  { id: 'default', name: '按运行机配置', description: '使用运行机上 Grok 的默认审批配置。' },
  { id: 'auto', name: '自动审批', description: '由 Grok 自动判断工具操作；未获自动批准的操作按 Grok 的策略处理。' },
  { id: 'always-approve', name: '全部放行', description: '跳过 Grok 的交互审批；Grok 的禁止规则与 hooks 仍然生效。' },
];
const retained = new Set(['available_commands_update', 'session_info_update']);
const fail = (message, code = -32602) => { throw { code, message }; };

export class GrokRelay {
  constructor({ binary, say, ended }) {
    this.binary = binary; this.say = say; this.ended = ended;
    this.requests = new Map(); this.questions = new Set();
    this.mode = 'default'; this.options = []; this.closed = false;
    this.peer = this.start();
  }
  start() {
    return new GrokPeer(this.binary, { message: (peer, message) => this.fromAgent(peer, message),
      ended: (peer, code) => { if (peer === this.peer && !this.closed) this.ended(code); } });
  }
  modes() { return { currentModeId: this.mode, availableModes: MODES }; }
  update(update) { this.say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.sessionId, update } }); }
  fromCoda(message) {
    // Answers and cancellation still flow while a normal prompt is running. A switch itself runs only when idle;
    // subsequent client messages wait until its replacement has either been published or discarded.
    if (this.switching) { void this.switching.then(() => this.fromCoda(message)); return; }
    if (this.closed) return;
    if (message.method === 'session/set_mode' && 'id' in message) {
      this.switching = this.setMode(message.params ?? {}).then(
        () => this.say({ jsonrpc: '2.0', id: message.id, result: {} }),
        error => this.say({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }),
      ).finally(() => { this.switching = null; });
      return;
    }
    if ('id' in message) {
      if (message.method) this.requests.set(message.id, message);
      else this.questions.delete(message.id);
    }
    this.peer.send(message);
  }
  remember(result) {
    if (Array.isArray(result?.configOptions)) this.options = result.configOptions;
    this.model = this.options.find(o => o.category === 'model')?.currentValue ?? result?.models?.currentModelId ?? this.model;
  }
  fromAgent(peer, message) {
    if (peer !== this.peer) {
      if (peer !== this.candidate) return;
      // A load replays history. Only current commands/title survive the switch; model/options are published once,
      // after restoration. A load is not a turn and cannot ask for permission or user input.
      if (message.method === 'session/update' && retained.has(message.params?.update?.sessionUpdate)) this.replayed.push(message);
      else if (message.method && 'id' in message) {
        const result = message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } }
          : message.method === 'elicitation/create' ? { action: 'cancel' } : null;
        peer.send({ jsonrpc: '2.0', id: message.id, ...(result ? { result } : { error: { code: -32601, message: '加载会话时不支持此请求' } }) });
      }
      return;
    }
    const request = !message.method && this.requests.get(message.id);
    if (request) {
      this.requests.delete(message.id);
      if (message.result) {
        if (request.method === 'initialize') { this.initialize = request.params; this.canLoad = message.result.agentCapabilities?.loadSession === true; }
        if (['session/new', 'session/load'].includes(request.method)) {
          this.open = request.params; this.sessionId = message.result.sessionId ?? request.params.sessionId;
          this.mode = request.params?._meta?.yoloMode ? 'always-approve' : request.params?._meta?.autoMode ? 'auto' : 'default';
          this.remember(message.result);
          message = { ...message, result: { ...message.result, modes: this.modes() } };
        } else if (request.method === 'session/set_config_option') this.remember(message.result);
        else if (request.method === 'session/set_model') {
          this.options = this.options.map(o => o.category === 'model' ? { ...o, currentValue: request.params.modelId } : o);
          this.model = request.params.modelId; this.remember(message.result);
        }
      }
    }
    if (message.method && 'id' in message) this.questions.add(message.id);
    if (message.method === '$/cancel_request') this.questions.delete(message.params?.requestId);
    if (message.method === 'session/update' && message.params?.sessionId === this.sessionId && message.params.update?.sessionUpdate === 'config_option_update')
      this.remember(message.params.update);
    this.say(message);
  }
  async setMode({ sessionId, modeId }) {
    if (!this.sessionId || sessionId !== this.sessionId) fail('Grok 会话不存在');
    if (!MODES.some(m => m.id === modeId)) fail('审批模式不可用');
    if (modeId === this.mode) return;
    if (this.requests.size || this.questions.size) fail('请在当前轮次结束后切换审批模式', -32600);
    if (!this.canLoad) fail('当前 Grok CLI 不支持恢复会话，无法切换审批模式', -32601);
    const peer = this.candidate = this.start(); this.replayed = [];
    try {
      await peer.request('initialize', this.initialize);
      const meta = { ...this.open._meta };
      delete meta.autoMode; delete meta.yoloMode;
      if (modeId !== 'default') { meta.autoMode = modeId === 'auto'; meta.yoloMode = modeId === 'always-approve'; }
      const params = { ...this.open, sessionId };
      if (Object.keys(meta).length) params._meta = meta; else delete params._meta;
      let loaded = await peer.request('session/load', params);
      // Loading may restore Grok's defaults. Keep the actual model and options from the preceding connection, including
      // choices Grok changed itself. Model goes first because it determines the remaining available options.
      const chosen = [...this.options].sort((a, b) => Number(b.category === 'model') - Number(a.category === 'model'));
      if (!chosen.some(o => o.category === 'model') && this.model && loaded.models?.currentModelId !== this.model) {
        await peer.request('session/set_model', { sessionId, modelId: this.model });
        loaded = { ...loaded, models: { ...loaded.models, currentModelId: this.model } };
      }
      for (const option of chosen) {
        const current = loaded.configOptions?.find(o => o.id === option.id);
        if (option.currentValue == null) continue;
        if (!current) fail(`切换审批模式后无法恢复 Grok 配置：${option.id}`);
        if (current.currentValue === option.currentValue) continue;
        const result = await peer.request('session/set_config_option', { sessionId, configId: option.id, value: option.currentValue });
        loaded = { ...loaded, ...result };
      }
      if (this.closed) fail('Grok 连接已关闭', -32603);
      const previous = this.peer;
      this.peer = peer; this.candidate = null; this.mode = modeId;
      this.remember(loaded); previous.close();
      for (const message of this.replayed) this.say(message);
      if (loaded.configOptions) this.update({ sessionUpdate: 'config_option_update', configOptions: loaded.configOptions });
      this.update({ sessionUpdate: 'current_mode_update', currentModeId: modeId });
    } catch (error) { peer.close(); throw error; }
    finally { this.candidate = null; this.replayed = []; }
  }
  close() { this.closed = true; this.peer.close(); this.candidate?.close(); }
}
