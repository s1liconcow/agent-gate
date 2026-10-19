import {digest} from './protocol.mjs';

// This authority is independent of the engagement mode and language model.
// Requests contain identifiers only; values live briefly in the dispatch caller.
export class SecretFillGate {
  constructor({vault, open, now = Date.now}) { Object.assign(this, {vault, open, now}); this.pending = new Map(); }
  clear() { this.pending.clear(); }
  invalidate() {
    for (const item of this.pending.values()) { delete item.decision; delete item.revision; item.meta.label = 'Unlock to review the requested secret'; }
  }
  prune(sessions) {
    for (const [id, item] of this.pending) if (!sessions.some(session => session.id === item.packet.session_id && session.status === 'executing' && session.last_command?.id === id)) this.pending.delete(id);
  }
  requests() {
    for (const [id, item] of this.pending) if (item.meta.expires_at <= this.now()) this.pending.delete(id);
    return [...this.pending.values()].filter(item => item.decision === undefined).map(item => ({...item.meta}));
  }
  decide(id, allow) {
    const item = this.pending.get(id);
    if (!item || item.meta.expires_at <= this.now() || typeof allow !== 'boolean' || item.decision !== undefined) throw new Error('This secret request expired or was already answered.');
    if (allow && (!this.vault.unlocked || item.revision === undefined || item.revision !== this.vault.revision)) throw new Error('Unlock the vault and review the current secret request.');
    item.decision = allow; return item.packet;
  }
  async authorize(packet, target, origin) {
    const {command, session_id} = packet;
    if (command.deadline <= this.now() || packet.scope.execution_browser !== 'local' || !packet.scope.permissions.includes('fill_secret') || !packet.scope.origins.includes(origin) || !origin.startsWith('https://') || target?.role !== 'secret') throw new Error('Secret request is outside its approved scope.');
    const key = await digest(packet), previous = this.pending.get(command.id);
    if (previous && previous.key !== key) throw new Error('Secret approval request changed.');
    if (previous?.decision === false) { this.pending.delete(command.id); return {denied: true}; }
    const metadataRevision = this.vault.revision;
    const entry = this.vault.unlocked ? (await this.vault.list()).find(item => item.id === command.action.secret_id) : null;
    if (metadataRevision !== this.vault.revision) throw new Error('The secret vault changed during authorization.');
    if (this.vault.unlocked && (!entry || entry.kind !== target.secret_kind || !entry.origins.includes(origin))) throw new Error('No matching secret is available for this field and website.');
    if (entry && (entry.approval === 'auto' || previous?.decision === true && previous.revision === this.vault.revision)) {
      const revision = this.vault.revision;
      const value = await this.vault.resolve({id: entry.id, origin, kind: target.secret_kind});
      if (!this.vault.unlocked || revision !== this.vault.revision) throw new Error('The secret vault changed before filling.');
      this.pending.delete(command.id); return {value, revision};
    }
    const meta = {command_id: command.id, session_id, label: entry?.label || 'Unlock to choose the requested secret', secret_id: command.action.secret_id, origin, kind: target.secret_kind, goal: packet.scope.goal, expires_at: command.deadline};
    if (!previous) {
      this.pending.set(command.id, {key, packet, meta, revision: entry ? this.vault.revision : undefined}); await this.open();
    } else { previous.meta = meta; previous.revision = entry ? this.vault.revision : undefined; delete previous.decision; }
    return {pending: true};
  }
}
