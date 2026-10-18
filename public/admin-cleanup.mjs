const $ = id => document.getElementById(id);
export class AccountCleanup {
  constructor(api, refreshed) {
    this.api = api; this.refreshed = refreshed;
    $('cancelDeletion').addEventListener('click', () => $('deleteAccountDialog').close());
    $('deleteConfirmation').addEventListener('input', () => this.update());
    $('deleteAccountForm').addEventListener('submit', event => {event.preventDefault(); this.remove();});
    $('reviewDeletion').addEventListener('click', () => this.open(this.id));
    $('deleteAccountDialog').addEventListener('cancel', event => {if (this.busy) event.preventDefault();});
  }
  update() { $('confirmDeletion').disabled = this.busy || !this.preview || $('deleteConfirmation').value !== 'DELETE'; }
  async open(id) {
    if (this.busy) return;
    this.id = id; this.preview = null;
    $('deleteAccountName').textContent = 'Loading account…'; $('deleteAccountId').textContent = id;
    $('deletionCounts').replaceChildren(); $('deleteConfirmation').value = '';
    $('deletionStatus').textContent = ''; $('reviewDeletion').hidden = true; this.update();
    if (!$('deleteAccountDialog').open) $('deleteAccountDialog').showModal();
    try {
      const {preview} = await this.api('admin/accounts/' + id + '/deletion');
      if (!$('deleteAccountDialog').open || this.id !== id) return;
      this.preview = preview; $('deleteAccountName').textContent = preview.name;
      const counts = preview.counts;
      for (const text of [counts.local_browsers + ' local browsers (' + counts.online_browsers + ' online)',
        counts.assistants + ' connected assistants', counts.stored_tasks + (counts.bounded ? '+' : '') + ' saved tasks (' + counts.active_tasks + ' open)']) {
        const item = document.createElement('li'); item.textContent = text; $('deletionCounts').append(item);
      }
      if (preview.deleting) $('deletionStatus').textContent = 'Deletion has started. Confirm to finish cleanup.';
      this.update();
    } catch (error) { $('deletionStatus').textContent = error.message; $('reviewDeletion').hidden = false; }
  }
  async remove() {
    if (this.busy || !this.preview || $('deleteConfirmation').value !== 'DELETE') return;
    this.busy = true; this.update(); $('cancelDeletion').disabled = true;
    $('deletionStatus').textContent = 'Deleting account…';
    try {
      const result = await this.api('admin/accounts/' + this.id + '/delete', {confirmation: this.id, fingerprint: this.preview.fingerprint});
      $('deleteAccountDialog').close();
      $('cleanupStatus').textContent = 'Account deleted.' + (result.cleanup_pending ? ' Remaining cloud connections are being cleaned up.' : '');
      await this.refreshed();
      $('accountCount').focus();
    } catch (error) {
      $('deletionStatus').textContent = error.message;
      if (error.code === 'ACCOUNT_CHANGED') {this.preview = null; $('reviewDeletion').hidden = false;}
    } finally {this.busy = false; $('cancelDeletion').disabled = false; this.update();}
  }
}
