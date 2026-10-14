// Which Cursor CLI runs: the one its installer links in ~/.local/bin, else the first `cursor-agent` on the PATH. A backend's
// service PATH need not have ~/.local/bin; `agent`, the other name the installer links, is too common a name to look for.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function cursorBinary(env = process.env) {
  const installed = join(homedir(), '.local/bin/cursor-agent');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'cursor-agent')).find(path => existsSync(path)) ?? null;
}
