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
        'globalThis.hooks = { parseGroupIds, scanSets, loadSession, sessionAdd, CONFIG }; if (document.body) build();'
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
