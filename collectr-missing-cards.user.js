// ==UserScript==
// @name         Collectr — missing cards in set
// @namespace    luis.lopes
// @version      3.4.1
// @description  Open a set page, click Find missing, get the cards of that set you do not own.
// @match        https://app.getcollectr.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      api-v2.getcollectr.com
// @run-at       document-idle
// ==/UserScript==

/*
 * How ownership is actually determined (from HAR capture app.getcollectr.com9):
 *
 *   1. GET /catalog?username=<acct>&filters=cards&groupId=<set>&offset=N&limit=30
 *      -> the set skeleton. `is_owned` here is ALWAYS false. Do not trust it.
 *
 *   2. GET /collections/<acct>/products?allCollections=true&unstackedView=false
 *          &productIds=<the 30 ids of that page>
 *      -> the ownership overlay: rows carry `is_owned: true` and `quantity`.
 *         `allCollections=true` spans every portfolio, so no collectionId needed.
 *
 * The HAR capture shows both calls succeeding with no Authorization header, but
 * the live API returns 401 for at least one of them, so the newest JWT found in
 * page storage is sent as `Authorization` whenever one exists.
 * 188 cards therefore costs 7 + 7 = 14 requests.
 */

(function () {
    "use strict";

    const LS_PREFIX = "collectr_missing:";
    const lsGet = (k, d) => {
        try {
            const v = localStorage.getItem(LS_PREFIX + k);
            return v === null ? d : JSON.parse(v);
        } catch {
            return d;
        }
    };
    const lsSet = (k, v) => {
        try {
            localStorage.setItem(LS_PREFIX + k, JSON.stringify(v));
            return true;
        } catch {
            return false; // quota, or storage blocked
        }
    };

    const CONFIG = {
        BASE: "https://api-v2.getcollectr.com",
        ACCOUNT_ID: "",
        TOKEN: "",
        MANUAL_ACCOUNT: lsGet("MANUAL_ACCOUNT", ""),
        ACCOUNT_SOURCE: "none",
        SET_INPUT: lsGet("SET_INPUT", ""),
        SCOPE: lsGet("SCOPE", "base"), // base | all
        DELAY_MS: lsGet("DELAY_MS", 200),
        COLLAPSED: lsGet("COLLAPSED", false),
    };

    // Prefs written by earlier versions that no longer mean anything.
    const PREFS_VERSION = 3;
    const STALE_KEYS = ["AUTO_LIMIT", "PAGE_LIMIT", "TOKEN", "OWNED_INDEX", "COLLECTION_ID"];
    (function migratePrefs() {
        if (lsGet("PREFS_VERSION", 0) === PREFS_VERSION) return;
        for (const k of STALE_KEYS) {
            try {
                localStorage.removeItem(LS_PREFIX + k);
            } catch {}
        }
        lsSet("PREFS_VERSION", PREFS_VERSION);
    })();

    const PAGE_SIZE = 30; // server caps pages at 30 regardless of `limit`
    const HARD_PAGE_CAP = 40; // 1200 cards; no real set is close

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ------------------------------------------------------------------
    // Account id — from any JWT the page has stored, else typed in
    // ------------------------------------------------------------------
    const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function decodeJwtPayload(tok) {
        try {
            const b = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            return JSON.parse(decodeURIComponent(escape(atob(b + "=".repeat((4 - (b.length % 4)) % 4)))));
        } catch {
            return null;
        }
    }

    function* storageStrings() {
        for (const store of [localStorage, sessionStorage]) {
            let keys = [];
            try {
                keys = Object.keys(store);
            } catch {
                continue;
            }
            for (const k of keys) {
                if (k.startsWith(LS_PREFIX)) continue;
                try {
                    const v = store.getItem(k);
                    if (v) yield v;
                } catch {}
            }
        }
        try {
            if (document.cookie) yield document.cookie;
        } catch {}
    }

    // Newest token wins, by its `date` claim.
    function detectAuth() {
        let best = null;
        for (const s of storageStrings()) {
            for (const tok of s.match(JWT_RE) || []) {
                const p = decodeJwtPayload(tok);
                const u = p && String(p.username || "");
                if (!u || !UUID_RE.test(u)) continue;
                const ts = Date.parse(p.date || "") || 0;
                if (!best || ts > best.ts) best = { acct: u, token: tok, ts };
            }
        }
        return best;
    }

    // The manual field takes either a bare account UUID or a full JWT; a JWT is
    // better, because some endpoints answer 401 without an Authorization header.
    function resolveAccount() {
        const manual = String(CONFIG.MANUAL_ACCOUNT || "").trim();
        if (UUID_RE.test(manual)) {
            CONFIG.ACCOUNT_ID = manual;
            CONFIG.TOKEN = "";
            CONFIG.ACCOUNT_SOURCE = "manual uuid (no token)";
            return;
        }
        if (JWT_RE.test(manual)) {
            const p = decodeJwtPayload(manual);
            const u = p && String(p.username || "");
            if (u && UUID_RE.test(u)) {
                CONFIG.ACCOUNT_ID = u;
                CONFIG.TOKEN = manual;
                CONFIG.ACCOUNT_SOURCE = "manual token";
                return;
            }
        }
        const found = detectAuth();
        if (!found)
            throw new Error("no token found — log in on this page, or paste your token / account UUID");
        CONFIG.ACCOUNT_ID = found.acct;
        CONFIG.TOKEN = found.token;
        CONFIG.ACCOUNT_SOURCE = "page token";
    }

    // ------------------------------------------------------------------
    // HTTP
    // ------------------------------------------------------------------
    const qs = (o) =>
        Object.entries(o)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");

    function api(path) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: CONFIG.BASE + path,
                headers: {
                    Accept: "application/json, text/plain, */*",
                    Origin: "https://app.getcollectr.com",
                    Referer: "https://app.getcollectr.com/",
                    "x-aim-plugin-installed": "true",
                    ...(CONFIG.TOKEN ? { Authorization: CONFIG.TOKEN } : {}),
                },
                onload: (r) => {
                    if (r.status === 401)
                        return reject(
                            new Error(
                                `HTTP 401 on ${path.split("?")[0]} — token ${CONFIG.TOKEN ? "was sent but rejected (expired? re-login, then Reset)" : "missing (log in, or paste a token)"}`
                            )
                        );
                    if (r.status < 200 || r.status >= 300)
                        return reject(new Error(`HTTP ${r.status} on ${path.slice(0, 90)}`));
                    try {
                        resolve(JSON.parse(r.responseText));
                    } catch (e) {
                        reject(new Error(`bad JSON on ${path.slice(0, 90)}`));
                    }
                },
                onerror: () => reject(new Error(`network error on ${path.slice(0, 90)}`)),
                ontimeout: () => reject(new Error(`timeout on ${path.slice(0, 90)}`)),
                timeout: 30000,
            });
        });
    }

    // ------------------------------------------------------------------
    // Set / card helpers
    // ------------------------------------------------------------------
    function parseGroupId(raw) {
        const s = String(raw || "").trim();
        if (!s) return "";
        if (/^\d+$/.test(s)) return s;
        const m = s.match(/[?&]groupId=(\d+)/);
        return m ? m[1] : "";
    }

    function groupIdFromLocation() {
        try {
            const u = new URL(location.href);
            return u.searchParams.get("groupId") || "";
        } catch {
            return "";
        }
    }

    // "036/132" -> {num: 36, denom: 132}
    function parseCardNumber(raw) {
        const m = String(raw || "").match(/(\d+)\s*\/\s*(\d+)/);
        if (m) return { num: Number(m[1]), denom: Number(m[2]) };
        const only = String(raw || "").match(/(\d+)/);
        return { num: only ? Number(only[1]) : NaN, denom: NaN };
    }

    // Base = printed within the set size. Secrets/promos number above it.
    //
    // Older sets number cards bare ("31", not "031/102"), so when the number
    // carries no denominator the set size stands in for one. Without this
    // fallback every card in such a set is judged non-base and the base scope
    // comes back empty (seen on Noble Victories, groupId 1385).
    function isBaseCard(card, setSize) {
        const { num, denom } = parseCardNumber(card.card_number);
        if (!Number.isFinite(num)) return false;
        const ceiling = Number.isFinite(denom) ? denom : Number(setSize);
        if (!Number.isFinite(ceiling) || ceiling <= 0) return true; // nothing to judge against
        return num <= ceiling;
    }

    const hasDenominator = (card) => Number.isFinite(parseCardNumber(card.card_number).denom);

    const pageSignature = (rows) => rows.map((r) => r.product_id).join(",");

    // ------------------------------------------------------------------
    // The scan: catalog page -> ownership overlay for that page's ids
    // ------------------------------------------------------------------
    // opts.skipOwnership: walk only the catalog pages. Used by the image
    // backfill, which already knows which cards are missing and needs just
    // the artwork and rarity — half the requests of a real scan.
    async function scanSet(groupId, setStatus, shouldAbort, opts) {
        const cards = [];
        const seen = new Set();
        const owned = new Map(); // product_id -> quantity
        let meta = { groupDetails: {}, setDetails: {} };
        let declaredTotal = 0;
        let offset = 0;
        let prevSig = null;
        let stop = "";
        let overlayRows = 0;

        for (let page = 0; page < HARD_PAGE_CAP; page++) {
            if (shouldAbort()) {
                stop = "stopped";
                break;
            }
            setStatus(
                `set ${groupId}: offset=${offset} cards=${cards.length}` +
                    (declaredTotal ? `/${declaredTotal}` : "") +
                    ` owned=${owned.size}`
            );

            const res = await api(
                "/catalog?" +
                    qs({
                        username: CONFIG.ACCOUNT_ID,
                        filters: "cards",
                        offset,
                        limit: PAGE_SIZE,
                        groupId,
                        unstackedView: "false",
                    })
            );
            if (!declaredTotal) {
                meta = { groupDetails: res.groupDetails || {}, setDetails: res.setDetails || {} };
                const n = Number(meta.setDetails.number_of_cards_in_group);
                if (Number.isFinite(n) && n > 0) declaredTotal = n;
            }

            const rows = (res && res.data) || [];
            if (rows.length === 0) break;

            const sig = pageSignature(rows);
            if (sig === prevSig) {
                stop = `offset ignored by API — same ${rows.length} rows repeated at offset ${offset}`;
                break;
            }
            prevSig = sig;

            const before = cards.length;
            const pageIds = [];
            let foreign = 0;
            for (const row of rows) {
                const rowGroup = String(row.catalog_group_id || "");
                if (rowGroup && rowGroup !== String(groupId)) {
                    foreign++;
                    continue;
                }
                const pid = String(row.product_id);
                pageIds.push(pid);
                if (seen.has(pid)) continue;
                seen.add(pid);
                cards.push(row);
            }
            if (foreign) {
                stop = `API left group ${groupId} at offset ${offset} (${foreign} foreign rows)`;
                break;
            }
            if (cards.length === before) {
                stop = `no new cards at offset ${offset}`;
                break;
            }

            // Ownership overlay for exactly these ids — this is the only
            // request that knows what you own.
            if (pageIds.length && !(opts && opts.skipOwnership)) {
                await sleep(CONFIG.DELAY_MS);
                const ov = await api(
                    `/collections/${encodeURIComponent(CONFIG.ACCOUNT_ID)}/products?` +
                        qs({
                            allCollections: "true",
                            unstackedView: "false",
                            productIds: pageIds.join(","),
                        })
                );
                const ovRows = (ov && ov.data) || [];
                overlayRows += ovRows.length;
                for (const r of ovRows) {
                    const qty = Number(r.quantity || 0);
                    // Rows for cards you do not own are either omitted or
                    // flagged false; both are handled by requiring a positive.
                    if (r.is_owned === true || qty > 0)
                        owned.set(String(r.product_id), Number.isFinite(qty) && qty > 0 ? qty : 1);
                }
            }

            offset += rows.length;
            if (declaredTotal && cards.length >= declaredTotal) break;
            if (declaredTotal && offset > declaredTotal + 2 * PAGE_SIZE) {
                stop = `walked past set size (${declaredTotal}) at offset ${offset}`;
                break;
            }
            await sleep(CONFIG.DELAY_MS);
        }

        if (stop) console.warn("[collectr-missing]", stop);
        return { cards, owned, stop, overlayRows, declaredTotal, groupId: String(groupId), ...meta };
    }

    // ------------------------------------------------------------------
    // Diff
    // ------------------------------------------------------------------
    // "Erika's Oddish (Poke Ball)" -> "Erika's Oddish"
    // "Cynthia's Spiritomb - 133/217 (Energy Symbol Pattern)" -> "Cynthia's Spiritomb"
    function baseName(name) {
        return String(name || "")
            .replace(/\s*\(.*$/, "")
            .replace(/\s*-\s*\d+\s*\/\s*\d+\s*$/, "")
            .trim();
    }

    // Thumbnails come straight off the CDN, so the HTML view needs no extra
    // requests. The extension varies per product (jpg/webp/png), so the
    // filename is stored rather than rebuilt from the product_id.
    const IMG_BASE = "https://public.getcollectr.com/public-assets/products/";
    const IMG_PARAMS = "?optimizer=image&format=webp&width=300&quality=80&strip=metadata";
    const IMG_PARAMS_BIG = "?optimizer=image&format=webp&width=900&quality=85&strip=metadata";
    const imgSrc = (file) => (file ? IMG_BASE + file + IMG_PARAMS : "");
    const imgSrcBig = (file) => (file ? IMG_BASE + file + IMG_PARAMS_BIG : "");
    const imgFile = (url) => {
        const path = String(url || "").split("?")[0];
        const file = path.slice(path.lastIndexOf("/") + 1);
        return /^product_/.test(file) ? file : "";
    };

    // Collectr's product names are not typed consistently: "Team Rocket's
    // exeggutor" arrives with one space in /catalog and two in the ownership
    // overlay, and apostrophes come as both ' and \u2019. Those differences are
    // invisible on screen but split one card into two groups, which loses the
    // owned printing. Everything that keys a card goes through here.
    const keyName = (name) =>
        baseName(name)
            .normalize("NFKC")
            .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")
            .replace(/[\u2010-\u2015]/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    const keyNumber = (n) => String(n == null ? "" : n).replace(/\s+/g, "").toLowerCase();
    const groupKey = (number, name) => `${keyNumber(number)}|${keyName(name)}`;

    function buildResult(scan) {
        const scoped =
            CONFIG.SCOPE === "base"
                ? scan.cards.filter((c) => isBaseCard(c, scan.declaredTotal))
                : scan.cards.slice();

        // One entry per printed card, not per printing. Any owned variant marks
        // the whole card as obtained.
        const groups = new Map();
        for (const c of scoped) {
            const pid = String(c.product_id);
            const number = String(c.card_number || "").trim();
            // Displayed name keeps its own spacing tidy; the key is normalized.
            const name = baseName(c.product_name).replace(/\s+/g, " ").trim();
            const key = groupKey(number, c.product_name);
            const { num } = parseCardNumber(number);
            let g = groups.get(key);
            if (!g) {
                g = {
                    card_number: number,
                    name,
                    sort: Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER,
                    image: imgFile(c.image_url),
                    rarity: String(c.rarity || "").trim(),
                    variants: [],
                    ownedVariants: 0,
                };
                groups.set(key, g);
            }
            if (!g.image) g.image = imgFile(c.image_url);
            if (!g.rarity) g.rarity = String(c.rarity || "").trim();
            const qty = scan.owned.get(pid) || 0;
            g.variants.push({ product_id: pid, label: String(c.product_name || "").trim(), qty });
            if (qty > 0) g.ownedVariants++;
        }

        const rows = [...groups.values()].sort(
            (a, b) => a.sort - b.sort || a.card_number.localeCompare(b.card_number) || a.name.localeCompare(b.name)
        );
        for (const g of rows) g.variantLabels = g.variants.map((v) => v.label).join(" | ");
        const missing = rows.filter((g) => g.ownedVariants === 0);

        const variantTotal = scoped.length;
        const variantsMissing = missing.reduce((n, g) => n + g.variants.length, 0);

        const warn = [];
        const reported = Number(scan.setDetails.cards_owned_in_group);
        if (Number.isFinite(reported) && reported !== scan.owned.size)
            warn.push(`set reports ${reported} owned, overlay found ${scan.owned.size} printings`);
        if (scan.declaredTotal && scan.cards.length !== scan.declaredTotal)
            warn.push(`walked ${scan.cards.length} of ${scan.declaredTotal} printings in the set`);
        if (scan.overlayRows === 0) warn.push("ownership overlay returned nothing — every card will look missing");
        if (CONFIG.SCOPE === "base" && scan.cards.length && !scan.cards.some(hasDenominator))
            warn.push(
                `set numbers cards without a total (e.g. "${String((scan.cards[0] || {}).card_number || "")}") — base/secret split unavailable, judging against set size ${scan.declaredTotal || "?"}`
            );
        if (scan.stop && scan.stop !== "stopped") warn.push(scan.stop);

        return {
            rows,
            missing,
            warn,
            scope: CONFIG.SCOPE,
            setName: scan.setDetails.catalog_group_name || "",
            // Collectr's own chronological set index. groupId is not a usable
            // substitute: 604 (Base Set Unlimited) releases before 1418 (WoTC
            // Promo), so sorting by id scrambles the pre-2023 sets.
            setOrder: Number(scan.setDetails.set_order_number) || 0,
            setSize: scan.declaredTotal,
            ownedTotal: scan.owned.size,
            variantTotal,
            variantsMissing,
            stopped: scan.stop === "stopped",
        };
    }

    const HEAD = ["card_number", "name"];
    const cells = (r) => [r.card_number, r.name];
    const SESSION_HEAD = ["set", ...HEAD];
    const sessionCells = (r) => [r.set, ...cells(r)];
    const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const toTSV = (rows, head = HEAD, fn = cells) =>
        [head.join("\t"), ...rows.map((r) => fn(r).join("\t"))].join("\n");
    const toCSV = (rows, head = HEAD, fn = cells) =>
        [head.join(","), ...rows.map((r) => fn(r).map(quote).join(","))].join("\n");

    // ------------------------------------------------------------------
    // Session — per-set snapshots accumulated across sets, kept in
    // localStorage until explicitly cleared. Nothing is stored implicitly.
    // ------------------------------------------------------------------
    const SESSION_KEY = "SESSION";
    const SESSION_VERSION = 2;
    // v1 entries lack image/rarity. They stay usable (placeholder tiles), so an
    // upgrade must never throw a real session away.
    const SESSION_VERSIONS = new Set([1, 2]);
    const emptySession = () => ({ version: SESSION_VERSION, sets: {} });

    function loadSession() {
        const raw = lsGet(SESSION_KEY, null);
        if (!raw || !SESSION_VERSIONS.has(raw.version) || !raw.sets || typeof raw.sets !== "object")
            return emptySession();
        const out = emptySession();
        for (const [gid, e] of Object.entries(raw.sets)) {
            if (!e || !Array.isArray(e.missing)) continue; // drop anything malformed
            out.sets[String(gid)] = e;
        }
        return out;
    }

    // Sets read newest first, by Collectr's own chronological set order
    // reversed. Entries stored before v3.4.0 have no setOrder; rank 0 keeps
    // them last, by name, until re-added or picked up by the backfill.
    const setRank = (e) => Number(e && e.setOrder) || 0;
    const bySetOrder = (a, b) => setRank(b) - setRank(a) || String(a.name).localeCompare(String(b.name));

    // Returns false when the write failed (quota) so the caller can say so.
    const saveSession = (s) => lsSet(SESSION_KEY, s);

    // Snapshot of one scan's result. Frozen at add time: changing the scope
    // toggle afterwards re-renders the live view but never rewrites this.
    function sessionAdd(out, groupId) {
        const s = loadSession();
        s.sets[String(groupId)] = {
            groupId: String(groupId),
            name: out.setName || String(groupId),
            setOrder: Number(out.setOrder) || 0,
            setSize: out.setSize,
            ownedTotal: out.ownedTotal,
            scope: out.scope,
            ts: new Date().toISOString(),
            missing: out.missing.map((g) => ({
                card_number: g.card_number,
                name: g.name,
                printings: g.variants.length,
                variantLabels: g.variantLabels,
                image: g.image || "",
                rarity: g.rarity || "",
            })),
        };
        return saveSession(s) ? s : null;
    }

    function sessionRemove(groupId) {
        const s = loadSession();
        delete s.sets[String(groupId)];
        saveSession(s);
        return s;
    }

    function sessionClear() {
        try {
            localStorage.removeItem(LS_PREFIX + SESSION_KEY);
        } catch {}
        return emptySession();
    }

    function sessionRows(s) {
        const rows = [];
        for (const e of Object.values(s.sets))
            for (const m of e.missing) {
                const { num } = parseCardNumber(m.card_number);
                rows.push({
                    set: e.name,
                    setOrder: Number(e.setOrder) || 0,
                    groupId: e.groupId,
                    sort: Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER,
                    ...m,
                });
            }
        rows.sort(
            (a, b) =>
                bySetOrder({ setOrder: a.setOrder, name: a.set }, { setOrder: b.setOrder, name: b.set }) ||
                a.sort - b.sort ||
                a.card_number.localeCompare(b.card_number)
        );
        return rows;
    }

    function sessionStats(s) {
        const sets = Object.values(s.sets);
        return {
            setCount: sets.length,
            cardCount: sets.reduce((n, e) => n + e.missing.length, 0),
            scopes: new Set(sets.map((e) => e.scope)),
            names: sets.map((e) => e.name),
        };
    }

    // ------------------------------------------------------------------
    // HTML view — a standalone page built from the session. Pure function of
    // the session (no DOM), so it can be unit-tested in node and is reused by
    // both the blob-URL tab and the file download.
    //
    // Interactivity is deliberately CSS-first: a blob: document inherits the
    // opener's CSP, so the inline <script> may be blocked. Collapse
    // (<details>), the rarity filter and the compact toggle are pure CSS and
    // always work; only the search box needs JS, and it hides itself with a
    // note when the script never runs.
    // ------------------------------------------------------------------
    // The viewer's behaviour, kept as source text because it is needed twice: as
    // the inline <script> of the saved file, and compiled in this userscript's
    // own context to wire up the blob tab, whose inline scripts Collectr's CSP
    // blocks (a blob: document inherits the opener's policy). One source, so the
    // two can never drift apart. arguments[0] is the document to wire.
    const VIEWER_SRC = `
var doc = arguments[0] || document;
var win = doc.defaultView || window;
doc.documentElement.className = "js";
var q = doc.getElementById("q");
var qn = doc.getElementById("qn");
var tiles = [].slice.call(doc.querySelectorAll(".tile"));
var setsEls = [].slice.call(doc.querySelectorAll(".set"));
var rars = [].slice.call(doc.querySelectorAll("input.rar"));
function apply() {
  var t = q.value.trim().toLowerCase();
  // Ticked rarities are an OR set; none ticked means no rarity restriction.
  var on = rars.filter(function (r) { return r.checked; }).map(function (r) { return r.dataset.r; });
  var shown = 0;
  for (var i = 0; i < tiles.length; i++) {
    var el = tiles[i];
    var hit = !t || el.dataset.q.indexOf(t) !== -1;
    if (hit && on.length) {
      hit = false;
      for (var k = 0; k < on.length; k++) if (el.classList.contains(on[k])) { hit = true; break; }
    }
    el.hidden = !hit;
    if (hit) shown++;
  }
  for (var j = 0; j < setsEls.length; j++)
    setsEls[j].hidden = !setsEls[j].querySelector(".tile:not([hidden])");
  qn.textContent = t || on.length ? shown + " shown" : "";
}
q.addEventListener("input", apply);
doc.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && win.location.hash) win.location.hash = "";
});
rars.forEach(function (r) { r.addEventListener("change", apply); });
doc.getElementById("clr").addEventListener("click", function () {
  rars.forEach(function (r) { r.checked = false; });
  apply();
});

// Export exactly what is on screen, same columns as the panel's session CSV.
function qt(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
doc.getElementById("csvb").addEventListener("click", function () {
  var lines = ["set,card_number,name"];
  for (var i = 0; i < tiles.length; i++) {
    var el = tiles[i];
    if (el.hidden || el.closest(".set").hidden) continue;
    lines.push([el.dataset.set, el.dataset.num, el.dataset.name].map(qt).join(","));
  }
  var csv = lines.join("\\n");
  var n = lines.length - 1;
  function fallback() {
    var url = win.URL.createObjectURL(new win.Blob([csv], { type: "text/csv" }));
    var a = doc.createElement("a");
    a.href = url;
    a.download = "collectr-missing.csv";
    doc.body.appendChild(a);
    a.click();
    a.remove();
    win.setTimeout(function () { win.URL.revokeObjectURL(url); }, 30000);
    qn.textContent = "downloaded " + n + " rows";
  }
  if (win.navigator.clipboard && win.navigator.clipboard.writeText)
    win.navigator.clipboard.writeText(csv).then(function () {
      qn.textContent = "copied " + n + " rows";
    }, fallback);
  else fallback();
});
`;

    // Page CSP does not reach this context, so compiling here is what makes the
    // blob tab interactive at all.
    function wireViewer(doc) {
        try {
            new Function(VIEWER_SRC)(doc);
            return true;
        } catch (e) {
            console.warn("[collectr-missing] could not wire the HTML view:", e.message);
            return false;
        }
    }

    const esc = (v) =>
        String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

    function renderSessionHtml(session) {
        const s = session && session.sets ? session : emptySession();
        const stats = sessionStats(s);
        const sets = Object.values(s.sets).sort(bySetOrder);
        const rarities = [
            ...new Set(sets.flatMap((e) => e.missing.map((m) => String(m.rarity || "").trim())).filter(Boolean)),
        ].sort();
        // 0 is "all"; each rarity gets index+1 so a tile carries class r<n>.
        const rIdx = new Map(rarities.map((r, i) => [r, i + 1]));

        // Rarity filters combine (OR). With none ticked everything shows; as soon
        // as one is ticked, all tiles hide and each ticked rarity brings its own
        // back. :has() keeps this working even if the inline script is blocked.
        const rarityCss =
            `body:has(input.rar:checked) .tile{display:none}\n` +
            rarities
                .map(
                    (r, i) =>
                        `body:has(#rar${i + 1}:checked) .tile.r${i + 1}{display:flex}` +
                        `#rar${i + 1}:checked~.bar label[for=rar${i + 1}]{background:#2f6d4f;border-color:#3b8a64;color:#fff}`
                )
                .join("\n");

        const radios =
            rarities
                .map((r, i) => `<input type="checkbox" class="rar" id="rar${i + 1}" data-r="r${i + 1}">`)
                .join("") + `<input type="checkbox" id="compact">`;

        const chips =
            `<button type="button" id="clr" class="chip js-chip">clear rarities</button>` +
            `<button type="button" id="csvb" class="chip js-chip">copy CSV shown</button>` +
            rarities.map((r, i) => `<label for="rar${i + 1}">${esc(r)}</label>`).join("") +
            `<label for="compact" class="tog">compact</label>`;

        // Zoom uses :target, so clicking a card works even when the inline
        // script is blocked. The big image sits in a hidden overlay, and
        // display:none keeps a lazy <img> from fetching until it is opened.
        const boxes = [];
        let seq = 0;
        const tile = (setName, m) => {
            const n = rIdx.get(String(m.rarity || "").trim()) || 0;
            const file = String(m.image || "");
            const q = `${m.card_number} ${m.name} ${setName} ${m.rarity || ""}`.toLowerCase();
            const alt = esc(m.card_number + " " + m.name);
            const img = file
                ? `<img loading="lazy" src="${esc(imgSrc(file))}" alt="${alt}">`
                : `<div class="ph">no image</div>`;
            const printings = Number(m.printings) > 1 ? `<span class="pb">&times;${Number(m.printings)}</span>` : "";
            const id = `c${++seq}`;
            boxes.push(
                `<div class="lb" id="${id}"><a class="lbbg" href="#" aria-label="close"></a>` +
                    `<figure>` +
                    (file ? `<img loading="lazy" src="${esc(imgSrcBig(file))}" alt="${alt}">` : `<div class="ph big">no image</div>`) +
                    `<figcaption><b>${esc(m.card_number)} ${esc(m.name)}</b>` +
                    `<span>${esc(setName)}${m.rarity ? " &middot; " + esc(m.rarity) : ""}` +
                    `${Number(m.printings) > 1 ? ` &middot; ${Number(m.printings)} printings` : ""}</span>` +
                    (m.variantLabels ? `<span class="vl">${esc(m.variantLabels)}</span>` : "") +
                    `<a class="lbx" href="#">close</a></figcaption></figure></div>`
            );
            return (
                `<article class="tile${n ? " r" + n : ""}" data-q="${esc(q)}"` +
                ` data-set="${esc(setName)}" data-num="${esc(m.card_number)}" data-name="${esc(m.name)}"` +
                ` title="${esc(m.variantLabels || m.name)}">` +
                `<a class="zoom" href="#${id}">` +
                `<div class="art">${img}${printings}</div>` +
                `<div class="num">${esc(m.card_number)}</div>` +
                `<div class="nm">${esc(m.name)}</div>` +
                (m.rarity ? `<div class="rar">${esc(m.rarity)}</div>` : "") +
                `</a></article>`
            );
        };

        const sections = sets
            .map((e) => {
                const tiles = e.missing.map((m) => tile(e.name, m)).join("");
                return (
                    `<details open class="set" data-set="${esc(e.name)}">` +
                    `<summary><b>${esc(e.name)}</b>` +
                    `<span class="n">${e.missing.length} missing</span>` +
                    `<span class="meta">owned ${esc(e.ownedTotal)} printings &middot; set says ${esc(e.setSize || "?")} cards &middot; ${esc(e.scope)}</span>` +
                    `</summary><div class="grid">${tiles}</div></details>`
                );
            })
            .join("\n");

        const mixed =
            stats.scopes.size > 1
                ? `<p class="warn">This session mixes <b>base</b> and <b>all</b> scans, so the totals are not directly comparable.</p>`
                : "";
        const empty = sets.length ? "" : `<p class="warn">Session is empty — add a set first.</p>`;

        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collectr — missing cards</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#15171c;color:#e7e9ee;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:18px 20px 10px;border-bottom:1px solid #2b2f38;background:#1b1e25}
h1{margin:0 0 4px;font-size:18px;font-weight:600}
.sub{color:#9aa2b1;font-size:12px}
.warn{margin:10px 0 0;padding:8px 10px;border:1px solid #6b5326;background:#2a2312;
  border-radius:6px;color:#f0d9a5;font-size:12px}
input.rar,#compact{position:absolute;left:-9999px}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 20px;
  border-bottom:1px solid #2b2f38;position:sticky;top:0;background:#1b1e25;z-index:5}
.bar label{border:1px solid #333947;background:#0f1116;color:#9aa2b1;border-radius:999px;
  padding:3px 10px;font-size:12px;cursor:pointer;user-select:none}
.bar label:hover{border-color:#4a5566;color:#e7e9ee}
.bar .chip{border:1px solid #333947;background:#0f1116;color:#9aa2b1;border-radius:999px;
  padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.bar .chip:hover{border-color:#4a5566;color:#e7e9ee}
.js-chip{display:none}
html.js .js-chip{display:inline-block}
#compact:checked~.bar label[for=compact]{background:#2f6d4f;border-color:#3b8a64;color:#fff}
#q{background:#0f1116;color:#e7e9ee;border:1px solid #333947;border-radius:6px;
  padding:4px 8px;font:inherit;min-width:200px;flex:1}
.js-only{display:none}
html.js .js-only{display:flex;flex:1;gap:6px;align-items:center}
html.js .nojs{display:none}
.nojs{color:#9aa2b1;font-size:12px;margin-left:auto}
.qn{color:#9aa2b1;font-size:12px;white-space:nowrap}
main{padding:14px 20px 40px}
.set{border:1px solid #2b2f38;border-radius:8px;margin-bottom:14px;background:#171a20}
.set[hidden]{display:none !important}
summary{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:10px 12px;
  cursor:pointer;user-select:none;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";color:#9aa2b1;font-size:11px}
.set[open]>summary::before{content:"\\25BE"}
summary b{font-size:14px}
summary .n{color:#f0a5a5;font-size:12px}
summary .meta{color:#9aa2b1;font-size:11px;margin-left:auto}
.grid{display:grid;gap:10px;padding:0 12px 14px;
  grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
#compact:checked~main .grid{grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px}
#compact:checked~main .nm{font-size:10px}
#compact:checked~main .rar{display:none}
.tile{display:flex;flex-direction:column;gap:3px;background:#1d212a;border:1px solid #2b2f38;
  border-radius:8px;padding:7px}
.tile[hidden]{display:none !important}
.art{position:relative;aspect-ratio:5/7;border-radius:5px;overflow:hidden;background:#0f1116}
.art img{width:100%;height:100%;object-fit:cover;display:block}
.ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
  color:#5d6575;font-size:10px}
.pb{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.72);border:1px solid #3a4454;
  border-radius:999px;padding:0 5px;font-size:10px;color:#e7e9ee}
.num{color:#9aa2b1;font-size:11px;font-variant-numeric:tabular-nums}
.nm{font-size:12px;line-height:1.3;word-break:break-word}
.rar{color:#7f8899;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.zoom{display:flex;flex-direction:column;gap:3px;color:inherit;text-decoration:none}
.tile:hover{border-color:#4a5566}
.lb{display:none}
.lb:target{display:flex;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;
  padding:24px}
.lbbg{position:absolute;inset:0;background:rgba(6,7,10,.86);backdrop-filter:blur(2px)}
.lb figure{position:relative;margin:0;display:flex;gap:16px;align-items:center;max-width:min(1000px,94vw)}
.lb img{max-height:84vh;max-width:min(62vw,620px);border-radius:10px;display:block;
  box-shadow:0 18px 50px rgba(0,0,0,.6)}
.lb .ph.big{width:300px;height:420px;border:1px dashed #3a4454;border-radius:10px;background:#0f1116}
.lb figcaption{display:flex;flex-direction:column;gap:6px;max-width:300px}
.lb figcaption b{font-size:16px}
.lb figcaption span{color:#9aa2b1;font-size:12px}
.lb figcaption .vl{color:#7f8899;font-size:11px;line-height:1.5}
.lbx{align-self:flex-start;margin-top:6px;border:1px solid #3a4454;border-radius:999px;
  padding:3px 12px;color:#e7e9ee;text-decoration:none;font-size:12px}
.lbx:hover{background:#2a3240}
@media (max-width:700px){.lb figure{flex-direction:column;gap:10px}
  .lb img{max-width:86vw;max-height:62vh}.lb figcaption{max-width:86vw}}
${rarityCss}
@media print{
  body{background:#fff;color:#000}
  header,.bar{position:static;background:#fff;border-color:#bbb}
  .sub,.num,.rar,summary .meta{color:#444}
  .bar{display:none}
  .warn{border-color:#999;background:#fff;color:#000}
  .set{background:#fff;border-color:#bbb;break-inside:auto}
  .set:not([open])>.grid{display:grid !important}
  .grid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}
  .tile{background:#fff;border-color:#ccc;break-inside:avoid}
  .art{background:#eee}
  .lb{display:none !important}
}
</style></head>
<body>
${radios}
<header>
  <h1>Missing cards</h1>
  <div class="sub">${stats.cardCount} card${stats.cardCount === 1 ? "" : "s"} across ${stats.setCount} set${
            stats.setCount === 1 ? "" : "s"
        } &middot; generated ${esc(new Date().toLocaleString())}</div>
  ${mixed}${empty}
</header>
<div class="bar">
  <span class="js-only"><input id="q" type="search" placeholder="search number, name, set, rarity"><span id="qn" class="qn"></span></span>
  <span class="nojs">search and export need JavaScript — reopen this page from the panel&#39;s View HTML button</span>
  ${chips}
</div>
<main>
${sections}
</main>
${boxes.join("\n")}
<script>(function(){${VIEWER_SRC}})();<\/script>
</body></html>`;
    }

    // ------------------------------------------------------------------
    // Image backfill — sets added before v3.3.0 have no image or rarity. Their
    // missing lists are still valid, so only the catalog pages are re-walked
    // (no ownership overlay) and the stored cards are patched in place.
    // ------------------------------------------------------------------
    const needsBackfill = (e) => !Number(e.setOrder) || e.missing.some((m) => !m.image);
    const cardKey = groupKey;

    async function backfillImages(setStatus, shouldAbort) {
        let session = loadSession();
        const todo = Object.values(session.sets).filter(needsBackfill);
        if (!todo.length) return { sets: 0, filled: 0, misses: 0, saved: true };

        let filled = 0;
        let misses = 0;
        let done = 0;
        for (const entry of todo) {
            if (shouldAbort()) break;
            const label = `${entry.name} (${++done}/${todo.length})`;
            const scan = await scanSet(entry.groupId, (t) => setStatus(`backfill ${label}: ${t}`), shouldAbort, {
                skipOwnership: true,
            });
            const art = new Map();
            for (const c of scan.cards) {
                const k = cardKey(c.card_number, c.product_name);
                if (art.has(k)) continue;
                art.set(k, { image: imgFile(c.image_url), rarity: String(c.rarity || "").trim() });
            }
            // Re-read each time: a scan takes seconds and the panel stays usable.
            session = loadSession();
            const live = session.sets[String(entry.groupId)];
            if (!live) continue;
            if (!Number(live.setOrder)) live.setOrder = Number(scan.setDetails.set_order_number) || 0;
            for (const m of live.missing) {
                if (m.image) continue;
                const hit = art.get(cardKey(m.card_number, m.name));
                if (!hit || !hit.image) {
                    misses++;
                    continue;
                }
                m.image = hit.image;
                if (!m.rarity) m.rarity = hit.rarity;
                filled++;
            }
            if (!saveSession(session)) return { sets: done, filled, misses, saved: false };
        }
        return { sets: done, filled, misses, saved: true };
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    const css = `
    #cm-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:420px;max-height:78vh;
      display:flex;flex-direction:column;background:#15171c;color:#e7e9ee;border:1px solid #2b2f38;
      border-radius:10px;font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;
      box-shadow:0 12px 34px rgba(0,0,0,.45);overflow:hidden}
    #cm-panel.cm-collapsed{width:auto;max-height:none}
    #cm-panel.cm-collapsed .cm-body{display:none}
    .cm-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1b1e25;
      border-bottom:1px solid #2b2f38;cursor:pointer;user-select:none}
    .cm-head b{font-weight:600;font-size:12px}
    .cm-head .cm-pill{margin-left:auto;font-size:11px;color:#9aa2b1}
    .cm-body{padding:10px;overflow:auto}
    .cm-row{display:flex;gap:6px;align-items:center;margin-bottom:7px;flex-wrap:wrap}
    .cm-row label{min-width:62px;color:#9aa2b1}
    #cm-panel input,#cm-panel select{background:#0f1116;color:#e7e9ee;border:1px solid #333947;
      border-radius:6px;padding:4px 6px;font:inherit;flex:1;min-width:0}
    #cm-panel button{background:#2a3240;color:#e7e9ee;border:1px solid #3a4454;border-radius:6px;
      padding:4px 9px;font:inherit;cursor:pointer}
    #cm-panel button:hover{background:#34404f}
    #cm-panel button.cm-primary{background:#2f6d4f;border-color:#3b8a64}
    #cm-panel button.cm-primary:hover{background:#38815d}
    #cm-panel button[disabled]{opacity:.5;cursor:default}
    .cm-tiny{font-size:11px;color:#9aa2b1}
    .cm-status{margin:6px 0;font-size:11px;color:#cfd4de;min-height:15px;word-break:break-word}
    .cm-warn{margin:6px 0;padding:6px 8px;border:1px solid #6b5326;background:#2a2312;
      border-radius:6px;color:#f0d9a5;font-size:11px;display:none}
    .cm-out{max-height:34vh;overflow:auto;border:1px solid #2b2f38;border-radius:6px;display:none}
    .cm-out table{border-collapse:collapse;width:100%}
    .cm-out th,.cm-out td{padding:3px 6px;border-bottom:1px solid #23262e;text-align:left;
      font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cm-out th{position:sticky;top:0;background:#1b1e25;color:#9aa2b1}
    .cm-t3 td:nth-child(1){width:70px;color:#9aa2b1}
    .cm-t3 td:nth-child(3){width:58px;text-align:right;color:#9aa2b1}
    .cm-t4 td:nth-child(1){max-width:110px;color:#9aa2b1}
    .cm-t4 td:nth-child(2){width:70px;color:#9aa2b1}
    .cm-t4 td:nth-child(4){width:58px;text-align:right;color:#9aa2b1}
    #cm-session{margin:2px 0 6px;color:#a8b6c6}
    #cm-session.cm-mixed{color:#f0d9a5}
  `;

    let aborted = false;
    let running = false;
    let result = null;

    function build() {
        if (document.getElementById("cm-panel")) return;

        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);

        const panel = document.createElement("div");
        panel.id = "cm-panel";
        if (CONFIG.COLLAPSED) panel.classList.add("cm-collapsed");
        panel.innerHTML = `
      <div class="cm-head"><b>Missing cards</b><span class="cm-pill">click to toggle</span></div>
      <div class="cm-body">
        <div class="cm-row"><label>Set</label>
          <input id="cm-set" placeholder="groupId or set URL" />
          <button id="cm-here">use page</button></div>
        <div class="cm-row"><label>Scope</label>
          <select id="cm-scope">
            <option value="base">base only (num &le; set size)</option>
            <option value="all">all cards incl. secrets</option>
          </select></div>
        <div class="cm-row"><label>Delay ms</label><input id="cm-delay" type="number" min="0" step="50" /></div>
        <div class="cm-row"><label>Account</label>
          <input id="cm-acct" placeholder="auto-detected — or paste token / UUID" /></div>
        <div class="cm-row">
          <button id="cm-find" class="cm-primary">Find missing</button>
          <button id="cm-stop" disabled>Stop</button>
          <button id="cm-copy" disabled>Copy</button>
          <button id="cm-csv" disabled>CSV</button>
          <button id="cm-reset">Reset</button></div>
        <div class="cm-row">
          <button id="cm-add" class="cm-primary">Add to session</button>
          <button id="cm-view">View: current</button>
          <button id="cm-scsv">Session CSV</button>
          <button id="cm-stsv">Session TSV</button>
          <button id="cm-html" class="cm-primary">View HTML</button>
          <button id="cm-fill">Backfill images</button>
          <button id="cm-dbg">Debug card</button>
          <button id="cm-save">Save HTML</button>
          <button id="cm-drop">Drop set</button>
          <button id="cm-sclear">Clear session</button></div>
        <div class="cm-tiny" id="cm-session"></div>
        <div class="cm-tiny" id="cm-auth"></div>
        <div class="cm-status" id="cm-status">idle</div>
        <div class="cm-warn" id="cm-warn"></div>
        <div class="cm-out" id="cm-out"></div>
      </div>`;
        document.body.appendChild(panel);

        const $ = (id) => panel.querySelector(id);
        const head = panel.querySelector(".cm-head");
        const setEl = $("#cm-set"),
            scopeEl = $("#cm-scope"),
            delayEl = $("#cm-delay"),
            acctEl = $("#cm-acct"),
            findBtn = $("#cm-find"),
            stopBtn = $("#cm-stop"),
            copyBtn = $("#cm-copy"),
            csvBtn = $("#cm-csv"),
            resetBtn = $("#cm-reset"),
            addBtn = $("#cm-add"),
            viewBtn = $("#cm-view"),
            sCsvBtn = $("#cm-scsv"),
            sTsvBtn = $("#cm-stsv"),
            htmlBtn = $("#cm-html"),
            fillBtn = $("#cm-fill"),
            dbgBtn = $("#cm-dbg"),
            saveBtn = $("#cm-save"),
            dropBtn = $("#cm-drop"),
            sClearBtn = $("#cm-sclear"),
            sessionEl = $("#cm-session"),
            authEl = $("#cm-auth"),
            statusEl = $("#cm-status"),
            warnEl = $("#cm-warn"),
            outEl = $("#cm-out");

        setEl.value = CONFIG.SET_INPUT || groupIdFromLocation();
        scopeEl.value = CONFIG.SCOPE;
        delayEl.value = CONFIG.DELAY_MS;
        acctEl.value = CONFIG.MANUAL_ACCOUNT;

        const setStatus = (t) => (statusEl.textContent = t);

        let session = loadSession();
        let view = "current"; // current | session
        let lastWarn = [];

        const sessionWarnings = () => {
            const st = sessionStats(session);
            return st.scopes.size > 1
                ? ["session mixes base and all scans — export will be inconsistent"]
                : [];
        };
        const showWarn = (list) => {
            lastWarn = list || [];
            const all = [...lastWarn, ...sessionWarnings()];
            if (!all.length) {
                warnEl.style.display = "none";
                warnEl.textContent = "";
                return;
            }
            warnEl.style.display = "block";
            warnEl.textContent = all.join(" · ");
        };
        const currentGroupId = () => parseGroupId(setEl.value) || groupIdFromLocation();

        function showSession() {
            const st = sessionStats(session);
            const gid = currentGroupId();
            const here = gid && session.sets[String(gid)];
            const names = st.names.slice(0, 4).join(", ") + (st.names.length > 4 ? ", …" : "");
            sessionEl.textContent =
                `session: ${st.setCount} set${st.setCount === 1 ? "" : "s"} · ${st.cardCount} cards` +
                (st.setCount ? ` · ${names}` : "") +
                (here ? ` · this set is in (${here.scope}, ${here.missing.length} missing)` : "");
            sessionEl.classList.toggle("cm-mixed", st.scopes.size > 1);
            const empty = st.setCount === 0;
            sCsvBtn.disabled = sTsvBtn.disabled = sClearBtn.disabled = empty;
            htmlBtn.disabled = saveBtn.disabled = empty;
            const stale = Object.values(session.sets).filter(needsBackfill).length;
            fillBtn.disabled = running || stale === 0;
            fillBtn.textContent = stale ? `Backfill images (${stale})` : "Backfill images";
            dropBtn.disabled = !here;
            viewBtn.textContent = `View: ${view}`;
            showWarn(lastWarn);
        }

        function showAuth() {
            try {
                resolveAccount();
                authEl.textContent =
                    `account: ${CONFIG.ACCOUNT_ID.slice(0, 8)}… (${CONFIG.ACCOUNT_SOURCE})` +
                    ` · token ${CONFIG.TOKEN ? "yes" : "no"} · ${PAGE_SIZE}/page`;
            } catch (e) {
                authEl.textContent = e.message;
            }
        }
        showAuth();
        showSession();

        head.onclick = () => {
            panel.classList.toggle("cm-collapsed");
            CONFIG.COLLAPSED = panel.classList.contains("cm-collapsed");
            lsSet("COLLAPSED", CONFIG.COLLAPSED);
        };
        $("#cm-here").onclick = (e) => {
            e.stopPropagation();
            const g = groupIdFromLocation();
            if (!g) return setStatus("no groupId in the current URL — open a set page");
            setEl.value = g;
            CONFIG.SET_INPUT = g;
            lsSet("SET_INPUT", g);
            setStatus(`set ${g} from page`);
            showSession();
        };
        setEl.onchange = () => {
            CONFIG.SET_INPUT = setEl.value.trim();
            lsSet("SET_INPUT", CONFIG.SET_INPUT);
            showSession();
        };
        scopeEl.onchange = () => {
            CONFIG.SCOPE = scopeEl.value;
            lsSet("SCOPE", CONFIG.SCOPE);
            if (result) render(buildResult(result.scan));
        };
        delayEl.onchange = () => {
            CONFIG.DELAY_MS = Math.max(0, Number(delayEl.value) || 0);
            lsSet("DELAY_MS", CONFIG.DELAY_MS);
        };
        acctEl.onchange = () => {
            CONFIG.MANUAL_ACCOUNT = acctEl.value.trim();
            lsSet("MANUAL_ACCOUNT", CONFIG.MANUAL_ACCOUNT);
            showAuth();
        };

        // headers: display labels; cols(row): the strings for one row.
        function drawTable(headers, rows, cols) {
            outEl.style.display = "block";
            outEl.innerHTML = "";
            const table = document.createElement("table");
            table.className = `cm-t${headers.length}`;
            const thead = document.createElement("thead");
            const trh = document.createElement("tr");
            headers.forEach((h) => {
                const th = document.createElement("th");
                th.textContent = h;
                trh.appendChild(th);
            });
            thead.appendChild(trh);
            table.appendChild(thead);
            const tb = document.createElement("tbody");
            for (const row of rows) {
                const tr = document.createElement("tr");
                const vals = cols(row);
                for (let i = 0; i < vals.length; i++) {
                    const td = document.createElement("td");
                    td.textContent = vals[i];
                    // All printings of this card, so it is clear what to look for.
                    td.title = row.variantLabels || vals[i];
                    tr.appendChild(td);
                }
                tb.appendChild(tr);
            }
            table.appendChild(tb);
            outEl.appendChild(table);
        }

        function renderSession() {
            view = "session";
            const rows = sessionRows(session);
            drawTable(["set", "#", "name", "printings"], rows, (r) => [
                r.set,
                r.card_number,
                r.name,
                String(r.printings),
            ]);
            const st = sessionStats(session);
            setStatus(`session view: ${st.cardCount} cards missing across ${st.setCount} sets`);
            showSession();
        }

        function render(r) {
            result = { ...(result || {}), out: r };
            view = "current";
            drawTable(["#", "name", "printings"], r.missing, (row) => [
                row.card_number,
                row.name,
                String(row.variants.length),
            ]);

            const scopeTxt = r.scope === "base" ? "base" : "all";
            setStatus(
                `${r.setName || "set"}: ${r.missing.length} missing of ${r.rows.length} ${scopeTxt} cards` +
                    ` (${r.variantsMissing}/${r.variantTotal} printings)` +
                    ` · owned ${r.ownedTotal} printings, set says ${r.setSize || "?"} cards` +
                    (r.stopped ? " · STOPPED early" : "")
            );
            showWarn(r.warn);
            copyBtn.disabled = csvBtn.disabled = r.missing.length === 0;
            showSession();
        }

        async function runScan() {
            if (running) return false;
            const groupId = currentGroupId();
            if (!groupId) {
                setStatus("no set — open a set page or paste its groupId");
                return false;
            }
            try {
                resolveAccount();
            } catch (e) {
                setStatus(e.message);
                return false;
            }
            running = true;
            aborted = false;
            findBtn.disabled = true;
            stopBtn.disabled = false;
            copyBtn.disabled = csvBtn.disabled = true;
            showWarn([]);
            outEl.style.display = "none";
            try {
                const scan = await scanSet(groupId, setStatus, () => aborted);
                result = { scan };
                render(buildResult(scan));
                return true;
            } catch (e) {
                setStatus(`failed: ${e.message}`);
                console.error("[collectr-missing]", e);
                return false;
            } finally {
                running = false;
                findBtn.disabled = false;
                stopBtn.disabled = true;
            }
        }

        findBtn.onclick = runScan;

        // Nothing is stored implicitly: a set joins the session only here.
        addBtn.onclick = async () => {
            if (running) return;
            const groupId = currentGroupId();
            if (!groupId) return setStatus("no set — open a set page or paste its groupId");
            // Reuse the scan already on screen when it is this set; scope changes
            // re-render from the same scan, so they need no new requests either.
            const fresh = result && result.scan && String(result.scan.groupId) === String(groupId);
            if (!fresh && !(await runScan())) return;
            if (!result || !result.out) return;
            const saved = sessionAdd(result.out, groupId);
            if (!saved) {
                session = loadSession();
                showSession();
                return showWarn(["session not saved — storage full; export and clear"]);
            }
            session = saved;
            const st = sessionStats(session);
            setStatus(
                `added ${result.out.setName || groupId} (${result.out.missing.length} missing) —` +
                    ` session: ${st.setCount} sets, ${st.cardCount} cards`
            );
            showSession();
        };

        viewBtn.onclick = () => {
            if (view === "current") return renderSession();
            view = "current";
            if (result && result.out) render(result.out);
            else {
                outEl.style.display = "none";
                setStatus("no scan in this view yet — click Find missing");
                showSession();
            }
        };

        // Generated fresh on every click: a blob URL cannot be overwritten and a
        // saved file cannot read the live session, so the tab is the current view
        // and the download is only a snapshot to keep.
        htmlBtn.onclick = () => {
            try {
                const url = URL.createObjectURL(
                    new Blob([renderSessionHtml(session)], { type: "text/html" })
                );
                // Inside the click gesture, so the popup blocker lets it through.
                const w = window.open(url, "_blank");
                if (!w && typeof GM_openInTab === "function") {
                    // No window handle, so nothing can be wired: CSS-only view.
                    GM_openInTab(url, { active: true });
                    setStatus("opened HTML view (search/export unavailable in this mode)");
                } else if (!w) {
                    return setStatus("popup blocked — allow popups for this site");
                } else {
                    const wire = () => wireViewer(w.document);
                    if (w.document && w.document.readyState === "complete") wire();
                    else w.addEventListener("load", wire, { once: true });
                }
                // Revoking at once can cut the new tab's load short.
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                const st = sessionStats(session);
                setStatus(`opened HTML view: ${st.cardCount} cards across ${st.setCount} sets`);
            } catch (e) {
                console.error("[collectr-missing]", e);
                setStatus("HTML view failed — see console");
            }
        };

        saveBtn.onclick = () => {
            try {
                const url = URL.createObjectURL(
                    new Blob([renderSessionHtml(session)], { type: "text/html" })
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "collectr-missing.html";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                setStatus("saved collectr-missing.html to Downloads (Chrome may add a number)");
            } catch (e) {
                console.error("[collectr-missing]", e);
                setStatus("HTML save failed — see console");
            }
        };

        fillBtn.onclick = async () => {
            if (running) return;
            try {
                resolveAccount();
            } catch (e) {
                return setStatus(e.message);
            }
            running = true;
            aborted = false;
            fillBtn.disabled = true;
            stopBtn.disabled = false;
            try {
                const r = await backfillImages(setStatus, () => aborted);
                session = loadSession();
                setStatus(
                    `backfill: ${r.filled} cards got artwork across ${r.sets} set${r.sets === 1 ? "" : "s"}` +
                        (r.misses ? ` · ${r.misses} not matched in the catalog` : "") +
                        (r.saved ? "" : " · STOPPED: storage full") +
                        (aborted ? " · stopped early" : "")
                );
            } catch (e) {
                console.error("[collectr-missing]", e);
                setStatus(`backfill failed: ${e.message}`);
            } finally {
                running = false;
                stopBtn.disabled = true;
                showSession();
                if (view === "session") renderSession();
            }
        };

        dropBtn.onclick = () => {
            const groupId = currentGroupId();
            if (!groupId || !session.sets[String(groupId)]) return setStatus("this set is not in the session");
            const name = session.sets[String(groupId)].name;
            session = sessionRemove(groupId);
            const st = sessionStats(session);
            setStatus(`dropped ${name} — session: ${st.setCount} sets, ${st.cardCount} cards`);
            if (view === "session") renderSession();
            else showSession();
        };

        sClearBtn.onclick = () => {
            session = sessionClear();
            setStatus("session cleared (saved settings kept)");
            if (view === "session") renderSession();
            else showSession();
        };

        stopBtn.onclick = () => {
            aborted = true;
            setStatus("stopping after current request…");
        };

        const copyOut = (text, label, count) => {
            navigator.clipboard.writeText(text).then(
                () => setStatus(`${label} copied (${count} rows)`),
                () => setStatus("clipboard blocked — see console"),
            );
            console.log(text);
        };
        copyBtn.onclick = () => copyOut(toTSV(result.out.missing), "TSV", result.out.missing.length);
        csvBtn.onclick = () => copyOut(toCSV(result.out.missing), "CSV", result.out.missing.length);
        sCsvBtn.onclick = () => {
            const rows = sessionRows(session);
            copyOut(toCSV(rows, SESSION_HEAD, sessionCells), "session CSV", rows.length);
        };
        sTsvBtn.onclick = () => {
            const rows = sessionRows(session);
            copyOut(toTSV(rows, SESSION_HEAD, sessionCells), "session TSV", rows.length);
        };

        resetBtn.onclick = () => {
            let n = 0;
            try {
                for (const k of Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX))) {
                    localStorage.removeItem(k);
                    n++;
                }
            } catch {}
            session = emptySession();
            showSession();
            setStatus(`cleared ${n} saved keys, session included — reload the page`);
        };

        // SPA navigation: follow the set the user is looking at.
        let lastHref = location.href;
        const syncFromLocation = () => {
            if (location.href === lastHref) return;
            lastHref = location.href;
            const g = groupIdFromLocation();
            if (g && !running) {
                setEl.value = g;
                CONFIG.SET_INPUT = g;
                lsSet("SET_INPUT", g);
                showSession();
            }
        };
        setInterval(syncFromLocation, 1000);

        const apiSurface = {
            find: () => findBtn.click(),
            stop: () => stopBtn.click(),
            add: () => addBtn.click(),
            get result() {
                return result;
            },
            get session() {
                return session;
            },
            sessionCSV: () => toCSV(sessionRows(session), SESSION_HEAD, sessionCells),
            sessionHTML: () => renderSessionHtml(session),
            viewHtml: () => htmlBtn.click(),
            backfill: () => fillBtn.click(),
            // Diagnostics: every printing of a card, how it was grouped, and the
            // raw overlay row for it. Needs a Find missing on this set first.
            debugCard: async (needle) => {
                const q = String(needle || "").toLowerCase();
                if (!result || !result.scan) return console.warn("run Find missing on this set first");
                const scan = result.scan;
                const hits = scan.cards.filter(
                    (c) =>
                        String(c.product_name || "").toLowerCase().includes(q) ||
                        String(c.card_number || "").toLowerCase().includes(q)
                );
                if (!hits.length) return console.warn(`no printing matches "${needle}" in this scan`);
                console.table(
                    hits.map((c) => ({
                        product_id: String(c.product_id),
                        product_name: c.product_name,
                        card_number: c.card_number,
                        rarity: c.rarity,
                        base_name: baseName(c.product_name),
                        group_key: groupKey(c.card_number, c.product_name),
                        name_codes: [...String(c.product_name || "")].map((ch) => ch.charCodeAt(0)).join(" "),
                        in_scope: CONFIG.SCOPE !== "base" || isBaseCard(c, scan.declaredTotal),
                        owned_qty: scan.owned.get(String(c.product_id)) || 0,
                    }))
                );
                const ids = hits.map((c) => String(c.product_id));
                const raw = await api(
                    `/collections/${encodeURIComponent(CONFIG.ACCOUNT_ID)}/products?` +
                        qs({ allCollections: "true", unstackedView: "false", productIds: ids.join(",") })
                );
                console.log("overlay asked for", ids.length, "ids, returned", ((raw && raw.data) || []).length);
                console.log(JSON.stringify((raw && raw.data) || [], null, 2));

                // Where does this card actually appear? Separates a live
                // computation from a stale snapshot on screen.
                const match = (r) => `${r.card_number} ${r.name}`.toLowerCase().includes(q);
                const live = ((result.out && result.out.missing) || []).filter(match);
                const grouped = ((result.out && result.out.rows) || []).filter(match);
                const snap = session.sets[String(scan.groupId)];
                const inSession = snap ? snap.missing.filter(match) : [];
                console.log("view on screen:", view, "· scan groupId:", scan.groupId);
                console.log(
                    "grouped rows:",
                    JSON.stringify(
                        grouped.map((g) => ({
                            key: groupKey(g.card_number, g.name),
                            card_number: g.card_number,
                            name: g.name,
                            ownedVariants: g.ownedVariants,
                            variants: g.variants.map((v) => `${v.product_id} qty=${v.qty} ${v.label}`),
                        })),
                        null,
                        2
                    )
                );
                console.log("in live missing list:", live.length, live.map((g) => g.card_number + " " + g.name));
                console.log(
                    "in session snapshot:",
                    snap ? `${inSession.length} (set added ${snap.ts}, scope ${snap.scope})` : "this set is not in the session"
                );
                return { hits, raw, grouped, live, inSession };
            },
            saveHtml: () => saveBtn.click(),
            clearSession: () => sClearBtn.click(),
            CONFIG,
        };
        // With @grant in use the script lives in an isolated context, so a plain
        // window.* assignment is invisible to the page console.
        window.collectrMissing = apiSurface;
        try {
            if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window)
                unsafeWindow.collectrMissing = apiSurface;
        } catch (e) {
            console.warn("[collectr-missing] page export blocked:", e.message);
        }

        // Console-free path to the same diagnostic.
        dbgBtn.onclick = () => {
            const needle = prompt("Debug which card? (part of the name or number)", "");
            if (!needle) return;
            setStatus(`debugging "${needle}" — output in the console`);
            apiSurface.debugCard(needle);
        };
    }

    if (document.body) build();
    else window.addEventListener("DOMContentLoaded", build, { once: true });
})();
