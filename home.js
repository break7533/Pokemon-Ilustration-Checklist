function renderHome() {
  const grid = document.getElementById('illustratorGrid');

  TRACKERS.forEach(tracker => {
    let obtainedCount = 0;
    let totalCards = tracker.totalCards;
    try {
      if (tracker.catalogStorageKey) {
        const saved = localStorage.getItem(tracker.catalogStorageKey);
        if (saved) {
          const state = JSON.parse(saved);
          const cards = state.catalog && Array.isArray(state.catalog.cards) ? state.catalog.cards : [];
          const obtained = state.found && typeof state.found === 'object' ? state.found : {};
          const cardIds = new Set(cards.map(card => card.id));
          totalCards = cards.length;
          obtainedCount = Object.keys(obtained).filter(id => cardIds.has(id)).length;
        }
      } else {
        const saved = localStorage.getItem(tracker.localStorageKey);
        if (saved) obtainedCount = Object.keys(JSON.parse(saved)).length;
      }
    } catch(e) {}

    const pct = totalCards > 0 ? Math.round((obtainedCount / totalCards) * 100) : 0;
    const progressLabel = tracker.catalogStorageKey && totalCards === 0
      ? 'Import an HTML or CSV export to begin'
      : `${obtainedCount} / ${totalCards} &mdash; ${pct}%`;

    const a = document.createElement('a');
    a.className = 'illustrator-card';
    a.href = tracker.href;
    a.innerHTML = `
      <div class="illustrator-img-wrap">
        <img src="${tracker.sampleImg}" alt="${tracker.name}" loading="lazy" width="160" height="224" decoding="async">
      </div>
      <div class="illustrator-info">
        <div class="illustrator-name">${tracker.name}</div>
        <div class="illustrator-progress-wrap">
          <div class="illustrator-progress-bar">
            <div class="illustrator-progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="illustrator-progress-text">${progressLabel}</span>
        </div>
      </div>`;
    grid.appendChild(a);
  });
}

renderHome();
