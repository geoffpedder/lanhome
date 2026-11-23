// LAN Home front end: renders config.yml like Mafl, plus an in-page editor.
const $ = (sel, root = document) => root.querySelector(sel);
const page = $('#page');

const state = {
  config: null,     // last saved config object, as read from the server
  version: null,    // file version, used to detect edits made elsewhere
  groups: [],       // [{ name, items }] currently shown (draft while editing)
  editing: false,
  dirty: false,
  password: sessionStorage.getItem('lanhome-pw') || '',
  passwordRequired: false,
};

// ---------- small utilities ----------
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

let toastTimer;
function toast(msg, isErr = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const ICON_SVG = {
  up: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>',
};
function svgButton(kind, title, onclick) {
  const b = el('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, onclick });
  b.innerHTML = ICON_SVG[kind];
  return b;
}

// ---------- config <-> groups ----------
function groupsFromConfig(cfg) {
  const s = cfg?.services;
  if (!s) return [];
  if (Array.isArray(s)) return [{ name: 'Services', items: clone(s) }];
  return Object.entries(s).map(([name, items]) => ({ name, items: clone(items || []) }));
}

function gridSettings(cfg) {
  const g = (cfg?.layout && typeof cfg.layout === 'object' && cfg.layout.grid) || cfg?.grid || {};
  return { small: g.small ?? 2, medium: g.medium ?? 2, large: g.large ?? 3, xlarge: g.xlarge ?? 4 };
}

function buildConfig() {
  const cfg = clone(state.config) || {};
  const services = {};
  for (const g of state.groups) services[g.name] = g.items;
  cfg.services = services;
  return cfg;
}

// ---------- icons ----------
const svgCache = new Map();
function loadSvg(name) {
  if (!svgCache.has(name)) {
    const [prefix, icon] = name.split(':');
    svgCache.set(name, fetch(`/icon/${encodeURIComponent(prefix)}/${encodeURIComponent(icon)}.svg`)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null));
  }
  return svgCache.get(name);
}

function normIcon(icon) {
  if (!icon) return null;
  if (typeof icon === 'string') return icon.includes('://') ? { url: icon } : { name: icon };
  return icon;
}

function iconNode(rawIcon) {
  const icon = normIcon(rawIcon);
  const box = el('div', { class: 'icon-box' });
  if (!icon) return null;
  if (icon.wrap) box.classList.add('wrapped');
  if (icon.color) box.style.color = icon.color;
  if (icon.url) {
    box.append(el('img', { src: icon.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
  } else if (icon.name && icon.name.includes(':')) {
    box.classList.add('loading');
    loadSvg(icon.name).then((svg) => {
      box.classList.remove('loading');
      if (svg) box.innerHTML = svg; // served by our own server, sanitized there
    });
  }
  return el('div', { class: 'icon-outer' }, el('div', { class: 'icon-size' }, box));
}

// ---------- rendering ----------
function cardNode(item, gi, ii) {
  const icon = iconNode(item.icon);
  const text = el('div', { class: 'text' },
    el('h3', { text: item.title || '(untitled)' }),
    item.description ? el('p', { text: String(item.description).trim() }) : null);
  const a = el('a', { class: 'card', href: item.link || '#', target: '_blank', rel: 'noopener' }, icon, text);
  if (state.editing) {
    a.removeAttribute('target');
    a.draggable = true;
    a.dataset.g = gi;
    a.dataset.i = ii;
    a.addEventListener('click', (e) => { e.preventDefault(); openItemDialog(gi, ii); });
    a.append(el('button', {
      type: 'button', class: 'card-del', title: 'Delete', 'aria-label': `Delete ${item.title || 'link'}`, text: '×',
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        if (confirm(`Delete "${item.title || 'this link'}"?`)) { state.groups[gi].items.splice(ii, 1); markDirty(); render(); }
      },
    }));
    wireDrag(a);
  }
  return a;
}

function render() {
  const cfg = state.config || {};
  const grid = state.editing && state.settingsDraft ? state.settingsDraft.grid : gridSettings(cfg);
  const title = (state.editing && state.settingsDraft ? state.settingsDraft.title : cfg.title) || 'Home';
  document.title = title;
  page.style.setProperty('--cols-sm', grid.small);
  page.style.setProperty('--cols-md', grid.medium);
  page.style.setProperty('--cols-lg', grid.large);
  page.style.setProperty('--cols-xl', grid.xlarge);

  page.replaceChildren();
  if (!state.groups.length) {
    page.append(el('div', { class: 'empty-state', text: state.editing ? 'No groups yet. Use "+ Group" to add one.' : 'Nothing here yet. Click the pencil in the corner to add links.' }));
  }
  state.groups.forEach((g, gi) => {
    const gridEl = el('div', { class: 'grid' }, g.items.map((it, ii) => cardNode(it, gi, ii)));
    if (state.editing) {
      const add = el('button', { type: 'button', class: 'add-card', onclick: () => openItemDialog(gi, null) }, '+ Add link');
      add.dataset.g = gi;
      wireDropEnd(add);
      gridEl.append(add);
    }
    const head = el('div', { class: 'group-head' },
      el('h2', { text: g.name }),
      el('input', {
        class: 'group-name', value: g.name, 'aria-label': 'Group name',
        onchange: (e) => renameGroup(gi, e.target),
      }),
      el('div', { class: 'group-tools' },
        svgButton('up', 'Move group up', () => moveGroup(gi, -1)),
        svgButton('down', 'Move group down', () => moveGroup(gi, 1)),
        svgButton('trash', 'Delete group', () => deleteGroup(gi))));
    page.append(el('section', { class: 'group' }, head, gridEl));
  });
}

// ---------- group operations ----------
function renameGroup(gi, input) {
  const name = input.value.trim();
  if (!name) { input.value = state.groups[gi].name; return; }
  if (state.groups.some((g, i) => i !== gi && g.name === name)) {
    toast(`There is already a group called "${name}".`, true);
    input.value = state.groups[gi].name;
    return;
  }
  state.groups[gi].name = name;
  markDirty();
}
function moveGroup(gi, delta) {
  const to = gi + delta;
  if (to < 0 || to >= state.groups.length) return;
  const [g] = state.groups.splice(gi, 1);
  state.groups.splice(to, 0, g);
  markDirty(); render();
}
function deleteGroup(gi) {
  const g = state.groups[gi];
  const msg = g.items.length ? `Delete the group "${g.name}" and its ${g.items.length} link(s)?` : `Delete the empty group "${g.name}"?`;
  if (!confirm(msg)) return;
  state.groups.splice(gi, 1);
  markDirty(); render();
}
function addGroup() {
  let n = 1, name = 'New group';
  while (state.groups.some((g) => g.name === name)) name = `New group ${++n}`;
  state.groups.push({ name, items: [] });
  markDirty(); render();
  const inputs = page.querySelectorAll('.group-name');
  const last = inputs[inputs.length - 1];
  last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  last?.select();
}

// ---------- drag and drop ----------
let drag = null;
function clearDropMarks() {
  page.querySelectorAll('.drop-before, .drop-target').forEach((n) => n.classList.remove('drop-before', 'drop-target'));
}
function moveItem(fromG, fromI, toG, toI) {
  const [item] = state.groups[fromG].items.splice(fromI, 1);
  if (fromG === toG && fromI < toI) toI -= 1;
  state.groups[toG].items.splice(toI, 0, item);
  markDirty(); render();
}
function wireDrag(card) {
  card.addEventListener('dragstart', (e) => {
    drag = { g: +card.dataset.g, i: +card.dataset.i };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${drag.g}:${drag.i}`);
  });
  card.addEventListener('dragend', () => { card.classList.remove('dragging'); clearDropMarks(); drag = null; });
  card.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    clearDropMarks();
    card.classList.add('drop-before');
  });
  card.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    moveItem(drag.g, drag.i, +card.dataset.g, +card.dataset.i);
  });
}
function wireDropEnd(addBtn) {
  addBtn.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    clearDropMarks();
    addBtn.classList.add('drop-target');
  });
  addBtn.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const g = +addBtn.dataset.g;
    moveItem(drag.g, drag.i, g, state.groups[g].items.length);
  });
}

// ---------- edit mode ----------
function markDirty() {
  state.dirty = true;
  $('#dirty').hidden = false;
}

async function ensurePassword() {
  if (!state.passwordRequired) return true;
  for (;;) {
    if (state.password) {
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'X-Edit-Password': state.password } });
      if (r.ok) { sessionStorage.setItem('lanhome-pw', state.password); return true; }
      sessionStorage.removeItem('lanhome-pw');
    }
    const pw = prompt(state.password ? 'Wrong password. Editing password:' : 'Editing password:');
    if (pw == null) return false;
    state.password = pw;
  }
}

async function enterEdit() {
  if (!(await ensurePassword())) return;
  state.editing = true;
  state.dirty = false;
  state.settingsDraft = { title: state.config.title || '', grid: gridSettings(state.config) };
  document.body.classList.add('editing');
  $('#toolbar').hidden = false;
  $('#dirty').hidden = true;
  render();
}

function exitEdit() {
  state.editing = false;
  state.dirty = false;
  state.settingsDraft = null;
  document.body.classList.remove('editing');
  $('#toolbar').hidden = true;
  state.groups = groupsFromConfig(state.config);
  render();
}

function applySettingsTo(cfg) {
  const s = state.settingsDraft;
  if (!s) return cfg;
  cfg.title = s.title;
  const g = { small: +s.grid.small, medium: +s.grid.medium, large: +s.grid.large, xlarge: +s.grid.xlarge };
  if (cfg.layout && typeof cfg.layout === 'object' && cfg.layout.grid) cfg.layout.grid = g;
  else cfg.grid = g;
  return cfg;
}

async function save() {
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    const cfg = applySettingsTo(buildConfig());
    const r = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Password': state.password },
      body: JSON.stringify({ config: cfg, version: state.version }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || `Save failed (${r.status})`, true, 7000); return; }
    state.config = cfg;
    state.version = j.version;
    exitEdit();
    toast('Saved');
  } catch (e) {
    toast(`Save failed: ${e.message}`, true, 7000);
  } finally {
    btn.disabled = false;
  }
}

// ---------- item dialog ----------
const dlgItem = $('#dlg-item');
const fItem = $('#form-item');
let editTarget = null; // { gi, ii } — ii null means new

function readItemForm(base) {
  const f = fItem.elements;
  const item = clone(base) || {};
  item.title = f.title.value.trim();
  const desc = f.description.value.trim();
  if (desc) item.description = desc; else delete item.description;
  const link = f.link.value.trim();
  if (link) item.link = link; else delete item.link;

  const type = f.iconType.value;
  if (type === 'none') {
    delete item.icon;
  } else {
    const icon = typeof base?.icon === 'object' && base.icon ? clone(base.icon) : {};
    if (type === 'url') { icon.url = f.iconUrl.value.trim(); delete icon.name; }
    else { icon.name = f.iconName.value.trim(); delete icon.url; }
    icon.wrap = f.wrap.checked;
    const color = f.color.value.trim();
    if (color) icon.color = color; else delete icon.color;
    item.icon = icon;
  }
  return item;
}

function updatePreview() {
  const base = editTarget && editTarget.ii != null ? state.groups[editTarget.gi].items[editTarget.ii] : {};
  const item = readItemForm(base);
  const icon = iconNode(item.icon);
  const card = el('div', { class: 'card' }, icon, el('div', { class: 'text' },
    el('h3', { text: item.title || 'Title' }), el('p', { text: item.description || 'Description' })));
  $('#item-preview').replaceChildren(card);
}

function setIconType(type) {
  $('#icon-name-row').hidden = type !== 'name';
  $('#icon-url-row').hidden = type !== 'url';
  $('#icon-style-row').hidden = type === 'none';
}

function openItemDialog(gi, ii) {
  editTarget = { gi, ii };
  const isNew = ii == null;
  const item = isNew ? { icon: { wrap: true, color: '#35c5f4' } } : state.groups[gi].items[ii];
  const icon = normIcon(item.icon);
  const f = fItem.elements;
  $('#item-dlg-title').textContent = isNew ? 'Add link' : 'Edit link';
  f.title.value = item.title || '';
  f.description.value = (item.description || '').trim();
  f.link.value = (item.link || '').trim();
  f.group.replaceChildren(...state.groups.map((g, i) => el('option', { value: i, text: g.name, selected: i === gi })));
  const type = !icon ? 'none' : icon.url ? 'url' : 'name';
  f.iconType.value = type;
  f.iconName.value = icon?.name || '';
  f.iconUrl.value = icon?.url || '';
  f.color.value = icon?.color || '';
  f.colorPick.value = /^#[0-9a-f]{6}$/i.test(icon?.color || '') ? icon.color : '#ffffff';
  f.wrap.checked = icon ? !!icon.wrap : true;
  $('#icon-search').value = '';
  $('#icon-results').replaceChildren();
  setIconType(type);
  $('#btn-item-delete').hidden = isNew;
  $('#btn-item-dup').hidden = isNew;
  updatePreview();
  dlgItem.showModal();
  f.title.focus();
}

fItem.addEventListener('input', (e) => {
  const f = fItem.elements;
  if (e.target === f.colorPick) f.color.value = f.colorPick.value;
  if (e.target === f.color && /^#[0-9a-f]{6}$/i.test(f.color.value.trim())) f.colorPick.value = f.color.value.trim();
  if (e.target.name === 'iconType') setIconType(f.iconType.value);
  updatePreview();
});

fItem.addEventListener('submit', (e) => {
  e.preventDefault();
  const { gi, ii } = editTarget;
  const f = fItem.elements;
  if (!f.title.value.trim()) { f.title.focus(); return; }
  const base = ii != null ? state.groups[gi].items[ii] : null;
  const item = readItemForm(base);
  const toG = +f.group.value;
  if (ii == null) {
    state.groups[toG].items.push(item);
  } else if (toG === gi) {
    state.groups[gi].items[ii] = item;
  } else {
    state.groups[gi].items.splice(ii, 1);
    state.groups[toG].items.push(item);
  }
  dlgItem.close();
  markDirty(); render();
});

$('#btn-item-cancel').addEventListener('click', () => dlgItem.close());
$('#btn-item-delete').addEventListener('click', () => {
  const { gi, ii } = editTarget;
  if (!confirm(`Delete "${state.groups[gi].items[ii].title || 'this link'}"?`)) return;
  state.groups[gi].items.splice(ii, 1);
  dlgItem.close();
  markDirty(); render();
});
$('#btn-item-dup').addEventListener('click', () => {
  const { gi, ii } = editTarget;
  const copy = readItemForm(state.groups[gi].items[ii]);
  copy.title = `${copy.title} (copy)`;
  state.groups[gi].items.splice(ii + 1, 0, copy);
  markDirty(); render();
  dlgItem.close();
  openItemDialog(gi, ii + 1);
});

// icon search
async function searchIcons() {
  const q = $('#icon-search').value.trim();
  const box = $('#icon-results');
  if (!q) { box.replaceChildren(); return; }
  box.replaceChildren(el('div', { class: 'msg', text: 'Searching…' }));
  try {
    const r = await fetch(`/api/icon-search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.icons?.length) { box.replaceChildren(el('div', { class: 'msg', text: j.error || 'No icons found.' })); return; }
    box.replaceChildren(...j.icons.map((name) => {
      const b = el('button', { type: 'button', title: name, 'aria-label': name });
      b.style.color = fItem.elements.color.value.trim() || '#fff';
      loadSvg(name).then((svg) => { if (svg) b.innerHTML = svg; });
      b.addEventListener('click', () => {
        fItem.elements.iconName.value = name;
        box.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
        b.classList.add('selected');
        updatePreview();
      });
      return b;
    }));
  } catch {
    box.replaceChildren(el('div', { class: 'msg', text: 'Icon search failed.' }));
  }
}
$('#btn-icon-search').addEventListener('click', searchIcons);
$('#icon-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchIcons(); } });

// ---------- settings dialog ----------
const dlgSettings = $('#dlg-settings');
$('#btn-settings').addEventListener('click', () => {
  const f = $('#form-settings').elements;
  const s = state.settingsDraft;
  f.title.value = s.title;
  for (const k of ['small', 'medium', 'large', 'xlarge']) f[k].value = s.grid[k];
  dlgSettings.showModal();
});
$('#btn-settings-cancel').addEventListener('click', () => dlgSettings.close());
$('#form-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const clamp = (v, d) => Math.min(8, Math.max(1, parseInt(v, 10) || d));
  state.settingsDraft = {
    title: f.title.value.trim(),
    grid: { small: clamp(f.small.value, 2), medium: clamp(f.medium.value, 2), large: clamp(f.large.value, 3), xlarge: clamp(f.xlarge.value, 4) },
  };
  dlgSettings.close();
  markDirty(); render();
});

// ---------- raw YAML dialog ----------
const dlgRaw = $('#dlg-raw');
let rawVersion = null;
async function openRaw(prefill) {
  if (!state.editing && !(await ensurePassword())) return;
  $('#raw-error').hidden = true;
  if (prefill != null) {
    $('#raw-text').value = prefill;
    rawVersion = state.version;
  } else {
    const r = await fetch('/api/raw');
    const j = await r.json();
    $('#raw-text').value = j.raw;
    rawVersion = j.version;
  }
  dlgRaw.showModal();
}
$('#btn-raw').addEventListener('click', () => {
  if (state.dirty && !confirm('You have unsaved changes in the visual editor. Editing the YAML will discard them. Continue?')) return;
  openRaw();
});
$('#btn-raw-cancel').addEventListener('click', () => dlgRaw.close());
$('#form-raw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/raw', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Edit-Password': state.password },
    body: JSON.stringify({ raw: $('#raw-text').value, version: rawVersion }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    $('#raw-error').textContent = j.error || `Save failed (${r.status})`;
    $('#raw-error').hidden = false;
    return;
  }
  dlgRaw.close();
  await load();
  if (state.editing) exitEdit();
  toast('YAML saved');
});

// ---------- toolbar wiring ----------
$('#btn-edit').addEventListener('click', enterEdit);
$('#btn-save').addEventListener('click', save);
$('#btn-add-group').addEventListener('click', addGroup);
$('#btn-cancel').addEventListener('click', () => {
  if (state.dirty && !confirm('Discard your unsaved changes?')) return;
  exitEdit();
});
window.addEventListener('beforeunload', (e) => {
  if (state.editing && state.dirty) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', (e) => {
  if (state.editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

// ---------- load ----------
async function load() {
  const r = await fetch('/api/config');
  const j = await r.json();
  state.passwordRequired = !!j.passwordRequired;
  state.version = j.version;
  if (j.error) {
    state.config = { services: {} };
    state.groups = [];
    page.replaceChildren(el('div', { class: 'empty-state' },
      el('p', { text: j.error }),
      el('button', { type: 'button', class: 'btn', text: 'Fix it in the YAML editor', onclick: () => openRaw(j.raw) })));
    return;
  }
  state.config = j.config;
  state.groups = groupsFromConfig(j.config);
  render();
}

load().catch((e) => {
  page.replaceChildren(el('div', { class: 'empty-state', text: `Could not load the page: ${e.message}` }));
});
