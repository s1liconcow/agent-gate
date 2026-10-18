const $ = id => document.getElementById(id);
const date = value => new Date(value).toLocaleString();
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };

export class InvitePanel {
  constructor(api) {
    this.api = api; this.cursors = [null]; this.page = 0; this.busy = false;
    $('inviteForm').addEventListener('submit', event => {event.preventDefault(); this.create();});
    $('invitePrevious').addEventListener('click', () => {if (!this.busy && this.page) {this.page--; this.refresh();}});
    $('inviteNext').addEventListener('click', () => {if (!this.busy && this.next) {this.cursors[++this.page] = this.next; this.refresh();}});
    $('copyInvite').addEventListener('click', async () => {
      try {await navigator.clipboard.writeText($('inviteURL').value); this.message('Invite link copied.');}
      catch { $('inviteURL').focus(); $('inviteURL').select(); this.message('Select and copy the invite link.'); }
    });
  }
  message(text, error = false) { $('inviteStatus').textContent = text; $('inviteStatus').classList.toggle('error', error); }
  controls() {
    $('createInvite').disabled = this.busy;
    $('invitePrevious').disabled = this.busy || this.page === 0;
    $('inviteNext').disabled = this.busy || !this.next;
    for (const button of $('invites').querySelectorAll('button')) button.disabled = this.busy;
  }
  render(data) {
    this.next = data.next_cursor;
    $('invites').replaceChildren(...data.invites.map(item => {
      const row = el('li', undefined, 'invite-row'), identity = el('div');
      identity.append(el('strong', item.label || 'Private account invitation'), el('p', 'Created ' + date(item.created_at), 'hint'));
      const state = el('div');
      state.append(el('span', {pending: item.use_count ? 'Active' : 'Pending', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired'}[item.status], 'admin-state ' + (item.status === 'pending' ? 'waiting' : '')),
        el('p', item.use_count + ' of ' + item.max_uses + ' uses', 'hint'),
        el('p', item.status === 'redeemed' ? 'Used ' + date(item.redeemed_at) : item.status === 'revoked' ? 'Revoked ' + date(item.revoked_at) : 'Expires ' + date(item.expires_at), 'hint'));
      if (item.account_id) {const link = el('a', item.max_uses > 1 ? 'Open latest account' : 'Open account'); link.href = '/u/' + item.account_id + '/'; state.append(link);}
      row.append(identity, state);
      if (item.status === 'pending') {
        const button = el('button', 'Revoke', 'secondary'); button.type = 'button'; button.setAttribute('aria-label', 'Revoke invite ' + (item.label || item.id));
        button.addEventListener('click', () => this.revoke(item.id)); row.append(button);
      }
      return row;
    }));
    $('inviteEmpty').hidden = data.invites.length > 0;
    $('invitePageLabel').textContent = 'Page ' + (this.page + 1);
  }
  async load() { this.render(await this.api('admin/invites?limit=5' + (this.cursors[this.page] ? '&cursor=' + encodeURIComponent(this.cursors[this.page]) : ''))); }
  async refresh() {
    if (this.busy) return;
    this.busy = true; this.controls();
    try { await this.load(); this.message(''); }
    catch (error) { this.message(error.message + ' Use Refresh to try again.', true); }
    finally { this.busy = false; this.controls(); }
  }
  async create() {
    if (this.busy) return;
    this.busy = true; this.controls(); this.message('Creating invite link…');
    try {
      const result = await this.api('admin/invites', {label: $('inviteLabel').value.trim(), expires_in_days: Number($('inviteExpiry').value), max_uses: Number($('inviteUses').value)});
      this.generatedId = result.invite.id; $('inviteURL').value = result.invite_url; $('generatedInvite').hidden = false;
      $('inviteLabel').value = ''; this.page = 0; this.cursors = [null];
      this.message('Invite created. Copy this link before leaving the page.'); $('inviteURL').focus(); $('inviteURL').select();
      try { await this.load(); } catch { this.message('Invite created. Copy the link, then use Refresh to reload the list.'); }
    } catch (error) { this.message(error.message, true); }
    finally { this.busy = false; this.controls(); }
  }
  async revoke(id) {
    if (this.busy) return;
    this.busy = true; this.controls(); this.message('Revoking invite…');
    try {
      const result = await this.api('admin/invites/' + id + '/revoke', {});
      if (id === this.generatedId) { $('generatedInvite').hidden = true; $('inviteURL').value = ''; }
      this.message(result.invite.status === 'revoked' ? 'Invite revoked.' : 'Invite is already ' + result.invite.status + '.');
      try { await this.load(); } catch { this.message('Invite updated. Use Refresh to reload the list.'); }
    } catch (error) { this.message(error.message, true); }
    finally { this.busy = false; this.controls(); }
  }
}
