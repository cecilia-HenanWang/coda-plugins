// OpenCode's models, as it passes them to Coda, grouped by their provider (Coda's docs/agent-protocol.md「模型的分组」): its
// own providers' (OpenCode, a key's), and each model service's chosen in Coda (providers.mjs, a provider named by the
// service's title). OpenCode names a model `<provider>/<model>` and lists a provider's together; here the provider is the
// group, by its ID and name, and the model is named alone. A service's title may have a `/` of its own: `services` names
// each service's provider by its title, which is taken off whole; any other provider's name ends at its first `/`. The
// models' IDs, which Coda sets them by, are as OpenCode gives them.
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function grouped(option, services) {
  if (option?.category !== 'model' || !Array.isArray(option.options) || option.options.some(choice => Array.isArray(choice?.options))) return option;
  const groups = [];
  for (const choice of option.options) {
    const provider = typeof choice?.value === 'string' ? choice.value.split('/')[0] : '', name = typeof choice?.name === 'string' ? choice.name : '';
    const title = Object.hasOwn(services, provider) && name.startsWith(`${services[provider]}/`) ? services[provider] : null;
    const at = title === null ? name.indexOf('/') : title.length;
    if (!provider || at <= 0) return option;
    let group = groups.find(g => g.group === provider);
    if (!group) groups.push(group = { group: provider, name: name.slice(0, at), options: [] });
    group.options.push({ ...choice, name: name.slice(at + 1) });
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
