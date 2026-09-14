/**
 * The in-page probe, as source text.
 *
 * It is a string rather than a function because it is injected with
 * `addInitScript` and must be completely self-contained — it cannot close over
 * anything in this module. Both the recorder and any future in-page consumer
 * install the same probe, so they agree on what "role", "accessible name" and
 * "the overlay that is open" mean.
 *
 * Installs `window.__ubProbe` with:
 *   describe(el) -> RecordedElement   (see src/recording-types.ts)
 *   overlay()    -> OverlayState
 *   scrollOf(el) -> RecordedScroll | null
 */
export const DOM_PROBE_SOURCE = String.raw`
(() => {
  if (window.__ubProbe) return;

  const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const attrEsc = (s) => String(s).replace(/(["\\])/g, '\\$1');
  const cssEsc = (s) =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/(["\\])/g, '\\$1');

  const uniqueFor = (sel, el) => {
    try {
      const found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (e) {
      return false;
    }
  };

  // React, Radix and MUI mint a fresh id per render; those are useless as selectors.
  const stableId = (id) =>
    !!id &&
    !/^[0-9]/.test(id) &&
    !/^(:|\u00ab)/.test(id) &&
    !/^(radix-|headlessui-|mui-|react-aria-|rc_|downshift-|chakra-)/i.test(id) &&
    !/[0-9a-f]{8,}/i.test(id) &&
    !/::/.test(id);

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const roleOf = (el) => {
    const explicit = clean(el.getAttribute && el.getAttribute('role'));
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const type = clean(el.getAttribute && el.getAttribute('type')).toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button':
      case 'summary': return 'button';
      case 'select': return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'input':
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') return 'button';
        if (type === 'hidden') return 'none';
        return 'textbox';
      default: return 'generic';
    }
  };

  const accName = (el) => {
    const aria = clean(el.getAttribute && el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy.split(/\s+/)
        .map((id) => { const n = document.getElementById(id); return n ? clean(n.textContent) : ''; })
        .filter(Boolean).join(' ');
      if (txt) return txt.slice(0, 80);
    }

    if (el.id && stableId(el.id)) {
      const lab = document.querySelector('label[for="' + cssEsc(el.id) + '"]');
      if (lab) { const t = clean(lab.textContent); if (t) return t.slice(0, 80); }
    }
    const wrapping = el.closest && el.closest('label');
    if (wrapping) { const t = clean(wrapping.textContent); if (t) return t.slice(0, 80); }

    const alt = clean(el.getAttribute && el.getAttribute('alt'));
    if (alt) return alt;
    const title = clean(el.getAttribute && el.getAttribute('title'));
    if (title) return title;

    // A <select>'s textContent is its option list, not a name for it.
    if (el.tagName && el.tagName.toLowerCase() !== 'select') {
      const text = clean(el.textContent);
      if (text) return text.slice(0, 80);
    }
    const ph = clean(el.getAttribute && el.getAttribute('placeholder'));
    if (ph) return ph;
    const nm = clean(el.getAttribute && el.getAttribute('name'));
    if (nm) return nm;
    return '';
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute('data-testid');
    const role = roleOf(el);
    const name = accName(el);
    const inputType = tag === 'input' ? clean(el.getAttribute('type') || 'text').toLowerCase() : null;
    const r = el.getBoundingClientRect();

    const candidates = [];
    const push = (selector, strategy) => {
      if (candidates.some((c) => c.selector === selector)) return;
      if (uniqueFor(selector, el)) candidates.push({ selector: selector, strategy: strategy });
    };

    if (testid) push('[data-testid="' + attrEsc(testid) + '"]', 'testid');
    if (el.id && stableId(el.id)) push('#' + cssEsc(el.id), 'id');
    const nameAttr = el.getAttribute('name');
    if (nameAttr) push(tag + '[name="' + attrEsc(nameAttr) + '"]', 'name');
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) push(tag + '[aria-label="' + attrEsc(ariaLabel) + '"]', 'aria-label');
    const href = el.getAttribute('href');
    if (href && href.indexOf('/') === 0) push('a[href="' + attrEsc(href) + '"]', 'href');

    const roleSelector =
      role && role !== 'generic' && role !== 'none' && name
        ? 'role=' + role + '[name="' + attrEsc(name) + '"]'
        : null;

    return {
      testid: testid || null,
      role: role,
      name: name,
      tag: tag,
      input_type: inputType,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      in_viewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
      selector_candidates: candidates,
      role_selector: roleSelector,
      role_selector_unique: null,
    };
  };

  const keyOf = (el) => {
    if (!el || el.nodeType !== 1) return 'window';
    const testid = el.getAttribute('data-testid');
    if (testid) return 'testid:' + testid;
    const role = el.getAttribute('role');
    if (role) return 'role:' + role + '/' + clean(el.getAttribute('aria-label') || el.textContent).slice(0, 30);
    if (el.id && stableId(el.id)) return 'id:' + el.id;
    return 'tag:' + el.tagName.toLowerCase();
  };

  const OVERLAY_SEL =
    '[role="dialog"], [role="alertdialog"], [data-testid*="modal" i], ' +
    '[data-testid*="sheet" i], [data-testid*="drawer" i], [data-testid*="popup" i]';

  const overlay = () => {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(OVERLAY_SEL)); } catch (e) { nodes = []; }
    const visible = nodes.filter(isVisible);
    if (!visible.length) return { open: false, key: null, selector: null };

    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    visible.sort((a, b) => area(b) - area(a));
    const top = visible[0];
    const testid = top.getAttribute('data-testid');
    return {
      open: true,
      key: keyOf(top),
      selector: testid ? '[data-testid="' + attrEsc(testid) + '"]' : null,
    };
  };

  const scrollOf = (target) => {
    const isWindow = target === document || target === window || target === document.documentElement;
    if (isWindow) {
      return {
        target_key: 'window',
        selector: null,
        top: Math.round(window.scrollY),
        left: Math.round(window.scrollX),
        scroll_height: document.documentElement.scrollHeight,
        client_height: window.innerHeight,
        is_window: true,
      };
    }
    if (!target || target.nodeType !== 1) return null;
    const testid = target.getAttribute('data-testid');
    return {
      target_key: keyOf(target),
      selector: testid ? '[data-testid="' + attrEsc(testid) + '"]' : null,
      top: Math.round(target.scrollTop),
      left: Math.round(target.scrollLeft),
      scroll_height: target.scrollHeight,
      client_height: target.clientHeight,
      is_window: false,
    };
  };

  window.__ubProbe = { describe: describe, overlay: overlay, scrollOf: scrollOf, keyOf: keyOf };
})();
`;
