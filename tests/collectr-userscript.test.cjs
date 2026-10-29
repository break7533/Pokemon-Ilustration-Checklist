const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../collectr-missing-cards.user.js'), 'utf8');

function harness(respond) {
    const storage = new Map();
    const requests = [];
    const context = vm.createContext({
        document: { body: null },
        window: { addEventListener() {} },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
        },
        console: { warn() {}, error() {} },
        setTimeout: callback => callback(),
        GM_xmlhttpRequest(options) {
            const url = new URL(options.url);
            requests.push(url);
            const response = respond(url);
            options.onload({ status: response.status || 200, responseText: JSON.stringify(response.body) });
        },
    });
    vm.runInContext(source.replace(
        'if (document.body) build();',
        'globalThis.hooks = { ALL_SET_IDS, SPECIAL_SET_NAMES, skipSet, parseGroupIds, scanSets, loadSession, sessionAdd, CONFIG }; if (document.body) build();'
    ), context);
    context.hooks.CONFIG.DELAY_MS = 0;
    return { ...context.hooks, requests, storage };
}

function catalog(groupId, total = 1) {
    return {
        body: {
            data: [{
                product_id: `${groupId}01`,
                catalog_group_id: groupId,
                card_number: '1/1',
                product_name: `Card ${groupId}`,
            }],
            setDetails: { number_of_cards_in_group: total, catalog_group_name: `Set ${groupId}` },
        },
    };
}

function success(url) {
    return url.pathname === '/catalog'
        ? catalog(url.searchParams.get('groupId'))
        : { body: { data: [] } };
}

function seed(h, id) {
    h.storage.set('collectr_missing:SESSION', JSON.stringify({
        version: 2,
        sets: { [id]: { groupId: id, name: 'Previous snapshot', scope: 'base', missing: [{ name: 'Old card' }] } },
    }));
}

test('static directory has 177 unique numeric IDs in supplied order', () => {
    const h = harness(success);
    assert.equal(h.ALL_SET_IDS.length, 177);
    assert.equal(new Set(h.ALL_SET_IDS).size, 177);
    assert.ok(h.ALL_SET_IDS.every(id => /^\d+$/.test(id)));
    assert.equal(h.ALL_SET_IDS[0], '24837');
    assert.equal(h.ALL_SET_IDS.at(-1), '1418');
});

test('scans all static sets and saves every result in source order', async () => {
    const h = harness(success);
    h.CONFIG.SCOPE = 'all';
    const summary = await h.scanSets(h.ALL_SET_IDS, () => {}, () => false);
    assert.deepEqual(Array.from(summary.saved), Array.from(h.ALL_SET_IDS));
    assert.equal(summary.failed.length, 0);
    assert.equal(Object.keys(h.loadSession().sets).length, 177);
    assert.equal(h.requests.length, 354);
});

test('base-only scans skip all 45 matching static sets without requesting them', async () => {
    const h = harness(success);
    const summary = await h.scanSets(h.ALL_SET_IDS, () => {}, () => false);
    assert.equal(summary.skipped.length, 45);
    assert.equal(summary.saved.length, 132);
    assert.equal(summary.failed.length, 0);
    assert.equal(h.requests.length, 264);
    assert.ok(h.requests.filter(url => url.pathname === '/catalog')
        .every(url => !h.SPECIAL_SET_NAMES[url.searchParams.get('groupId')]));
});

test('name exclusions are case-insensitive, include curly apostrophes, and only apply to base scope', () => {
    const h = harness(success);
    for (const name of ['Classic Collection', 'PROMOS', 'Promo', 'Trick or Trade',
        "McDonald's", 'McDonald’s', 'Gallery', 'Shiny', 'Radiant', 'POP Series', 'Shadowless']) {
        assert.equal(h.skipSet(`Set ${name} 2026`, 'base'), true, name);
        assert.equal(h.skipSet(`Set ${name} 2026`, 'all'), false, name);
    }
    for (const name of ['Shining Fates', 'Astral Radiance', 'Base Set (Unlimited)']) {
        assert.equal(h.skipSet(name, 'base'), false, name);
    }
});

test('custom unknown set names are excluded after the first catalog response', async () => {
    const h = harness(url => {
        const response = success(url);
        if (url.pathname === '/catalog') response.body.setDetails.catalog_group_name = 'New Promo Set';
        return response;
    });
    const summary = await h.scanSets(['123456'], () => {}, () => false);
    assert.equal(summary.skipped.length, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(Object.keys(h.loadSession().sets).length, 0);
});

test('refresh preserves skipped snapshots and honors each saved scope', async () => {
    const h = harness(success);
    seed(h, '24451');
    let summary = await h.scanSets(['24451'], () => {}, () => false, { '24451': 'base' });
    assert.equal(summary.skipped.length, 1);
    assert.equal(h.loadSession().sets['24451'].name, 'Previous snapshot');
    assert.equal(h.requests.length, 0);
    summary = await h.scanSets(['24451'], () => {}, () => false, { '24451': 'all' });
    assert.equal(summary.saved.length, 1);
    assert.equal(h.loadSession().sets['24451'].scope, 'all');
});

test('parses IDs and URLs with mixed separators, removes duplicates, rejects invalid input', () => {
    const h = harness(success);
    assert.deepEqual(Array.from(h.parseGroupIds('001, 2;\nhttps://app.getcollectr.com/explore?groupId=1 2')), ['1', '2']);
    assert.throws(() => h.parseGroupIds(''), /at least one/);
    assert.throws(() => h.parseGroupIds('1, invalid, 2'), /invalid set/);
});

test('scans sequentially and automatically saves each set', async () => {
    const h = harness(success);
    const summary = await h.scanSets(['1', '2'], () => {}, () => false);
    assert.deepEqual(Array.from(summary.saved), ['1', '2']);
    assert.equal(summary.failed.length, 0);
    assert.deepEqual(h.requests.map(url => url.pathname), [
        '/catalog', '/collections//products', '/catalog', '/collections//products',
    ]);
    assert.equal(Object.keys(h.loadSession().sets).length, 2);
});

test('refresh replaces a saved snapshot, including clearing cards now owned', async () => {
    const h = harness(url => url.pathname === '/catalog'
        ? catalog(url.searchParams.get('groupId'))
        : { body: { data: [{ product_id: '101', is_owned: true, quantity: 1 }] } });
    seed(h, '1');
    await h.scanSets(Object.keys(h.loadSession().sets), () => {}, () => false);
    assert.equal(h.loadSession().sets['1'].name, 'Set 1');
    assert.equal(h.loadSession().sets['1'].missing.length, 0);
});

test('incomplete scans preserve snapshots and allow later sets to finish', async () => {
    const h = harness(url => url.pathname === '/catalog' && url.searchParams.get('groupId') === '1'
        ? catalog('1', 3)
        : success(url));
    seed(h, '1');
    const summary = await h.scanSets(['1', '2'], () => {}, () => false);
    assert.equal(summary.failed.length, 1);
    assert.equal(h.loadSession().sets['1'].name, 'Previous snapshot');
    assert.equal(h.loadSession().sets['2'].name, 'Set 2');
});

test('refresh retains each saved scope instead of applying the current scope', async () => {
    const h = harness(url => {
        const response = success(url);
        if (url.pathname === '/catalog') response.body.data[0].card_number = '2/1';
        return response;
    });
    await h.scanSets(['1', '2'], () => {}, () => false, { '1': 'all', '2': 'base' });
    assert.equal(h.loadSession().sets['1'].scope, 'all');
    assert.equal(h.loadSession().sets['1'].missing.length, 1);
    assert.equal(h.loadSession().sets['2'].scope, 'base');
    assert.equal(h.loadSession().sets['2'].missing.length, 0);
});

test('stopping an in-flight set preserves its snapshot and skips remaining sets', async () => {
    let aborted = false;
    const h = harness(url => {
        if (url.pathname !== '/catalog') aborted = true;
        return success(url);
    });
    seed(h, '1');
    const summary = await h.scanSets(['1', '2'], () => {}, () => aborted);
    assert.equal(summary.stopped, true);
    assert.equal(summary.saved.length, 0);
    assert.equal(h.loadSession().sets['1'].name, 'Previous snapshot');
    assert.equal(h.loadSession().sets['2'], undefined);
});

test('authentication and rate-limit errors halt the batch without touching snapshots', async () => {
    for (const status of [401, 403, 429]) {
        const h = harness(() => ({ status, body: {} }));
        seed(h, '1');
        const summary = await h.scanSets(['1', '2'], () => {}, () => false);
        assert.equal(summary.failed.length, 1);
        assert.equal(h.requests.length, 1);
        assert.equal(h.loadSession().sets['1'].name, 'Previous snapshot');
    }
});

test('storage failure halts the batch without claiming success', async () => {
    const h = harness(success);
    h.storage.set = () => { throw new Error('quota exceeded'); };
    const summary = await h.scanSets(['1', '2'], () => {}, () => false);
    assert.equal(summary.saved.length, 0);
    assert.match(summary.failed[0], /storage full/);
    assert.equal(h.requests.length, 2);
});
