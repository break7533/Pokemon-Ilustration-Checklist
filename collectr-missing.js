(() => {
  const PAGE_ID = 'collectr-missing';
  const STATE_KEY = 'collectr-missing_state';
  const COMPACT_KEY = 'collectr-missing_compact';
  const MAX_CARDS = 25000;
  const MAX_CATALOG_BYTES = 850000;
  const root = document.body;
  const searchInput = document.getElementById('collectrSearch');
  const compactInput = document.getElementById('collectrCompact');
  const importInput = document.getElementById('collectrImport');
  const exportButton = document.getElementById('collectrExport');
  const rarityContainer = document.getElementById('collectrRarities');
  const setsContainer = document.getElementById('collectrSets');
  const emptyState = document.getElementById('collectrEmpty');
  const statusMessage = document.getElementById('collectrMessage');
  const shownLabel = document.getElementById('collectrShown');
  const statsLabel = document.getElementById('collectrStats');
  const progressBar = document.getElementById('collectrProgress');
  const progressText = document.getElementById('collectrProgressText');

  window.PAGE_ID = PAGE_ID;
  window.catalogRevision = 0;
  window.stateRevision = 0;

  let state = loadState();
  let search = '';
  let selectedRarities = new Set();
  let visibleCards = [];
  let visibleUnfoundCards = [];
  let openSets = new Set();
  let hasRendered = false;
  window.obtained = state.found;
  window.collectrCatalogUpdatedAt = state.catalog ? state.catalog.updatedAt : 0;
  window.collectrCatalogBytes = state.catalog
    ? new TextEncoder().encode(JSON.stringify(state.catalog)).length
    : 0;

  function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
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
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
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

  function captureOpenSets() {
    if (!hasRendered) return;
    openSets = new Set([...setsContainer.querySelectorAll('.collectr-set[open]')].map(section => section.dataset.set));
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
        captureOpenSets();
        render();
      });
      label.append(input, document.createTextNode(rarity));
      rarityContainer.appendChild(label);
    }
    const clear = createElement('button', 'collectr-clear-filters', 'Clear rarities');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      selectedRarities.clear();
      captureOpenSets();
      render();
    });
    rarityContainer.appendChild(clear);
  }

  function render() {
    const cards = state.catalog ? state.catalog.cards : [];
    emptyState.hidden = cards.length > 0;
    setsContainer.hidden = cards.length === 0;
    exportButton.disabled = cards.length === 0;
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
      section.open = !hasRendered || openSets.has(set);
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
    hasRendered = true;
  }

  function syncFound() {
    if (typeof window.syncObtainedToCloud === 'function') {
      window.syncObtainedToCloud(PAGE_ID, state.found).then(result => {
        if (result && result.reason === 'too-large') {
          setMessage('Found marks are saved locally, but the Firebase document is at its size limit.', 'error');
        }
      });
    }
  }

  function syncCatalog() {
    if (!state.catalog || typeof window.syncCatalogToCloud !== 'function') {
      return Promise.resolve({ ok: false, reason: 'not-ready' });
    }
    return window.syncCatalogToCloud(PAGE_ID, state.catalog);
  }

  window.applyCloudState = function(cloudData) {
    state.found = cleanFound(cloudData, state.catalog ? state.catalog.cards : []);
    saveState();
    render();
  };

  window.applyCloudCatalog = async function(cloudCatalog, revisionAtLoad) {
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
        found: cleanFound(state.found, cloudCatalog.cards)
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
      window.collectrCatalogBytes = new TextEncoder().encode(JSON.stringify(cloudCatalog)).length;
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
    if (!file) return;

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
      const serialized = JSON.stringify(catalog);
      const catalogBytes = new TextEncoder().encode(serialized).length;
      if (catalogBytes > MAX_CATALOG_BYTES) {
        throw new Error('This catalog is too large to sync safely through Firebase. Reduce the export size and try again.');
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
      window.collectrCatalogBytes = catalogBytes;
      window.catalogRevision++;
      window.stateRevision++;
      selectedRarities.clear();
      search = '';
      searchInput.value = '';
      openSets.clear();
      hasRendered = false;
      render();
      syncFound();

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
    captureOpenSets();
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
    captureOpenSets();
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
    const csv = [
      'set,card_number,name',
      ...visibleUnfoundCards.map(card => [card.set, card.number, card.name].map(quoteCsv).join(','))
    ].join('\r\n');
    const count = visibleUnfoundCards.length;
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
  render();
})();
