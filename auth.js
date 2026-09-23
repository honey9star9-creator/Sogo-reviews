/* SOGO REVIEWS — Shared Auth + Data Logic (Firebase version)
   ------------------------------------------------------------------
   FIXED VERSION — see notes marked "FIX:" below for what changed and why.

   Same "SogoAuth" namespace/function names as before — every call is
   still ASYNC (returns a Promise):
     const result = await SogoAuth.login(email, pass);

   Load as a module:
     <script type="module" src="auth.js"></script>
*/

import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, addDoc, orderBy, onSnapshot, serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

// FIX: import the ALREADY-initialized auth/db/config from firebase-config.js
// instead of calling initializeApp() again here. Calling initializeApp()
// twice on the default app crashes with "app/duplicate-app" and the whole
// module silently fails to load — that was the #1 reason nothing worked.
import { auth, db, firebaseConfig } from "./firebase-config.js";

const USERS_COL = "users";
const INVITE_CODES_COL = "inviteCodes";  // FIX: new public-readable collection
const CHATS_COL = "chats";               // chats/{uid}/messages/{msgId}
const WITHDRAWALS_COL = "withdrawals";
const TOPUPS_COL = "topups";
const PW_REQUESTS_COL = "passwordRequests";
const ACTIVITY_COL = "activity";

const SogoAuth = (() => {

  /* ---------------- helpers ---------------- */
  function normalizeEmail(email) { return (email || "").trim().toLowerCase(); }
  function normalizeInviteCode(code) {
    return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  }
  function parseFiniteAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : NaN;
  }
  function generateInviteCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, n => alphabet[n % alphabet.length]).join("");
  }
  function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    if (value.seconds != null) return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000));
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  async function logActivity(type, message, meta) {
    try {
      await addDoc(collection(db, ACTIVITY_COL), {
        type, message, meta: meta || {}, time: serverTimestamp()
      });
    } catch (e) { /* non-fatal */ }
  }

  async function getUserDoc(uid) {
    const snap = await getDoc(doc(db, USERS_COL, uid));
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
  }

  // NOTE: only call this when the caller is already signed in as an
  // admin or as the user themself — Firestore rules require auth to
  // read the /users collection. (Used by admin screens + post-login code.)
  async function getUserByEmail(email) {
    const q = query(collection(db, USERS_COL), where("email", "==", normalizeEmail(email)));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { uid: d.id, ...d.data() };
  }

  // FIX: invite codes now live in their own small public collection so a
  // NOT-YET-SIGNED-IN visitor can validate a code during signup without
  // needing read access to the whole /users collection.
  async function getInviteCodeOwner(code) {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return null;
    const snap = await getDoc(doc(db, INVITE_CODES_COL, normalized));
    return snap.exists() ? snap.data() : null;
  }
  async function registerInviteCode(code, uid, email) {
    const normalized = normalizeInviteCode(code);
    if (!normalized || !uid) throw new Error("Invalid invitation code.");
    const ref = doc(db, INVITE_CODES_COL, normalized);
    const existing = await getDoc(ref);
    if (existing.exists() && existing.data().ownerUid !== uid) {
      throw new Error("Invitation code is already assigned.");
    }
    await setDoc(ref, {
      ownerUid: uid, ownerEmail: normalizeEmail(email)
    }, { merge: false });
  }

  async function reserveInviteCode(uid, email, preferredCode = "", maxAttempts = 8) {
    const requested = normalizeInviteCode(preferredCode);
    if (requested) {
      const existing = await getInviteCodeOwner(requested);
      if (existing && existing.ownerUid !== uid) throw new Error("Invitation code is already assigned.");
      await registerInviteCode(requested, uid, email);
      return requested;
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = generateInviteCode();
      const existing = await getInviteCodeOwner(candidate);
      if (existing) continue;
      try {
        await registerInviteCode(candidate, uid, email);
        return candidate;
      } catch (e) {
        if (attempt === maxAttempts - 1) throw e;
      }
    }
    throw new Error("Could not allocate a unique invitation code.");
  }


  async function seedDefaultAdminOnce(email, password, name) {
    const cred = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
    await setDoc(doc(db, USERS_COL, cred.user.uid), {
      name: name || "Admin",
      email: normalizeEmail(email),
      role: "admin",
      invitationCode: "",
      myInviteCode: "ADMIN0001",
      balance: 0,
      createdAt: serverTimestamp(),
      blocked: false
    });
    await registerInviteCode("ADMIN0001", cred.user.uid, email);
    await signOut(auth);
    return { ok: true };
  }

  /* ---------------- auth: login / signup / logout ---------------- */

  // FIX: restored the actual Firebase Auth password check. The previous
  // version only looked the email up in Firestore and returned success —
  // no password was verified at all, and (once rules are correct) that
  // Firestore read fails anyway when nobody is signed in yet.
  async function login(email, password) {
    try {
      const cred = await signInWithEmailAndPassword(auth, normalizeEmail(email), password);
      const profile = await getUserDoc(cred.user.uid);
      if (!profile) {
        await signOut(auth);
        return { ok: false, message: "Account profile not found." };
      }
      if (profile.blocked) {
        await signOut(auth);
        return { ok: false, message: "This account has been blocked. Please contact support." };
      }
      logActivity("login", `${profile.name} logged in`, { email: profile.email, role: profile.role });
      return { ok: true, user: profile };
    } catch (e) {
      // DEBUG: real Firebase error code/message printed to console so we
      // can see the actual cause (wrong password vs too-many-requests vs
      // something else) instead of guessing from the generic UI message.
      console.error("SogoAuth.login failed:", e.code, e.message);
      if (e.code === "auth/too-many-requests") {
        return { ok: false, message: "Too many attempts — please wait a few minutes and try again." };
      }
      return { ok: false, message: "Incorrect email/phone or password. (" + (e.code || "unknown") + ")" };
    }
  }

  // FIX: invite-code lookup now uses the public inviteCodes doc (works
  // pre-auth). The "email already registered" pre-check was removed —
  // createUserWithEmailAndPassword already rejects duplicate emails on
  // its own (auth/email-already-in-use), so we don't need an
  // unauthenticated read of /users just to check that.
  async function signup({ name, email, password, invitationCode }) {
    const code = (invitationCode || "").trim();
    if (!code) return { ok: false, message: "Invitation code is required." };

    const inviter = await getInviteCodeOwner(code);
    if (!inviter || !inviter.ownerUid) return { ok: false, message: "Invalid invitation code." };

    try {
      const cred = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
      const myCode = await reserveInviteCode(cred.user.uid, email);
      const profile = {
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitationCode: normalizeInviteCode(code),
        invitedByEmail: normalizeEmail(inviter.ownerEmail),
        myInviteCode: myCode,
        balance: 0,
        createdAt: serverTimestamp(),
        blocked: false
      };
      try {
        await setDoc(doc(db, USERS_COL, cred.user.uid), profile);
      } catch (profileError) {
        try { await deleteDoc(doc(db, INVITE_CODES_COL, myCode)); } catch (_) {}
        throw profileError;
      }
      logActivity("signup", `${profile.name} signed up using invite code ${code}`, { email: profile.email, invitedBy: inviter.ownerEmail });
      return { ok: true, user: { uid: cred.user.uid, ...profile } };
    } catch (e) {
      if (e.code === "auth/email-already-in-use") return { ok: false, message: "This email is already registered." };
      if (e.code === "auth/weak-password") return { ok: false, message: "Password must be at least 6 characters." };
      if (e.code === "auth/invalid-email") return { ok: false, message: "Please enter a valid email address." };
      return { ok: false, message: "Signup failed: " + e.message };
    }
  }

  async function logout() {
    await signOut(auth);
    window.location.href = "auth.html";
  }

  function getSession() {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, async (fbUser) => {
        unsub();
        if (!fbUser) return resolve(null);
        const profile = await getUserDoc(fbUser.uid);
        if (!profile) return resolve(null);
        resolve({ uid: fbUser.uid, email: profile.email, name: profile.name, role: profile.role });
      });
    });
  }

  async function requireRole(role) {
    const session = await getSession();
    if (!session || session.role !== role) {
      window.location.href = "auth.html";
      return null;
    }
    const fresh = await getUserDoc(session.uid);
    if (!fresh || fresh.blocked) {
      await logout();
      return null;
    }
    return session;
  }

  function redirectForRole(role) {
    window.location.href = role === "admin" ? "master-admin.html" : "client-dashboard.html";
  }

  /* ---------------- password reset requests ---------------- */

  // FIX: no longer pre-checks getUserByEmail() (that read needs auth and
  // this form is used by signed-out visitors). We just log the request
  // with whatever email was typed — admin can verify manually.
  async function requestPasswordReset(email) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return { ok: false, message: "Please enter your email." };
    await addDoc(collection(db, PW_REQUESTS_COL), {
      email: cleanEmail, name: cleanEmail, status: "pending", requestedAt: serverTimestamp()
    });
    logActivity("password_reset_requested", `${cleanEmail} requested a password reset`, { email: cleanEmail });
    return { ok: true };
  }

  async function getPasswordRequests() {
    const snap = await getDocs(collection(db, PW_REQUESTS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function fulfillPasswordRequest(id) {
    await updateDoc(doc(db, PW_REQUESTS_COL, id), { status: "fulfilled" });
  }
  async function dismissPasswordRequest(id) {
    await updateDoc(doc(db, PW_REQUESTS_COL, id), { status: "dismissed" });
  }

  /* ---------------- users (admin) ---------------- */

  async function updateUserByUid(uid, changes) {
    if (!uid) return null;
    await updateDoc(doc(db, USERS_COL, uid), changes);
    return getUserDoc(uid);
  }

  async function getUsers() {
    const snap = await getDocs(collection(db, USERS_COL));
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  }

  async function updateUser(email, changes) {
    const user = await getUserByEmail(email);
    if (!user) return null;
    await updateDoc(doc(db, USERS_COL, user.uid), changes);
    return { ...user, ...changes };
  }

  async function deleteUser(email) {
    const user = await getUserByEmail(email);
    if (!user) return;
    await deleteDoc(doc(db, USERS_COL, user.uid));
    logActivity("user_deleted", `${user.name} (${user.email}) was deleted by admin`, { email: user.email });
  }

  async function adminCreateUser(name, email, password) {
    const existing = await getUserByEmail(email);
    if (existing) return { ok: false, message: "This email is already registered." };

    const secondaryApp = initializeApp(firebaseConfig, "Secondary-" + Date.now());
    const { getAuth: getSecondaryAuth } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js");
    const { deleteApp } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
    const secondaryAuth = getSecondaryAuth(secondaryApp);

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, normalizeEmail(email), password);
      const myCode = generateInviteCode();
      const profile = {
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitationCode: "(created by admin)",
        myInviteCode: myCode,
        balance: 0,
        createdAt: serverTimestamp(),
        blocked: false
      };
      await setDoc(doc(db, USERS_COL, cred.user.uid), profile);
      await registerInviteCode(myCode, cred.user.uid, email);
      logActivity("user_created_by_admin", `Admin created new user ${profile.name} (${profile.email})`, { email: profile.email });
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);
      return { ok: true, user: profile };
    } catch (e) {
      try { await deleteApp(secondaryApp); } catch (_) {}
      if (e.code === "auth/email-already-in-use") return { ok: false, message: "This email is already registered." };
      return { ok: false, message: "Could not create user: " + e.message };
    }
  }

  async function setInviteCode(email, customCode) {
    const user = await getUserByEmail(email);
    if (!user) return null;
    const requested = normalizeInviteCode(customCode);
    if (requested && !/^[A-Z0-9]{6,32}$/.test(requested)) {
      throw new Error('Invitation code must be 6–32 letters or numbers.');
    }
    const oldCode = normalizeInviteCode(user.myInviteCode);
    const code = await reserveInviteCode(user.uid, user.email, requested);
    try {
      await updateDoc(doc(db, USERS_COL, user.uid), { myInviteCode: code });
    } catch (e) {
      if (!oldCode || oldCode !== code) {
        try { await deleteDoc(doc(db, INVITE_CODES_COL, code)); } catch (_) {}
      }
      throw e;
    }
    if (oldCode && oldCode !== code) {
      try {
        const oldRef = doc(db, INVITE_CODES_COL, oldCode);
        const oldSnap = await getDoc(oldRef);
        if (oldSnap.exists() && oldSnap.data().ownerUid === user.uid) await deleteDoc(oldRef);
      } catch (_) {}
    }
    return { ...user, myInviteCode: code };
  }

  function impersonate(email) {
    getUserByEmail(email).then(user => {
      if (!user) return;
      logActivity("admin_access", `Admin previewed ${user.name}'s account (${user.email})`, { email: user.email });
      window.location.href = "client-dashboard.html?previewUid=" + user.uid;
    });
  }

  /* ---------------- chat (realtime) ---------------- */

  async function getChatThread(clientEmail) {
    const user = await getUserByEmail(clientEmail);
    if (!user) return [];
    const q = query(collection(db, CHATS_COL, user.uid, "messages"), orderBy("time", "asc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  function listenChatThread(clientEmail, callback) {
    let stopped = false;
    let unsubscribe = () => { stopped = true; };
    getUserByEmail(clientEmail).then(user => {
      if (stopped) return;
      if (!user) { callback([]); return; }
      const q = query(collection(db, CHATS_COL, user.uid, "messages"), orderBy("time", "asc"));
      unsubscribe = onSnapshot(q, (snap) => {
        if (!stopped) callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, (error) => {
        console.error("Chat listener failed:", error);
        if (!stopped) callback([]);
      });
    }).catch(error => {
      console.error("Chat listener setup failed:", error);
      if (!stopped) callback([]);
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  async function sendChatMessage(clientEmail, _from, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Message cannot be empty.');
    const fbUser = auth.currentUser;
    if (!fbUser) throw new Error('You must be signed in to send a message.');
    const sender = await getUserDoc(fbUser.uid);
    const client = await getUserByEmail(clientEmail);
    if (!sender || !client) throw new Error('Chat participant not found.');
    const isAdmin = sender.role === 'admin';
    if (!isAdmin && client.uid !== fbUser.uid) throw new Error('You are not allowed to send in this chat.');
    const from = isAdmin ? 'admin' : 'client';
    await addDoc(collection(db, CHATS_COL, client.uid, 'messages'), {
      from, text: cleanText, time: serverTimestamp(), read: from === 'admin'
    });
  }

  async function markChatRead(clientEmail) {
    const user = await getUserByEmail(clientEmail);
    if (!user) return;
    const q = query(collection(db, CHATS_COL, user.uid, "messages"), where("from", "==", "client"), where("read", "==", false));
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map(d => updateDoc(d.ref, { read: true })));
  }

  async function getUnreadMessageCount() {
    const users = (await getUsers()).filter(u => u.role === "client");
    const promises = users.map(u => {
      const q = query(
        collection(db, CHATS_COL, u.uid, "messages"),
        where("from", "==", "client"),
        where("read", "==", false)
      );
      return getDocs(q);
    });
    const snapshots = await Promise.all(promises);
    return snapshots.reduce((total, snap) => total + snap.size, 0);
  }

  async function getActiveChatsCount() {
    const users = (await getUsers()).filter(u => u.role === "client");
    const promises = users.map(u => getDocs(collection(db, CHATS_COL, u.uid, "messages")));
    const snapshots = await Promise.all(promises);
    return snapshots.filter(snap => snap.size > 0).length;
  }

  /* ---------------- withdrawals ---------------- */

  async function getWithdrawals() {
    const snap = await getDocs(collection(db, WITHDRAWALS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function requestWithdrawal({ amount, accountDetails }) {
    const fbUser = auth.currentUser;
    if (!fbUser) throw new Error('You must be signed in to request a withdrawal.');
    const user = await getUserDoc(fbUser.uid);
    const cleanAmount = parseFiniteAmount(amount);
    const cleanAccountDetails = String(accountDetails || '').trim();
    if (!user) throw new Error('User profile not found.');
    if (user.role !== 'client') throw new Error('Only client accounts can request withdrawals.');
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) throw new Error('Enter a valid positive withdrawal amount.');
    if (!cleanAccountDetails) throw new Error('Enter the account details for this withdrawal.');
    const balance = parseFiniteAmount(user.balance);
    if (!Number.isFinite(balance) || cleanAmount > balance) throw new Error('Insufficient balance.');
    const pendingSnap = await getDocs(query(
      collection(db, WITHDRAWALS_COL),
      where('userId', '==', fbUser.uid),
      where('status', '==', 'pending')
    ));
    const pendingTotal = pendingSnap.docs.reduce((total, item) => total + (parseFiniteAmount(item.data().amount) || 0), 0);
    if (pendingTotal + cleanAmount > balance) throw new Error('This amount exceeds your available balance after pending withdrawals.');
    const record = {
      userId: fbUser.uid,
      email: normalizeEmail(fbUser.email || user.email),
      name: user.name || '',
      amount: cleanAmount,
      accountDetails: cleanAccountDetails,
      status: 'pending', requestedAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, WITHDRAWALS_COL), record);
    logActivity('withdrawal_requested', `${record.name} requested a withdrawal of $${cleanAmount.toFixed(2)}`, { email: record.email });
    return { id: ref.id, ...record };
  }

  async function updateWithdrawal(id, status) {
    if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid withdrawal status.');
    const withdrawalRef = doc(db, WITHDRAWALS_COL, id);
    let result = null;
    await runTransaction(db, async (transaction) => {
      const withdrawalSnap = await transaction.get(withdrawalRef);
      if (!withdrawalSnap.exists()) throw new Error('Withdrawal request not found.');
      const w = withdrawalSnap.data();
      if (w.status !== 'pending') {
        result = { id, ...w };
        return;
      }
      const amount = parseFiniteAmount(w.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Withdrawal amount is invalid.');
      if (status === 'approved') {
        if (!w.userId) throw new Error('Withdrawal has no owner.');
        const userRef = doc(db, USERS_COL, w.userId);
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists()) throw new Error('Withdrawal owner not found.');
        const balance = parseFiniteAmount(userSnap.data().balance);
        if (!Number.isFinite(balance) || balance < amount) throw new Error('Insufficient balance for approval.');
        transaction.update(userRef, { balance: balance - amount });
      }
      transaction.update(withdrawalRef, { status, processedAt: serverTimestamp() });
      result = { id, ...w, status };
    });
    if (result && result.status === status) {
      const amount = parseFiniteAmount(result.amount);
      await logActivity(status === 'approved' ? 'withdrawal_approved' : 'withdrawal_rejected',
        `Withdrawal of $${amount.toFixed(2)} ${status} for ${result.name || result.email}`, { email: result.email });
    }
    return result;
  }

  /* ---------------- top-ups ---------------- */

  async function getTopups() {
    const snap = await getDocs(collection(db, TOPUPS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function requestTopup({ amount, note }) {
    const fbUser = auth.currentUser;
    if (!fbUser) throw new Error('You must be signed in to request a top-up.');
    const user = await getUserDoc(fbUser.uid);
    const cleanAmount = parseFiniteAmount(amount);
    if (!user) throw new Error('User profile not found.');
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) throw new Error('Enter a valid positive top-up amount.');
    const record = {
      userId: fbUser.uid,
      email: normalizeEmail(fbUser.email || user.email),
      name: user.name || '',
      amount: cleanAmount,
      note: String(note || '').trim(),
      status: 'pending', requestedAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, TOPUPS_COL), record);
    logActivity('topup_requested', `${record.name} requested a top-up of $${cleanAmount.toFixed(2)}`, { email: record.email });
    return { id: ref.id, ...record };
  }

  async function updateTopup(id, status) {
    if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid top-up status.');
    const topupRef = doc(db, TOPUPS_COL, id);
    let result = null;
    await runTransaction(db, async (transaction) => {
      const topupSnap = await transaction.get(topupRef);
      if (!topupSnap.exists()) throw new Error('Top-up request not found.');
      const t = topupSnap.data();
      if (t.status !== 'pending') {
        result = { id, ...t };
        return;
      }
      const amount = parseFiniteAmount(t.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Top-up amount is invalid.');
      if (status === 'approved') {
        if (!t.userId) throw new Error('Top-up has no owner.');
        const userRef = doc(db, USERS_COL, t.userId);
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists()) throw new Error('Top-up owner not found.');
        const balance = parseFiniteAmount(userSnap.data().balance);
        if (!Number.isFinite(balance) || balance < 0) throw new Error('User balance is invalid.');
        transaction.update(userRef, { balance: balance + amount });
      }
      transaction.update(topupRef, { status, processedAt: serverTimestamp() });
      result = { id, ...t, status };
    });
    if (result && result.status === status) {
      const amount = parseFiniteAmount(result.amount);
      await logActivity(status === 'approved' ? 'topup_approved' : 'topup_rejected',
        `Top-up of $${amount.toFixed(2)} ${status} for ${result.name || result.email}`, { email: result.email });
    }
    return result;
  }

  /* ---------------- activity log ---------------- */
  async function getActivity() {
    const q = query(collection(db, ACTIVITY_COL), orderBy("time", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  return {
    login, signup, logout, getSession, requireRole, redirectForRole, impersonate,
    getUserDoc, getUserByEmail, updateUserByUid, seedDefaultAdminOnce,
    getUsers, updateUser, deleteUser, adminCreateUser, setInviteCode,
    getChatThread, listenChatThread, sendChatMessage, markChatRead, getUnreadMessageCount, getActiveChatsCount,
    getWithdrawals, requestWithdrawal, updateWithdrawal,
    getTopups, requestTopup, updateTopup,
    getPasswordRequests, requestPasswordReset, fulfillPasswordRequest, dismissPasswordRequest,
    getActivity, logActivity
  };
})();

window.SogoAuth = SogoAuth;
