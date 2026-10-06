// Runs in Chrome's isolated extension world. The web page cannot access the reference map.
(() => {
  const version = '0.7.0-purpose-3-draft-1';
  if (globalThis.__agentgateReader?.version === version) return;
  globalThis.__agentgateReader?.dispose?.();
  let references = new Map(), capturedAt = 0, captureId;
  let revision = 0;
  // Accessible names describe fields without reading their existing values.
  // Resolve referenced labels through the same editable-text exclusion as blocks.
  const labelledBy = node => (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).map(id => {
    const target = document.getElementById(id); return target ? renderedText(target) : '';
  }).filter(Boolean).join(' ');
  const label = node => (node.labels?.[0] && renderedText(node.labels[0]) || node.getAttribute('aria-label') || labelledBy(node) || (node.isContentEditable ? '' : renderedText(node)) || node.getAttribute('placeholder') || node.getAttribute('name') || '').trim().slice(0, 200);
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const allowedField = node => (['INPUT', 'TEXTAREA'].includes(node.tagName) || node.isContentEditable && node.getAttribute('role') === 'textbox') && !['password', 'hidden', 'file', 'submit', 'button', 'checkbox', 'radio'].includes(node.type) && !/(?:password|one-time-code|username|cc-|webauthn)/i.test(node.autocomplete || '') && !/(?:password|passcode|\botp\b|security code|\bpin\b)/i.test(label(node));
  const fingerprint = node => JSON.stringify([node.tagName, node.type, node.id, node.name, node.getAttribute('href'), node.getAttribute('target'), node.getAttribute('role'), node.isContentEditable, node.readOnly, node.autocomplete, label(node)]);
  const context = (node, complete = false) => {
    // Purpose reads cannot authorize a prefix of an oversized heading. Other
    // planner snapshots retain their existing bounded display excerpt.
    const bounded = text => complete && text.length > 180 ? '' : text.slice(0, 180);
    const container = node.closest('article,section,fieldset,tr,[role="region"],[role="dialog"],[role="alertdialog"]');
    // Carry nearby section headings into descendants, including ordinary div-based
    // account panels. Redacting a number does not make a forbidden balance releasable.
    for (let child = node, parent = node.parentElement; parent && parent !== document.body; child = parent, parent = parent.parentElement) {
      for (let previous = child.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.matches('h1,h2,h3,legend,[role="heading"]') && visible(previous)) return bounded(previous.innerText.trim());
      }
      if (parent.matches('main,[role="main"]')) break;
    }
    return bounded((container?.getAttribute('aria-label') || container && labelledBy(container) || container?.querySelector('h1,h2,h3,legend,th')?.innerText || '').trim());
  };
  // Read rendered text in semantic groups. Nested spans, links and decorative controls
  // must not make an entire message disappear. Existing editable values stay private.
  const privateNode = 'input,textarea,[contenteditable]:not([contenteditable="false"]),script,style,noscript,button,[role="button"],[role="checkbox"],[role="switch"],[data-agentgate-ui]';
  const mailPreviewKind = node => {
    if(node.tagName!=='SPAN'||!node.closest('tr[role="row"]'))return null;
    const subject=node.classList.contains('bog'),snippet=node.classList.contains('y2');
    return subject!==snippet?(subject?'inbox_subject':'inbox_snippet'):null;
  };
  const mailSender = node => {
    const row=node.closest('tr[role="row"]');if(!row)return null;
    // The preview's text/descendants cannot supply their own author. Accept only
    // a single separate top-level mail-header widget, like the inbox adapter.
    const headers=[...row.querySelectorAll(':scope > td > span.yP')].filter(n=>visible(n)&&!n.closest('[contenteditable]:not([contenteditable="false"])')&&!node.contains(n));
    if(headers.length!==1)return null;
    const label=headers[0].innerText.trim(),address=headers[0].getAttribute('email')||'';
    if(!label||label.length>100||address.length>100)return null;
    return {label,address};
  };
  const renderedText = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pieces = []; let length = 0, node, previousFlow;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement, excluded = parent?.closest(privateNode);
      if (!parent || !visible(parent) || excluded && (excluded !== root || root.matches('input,textarea,[contenteditable]:not([contenteditable="false"]),script,style,noscript'))) continue;
      const text = node.textContent.replace(/\s+/g, ' '); if (!text.trim()) { if (pieces.length) pieces.push(' '); continue; }
      let flow = parent;
      while (flow !== root && ['inline', 'inline-block', 'contents'].includes(getComputedStyle(flow).display)) flow = flow.parentElement;
      // Preserve adjacent inline text (e.g. a highlighted part of an email address)
      // so the deterministic redactor sees the same identifier the user sees.
      if (previousFlow && previousFlow !== flow) pieces.push(' ');
      pieces.push(text); previousFlow = flow; length += text.length + 1; if (length > 2000) return '';
    }
    return pieces.join('').replace(/\s+/g, ' ').trim();
  };
  const observer = new MutationObserver(changes => {
    const main = document.querySelector('[role="main"],main');
    if (changes.some(change => !main || main.contains(change.target) || [...change.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('[role="main"],main') || n.querySelector?.('[role="main"],main'))))) revision++;
  });
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-busy', 'aria-label', 'class', 'style']});
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    try {
      if (message.type === 'snapshot_current') {
        const ids = message.ids;
        const current = Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && new Set(ids).size === ids.length && ids.every(id => {
          const ref = references.get(id), node = ref?.node;
          return node?.isConnected && visible(node) && !node.disabled && (ref.role!=='dom_text'||AgentGateXPath.selectElements(document,ref.selector)[ref.match_offset]===node) && ref.fingerprint === (ref.role === 'dom_text' ? JSON.stringify([renderedText(node), context(node,true), AgentGateXPath.elementPath(node), location.href,mailSender(node),mailPreviewKind(node)]) : ref.role === 'text' ? JSON.stringify([renderedText(node), context(node)]) : JSON.stringify([fingerprint(node), context(node)]));
        });
        respond({revision, version, capture_id: captureId, current}); return false;
      }
      if (message.type === 'dom_snapshot') {
        if (!Array.isArray(message.origins) || !message.origins.includes(location.origin) || !Number.isInteger(message.offset) || message.offset < 0 || message.offset > 100 || !Number.isInteger(message.limit) || message.limit < 1 || message.limit > 4) throw new Error();
        const nodes = AgentGateXPath.selectElements(document, message.xpath).slice(message.offset, message.offset + message.limit);
        references = new Map(); capturedAt = performance.now(); captureId = crypto.randomUUID();
        const blocks = [], paths = {};
        for (const node of nodes) {
          if (!node.isConnected || !visible(node) || node.closest('input,textarea,[contenteditable]:not([contenteditable="false"]),script,style,noscript,[data-agentgate-ui]')) continue;
          const text = renderedText(node), path = AgentGateXPath.elementPath(node), nearby = context(node,true);
          if (!text || !path) continue;
          const ref = crypto.randomUUID().replaceAll('-', '');
          const sender=mailSender(node),source_kind=mailPreviewKind(node);
          references.set(ref, {node, role: 'dom_text',selector:message.xpath,match_offset:message.offset+nodes.indexOf(node), fingerprint: JSON.stringify([text, nearby, path, location.href,sender,source_kind])});
          blocks.push({ref, text, context: nearby,source_kind,...(sender?{sender}: {})}); paths[ref] = path;
        }
        respond({origin: location.origin, controls: [], blocks, paths, revision, version, capture_id: captureId}); return false;
      }
      if (message.type === 'collect' || message.type === 'snapshot') {
        references = new Map(); capturedAt = performance.now(); captureId = crypto.randomUUID();
        const controls = [];
        const gmail = location.hostname === 'mail.google.com';
        const selector = 'input,textarea,button,a[href],[role="button"],[role="link"],[role="row"],[role="textbox"][contenteditable="true"]' + (gmail ? ',tr.zA' : '');
        const main = document.querySelector('[role="main"],main');
        // Dense message lists previously exhausted all 72 slots before sidebar
        // Compose or floating editor controls outside main could be considered.
        // Reserve the bounded capture for fields and dialog/navigation affordances
        // first. Ordering is discovery only; no candidate is thereby authorized.
        const priority = node => {
          const dialog = node.closest('[role="dialog"],[role="alertdialog"]');
          if (allowedField(node)) return dialog ? 0 : 1;
          if (dialog) return 2;
          if (node.closest('[role="row"],tr' + (gmail ? ',.zA' : ''))) return 4;
          return 3;
        };
        const candidates = [...document.querySelectorAll(selector)].filter(node => visible(node) && !node.disabled && !node.readOnly).sort((a, b) => priority(a) - priority(b));
        for (const node of candidates) {
          if (controls.length >= 72) break;
          if (!visible(node) || node.disabled || node.readOnly || (!allowedField(node) && !['BUTTON', 'A'].includes(node.tagName) && !['button', 'link', 'row'].includes(node.getAttribute('role')) && !(gmail && node.matches('tr.zA')))) continue;
          const name = label(node); if (!name || /(?:password|passcode|\botp\b|sign in|log in)/i.test(name)) continue;
          const ref = crypto.randomUUID().replaceAll('-', ''), role = allowedField(node) ? 'field' : node.tagName === 'A' ? 'link' : 'button';
          references.set(ref, {node, fingerprint: JSON.stringify([fingerprint(node), context(node)]), role}); controls.push({ref, role, label: name, ...(message.type === 'snapshot' ? {context: context(node), submit: Boolean(node.form && node.type === 'submit')} : {})});
        }
        const selection = window.getSelection(); let selectedText = '';
        if (selection?.rangeCount === 1 && !selection.isCollapsed) {
          const range = selection.getRangeAt(0);
          const editable = [range.startContainer, range.endContainer].some(n => (n.nodeType === 1 ? n : n.parentElement)?.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'));
          if (!editable && range.getClientRects().length) selectedText = selection.toString().slice(0, 12000);
        }
        if (message.type === 'snapshot') {
          const blocks = [], covered = [], texts = new Set(); let total = 0;
          const blockSelector = 'h1,h2,h3,p,li,dt,dd,td,th,[role="status"],[role="heading"],[role="listitem"],div,span';
          const semantic = 'tr,[role="row"],[role="listitem"],article' + (gmail ? ',.zA,.a3s' : '');
          const nodes = [...new Set([...(main?.querySelectorAll(semantic) || []), ...(main?.querySelectorAll(blockSelector) || []), ...document.querySelectorAll(semantic), ...document.querySelectorAll(blockSelector)])];
          for (const node of nodes) {
            if (blocks.length >= 96 || total >= 30000) break;
            if (!visible(node) || covered.some(parent => parent.contains(node)) || node.closest('input,textarea,[contenteditable]:not([contenteditable="false"]),script,style,noscript,[data-agentgate-ui]')) continue;
            const grouped = node.matches(semantic);
            if (!grouped && (node.closest('button,[role="button"],[role="checkbox"],[role="switch"]') || ['DIV', 'SPAN'].includes(node.tagName) && node.children.length)) continue;
            // Table header/select rows carry no message content.
            if (grouped && node.querySelector('th,[role="columnheader"]')) continue;
            const text = renderedText(node); if (!text || texts.has(text)) continue;
            total += text.length; texts.add(text); covered.push(node);
            const ref = crypto.randomUUID().replaceAll('-', ''), nearby = context(node);
            references.set(ref, {node, role: 'text', fingerprint: JSON.stringify([text, nearby])});
            blocks.push({ref, text, context: nearby});
          }
          respond({origin: location.origin, controls, blocks, revision, version, capture_id: captureId, loading: Boolean(main && [main, ...main.querySelectorAll('[aria-busy="true"]')].some(n => n.matches('[aria-busy="true"]') && visible(n))), login_required: [...document.querySelectorAll('input[type="password"]')].some(visible)});
        } else respond({origin: location.origin, text: selectedText, controls});
        return false;
      }
      if (message.type === 'execute') {
        const {action, origins} = message, reference = references.get(action.ref), node = reference?.node;
        if (!origins.includes(location.origin) || !node || !['field', 'button', 'link'].includes(reference.role) || !node.isConnected || !visible(node) || node.disabled || performance.now() - capturedAt > 600000 || JSON.stringify([fingerprint(node), context(node)]) !== reference.fingerprint) { respond({ok: false, code: 'STALE_VIEW'}); return false; }
        if (action.type === 'fill' && reference.role === 'field' && allowedField(node) && typeof action.value === 'string' && action.value.length <= 2000) {
          if (node.isContentEditable) node.textContent = action.value;
          else { const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, action.value); }
          node.dispatchEvent(new Event('input', {bubbles: true})); node.dispatchEvent(new Event('change', {bubbles: true}));
          const matches = (node.isContentEditable ? node.textContent : node.value) === action.value;
          respond({ok: matches, code: matches ? 'DISPATCHED' : 'BRIDGE_ERROR'}); return false;
        }
        if (action.type === 'click' && reference.role !== 'field') {
          for (const field of message.staged_fields || []) {
            const staged = references.get(field.ref);
            if (!staged || staged.role !== 'field' || !staged.node.isConnected || JSON.stringify([fingerprint(staged.node), context(staged.node)]) !== staged.fingerprint || (staged.node.isContentEditable ? staged.node.textContent : staged.node.value) !== field.value) { respond({ok: false, code: 'STALE_VIEW'}); return false; }
          }
          if (node.tagName === 'A') { const u = new URL(node.href); if (!origins.includes(u.origin) || u.username || u.password || (node.target && node.target !== '_self') || !['https:', 'http:'].includes(u.protocol)) { respond({ok: false, code: 'OUT_OF_SCOPE'}); return false; } }
          respond({ok: true, code: 'DISPATCHED'}); node.click(); return false;
        }
        respond({ok: false, code: 'OUT_OF_SCOPE'});
      }
    } catch { respond({ok: false, code: 'BRIDGE_ERROR'}); }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__agentgateReader = {version, dispose() { observer.disconnect(); chrome.runtime.onMessage.removeListener(listener); references.clear(); }};
})();
