// Coda's session instructions (docs/agent-protocol.md「会话指令」) reach Codex as the thread's developer instructions, given on
// `thread/start` and `thread/resume`. codex-acp reads `session/new` and `session/load` through ACP's schema, which drops
// `systemPrompt`: the entry checks it and hands its text over in the request's `_meta` under INSTRUCTIONS (waits.mjs), which
// the schema keeps, and the patched adapter passes that on. They are appended to the developer instructions Codex's own
// configuration gives as seen from the session's directory (`config/read`), which the thread's would otherwise replace;
// without them Codex is told nothing. A collaboration mode codex-acp sets carries instructions of its own mode
// (`developer_instructions: null` is the mode's built-in ones), beside the thread's, not in place of them.
export const INSTRUCTIONS = 'coda/sessionInstructions';

// ACP's `systemPrompt`: its text, '' when there is none; throws on anything but text appended to the agent's own.
export function sessionInstructions(systemPrompt) {
  if (systemPrompt === undefined || systemPrompt === null) return '';
  if (systemPrompt.mode !== 'append') throw new Error('会话指令只支持 append 模式');
  const { content } = systemPrompt;
  if (!Array.isArray(content) || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new Error('会话指令只接受文本块');
  return content.map(block => block.text).join('\n\n');
}

// Coda's instructions for the session this process runs (Coda runs one a process), as it last opened it; codex-acp's own resume
// of its thread as the session moves to another model provider (providers.mjs, `carriedInstructions`) carries them on.
let opened, carrying = false;
export async function carriedInstructions(work) {
  carrying = true;
  try { return await work(); } finally { carrying = false; }
}
// The thread's developer instructions for a session request: its own configuration's, then Coda's.
export async function codaDeveloperInstructions(codexClient, request) {
  if (!carrying) opened = request._meta?.[INSTRUCTIONS];
  const ours = opened;
  if (!ours) return void 0;
  const own = (await codexClient.configRead({ cwd: request.cwd, includeLayers: false }))?.config?.developer_instructions;
  return own ? `${own}\n\n${ours}` : ours;
}

const given = ',\n      developerInstructions: await codaDeveloperInstructions(this.codexClient, request)';
const patches = [
  // newSession
  [`      modelProvider: this.getModelProvider(),
      cwd: request.cwd
    });`, before => before.replace('\n    });', `${given}\n    });`), 1],
  // loadSession and resumeSession
  [`      modelProvider: await this.getResumeModelProvider(),
      threadId: request.sessionId
    });`, before => before.replace('\n    });', `${given}\n    });`), 2],
];
// Fails loudly once the locked adapter changes.
export function instructedCodexThreads(source) {
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp session instructions patch no longer matches the locked adapter');
    source = source.replaceAll(before, after(before));
  }
  return `import { codaDeveloperInstructions } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
