// Codex's config options as Coda shows them (docs/agent-protocol.md「ACP 部分」): fast mode in the words Coda's users have
// always seen, in both its switch and its choice form; the collaboration mode (plan before changing) not offered, its
// `/plan` command still there (#1069). Fails loudly once the adapter changes.
const name = 'name: "Fast mode",', description = 'var FAST_MODE_DESCRIPTION = "1.5x speed, increased usage";';
const collaboration = '      createCollaborationModeConfigOption(sessionState.collaborationMode),\n';
export function codexOptionsAsShown(source) {
  if (source.split(description).length !== 2 || source.split(name).length !== 3 || source.split(collaboration).length !== 2)
    throw new Error('codex-acp config option patch no longer matches the locked adapter');
  return source.replace(description, 'var FAST_MODE_DESCRIPTION = "加速生成，会增加用量";').replaceAll(name, 'name: "加速",').replace(collaboration, '');
}
