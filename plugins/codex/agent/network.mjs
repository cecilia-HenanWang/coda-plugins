// codex-acp 1.12.0 supplies its own sandbox policy on every turn, overriding CODEX_CONFIG's
// sandbox_workspace_write.network_access. Coda's automatic development mode permits networking
// inside workspace-write; filesystem escapes still use on-request and the native automatic reviewer.
// The explicit ask-for-approval mode keeps its network boundary. Fail loudly on an adapter upgrade.
const before = `  static Agent = new _AgentMode(
    "agent",
    "Approve for me",
    "Only ask for actions detected as potentially unsafe",
    "auto_review",
    "on-request",
    "auto_review",
    {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    "workspace-write"
  );`;

export function networkedCodexDevelopment(source) {
  if (source.split(before).length !== 2) throw new Error('codex-acp network policy patch no longer matches the locked adapter');
  return source.replace(before, before.replace('networkAccess: false', 'networkAccess: true'));
}
