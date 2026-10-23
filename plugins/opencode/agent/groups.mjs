// OpenCode's models, as it passes them to Coda, grouped by their provider (Coda's docs/agent-protocol.md「模型的分组」): its
// own providers' (OpenCode, a key's), and each model service's chosen in Coda (providers.mjs). OpenCode names a model
// `<provider ID>/<model>` and its ID `<provider ID>/<model ID>`; here the provider is the group, named by the service's
// title for a service's (`services`), else by its ID, which is all OpenCode says of it, and the model is named alone. The
// models' IDs, which Coda sets them by, are as OpenCode gives them.
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function grouped(option, services) {
  if (option?.category !== 'model' || !Array.isArray(option.options) || option.options.some(choice => Array.isArray(choice?.options))) return option;
  const groups = [];
  for (const choice of option.options) {
    const provider = typeof choice?.value === 'string' ? choice.value.split('/')[0] : '', name = typeof choice?.name === 'string' ? choice.name : '';
    if (!provider || provider === choice.value) return option;
    let group = groups.find(g => g.group === provider);
    if (!group) groups.push(group = { group: provider, name: Object.hasOwn(services, provider) ? services[provider] : provider, options: [] });
    group.options.push({ ...choice, name: name.startsWith(`${provider}/`) ? name.slice(provider.length + 1) : name });
  }
  return { ...option, options: groups };
}

// A message from OpenCode with its model option grouped, wherever it says its options: a session's opening, a change it
// answers, an update of its own. Anything else as it is. `services`: each chosen service's provider ID and title.
export function groupedModels(message, services = {}) {
  const options = record(message?.result) && Array.isArray(message.result.configOptions) ? 'result'
    : record(message?.params?.update) && Array.isArray(message.params.update.configOptions) ? 'update' : null;
  if (!options) return message;
  const group = list => list.map(option => grouped(option, services));
  if (options === 'result') return { ...message, result: { ...message.result, configOptions: group(message.result.configOptions) } };
  return { ...message, params: { ...message.params, update: { ...message.params.update, configOptions: group(message.params.update.configOptions) } } };
}
