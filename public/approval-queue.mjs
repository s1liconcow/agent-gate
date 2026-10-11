// Presentation only. The app retains the signed challenge and approval callback.
export class ApprovalQueue {
  constructor({section, list, heading, count, empty, navigation, position, previous, next, shortcut, label, now = Date.now}) {
    Object.assign(this, {section, list, heading, count, empty, navigation, position, previous, next, shortcut, label, now});
    this.cards = new Map(); this.order = []; this.rows = []; this.selected = ''; this.pressing = new Set();
    previous.addEventListener('click', () => this.step(-1)); next.addEventListener('click', () => this.step(1));
    shortcut.addEventListener('click', event => { event.preventDefault(); this.review(); });
    const release = key => {
      this.pressing.delete(key);
      setTimeout(() => { if (!this.pressing.size && this.deferred) { this.deferred = false; this.present(this.rows); } }, 0);
    };
    // Commit incoming changes after the held click/key event has finished.
    document.addEventListener('pointerdown', event => { if (section.contains(event.target)) this.pressing.add('pointer:' + event.pointerId); }, true);
    document.addEventListener('pointerup', event => release('pointer:' + event.pointerId), true);
    document.addEventListener('pointercancel', event => release('pointer:' + event.pointerId), true);
    document.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && section.contains(event.target)) this.pressing.add('key:' + event.key); }, true);
    document.addEventListener('keyup', event => release('key:' + event.key), true);
    window.addEventListener('blur', () => { this.pressing.clear(); release('blur'); });
    window.addEventListener('resize', () => this.size());
    this.timer = setInterval(() => this.present(this.rows), 1000);
  }
  prepare(row) {
    const card = row.node, review = document.createElement('div'), actions = document.createElement('div');
    card.classList.add('pending-approval'); card.dataset.approvalKey = row.key;
    review.className = 'approval-review'; review.tabIndex = 0; review.setAttribute('role', 'region'); review.setAttribute('aria-label', 'Complete approval details');
    actions.className = 'actions approval-actions';
    for (const node of [...card.childNodes]) {
      if (node.nodeType === 1 && node.classList.contains('actions')) actions.append(...node.childNodes);
      else if (node.nodeName === 'BUTTON') actions.append(node);
      else review.append(node);
    }
    let expiry = review.querySelector('.phase span:last-child');
    if (!expiry) {
      const phase = document.createElement('div'), label = document.createElement('span'); phase.className = 'phase'; label.textContent = 'Needs permission';
      expiry = document.createElement('span'); phase.append(label, expiry); review.prepend(phase);
    }
    card.replaceChildren(review, actions);
    return {...row, review, actions, expiry};
  }
  present(rows) {
    this.rows = rows;
    const pending = rows.filter(row => row.expiresAt > this.now()), byKey = new Map(pending.map(row => [row.key, row]));
    const focused = document.activeElement, hadFocus = this.list.contains(focused), oldSelected = this.selected;
    // Stale or expired controls stop immediately, including during a held gesture.
    for (const [key, row] of this.cards) {
      if (!byKey.has(key)) for (const button of row.node.querySelectorAll('button')) button.disabled = true;
      else if (byKey.get(key).revision !== row.revision) for (const button of row.actions.querySelectorAll('button')) button.disabled = true;
    }
    if (hadFocus && (focused.disabled || focused !== document.activeElement)) this.lostFocus = focused;
    if (this.pressing.size) { this.deferred = true; return; }
    for (const key of this.cards.keys()) if (!byKey.has(key)) this.cards.delete(key);
    for (const row of pending) {
      const previous = this.cards.get(row.key);
      if (!previous) this.cards.set(row.key, this.prepare(row));
      else if (previous.revision !== row.revision) {
        previous.updated = row;
        if (row.key === this.selected) this.changed(previous);
        else this.cards.set(row.key, this.prepare(row));
      }
    }
    this.order = [...this.order.filter(key => byKey.has(key)), ...pending.filter(row => !this.order.includes(row.key)).sort((a, b) => a.expiresAt - b.expiresAt || a.key.localeCompare(b.key)).map(row => row.key)];
    if (!this.order.includes(this.selected)) this.selected = this.order[0] || '';
    const nodes = this.order.map(key => this.cards.get(key).node);
    for (const node of [...this.list.children]) if (!nodes.includes(node)) node.remove();
    for (const node of nodes) if (node.parentElement !== this.list) this.list.append(node);
    for (const key of this.order) {
      const row = this.cards.get(key); row.node.hidden = key !== this.selected;
      row.expiry.textContent = Math.max(0, Math.ceil((row.expiresAt - this.now()) / 1000)) + 's left';
    }
    if (this.count.textContent !== String(this.order.length)) this.count.textContent = this.order.length;
    if (this.label.textContent !== this.order.length + ' pending') this.label.textContent = this.order.length + ' pending';
    this.shortcut.hidden = !this.order.length; this.empty.hidden = Boolean(this.order.length); this.navigation.hidden = this.order.length < 2;
    const position = (this.order.indexOf(this.selected) + 1) + ' of ' + this.order.length;
    if (this.position.textContent !== position) this.position.textContent = position;
    if (hadFocus && (!focused.isConnected || focused.disabled || oldSelected !== this.selected) || this.lostFocus && (focused === document.body || focused === this.lostFocus) || this.navigation.hidden && this.navigation.contains(focused)) this.heading.focus({preventScroll: true});
    this.lostFocus = null;
    const node = this.cards.get(this.selected)?.node;
    if (this.sized !== node || node && Math.abs(node.getBoundingClientRect().top + window.scrollY - this.sizedTop) > .5) this.size();
  }
  changed(row) {
    for (const button of row.actions.querySelectorAll('button')) button.disabled = true;
    if (row.warning) return;
    const warning = document.createElement('div'), text = document.createElement('p'), button = document.createElement('button');
    warning.className = 'approval-changed'; text.textContent = 'This approval changed. Review the updated request before confirming.';
    button.type = 'button'; button.className = 'secondary'; button.textContent = 'Review updated approval';
    button.addEventListener('click', () => {
      const updated = this.cards.get(row.key)?.updated; if (!updated) return;
      this.cards.set(row.key, this.prepare(updated)); row.node.remove(); this.deferred = true;
      setTimeout(() => { if (!this.pressing.size) { this.deferred = false; this.present(this.rows); this.heading.focus({preventScroll: true}); } }, 0);
    });
    warning.append(text, button); row.review.prepend(warning); row.warning = warning;
  }
  show(key) {
    this.selected = key;
    for (const [id, row] of this.cards) row.node.hidden = id !== this.selected;
    this.position.textContent = (this.order.indexOf(this.selected) + 1) + ' of ' + this.order.length;
    this.size(true);
  }
  step(direction) {
    if (this.order.length > 1) this.show(this.order[(this.order.indexOf(this.selected) + direction + this.order.length) % this.order.length]);
  }
  selectNode(id) {
    const row = [...this.cards.values()].find(row => row.node.id === id);
    if (!row) return false;
    this.show(row.key); return true;
  }
  review() { if (!this.order.length) return; this.section.scrollIntoView({block: 'start'}); this.heading.focus({preventScroll: true}); this.size(); }
  size(explicitSelection = false) {
    if (this.pressing.size && !explicitSelection) { this.sized = null; return; }
    const row = this.cards.get(this.selected); if (!row) return;
    const top = Math.max(20, row.node.getBoundingClientRect().top), footer = row.actions.getBoundingClientRect().height;
    row.review.style.maxHeight = Math.max(100, Math.min(560, window.innerHeight - top - footer - 64)) + 'px';
    const focused = document.activeElement;
    if (focused !== row.review && row.review.contains(focused)) {
      const area = row.review.getBoundingClientRect(), field = focused.getBoundingClientRect();
      if (field.bottom > area.bottom - 4) row.review.scrollTop += field.bottom - area.bottom + 4;
      else if (field.top < area.top + 4) row.review.scrollTop -= area.top - field.top + 4;
    }
    this.sized = row.node;
    this.sizedTop = row.node.getBoundingClientRect().top + window.scrollY;
  }
}
