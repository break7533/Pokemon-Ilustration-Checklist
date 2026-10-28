function renderHome() {
  const grid = document.getElementById('illustratorGrid');

  TRACKERS.forEach(tracker => {
    let obtainedCount = 0;
    try {
      const saved = localStorage.getItem(tracker.localStorageKey);
      if (saved) obtainedCount = Object.keys(JSON.parse(saved)).length;
    } catch(e) {}

    const pct = tracker.totalCards > 0 ? Math.round((obtainedCount / tracker.totalCards) * 100) : 0;

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
          <span class="illustrator-progress-text">${obtainedCount} / ${tracker.totalCards} &mdash; ${pct}%</span>
        </div>
      </div>`;
    grid.appendChild(a);
  });
}

renderHome();
