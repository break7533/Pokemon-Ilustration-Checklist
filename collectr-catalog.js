(function(root) {
  const IMAGE_BASE = 'https://public.getcollectr.com/public-assets/products/';
  const IMAGE_SUFFIX = '?optimizer=image&format=webp&width=300&quality=80&strip=metadata';
  const MAX_DOCUMENT_BYTES = 900000;

  function encode(catalog) {
    const sets = new Map();
    for (const card of catalog.cards) {
      if (!sets.has(card.set)) sets.set(card.set, []);
      const entry = { number: card.number, name: card.name };
      if (card.rarity && card.rarity !== 'No rarity data') entry.rarity = card.rarity;
      if (card.img) {
        const filename = card.img.slice(IMAGE_BASE.length, -IMAGE_SUFFIX.length);
        if (card.img === IMAGE_BASE + filename + IMAGE_SUFFIX && /^product_[\w.-]+$/.test(filename)) {
          entry.image = filename;
        } else {
          entry.url = card.img;
        }
      }
      sets.get(card.set).push(entry);
    }
    return {
      version: 2,
      updatedAt: catalog.updatedAt,
      source: catalog.source,
      sets: [...sets].map(([name, cards]) => ({ name, cards }))
    };
  }

  function decode(value) {
    if (!value || value.version !== 2) return value;
    if (!Number.isFinite(value.updatedAt) || !Array.isArray(value.sets)) {
      throw new Error('Invalid compact Collectr catalog.');
    }
    const cards = [];
    for (const set of value.sets) {
      if (typeof set.name !== 'string' || !Array.isArray(set.cards)) {
        throw new Error('Invalid Collectr set data.');
      }
      for (const card of set.cards) {
        if (typeof card.number !== 'string' || typeof card.name !== 'string' ||
            (card.rarity !== undefined && typeof card.rarity !== 'string') ||
            (card.url !== undefined && typeof card.url !== 'string') ||
            (card.image !== undefined && (typeof card.image !== 'string' || !/^product_[\w.-]+$/.test(card.image)))) {
          throw new Error('Invalid Collectr card data.');
        }
        cards.push({
          id: [set.name, card.number, card.name].map(part => part.trim().replace(/\s+/g, ' ').toLocaleLowerCase()).join('::'),
          set: set.name,
          number: card.number,
          name: card.name,
          rarity: card.rarity || 'No rarity data',
          img: card.url || (card.image ? IMAGE_BASE + card.image + IMAGE_SUFFIX : '')
        });
      }
    }
    return { version: 1, updatedAt: value.updatedAt, source: value.source, cards };
  }

  // Firestore strings include a terminator; maps include 32 bytes of overhead.
  // Reserve additional space for the document name and metadata.
  function valueBytes(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value).length + 1;
    if (typeof value === 'boolean' || value === null) return 1;
    if (typeof value === 'number') return 8;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + valueBytes(item), 0);
    if (value && typeof value === 'object') {
      return 32 + Object.entries(value).reduce((sum, [key, item]) => sum + valueBytes(key) + valueBytes(item), 0);
    }
    throw new Error('Unsupported value in Collectr storage.');
  }

  const SHARE_VERSION = 1;
  const MAX_SHARE_BYTES = 8 * 1024 * 1024;

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(text) {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid share link.');
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }

  async function encodeShare(catalog, filters) {
    const payload = {
      v: SHARE_VERSION,
      catalog: encode(catalog),
      filters: {
        search: String(filters.search || ''),
        rarities: [...(filters.rarities || [])].map(String),
        collapsed: [...(filters.collapsed || [])].map(String)
      }
    };
    const json = new TextEncoder().encode(JSON.stringify(payload));
    return bytesToBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
  }

  async function decodeShare(text) {
    const inflated = await pipe(base64UrlToBytes(text), new DecompressionStream('deflate-raw'));
    if (inflated.length > MAX_SHARE_BYTES) throw new Error('This share link is too large.');
    const payload = JSON.parse(new TextDecoder().decode(inflated));
    if (!payload || payload.v !== SHARE_VERSION || !payload.catalog || payload.catalog.version !== 2) {
      throw new Error('This share link is not supported.');
    }
    const filters = payload.filters && typeof payload.filters === 'object' ? payload.filters : {};
    const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    return {
      catalog: decode(payload.catalog),
      filters: {
        search: typeof filters.search === 'string' ? filters.search : '',
        rarities: strings(filters.rarities),
        collapsed: strings(filters.collapsed)
      }
    };
  }

  const storage = {
    encode,
    decode,
    encodeShare,
    decodeShare,
    documentBytes: value => 1024 + valueBytes(value),
    MAX_DOCUMENT_BYTES
  };
  root.collectrCatalogStorage = storage;
  if (typeof module !== 'undefined' && module.exports) module.exports = storage;
})(typeof window !== 'undefined' ? window : globalThis);
