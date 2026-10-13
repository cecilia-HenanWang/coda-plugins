import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Variables that make the Claude CLI use something other than the user's normal login.
const authOverrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

// Read only in the SDK driver, never in the product service or host journal.
export async function sdkEnvironment(env = process.env) {
  const path = env.CODA_CLAUDE_OAUTH_TOKEN_FILE;
  // Let the SDK use the user's normal login or provider configuration. A token
  // file is an explicit override, never a dependency on a maintainer's machine.
  if (path === undefined) return { ...env };
  const fail = reason => new Error(`Claude SDK setup token: ${reason}`);
  if (!isAbsolute(path)) throw fail('file path must be absolute');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600)
      throw fail('file must be a regular file owned by the current user with mode 0600');
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
    if (bytesRead > 8192 || !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token))
      throw fail('file must contain one subscription OAuth token');
    const result = { ...env };
    for (const key of authOverrides) delete result[key];
    result.CLAUDE_CODE_OAUTH_TOKEN = token;
    return result;
  } catch (error) {
    if (error.message.startsWith('Claude SDK setup token:')) throw error;
    throw fail('cannot read CODA_CLAUDE_OAUTH_TOKEN_FILE; choose a readable token file or remove this override to use your normal login');
  } finally { await file?.close(); }
}
