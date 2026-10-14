// Which OpenCode CLI runs: the one its installer puts in ~/.opencode/bin, else the first `opencode` on the PATH. The
// installer adds that directory to the shell's configuration, which a backend's service PATH need not read.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function opencodeBinary(env = process.env) {
  const installed = join(homedir(), '.opencode/bin/opencode');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'opencode')).find(path => existsSync(path)) ?? null;
}
