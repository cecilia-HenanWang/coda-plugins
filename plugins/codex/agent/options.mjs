// Codex's speed is one ordinary ACP select option. The native model catalog decides which paid tiers are offered;
// their IDs travel unchanged to turn/start. `fast` is Codex's config alias for the catalog/request ID `priority`.
export const nativeServiceTier = tier => tier === 'fast' ? 'priority' : tier ?? 'default';
export function codexSpeedOption(model, tier) {
  const tiers = model?.serviceTiers ?? [];
  if (!tiers.length) return null;
  return { id: 'service-tier', name: '速度', description: '加速生成会增加用量', category: 'model_config', type: 'select',
    currentValue: nativeServiceTier(tier), options: [
      { value: 'default', name: '标准', description: '标准速度与用量' },
      ...tiers.filter(t => t.id !== 'default').map(t => ({ value: t.id,
        name: t.id === 'priority' ? '加速' : t.id === 'ultrafast' ? '超高速' : t.name, description: t.description })),
    ] };
}

// Patch the locked codex-acp's session state, config options and outgoing turn together. No boolean conversion may
// discard an Ultrafast (or future) tier when opening or restoring a session. A different model starts at its own default.
// The collaboration mode (plan before changing) is not offered; its `/plan` command remains (#1069).
export function codexOptionsAsShown(source) {
  const patches = [
    ['      createCollaborationModeConfigOption(sessionState.collaborationMode),\n', '', 1],
    ['    const currentModelSupportsFast = modelSupportsFast(currentModel);\n', '', 2],
    ['      fastModeEnabled: sessionMetadata.currentServiceTier === "fast",\n      currentModelSupportsFast,',
      '      serviceTier: nativeServiceTier(sessionMetadata.currentServiceTier),', 2],
    [`      case FAST_MODE_CONFIG_ID:
        this.applyFastModeChange(sessionState, params);
        break;`, `      case "service-tier": {
        const model = this.findCurrentModel(sessionState.availableModels, sessionState.currentModelId);
        const option = codexSpeedOption(model, sessionState.serviceTier);
        if (!option?.options.some(choice => choice.value === params.value)) throw RequestError.invalidParams();
        sessionState.serviceTier = params.value;
        break;
      }`, 1],
    [`  applyFastModeChange(sessionState, params) {
    const value = params.value;
    if (typeof value === "boolean") {
      sessionState.fastModeEnabled = value;
      return;
    }
    if (value !== FAST_MODE_ON && value !== FAST_MODE_OFF) {
      throw RequestError.invalidParams();
    }
    sessionState.fastModeEnabled = value === FAST_MODE_ON;
  }
`, '', 1],
    ['  applyModelAndEffort(sessionState, model, effort) {', `  applyModelAndEffort(sessionState, model, effort) {
    if (ModelId.fromString(sessionState.currentModelId).model !== model.model) {
      sessionState.serviceTier = nativeServiceTier(model.defaultServiceTier);
    }`, 1],
    ['    sessionState.currentModelSupportsFast = modelSupportsFast(model);\n', '', 1],
    [`    if (sessionState.currentModelSupportsFast) {
      configOptions.push(createFastModeConfigOption(
        sessionState.fastModeEnabled,
        this.booleanConfigOptionsSupported
      ));
    }`, `    const speed = codexSpeedOption(currentModel, sessionState.serviceTier);
    if (speed) configOptions.push(speed);`, 1],
    [`      const serviceTier = resolveFastServiceTier(
        sessionState.fastModeEnabled,
        sessionState.currentModelSupportsFast
      );`, '      const serviceTier = sessionState.serviceTier === "default" ? null : sessionState.serviceTier;', 1],
  ];
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp config option patch no longer matches the locked adapter');
    source = source.replaceAll(before, after);
  }
  return `import { codexSpeedOption, nativeServiceTier } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
