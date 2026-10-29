const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const storage = require('../collectr-catalog.js');

const image = 'https://public.getcollectr.com/public-assets/products/product_123.jpg?optimizer=image&format=webp&width=300&quality=80&strip=metadata';
function catalog() {
    const cards = [
        { set: 'Test Set', number: '001/100', name: 'Pikachu', rarity: 'Common', img: image },
        { set: 'Test Set', number: '002/100', name: 'Mew', rarity: 'No rarity data', img: '' },
        { set: 'Other Set', number: '1', name: 'Flabébé', rarity: 'Rare', img: 'https://example.com/image.png' },
    ].map(card => ({ id: [card.set, card.number, card.name].map(v => v.toLocaleLowerCase()).join('::'), ...card }));
    return { version: 1, updatedAt: 123, source: 'html', cards };
}

test('compact grouped storage round trips IDs, order, metadata and artwork', () => {
    const original = catalog();
    const encoded = storage.encode(original);
    assert.equal(encoded.version, 2);
    assert.equal(encoded.sets.length, 2);
    assert.equal(encoded.sets[0].cards[0].image, 'product_123.jpg');
    assert.equal(encoded.sets[0].cards[0].id, undefined);
    assert.equal(encoded.sets[0].cards[1].rarity, undefined);
    assert.equal(encoded.sets[1].cards[0].url, 'https://example.com/image.png');
    assert.deepEqual(storage.decode(encoded), original);
    assert.ok(JSON.stringify(encoded).length < JSON.stringify(original).length);
});

test('legacy catalogs still load unchanged', () => {
    const original = catalog();
    assert.equal(storage.decode(original), original);
    assert.equal(storage.decode(null), null);
});

test('nonstandard Collectr image parameters are preserved rather than rewritten', () => {
    const original = catalog();
    original.cards[0].img = image.replace('width=300', 'width=900');
    assert.deepEqual(storage.decode(storage.encode(original)), original);
});

test('malformed compact catalogs are rejected', () => {
    assert.throws(() => storage.decode({ version: 2, updatedAt: 1, sets: [{}] }), /Invalid/);
    const invalid = storage.encode(catalog());
    invalid.sets[0].cards[0].image = '../bad.jpg';
    assert.throws(() => storage.decode(invalid), /Invalid/);
});

test('document sizing counts UTF-8 bytes, field names, maps, arrays and scalar values', () => {
    assert.equal(storage.documentBytes({ label: 'é', cards: [{ found: true, n: 1 }] }),
        1024 + 32 + 6 + 3 + 6 + 32 + 6 + 1 + 2 + 8);
});

function firebaseHarness(initial = {}) {
    let data = initial;
    let writes = 0;
    const snapshot = () => ({ exists: () => true, data: () => data });
    const window = { collectrCatalogStorage: storage, obtained: {}, collectrCatalogUpdatedAt: 123 };
    const context = vm.createContext({
        window, TextEncoder,
        console: { warn() {} },
        initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}),
        GoogleAuthProvider: function() {},
        onAuthStateChanged() {},
        document: { addEventListener() {} },
        doc: () => ({}), getDoc: async () => snapshot(),
        runTransaction: async (_db, callback) => callback({
            get: async () => snapshot(),
            set: (_ref, fields) => { data = { ...data, ...fields }; writes++; },
        }),
    });
    const source = fs.readFileSync(path.join(__dirname, '../firebase.js'), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('let currentUser = null;', "let currentUser = { uid: 'test' };");
    vm.runInContext(source, context);
    return { window, data: () => data, writes: () => writes };
}

test('Firebase saves compact catalog and matching found state atomically without changing other trackers', async () => {
    const h = firebaseHarness({ 'yuka-morii': { existing: true } });
    const original = catalog();
    const id = original.cards[0].id;
    h.window.obtained = { [id]: true };
    assert.equal((await h.window.syncCatalogToCloud('collectr-missing', original)).ok, true);
    assert.equal(h.writes(), 1);
    assert.deepEqual(h.data()['yuka-morii'], { existing: true });
    assert.equal(h.data()['collectr-missing_catalog'].version, 2);
    assert.equal(h.data()['collectr-missing'].catalogUpdatedAt, original.updatedAt);
    assert.equal(h.data()['collectr-missing'].found[id], true);
    const loaded = await h.window.loadCatalogFromCloud('collectr-missing');
    assert.deepEqual(loaded.catalog, original);
});

test('Firebase rejects combined oversized user documents without writing', async () => {
    const h = firebaseHarness({ unrelated: 'x'.repeat(900000) });
    const result = await h.window.syncCatalogToCloud('collectr-missing', catalog());
    assert.equal(result.reason, 'too-large');
    assert.equal(h.writes(), 0);
    const foundResult = await h.window.syncObtainedToCloud('collectr-missing', { test: true });
    assert.equal(foundResult.reason, 'too-large');
    assert.equal(h.writes(), 0);
});

test('a 4,037-card catalog fits with all found marks and existing tracker progress', async () => {
    const original = catalog();
    original.cards = Array.from({ length: 4037 }, (_, index) => {
        const set = `Example expansion ${Math.floor(index / 73)}`;
        const number = `${index % 73 + 1}/200`;
        const name = `Example Pokémon ${index}`;
        return {
            id: [set, number, name].map(value => value.toLocaleLowerCase()).join('::'),
            set, number, name, rarity: 'Common',
            img: image.replace('product_123.jpg', `product_${index}.jpg`)
        };
    });
    const h = firebaseHarness({ 'yuka-morii': { existing: true } });
    h.window.obtained = Object.fromEntries(original.cards.map(card => [card.id, true]));
    assert.ok(new TextEncoder().encode(JSON.stringify(original)).length > 850000);
    assert.equal((await h.window.syncCatalogToCloud('collectr-missing', original)).ok, true);
    assert.ok(storage.documentBytes(h.data()) < storage.MAX_DOCUMENT_BYTES);
    assert.deepEqual((await h.window.loadCatalogFromCloud('collectr-missing')).catalog, original);
    assert.equal((await h.window.syncObtainedToCloud('collectr-missing', h.window.obtained)).ok, true);
    assert.equal(Object.keys(h.data()['collectr-missing'].found).length, 4037);
});

test('Firebase loads legacy catalogs and reports malformed compact data as a cloud error', async () => {
    let h = firebaseHarness({ 'collectr-missing_catalog': catalog() });
    assert.deepEqual((await h.window.loadCatalogFromCloud('collectr-missing')).catalog, catalog());
    h = firebaseHarness({ 'collectr-missing_catalog': { version: 2, sets: null } });
    assert.equal((await h.window.loadCatalogFromCloud('collectr-missing')).reason, 'cloud-error');
});
