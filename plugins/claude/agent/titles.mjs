// SDK headless sessions do not automatically generate the CLI's topic title.
// Use the same native generator as the ACP adapter, without blocking the event
// pump or asking the main conversation to produce extra output.
export class SessionTitle {
  context = ''; settled = false; pending = null; last = null;
  constructor({ sdk, query, cwd, sessionId, publish, alive, onError = () => {} }) {
    Object.assign(this, { sdk, query, cwd, sessionId, publish, alive, onError });
  }
  append(text) { if (!this.settled) this.context = (this.context + text).slice(-1000); }
  refresh(generate = false) {
    // Serialize reads/generation; a result arriving during the initial read
    // must still get its chance to generate a title.
    this.pending = (this.pending ?? Promise.resolve()).then(() => this.update(generate))
      .catch(error => this.onError(error)).catch(() => {});
    return this.pending;
  }
  async update(generate) {
    if (!this.alive()) return;
    const info = await this.sdk.getSessionInfo(this.sessionId, { dir: this.cwd });
    let title = info?.customTitle;
    if (!title && generate && !this.settled && this.context.trim().length >= 10 &&
        typeof this.query.generateSessionTitle === 'function') {
      title = await this.query.generateSessionTitle(this.context.trim(), { persist: false });
      if (!this.alive()) return;
      // A /rename completed while generation was in flight takes precedence.
      const current = await this.sdk.getSessionInfo(this.sessionId, { dir: this.cwd });
      if (current?.customTitle) title = current.customTitle;
      else if (typeof title === 'string' && title.trim())
        await this.sdk.renameSession(this.sessionId, title, { dir: this.cwd });
    }
    if (!this.alive() || typeof title !== 'string' || !title.trim()) return;
    title = title.replace(/\s+/g, ' ').trim();
    this.settled = true; this.context = '';
    if (title !== this.last) { await this.publish(title); this.last = title; }
  }
}
