function renderHome() {
  const grid = document.getElementById('illustratorGrid');

  ILLUSTRATORS.forEach(ill => {
    let obtainedCount = 0;
    try {
      const saved = localStorage.getItem(ill.localStorageKey);
      if (saved) obtainedCount = Object.keys(JSON.parse(saved)).length;
    } catch(e) {}

    const pct = ill.totalCards > 0 ? Math.round((obtainedCount / ill.totalCards) * 100) : 0;

    const a = document.createElement('a');
    a.className = 'illustrator-card';
    a.href = ill.href;
    a.innerHTML = `
      <div class="illustrator-img-wrap">
        <img src="${ill.sampleImg}" alt="${ill.name}" loading="lazy" width="160" height="224" decoding="async">
      </div>
      <div class="illustrator-info">
        <div class="illustrator-name">${ill.name}</div>
        <div class="illustrator-progress-wrap">
          <div class="illustrator-progress-bar">
            <div class="illustrator-progress-fill" style="width:${pct}%"></div>
          </div>
          <span class="illustrator-progress-text">${obtainedCount} / ${ill.totalCards} &mdash; ${pct}%</span>
        </div>
      </div>`;
    grid.appendChild(a);
  });
}

renderHome();
