(() => {
  const PAGE_ID = 'collectr-missing';
  const STATE_KEY = 'collectr-missing_state';
  const COMPACT_KEY = 'collectr-missing_compact';
  const MAX_CARDS = 25000;
  const catalogStorage = window.collectrCatalogStorage;
  const root = document.body;
  const searchInput = document.getElementById('collectrSearch');
  const compactInput = document.getElementById('collectrCompact');
  const importInput = document.getElementById('collectrImport');
  const exportButton = document.getElementById('collectrExport');
  const collapseAllButton = document.getElementById('collectrCollapseAll');
  const rarityContainer = document.getElementById('collectrRarities');
  const setsContainer = document.getElementById('collectrSets');
  const emptyState = document.getElementById('collectrEmpty');
  const statusMessage = document.getElementById('collectrMessage');
  const shownLabel = document.getElementById('collectrShown');
  const statsLabel = document.getElementById('collectrStats');
  const progressBar = document.getElementById('collectrProgress');
  const progressText = document.getElementById('collectrProgressText');
  const shareButton = document.getElementById('collectrShare');
  const sharedBanner = document.getElementById('collectrSharedBanner');
  const sharedResetButton = document.getElementById('collectrSharedReset');

  const SHARE_PREFIX = '#share=';
  const SHORT_SHARE_PREFIX = '#s=';
  const SHARE_LOAD_TIMEOUT_MS = 15000;
  const sharedToken = location.hash.startsWith(SHARE_PREFIX) ? location.hash.slice(SHARE_PREFIX.length) : '';
  const sharedId = location.hash.startsWith(SHORT_SHARE_PREFIX) ? location.hash.slice(SHORT_SHARE_PREFIX.length) : '';
  const isShared = Boolean(sharedToken || sharedId);
  const sharedKey = isShared ? `collectr-missing_shared_${hashString(sharedId || sharedToken)}` : '';
  const FINDER_NAME_KEY = 'collectr-missing_finder_name';
  const MAX_FINDER_NAME = 40;
  let sharedOwnerUid = '';

  // firebase.js skips cloud load/sync for 'index', so a shared view never touches anyone's account.
  window.PAGE_ID = isShared ? 'index' : PAGE_ID;
  window.catalogRevision = 0;
  window.stateRevision = 0;

  let state = isShared ? { catalog: null, found: {} } : loadState();
  let search = '';
  let selectedRarities = new Set();
  let visibleCards = [];
  let visibleUnfoundCards = [];
  const collapsedSets = new Set();
  window.obtained = state.found;
  window.collectrCatalogUpdatedAt = state.catalog ? state.catalog.updatedAt : 0;

  function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function hashString(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeIdentityPart(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function cardId(set, number, name) {
    return [set, number, name].map(normalizeIdentityPart).join('::');
  }

  function safeImageUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function normalizeCard(input) {
    const set = normalizeText(input.set);
    const number = normalizeText(input.number);
    const name = normalizeText(input.name);
    if (!set || !number || !name) return null;
    return {
      id: cardId(set, number, name),
      set,
      number,
      name,
      rarity: normalizeText(input.rarity) || 'No rarity data',
      img: safeImageUrl(input.img)
    };
  }

  function isCatalog(value) {
    return Boolean(
      value &&
      value.version === 1 &&
      Number.isFinite(value.updatedAt) &&
      Array.isArray(value.cards) &&
      value.cards.length > 0 &&
      value.cards.length <= MAX_CARDS &&
      value.cards.every(card =>
        card &&
        typeof card.id === 'string' &&
        typeof card.set === 'string' &&
        typeof card.number === 'string' &&
        typeof card.name === 'string'
      )
    );
  }

  function cleanFound(found, cards) {
    if (!found || typeof found !== 'object' || Array.isArray(found)) return {};
    const ids = new Set(cards.map(card => card.id));
    return Object.fromEntries(Object.keys(found).filter(id => ids.has(id) && found[id]).map(id => [id, true]));
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (saved && isCatalog(saved.catalog)) {
        return { catalog: saved.catalog, found: cleanFound(saved.found, saved.catalog.cards) };
      }
    } catch (error) {
      console.warn('Could not load the saved Collectr tracker.', error);
    }
    return { catalog: null, found: {} };
  }

  function saveState() {
    try {
      if (isShared) localStorage.setItem(sharedKey, JSON.stringify(state.found));
      else localStorage.setItem(STATE_KEY, JSON.stringify(state));
      window.obtained = state.found;
      return true;
    } catch (error) {
      console.error('Could not save the Collectr tracker locally.', error);
      return false;
    }
  }

  function setMessage(message, kind = '') {
    statusMessage.textContent = message;
    statusMessage.className = 'collectr-message' + (kind ? ` ${kind}` : '');
  }

  function parseHtmlExport(text) {
    const parsed = new DOMParser().parseFromString(text, 'text/html');
    const sections = [...parsed.querySelectorAll('details.set')];
    if (!sections.length) throw new Error('No Collectr set sections were found in this HTML file.');

    const cards = [];
    for (const section of sections) {
      const set = normalizeText(section.dataset.set || section.querySelector('summary b')?.textContent);
      if (!set) continue;
      for (const tile of section.querySelectorAll('.tile')) {
        const card = normalizeCard({
          set,
          number: tile.dataset.num,
          name: tile.dataset.name || tile.querySelector('.nm')?.textContent,
          rarity: tile.querySelector('.rar')?.textContent,
          img: tile.querySelector('.art img')?.getAttribute('src')
        });
        if (card) cards.push(card);
      }
    }
    return deduplicate(cards);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let closedQuote = false;
    const source = text.replace(/^\uFEFF/, '');

    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closedQuote = true;
          }
        } else {
          field += char;
        }
      } else if (char === '"' && field === '' && !closedQuote) {
        quoted = true;
      } else if (char === ',' || char === '\n' || char === '\r') {
        row.push(field);
        field = '';
        closedQuote = false;
        if (char === ',') continue;
        if (char === '\r' && source[i + 1] === '\n') i++;
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
      } else if (closedQuote && !/\s/.test(char)) {
        throw new Error('This CSV has characters after a closing quote. Export it again and retry.');
      } else if (!closedQuote) {
        field += char;
      }
    }
    if (quoted) throw new Error('This CSV has an unclosed quoted field.');
    row.push(field);
    if (row.some(value => value.trim())) rows.push(row);
    if (rows.length < 2) throw new Error('The CSV has no card rows.');

    const headers = rows[0].map(value => value.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_'));
    const setColumn = headers.indexOf('set');
    const numberColumn = headers.indexOf('card_number');
    const nameColumn = headers.indexOf('name');
    if ([setColumn, numberColumn, nameColumn].some(index => index < 0)) {
      throw new Error('CSV needs the columns set, card_number, and name.');
    }
    return deduplicate(rows.slice(1).map(values => normalizeCard({
      set: values[setColumn],
      number: values[numberColumn],
      name: values[nameColumn]
    })).filter(Boolean));
  }

  function deduplicate(cards) {
    const seen = new Set();
    return cards.filter(card => {
      if (seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  }

  function parseImport(text, filename) {
    const extension = filename.toLocaleLowerCase().split('.').pop();
    if (extension === 'csv') return { source: 'csv', cards: parseCsv(text) };
    if (extension === 'html' || extension === 'htm') return { source: 'html', cards: parseHtmlExport(text) };
    if (/^\s*</.test(text)) return { source: 'html', cards: parseHtmlExport(text) };
    return { source: 'csv', cards: parseCsv(text) };
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function isVisible(card) {
    const queryMatch = !search || [card.set, card.number, card.name, card.rarity]
      .some(value => value.toLocaleLowerCase().includes(search));
    const rarityMatch = !selectedRarities.size || selectedRarities.has(card.rarity);
    return queryMatch && rarityMatch;
  }

  function makeCard(card) {
    const found = Boolean(state.found[card.id]);
    const article = createElement('article', 'collectr-tile' + (found ? ' is-found' : ''));
    article.dataset.id = card.id;

    const artwork = createElement('div', 'collectr-art');
    if (card.img) {
      const link = createElement('a');
      link.href = card.img;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open ${card.name} card image`);
      const image = createElement('img');
      image.src = card.img;
      image.alt = `${card.number} ${card.name}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      link.appendChild(image);
      artwork.appendChild(link);
    } else {
      artwork.appendChild(createElement('span', 'collectr-placeholder', 'No image'));
    }
    if (found) artwork.appendChild(createElement('span', 'collectr-found-badge', '✓ Found'));
    article.appendChild(artwork);

    const info = createElement('div', 'collectr-card-info');
    info.appendChild(createElement('span', 'collectr-number', card.number));
    info.appendChild(createElement('strong', 'collectr-name', card.name));
    info.appendChild(createElement('span', 'collectr-rarity', card.rarity));
    const foundButton = createElement('button', 'collectr-found-button', found ? 'Found' : 'Mark found');
    foundButton.type = 'button';
    foundButton.dataset.action = 'toggle-found';
    foundButton.setAttribute('aria-pressed', String(found));
    info.appendChild(foundButton);
    article.appendChild(info);
    return article;
  }

  function renderRarities(cards) {
    const rarities = [...new Set(cards.map(card => card.rarity))];
    rarityContainer.replaceChildren();
    if (!rarities.length) return;
    rarityContainer.appendChild(createElement('span', 'collectr-filter-label', 'Rarity'));

    for (const rarity of rarities) {
      const label = createElement('label', 'collectr-rarity-chip' + (selectedRarities.has(rarity) ? ' active' : ''));
      const input = createElement('input');
      input.type = 'checkbox';
      input.value = rarity;
      input.checked = selectedRarities.has(rarity);
      input.addEventListener('change', () => {
        if (input.checked) selectedRarities.add(rarity);
        else selectedRarities.delete(rarity);
        render();
      });
      label.append(input, document.createTextNode(rarity));
      rarityContainer.appendChild(label);
    }
    const clear = createElement('button', 'collectr-clear-filters', 'Clear rarities');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      selectedRarities.clear();
      render();
    });
    rarityContainer.appendChild(clear);
  }

  function updateCollapseAllButton() {
    const sections = [...setsContainer.querySelectorAll('.collectr-set')];
    const anyOpen = sections.some(section => section.open);
    collapseAllButton.disabled = sections.length === 0;
    collapseAllButton.textContent = anyOpen || !sections.length ? 'Collapse all' : 'Expand all';
  }

  function render() {
    const cards = state.catalog ? state.catalog.cards : [];
    emptyState.hidden = cards.length > 0;
    setsContainer.hidden = cards.length === 0;
    exportButton.disabled = cards.length === 0;
    shareButton.disabled = cards.length === 0;
    renderRarities(cards);
    setsContainer.replaceChildren();
    visibleCards = cards.filter(isVisible);
    visibleUnfoundCards = visibleCards.filter(card => !state.found[card.id]);

    const groups = new Map();
    for (const card of cards) {
      if (!groups.has(card.set)) groups.set(card.set, []);
      groups.get(card.set).push(card);
    }

    for (const [set, setCards] of groups) {
      const shownCards = setCards.filter(isVisible);
      if (!shownCards.length) continue;
      const section = createElement('details', 'collectr-set');
      section.dataset.set = set;
      section.open = !collapsedSets.has(set);
      section.addEventListener('toggle', () => {
        if (section.open) collapsedSets.delete(set);
        else collapsedSets.add(set);
        updateCollapseAllButton();
      });
      const summary = createElement('summary', 'collectr-set-summary');
      summary.appendChild(createElement('strong', '', set));
      summary.appendChild(createElement('span', 'collectr-set-count', `${shownCards.length} shown`));
      const remaining = setCards.filter(card => !state.found[card.id]).length;
      summary.appendChild(createElement('span', 'collectr-set-meta', `${remaining} left to find`));
      section.appendChild(summary);
      const grid = createElement('div', 'collectr-card-grid');
      for (const card of shownCards) grid.appendChild(makeCard(card));
      section.appendChild(grid);
      setsContainer.appendChild(section);
    }

    const foundCount = cards.filter(card => state.found[card.id]).length;
    const remaining = cards.length - foundCount;
    const setCount = groups.size;
    statsLabel.textContent = `${cards.length.toLocaleString()} cards across ${setCount} sets · ${foundCount.toLocaleString()} found · ${remaining.toLocaleString()} left to find`;
    const percent = cards.length ? Math.round((foundCount / cards.length) * 100) : 0;
    progressBar.style.width = `${percent}%`;
    progressBar.parentElement.setAttribute('aria-valuenow', String(percent));
    progressText.textContent = `${percent}%`;
    shownLabel.textContent = cards.length
      ? `${visibleUnfoundCards.length.toLocaleString()} missing shown`
      : '';
    if (cards.length && visibleCards.length === 0) {
      setsContainer.appendChild(createElement('p', 'collectr-no-results', 'No cards match those filters.'));
    }
    updateCollapseAllButton();
  }

  function syncFound() {
    if (isShared) return;
    if (typeof window.syncObtainedToCloud === 'function') {
      window.syncObtainedToCloud(PAGE_ID, state.found).then(result => {
        if (result && result.reason === 'too-large') {
          setMessage('Found marks are saved locally, but the Firebase document is at its size limit.', 'error');
        } else if (result && result.reason === 'cloud-error') {
          setMessage('Found marks are saved locally, but Firebase sync failed. Check your connection and permissions.', 'error');
        }
      });
    }
  }

  function syncCatalog() {
    if (isShared || !state.catalog || typeof window.syncCatalogToCloud !== 'function') {
      return Promise.resolve({ ok: false, reason: 'not-ready' });
    }
    return window.syncCatalogToCloud(PAGE_ID, state.catalog);
  }

  window.applyCloudState = function(cloudData) {
    if (isShared) return;
    state.found = cleanFound(cloudData, state.catalog ? state.catalog.cards : []);
    saveState();
    render();
  };

  window.applyCloudCatalog = async function(cloudCatalog, revisionAtLoad) {
    if (isShared) return;
    if (window.catalogRevision !== revisionAtLoad) {
      await syncCatalog();
      return;
    }
    if (!cloudCatalog) {
      await syncCatalog();
      return;
    }
    if (!isCatalog(cloudCatalog)) {
      console.warn('Ignoring an invalid Collectr catalog from Firebase.');
      return;
    }

    if (!state.catalog || cloudCatalog.updatedAt >= state.catalog.updatedAt) {
      const nextState = {
        catalog: cloudCatalog,
        found: state.catalog && state.catalog.updatedAt === cloudCatalog.updatedAt
          ? cleanFound(state.found, cloudCatalog.cards)
          : {}
      };
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(nextState));
      } catch (error) {
        console.error('Could not save the cloud Collectr catalog locally.', error);
        setMessage('Cloud catalog loaded, but this browser could not save it locally.', 'error');
        return;
      }
      state = nextState;
      window.obtained = state.found;
      window.collectrCatalogUpdatedAt = cloudCatalog.updatedAt;
      window.catalogRevision++;
      window.stateRevision++;
      render();
    } else {
      await syncCatalog();
    }
  };

  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file || isShared) return;

    try {
      const parsed = parseImport(await file.text(), file.name);
      if (!parsed.cards.length) throw new Error('No valid missing-card rows were found in the selected file.');
      if (parsed.cards.length > MAX_CARDS) throw new Error(`The import exceeds the ${MAX_CARDS.toLocaleString()} card safety limit.`);

      const catalog = {
        version: 1,
        updatedAt: Date.now(),
        source: parsed.source,
        cards: parsed.cards
      };
      const catalogBytes = catalogStorage.documentBytes(catalogStorage.encode(catalog));
      if (catalogBytes > catalogStorage.MAX_DOCUMENT_BYTES) {
        throw new Error('The compact catalog exceeds the safe Firebase document size. Use a smaller export.');
      }
      const description = parsed.source === 'csv'
        ? 'This CSV contains only its exported rows and may be filtered. Cards without HTML metadata will have no rarity or artwork.'
        : 'This HTML replaces the full imported card list.';
      if (!window.confirm(`Replace the Collectr tracker with ${parsed.cards.length.toLocaleString()} cards from this ${parsed.source.toUpperCase()} file?\n\n${description}\n\nAll found marks on this tracker will be cleared.`)) return;

      const nextState = { catalog, found: {} };
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(nextState));
      } catch (error) {
        console.error('Could not save the imported Collectr catalog locally.', error);
        throw new Error('The import could not be saved in this browser. Free some browser storage and retry.');
      }
      state = nextState;
      window.obtained = state.found;
      window.collectrCatalogUpdatedAt = catalog.updatedAt;
      window.catalogRevision++;
      window.stateRevision++;
      selectedRarities.clear();
      search = '';
      searchInput.value = '';
      collapsedSets.clear();
      render();
      const result = await syncCatalog();
      if (result && result.ok) {
        setMessage(`Imported ${parsed.cards.length.toLocaleString()} cards and synced the catalog to Firebase.`, 'success');
      } else if (result && result.reason === 'too-large') {
        setMessage('Imported locally, but the catalog is too large to sync to Firebase. This import is available only in this browser.', 'error');
      } else if (result && result.reason === 'not-signed-in') {
        setMessage('Imported locally. Sign in with Google to sync the catalog and found marks across devices.', 'info');
      } else {
        setMessage('Imported locally, but Firebase sync failed. Check the console or try signing in again.', 'error');
      }
    } catch (error) {
      console.error('Collectr import failed.', error);
      setMessage(error instanceof Error ? error.message : 'The selected file could not be imported.', 'error');
    }
  });

  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLocaleLowerCase();
    render();
  });

  collapseAllButton.addEventListener('click', () => {
    const anyOpen = [...setsContainer.querySelectorAll('.collectr-set')].some(section => section.open);
    collapsedSets.clear();
    // Collapse every catalog set, not just shown ones, so sets revealed by a later search start collapsed.
    if (anyOpen && state.catalog) {
      for (const card of state.catalog.cards) collapsedSets.add(card.set);
    }
    render();
  });

  compactInput.addEventListener('change', () => {
    root.classList.toggle('collectr-compact', compactInput.checked);
    try {
      localStorage.setItem(COMPACT_KEY, String(compactInput.checked));
    } catch (error) {
      console.warn('Could not save compact-view preference.', error);
    }
  });

  setsContainer.addEventListener('click', event => {
    const button = event.target.closest('[data-action="toggle-found"]');
    if (!button) return;
    const article = button.closest('.collectr-tile');
    if (!article) return;
    const id = article.dataset.id;
    const wasFound = Boolean(state.found[id]);
    if (state.found[id]) delete state.found[id];
    else state.found[id] = true;
    window.stateRevision++;
    if (!saveState()) {
      if (wasFound) state.found[id] = true;
      else delete state.found[id];
      window.stateRevision--;
      window.obtained = state.found;
      render();
      setMessage('Could not save this found mark in browser storage.', 'error');
      return;
    }
    render();
    syncFound();
  });

  function quoteCsv(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  exportButton.addEventListener('click', async () => {
    const expandedCards = visibleUnfoundCards.filter(card => !collapsedSets.has(card.set));
    const csv = [
      'set,card_number,name',
      ...expandedCards.map(card => [card.set, card.number, card.name].map(quoteCsv).join(','))
    ].join('\r\n');
    const count = expandedCards.length;
    try {
      await navigator.clipboard.writeText(csv);
      setMessage(`Copied ${count.toLocaleString()} visible unfound cards as CSV.`, 'success');
    } catch (error) {
      console.warn('Clipboard access unavailable; downloading visible CSV instead.', error);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = createElement('a');
      link.href = url;
      link.download = 'collectr-missing-shown.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`Downloaded ${count.toLocaleString()} visible unfound cards as CSV.`, 'success');
    }
  });

  shareButton.addEventListener('click', async () => {
    if (!state.catalog) return;
    const cards = state.catalog.cards.filter(card => !state.found[card.id]);
    if (!cards.length) {
      setMessage('There are no missing cards to share.', 'info');
      return;
    }
    const sets = new Set(cards.map(card => card.set));
    shareButton.disabled = true;
    try {
      const token = await catalogStorage.encodeShare(
        { version: 1, updatedAt: Date.now(), source: state.catalog.source, cards },
        { search: searchInput.value.trim(), rarities: selectedRarities, collapsed: [...collapsedSets].filter(set => sets.has(set)) }
      );
      const base = `${location.origin}${location.pathname}`;
      const saved = window.collectrShares ? await window.collectrShares.create(token) : { ok: false, reason: 'cloud-error' };
      const url = saved.ok ? `${base}${SHORT_SHARE_PREFIX}${saved.id}` : `${base}${SHARE_PREFIX}${token}`;
      const fallback = saved.ok ? ''
        : saved.reason === 'not-signed-in' ? (isShared ? '' : ' Sign in to get a short link instead of this long one.')
        : ' A short link could not be saved, so this is the long version.';
      const done = `share link for ${cards.length.toLocaleString()} missing cards with your current filters. Anything changed from that link stays in the other person's browser.${fallback}`;
      try {
        await navigator.clipboard.writeText(url);
        setMessage(`Copied a ${done}`, 'success');
      } catch (error) {
        console.warn('Clipboard access unavailable; showing the share link instead.', error);
        window.prompt('Copy this share link:', url);
        setMessage(`Created a ${done}`, 'success');
      }
    } catch (error) {
      console.error('Could not create a Collectr share link.', error);
      setMessage('This browser could not create a share link.', 'error');
    } finally {
      shareButton.disabled = !state.catalog;
    }
  });

  function showSharedError(reason) {
    const detail = reason === 'not-found'
      ? 'This shared list no longer exists. Ask the person who shared it for a new link.'
      : reason === 'cloud-error'
        ? 'The shared list could not be downloaded. Check your connection or disable ad blockers for this site, then reload.'
        : 'The link may be incomplete. Ask the person who shared it to copy a new one.';
    emptyState.replaceChildren(
      createElement('h1', '', 'This share link could not be opened'),
      createElement('p', '', detail)
    );
  }

  function waitForShares() {
    if (window.collectrShares) return Promise.resolve(window.collectrShares);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Firebase did not load.'), { reason: 'cloud-error' })), SHARE_LOAD_TIMEOUT_MS);
      window.addEventListener('collectr-shares-ready', () => {
        clearTimeout(timer);
        resolve(window.collectrShares);
      }, { once: true });
    });
  }

  async function loadSharedToken() {
    if (!sharedId) return sharedToken;
    const result = await (await waitForShares()).load(sharedId);
    if (!result.ok) throw Object.assign(new Error('Shared list unavailable.'), { reason: result.reason });
    sharedOwnerUid = typeof result.ownerUid === 'string' ? result.ownerUid : '';
    return result.payload;
  }

  async function loadShared() {
    root.classList.add('collectr-shared');
    document.title = 'Shared Collectr Missing Cards';
    const subtitle = document.querySelector('.logo-text span');
    if (subtitle) subtitle.textContent = 'Shared missing cards';
    sharedBanner.hidden = false;
    statsLabel.textContent = 'Loading shared list…';
    emptyState.hidden = true;
    try {
      const shared = await catalogStorage.decodeShare(await loadSharedToken());
      if (!isCatalog(shared.catalog)) throw new Error('Invalid shared catalog.');
      let found = {};
      try {
        found = cleanFound(JSON.parse(localStorage.getItem(sharedKey) || 'null'), shared.catalog.cards);
      } catch (error) {
        console.warn('Could not load saved marks for this shared list.', error);
      }
      state = { catalog: shared.catalog, found };
      window.obtained = state.found;
      const rarities = new Set(shared.catalog.cards.map(card => card.rarity));
      const setNames = new Set(shared.catalog.cards.map(card => card.set));
      searchInput.value = shared.filters.search;
      search = shared.filters.search.trim().toLocaleLowerCase();
      selectedRarities = new Set(shared.filters.rarities.filter(rarity => rarities.has(rarity)));
      collapsedSets.clear();
      for (const set of shared.filters.collapsed) if (setNames.has(set)) collapsedSets.add(set);
      render();
      if (sharedId && sharedOwnerUid) addSendFindsButton();
    } catch (error) {
      console.error('Could not open the Collectr share link.', error);
      showSharedError(error.reason);
      render();
      statsLabel.textContent = 'Shared list unavailable.';
    }
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      console.warn('Could not save to browser storage.', error);
    }
  }

  function randomId() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => alphabet[byte % alphabet.length]).join('');
  }

  // Built in JS rather than HTML so a stale cached page with a newer script still works.
  function addSendFindsButton() {
    if (!sharedBanner || document.getElementById('collectrSendFinds')) return;
    const button = createElement('button', 'collectr-button collectr-send-finds', 'Send my finds to owner');
    button.id = 'collectrSendFinds';
    button.type = 'button';
    button.title = 'Send the cards you marked found so the owner can review and add them to their tracker';
    sharedBanner.insertBefore(button, sharedResetButton);
    button.addEventListener('click', () => sendFinds(button));
  }

  async function sendFinds(button) {
    const cards = Object.keys(state.found);
    if (!cards.length) {
      setMessage('Mark the cards you found first, then send them to the owner.', 'info');
      return;
    }
    const answer = window.prompt('Your name (optional), so the owner knows who found these:', storageGet(FINDER_NAME_KEY));
    if (answer === null) return;
    const name = normalizeText(answer).slice(0, MAX_FINDER_NAME);
    storageSet(FINDER_NAME_KEY, name);
    const findKey = `${sharedKey}_find`;
    let findId = storageGet(findKey);
    if (!/^[A-Za-z0-9]{20}$/.test(findId)) {
      findId = randomId();
      storageSet(findKey, findId);
    }
    button.disabled = true;
    try {
      const shares = await waitForShares();
      const result = await shares.sendFinds({ findId, shareId: sharedId, ownerUid: sharedOwnerUid, name, cards });
      if (result.ok) {
        setMessage(`Sent ${cards.length.toLocaleString()} found ${cards.length === 1 ? 'card' : 'cards'} to the owner. Sending again replaces this update.`, 'success');
      } else {
        setMessage('Could not send your finds. Check your connection or disable ad blockers for this site, then try again.', 'error');
      }
    } catch (error) {
      console.error('Could not send Collectr finds.', error);
      setMessage('Could not send your finds. Check your connection or disable ad blockers for this site, then try again.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  let findsPanel = null;

  function formatAge(ms) {
    if (!ms) return '';
    const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }

  function renderFinds(finds) {
    if (!findsPanel) {
      findsPanel = createElement('div', 'collectr-finds');
      findsPanel.setAttribute('aria-label', 'Finds sent from your share links');
      statusMessage.parentNode.insertBefore(findsPanel, statusMessage);
    }
    findsPanel.replaceChildren();
    const cardsById = new Map((state.catalog ? state.catalog.cards : []).map(card => [card.id, card]));
    for (const find of finds) {
      const known = find.cards.filter(id => cardsById.has(id));
      const fresh = known.filter(id => !state.found[id]);
      const who = find.name || 'Someone';
      const item = createElement('div', 'collectr-find');
      const summary = createElement('div', 'collectr-find-summary');
      const parts = [`${who} found ${find.cards.length.toLocaleString()} ${find.cards.length === 1 ? 'card' : 'cards'}`];
      if (fresh.length !== find.cards.length) {
        const already = known.length - fresh.length;
        const missing = find.cards.length - known.length;
        const notes = [];
        if (fresh.length) notes.push(`${fresh.length.toLocaleString()} new`);
        if (already) notes.push(`${already.toLocaleString()} already marked`);
        if (missing) notes.push(`${missing.toLocaleString()} not in your current list`);
        parts.push(`(${notes.join(', ')})`);
      }
      const age = formatAge(find.updatedAt);
      summary.appendChild(createElement('span', 'collectr-find-text', parts.join(' ') + (age ? ` · ${age}` : '')));

      const list = createElement('ul', 'collectr-find-list');
      list.hidden = true;
      for (const id of fresh) {
        const card = cardsById.get(id);
        list.appendChild(createElement('li', '', `${card.set} · ${card.number} · ${card.name}`));
      }
      if (fresh.length) {
        const review = createElement('button', 'collectr-clear-filters', 'Review');
        review.type = 'button';
        review.addEventListener('click', () => {
          list.hidden = !list.hidden;
          review.textContent = list.hidden ? 'Review' : 'Hide';
        });
        const accept = createElement('button', 'collectr-button', `Mark ${fresh.length.toLocaleString()} found`);
        accept.type = 'button';
        accept.addEventListener('click', () => acceptFind(find, fresh, who));
        summary.append(review, accept);
      }
      const dismiss = createElement('button', 'collectr-clear-filters', 'Dismiss');
      dismiss.type = 'button';
      dismiss.addEventListener('click', () => removeFind(find, `Dismissed the finds from ${who}.`));
      summary.appendChild(dismiss);
      item.append(summary, list);
      findsPanel.appendChild(item);
    }
    findsPanel.hidden = finds.length === 0;
  }

  let currentFinds = [];

  async function removeFind(find, message) {
    const result = await window.collectrShares.deleteFind(find.id);
    if (!result.ok) {
      setMessage('Could not remove this update from Firebase. Try again later.', 'error');
      return;
    }
    currentFinds = currentFinds.filter(item => item.id !== find.id);
    renderFinds(currentFinds);
    if (message) setMessage(message, 'success');
  }

  async function acceptFind(find, ids, who) {
    const added = ids.filter(id => !state.found[id]);
    for (const id of added) state.found[id] = true;
    window.stateRevision++;
    if (!saveState()) {
      for (const id of added) delete state.found[id];
      window.stateRevision--;
      window.obtained = state.found;
      setMessage('Could not save these found marks in browser storage.', 'error');
      return;
    }
    render();
    syncFound();
    await removeFind(find, `Marked ${added.length.toLocaleString()} ${added.length === 1 ? 'card' : 'cards'} found from ${who}.`);
  }

  async function loadFinds() {
    if (isShared || !state.catalog || !window.collectrShares || typeof window.collectrShares.listFinds !== 'function') return;
    const result = await window.collectrShares.listFinds();
    if (!result.ok) {
      currentFinds = [];
      if (findsPanel) renderFinds(currentFinds);
      return;
    }
    currentFinds = result.finds.sort((a, b) => b.updatedAt - a.updatedAt);
    renderFinds(currentFinds);
  }

  window.addEventListener('collectr-auth-ready', loadFinds);

  sharedResetButton.addEventListener('click', () => {
    try {
      localStorage.removeItem(sharedKey);
    } catch (error) {
      console.warn('Could not clear marks for this shared list.', error);
    }
    location.reload();
  });

  window.addEventListener('hashchange', () => location.reload());

  (function initializeTheme() {
    const toggle = document.querySelector('[data-theme-toggle]');
    const html = document.documentElement;
    let theme = localStorage.getItem('yukaMoriiTheme') || 'dark';
    html.setAttribute('data-theme', theme);
    toggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', theme);
      localStorage.setItem('yukaMoriiTheme', theme);
    });
  })();

  try {
    compactInput.checked = localStorage.getItem(COMPACT_KEY) === 'true';
    root.classList.toggle('collectr-compact', compactInput.checked);
  } catch (error) {
    console.warn('Could not load compact-view preference.', error);
  }
  if (isShared) loadShared();
  else render();
})();
