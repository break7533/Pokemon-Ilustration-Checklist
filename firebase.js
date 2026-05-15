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

let currentUser = null;

// Exposed for app.js to call after toggleObtained
window.syncObtainedToCloud = async function(pageId, obtained) {
  if (!currentUser) return;
  const ref = doc(db, 'users', currentUser.uid);
  await setDoc(ref, { [pageId]: obtained }, { merge: true });
};

// Load this page's obtained state from Firestore
async function loadFromCloud(pageId) {
  if (!currentUser) return null;
  const ref = doc(db, 'users', currentUser.uid);
  const snap = await getDoc(ref);
  if (snap.exists() && snap.data()[pageId]) {
    return snap.data()[pageId];
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

  // If a checklist page is open, load cloud data and merge
  if (user && typeof PAGE_ID !== 'undefined' && PAGE_ID !== 'index') {
    const cloudData = await loadFromCloud(PAGE_ID);
    if (cloudData && typeof window.applyCloudState === 'function') {
      window.applyCloudState(cloudData);
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
