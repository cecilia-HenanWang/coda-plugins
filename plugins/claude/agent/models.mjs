// Claude's settings as ACP config options. A model is named by the concrete ID it runs as, never by an alias: each row the
// SDK lists is its resolved wire ID with the context variant it selects (`[1m]`), or its own value when it resolves to
// none, and rows that come to the same ID are one model. What the row is called is kept, the ID beside it when the name
// does not say it.
export const MODES = [['default', '人工审批'], ['acceptEdits', '自动接受编辑'], ['plan', '规划'], ['dontAsk', '未预先允许则拒绝'], ['auto', '自动审批'],
  ['bypassPermissions', '跳过所有审批']].map(([id, name]) => ({ id, name }));

export function claudeModels(rows = []) {
  const models = new Map();
  for (const row of rows) {
    if (typeof row?.value !== 'string' || !row.value) continue;
    const variant = row.value.match(/\[[^\]]+\]$/)?.[0] ?? '', resolved = row.resolvedModel?.trim();
    const id = resolved ? resolved + (resolved.endsWith(variant) ? '' : variant) : row.value;
    const label = row.displayName || row.value, name = label.includes(id) ? label : `${label} (${id})`;
    const known = models.get(id);
    // The SDK's `default` row is the model it would pick: the row naming that model says what it is.
    if (!known) models.set(id, { id, name, efforts: row.supportedEffortLevels ?? [], from: row.value });
    else if (known.from === 'default') Object.assign(known, { name, from: row.value });
  }
  return [...models.values()];
}

// The model a native init reports: one of the list, keeping the context variant chosen when its base is the one reported.
export function reportedModel(models, current, model) {
  if (typeof model !== 'string' || !model) return current;
  if (current === model || current?.replace(/\[[^\]]+\]$/, '') === model) return current;
  return models.find(m => m.id === model)?.id ?? model;
}

const select = (id, name, category, currentValue, choices) => ({ id, name, category, type: 'select', currentValue,
  options: choices.map(c => ({ value: c.id, name: c.name, ...(c._meta ? { _meta: c._meta } : {}) })) });
// The models, grouped by where they come from once a model service's are among them (ACP's select groups, Coda's
// docs/agent-protocol.md「模型的分组」): Claude's own, then each service's, under its title. Claude's alone are one plain list.
function modelSelect(currentValue, models) {
  if (!models.some(model => model.service)) return select('model', '模型', 'model', currentValue, models);
  const groups = [{ group: 'claude', name: 'Claude', options: [] }];
  for (const model of models) {
    const id = model.service ?? 'claude';
    let group = groups.find(g => g.group === id);
    if (!group) groups.push(group = { group: id, name: model.group || id, options: [] });
    group.options.push({ value: model.id, name: model.name });
  }
  return { id: 'model', name: '模型', category: 'model', type: 'select', currentValue, options: groups.filter(g => g.options.length) };
}
// The effort that leaves it to the model, marked as the agent's own default (docs/agent-protocol.md): what Coda goes back to
// when the session's effort is taken off.
export const MODEL_EFFORT = 'default';
// `current`: { mode, model, effort }. An effort not chosen is null: the model's own default.
export function configOptions(models, current) {
  const efforts = models.find(m => m.id === current.model)?.efforts ?? [];
  return [select('mode', '审批模式', 'mode', current.mode, MODES), modelSelect(current.model, models),
    ...(efforts.length ? [select('effort', '推理强度', 'thought_level', efforts.includes(current.effort) ? current.effort : MODEL_EFFORT,
      [{ id: MODEL_EFFORT, name: '模型默认', _meta: { coda: { default: true } } }, ...efforts.map(id => ({ id, name: id }))])] : [])];
}
