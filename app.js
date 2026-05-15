// Derive storage key from page filename (e.g. "yuka-morii.html" -> "yuka-morii")
const PAGE_ID = location.pathname.split('/').pop().replace('.html', '') || 'index';
const LS_OBTAINED = PAGE_ID + '_obtained';
const LS_UI = PAGE_ID + '_ui';

let obtained = {};
let filterMode = 'all';
let sortField = 'name';
let sortDir = { name: 1, date: 1 };
let searchQuery = '';

// Load obtained state (with migration from old keys)
try {
  const saved = localStorage.getItem(LS_OBTAINED);
  if (saved) {
    obtained = JSON.parse(saved);
  } else if (PAGE_ID === 'yuka-morii') {
    // Migrate from old key format
    const legacy = localStorage.getItem('yukaMoriiObtained');
    if (legacy) { obtained = JSON.parse(legacy); localStorage.setItem(LS_OBTAINED, legacy); }
  }
} catch(e) {}

// Load UI state (filter, sort)
try {
  const savedUI = localStorage.getItem(LS_UI);
  if (savedUI) {
    const ui = JSON.parse(savedUI);
    if (ui.filterMode) filterMode = ui.filterMode;
    if (ui.sortField) sortField = ui.sortField;
    if (ui.sortDir) sortDir = ui.sortDir;
  }
} catch(e) {}

function saveState() {
  try { localStorage.setItem(LS_OBTAINED, JSON.stringify(obtained)); } catch(e) {}
}

function saveUIState() {
  try { localStorage.setItem(LS_UI, JSON.stringify({ filterMode, sortField, sortDir })); } catch(e) {}
}

function toggleObtained(cardId) {
  if (obtained[cardId]) delete obtained[cardId];
  else obtained[cardId] = true;
  saveState();
  render();
}

function getFilteredSorted() {
  let list = CARDS.slice();

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.set.toLowerCase().includes(q) ||
      c.set_code.toLowerCase().includes(q)
    );
  }

  if (filterMode === 'obtained') list = list.filter(c => obtained[c.id]);
  else if (filterMode === 'missing') list = list.filter(c => !obtained[c.id]);

  const dir = sortDir[sortField];
  list.sort((a, b) => {
    if (sortField === 'name') {
      const cmp = a.name.localeCompare(b.name);
      if (cmp !== 0) return cmp * dir;
      return a.release_date.localeCompare(b.release_date);
    } else {
      const cmp = a.release_date.localeCompare(b.release_date);
      if (cmp !== 0) return cmp * dir;
      return a.name.localeCompare(b.name);
    }
  });

  return list;
}

function updateStats() {
  const total = CARDS.length;
  const obtainedCount = Object.keys(obtained).length;
  const missing = total - obtainedCount;
  const pct = total > 0 ? Math.round((obtainedCount / total) * 100) : 0;
  document.getElementById('statTotal').textContent = total + ' total';
  document.getElementById('statObtained').textContent = obtainedCount + ' obtained';
  document.getElementById('statMissing').textContent = missing + ' missing';
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = pct + '%';
}

function makeCardEl(card) {
  const isObtained = !!obtained[card.id];
  const setLabel = card.set_code ? card.set + ' (' + card.set_code + ')' : card.set;
  const div = document.createElement('div');
  div.className = 'card-item' + (isObtained ? ' obtained' : '');
  div.dataset.id = card.id;
  div.setAttribute('role', 'listitem');
  div.setAttribute('tabindex', '0');
  div.setAttribute('title', (isObtained ? '\u2713 Obtained \u2013 click to unmark' : 'Click to mark as obtained'));
  div.innerHTML = `
    <div class="card-img-wrap">
      <img src="${card.img}" alt="${card.name} \u2014 ${card.set}" loading="lazy" width="160" height="224" decoding="async">
      <div class="obtained-badge" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    </div>
    <div class="card-info">
      <div class="card-name">${card.name}</div>
      <div class="card-set">${setLabel}</div>
      <div class="card-meta"><span>#${card.number}</span><span>${card.release_year}</span></div>
    </div>`;
  div.addEventListener('click', () => toggleObtained(div.dataset.id));
  div.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleObtained(div.dataset.id); }});
  return div;
}

function render() {
  const grid = document.getElementById('cardGrid');
  const list = getFilteredSorted();
  updateStats();

  grid.innerHTML = '';

  if (list.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <h3>No cards found</h3><p style="color:var(--color-text-muted);font-size:var(--text-sm)">Try a different search or filter.</p></div>`;
    return;
  }

  if (sortField === 'date') {
    const groups = {};
    list.forEach(c => {
      const y = c.release_year;
      if (!groups[y]) groups[y] = [];
      groups[y].push(c);
    });
    const years = Object.keys(groups).sort((a, b) => sortDir.date * (a - b));
    years.forEach(year => {
      const header = document.createElement('div');
      header.className = 'year-header';
      header.innerHTML = `<h2>${year}</h2><div class="year-header-line"></div><span class="year-count">${groups[year].length} card${groups[year].length !== 1 ? 's' : ''}</span>`;
      grid.appendChild(header);
      groups[year].forEach(card => grid.appendChild(makeCardEl(card)));
    });
  } else {
    list.forEach(card => grid.appendChild(makeCardEl(card)));
  }
}

// Sync UI buttons with loaded state
function syncUI() {
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filterMode);
  });
  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === sortField);
  });
  // Arrows
  document.getElementById('arrow-name').textContent = sortDir.name === 1 ? '\u2191' : '\u2193';
  document.getElementById('arrow-date').textContent = sortDir.date === 1 ? '\u2191' : '\u2193';
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    filterMode = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveUIState();
    render();
  });
});

// Sort buttons
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.sort;
    if (sortField === field) {
      sortDir[field] *= -1;
    } else {
      sortField = field;
    }
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('arrow-name').textContent = sortDir.name === 1 ? '\u2191' : '\u2193';
    document.getElementById('arrow-date').textContent = sortDir.date === 1 ? '\u2191' : '\u2193';
    saveUIState();
    render();
  });
});

// Search
let searchTimeout;
document.getElementById('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => { searchQuery = e.target.value.trim(); render(); }, 200);
});

// Theme toggle
(function(){
  const t = document.querySelector('[data-theme-toggle]');
  const r = document.documentElement;
  let d = localStorage.getItem('yukaMoriiTheme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  r.setAttribute('data-theme', d);
  function updateIcon() {
    t.innerHTML = d === 'dark'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
  updateIcon();
  if (t) t.addEventListener('click', () => {
    d = d === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', d);
    localStorage.setItem('yukaMoriiTheme', d);
    updateIcon();
  });
})();

syncUI();
render();
