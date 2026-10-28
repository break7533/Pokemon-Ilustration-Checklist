import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "__FIREBASE_AUTH_DOMAIN__",
  projectId: "__FIREBASE_PROJECT_ID__",
  storageBucket: "__FIREBASE_STORAGE_BUCKET__",
  messagingSenderId: "__FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__FIREBASE_APP_ID__"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
const MAX_CATALOG_BYTES = 850000;
const MAX_USER_DOCUMENT_BYTES = 900000;
const USER_DOCUMENT_HEADROOM = 20000;

let currentUser = null;

// Exposed for app.js to call after toggleObtained
window.syncObtainedToCloud = async function(pageId, obtained) {
  if (!currentUser) return { ok: false, reason: 'not-signed-in' };
  try {
    if (pageId === 'collectr-missing') {
      const foundBytes = new TextEncoder().encode(JSON.stringify(obtained)).length;
      if ((window.collectrCatalogBytes || 0) + foundBytes + USER_DOCUMENT_HEADROOM > MAX_USER_DOCUMENT_BYTES) {
        return { ok: false, reason: 'too-large' };
      }
    }
    const ref = doc(db, 'users', currentUser.uid);
    const value = pageId === 'collectr-missing'
      ? { catalogUpdatedAt: window.collectrCatalogUpdatedAt || 0, found: obtained }
      : obtained;
    await setDoc(ref, { [pageId]: value }, { mergeFields: [pageId] });
    return { ok: true };
  } catch (e) {
    console.warn('Firestore write failed (ad blocker?), data saved locally only.', e.message);
    return { ok: false, reason: 'cloud-error' };
  }
};

window.syncCatalogToCloud = async function(pageId, catalog) {
  if (!currentUser) return { ok: false, reason: 'not-signed-in' };
  const field = `${pageId}_catalog`;
  const bytes = new TextEncoder().encode(JSON.stringify(catalog)).length;
  if (bytes > MAX_CATALOG_BYTES) return { ok: false, reason: 'too-large' };
  if (pageId === 'collectr-missing') {
    const foundBytes = new TextEncoder().encode(JSON.stringify(window.obtained || {})).length;
    if (bytes + foundBytes + USER_DOCUMENT_HEADROOM > MAX_USER_DOCUMENT_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
  }
  try {
    const ref = doc(db, 'users', currentUser.uid);
    await setDoc(ref, { [field]: catalog }, { mergeFields: [field] });
    return { ok: true };
  } catch (e) {
    console.warn('Firestore catalog write failed; catalog remains saved locally.', e.message);
    return { ok: false, reason: 'cloud-error' };
  }
};

window.loadCatalogFromCloud = async function(pageId) {
  if (!currentUser) return { ok: false, reason: 'not-signed-in' };
  try {
    const ref = doc(db, 'users', currentUser.uid);
    const snap = await getDoc(ref);
    const field = `${pageId}_catalog`;
    return { ok: true, catalog: snap.exists() ? snap.data()[field] || null : null };
  } catch (e) {
    console.warn('Firestore catalog read failed; using the locally saved catalog.', e.message);
    return { ok: false, reason: 'cloud-error' };
  }
};

// Load this page's obtained state from Firestore
async function loadFromCloud(pageId) {
  if (!currentUser) return null;
  try {
    const ref = doc(db, 'users', currentUser.uid);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data()[pageId]) {
      return snap.data()[pageId];
    }
  } catch (e) {
    console.warn('Firestore read failed (ad blocker?), using local data.', e.message);
  }
  return null;
};

function renderAuthButton(user) {
  const btn = document.getElementById('authBtn');
  if (!btn) return;
  if (user) {
    btn.title = `Signed in as ${user.displayName || user.email} — click to sign out`;
    btn.innerHTML = `<img src="${user.photoURL}" alt="" width="22" height="22" style="border-radius:50%;display:block;">`;
    btn.classList.add('signed-in');
  } else {
    btn.title = 'Sign in with Google to sync across devices';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    btn.classList.remove('signed-in');
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  renderAuthButton(user);

  if (user && window.PAGE_ID && window.PAGE_ID !== 'index') {
    if (typeof window.applyCloudCatalog === 'function' && typeof window.loadCatalogFromCloud === 'function') {
      const catalogRevision = window.catalogRevision || 0;
      const cloudCatalog = await window.loadCatalogFromCloud(window.PAGE_ID);
      if (cloudCatalog.ok) {
        await window.applyCloudCatalog(cloudCatalog.catalog, catalogRevision);
      }
    }

    const stateRevision = window.stateRevision || 0;
    const cloudData = await loadFromCloud(window.PAGE_ID);
    if ((window.stateRevision || 0) !== stateRevision) {
      if (typeof window.syncObtainedToCloud === 'function') {
        window.syncObtainedToCloud(window.PAGE_ID, window.obtained || {});
      }
    } else if (window.PAGE_ID === 'collectr-missing') {
      const catalogUpdatedAt = window.collectrCatalogUpdatedAt || 0;
      if (cloudData && cloudData.catalogUpdatedAt === catalogUpdatedAt) {
        const merged = Object.assign({}, window.obtained || {}, cloudData.found || {});
        window.applyCloudState(merged);
      } else if (typeof window.syncObtainedToCloud === 'function') {
        window.syncObtainedToCloud(window.PAGE_ID, window.obtained || {});
      }
    } else if (cloudData && typeof window.applyCloudState === 'function') {
      // Merge: union of local + cloud so neither device loses data
      const merged = Object.assign({}, window.obtained || {}, cloudData);
      window.applyCloudState(merged);
    } else if (typeof window.syncObtainedToCloud === 'function') {
      // No cloud data yet — push local state up
      window.syncObtainedToCloud(window.PAGE_ID, window.obtained || {});
    }
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#authBtn');
  if (!btn) return;
  if (currentUser) {
    signOut(auth);
  } else {
    signInWithPopup(auth, provider).catch(console.error);
  }
});
