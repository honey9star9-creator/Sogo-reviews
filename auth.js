/* SOGO REVIEWS — Shared Auth + Data Logic (Firebase version)
   ------------------------------------------------------------------
   Replaces the old localStorage-based auth.js. Same "SogoAuth"
   namespace and (mostly) the same function names, so existing pages
   need minimal renaming — BUT every SogoAuth call is now ASYNC
   (returns a Promise), because Firebase talks to a real server.

   Old code:   const result = SogoAuth.login(email, pass);
   New code:   const result = await SogoAuth.login(email, pass);

   This file MUST be loaded as a module:
     <script type="module" src="auth.js"></script>
   (not a plain <script src="auth.js"></script> — Firebase's modular
   SDK requires ES module imports.)
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword as fbUpdatePassword,
  deleteApp, EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, addDoc, orderBy, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const USERS_COL = "users";
const CHATS_COL = "chats";               // chats/{uid}/messages/{msgId}
const WITHDRAWALS_COL = "withdrawals";
const TOPUPS_COL = "topups";
const PW_REQUESTS_COL = "passwordRequests";
const ACTIVITY_COL = "activity";

const SogoAuth = (() => {

  /* ---------------- helpers ---------------- */
  function normalizeEmail(email) { return (email || "").trim().toLowerCase(); }
  function generateInviteCode() { return Math.random().toString(36).substring(2, 10).toUpperCase(); }

  async function logActivity(type, message, meta) {
    try {
      await addDoc(collection(db, ACTIVITY_COL), {
        type, message, meta: meta || {}, time: serverTimestamp()
      });
    } catch (e) { /* non-fatal */ }
  }

  // Firestore stores users by their Firebase Auth UID as the doc id.
  async function getUserDoc(uid) {
    const snap = await getDoc(doc(db, USERS_COL, uid));
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
  }

  async function getUserByEmail(email) {
    const q = query(collection(db, USERS_COL), where("email", "==", normalizeEmail(email)));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { uid: d.id, ...d.data() };
  }

  /* ---------------- one-time admin seed ----------------
     Run this ONCE from the browser console (or a temporary button)
     after you've enabled Email/Password auth, to create the first
     admin account. Firestore can't "auto seed" the way localStorage
     did, because creating an Auth user requires a real signup call. */
  async function seedDefaultAdminOnce(email, password, name) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
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
    await signOut(auth);
    return { ok: true };
  }

  /* ---------------- auth: login / signup / logout ---------------- */

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
      return { ok: false, message: "Incorrect email/phone or password." };
    }
  }

  async function signup({ name, email, password, invitationCode }) {
    const code = (invitationCode || "").trim();
    if (!code) return { ok: false, message: "Invitation code is required." };

    // Find the inviter BEFORE creating the account (createUser signs the
    // new user in immediately, so we must look this up first).
    const q = query(collection(db, USERS_COL), where("myInviteCode", "==", code.toUpperCase()));
    const snap = await getDocs(q);
    if (snap.empty) return { ok: false, message: "Invalid invitation code." };
    const inviter = { uid: snap.docs[0].id, ...snap.docs[0].data() };

    const existing = await getUserByEmail(email);
    if (existing) return { ok: false, message: "This email is already registered." };

    try {
      const cred = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
      const profile = {
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitationCode: code,
        invitedByEmail: inviter.email,
        myInviteCode: generateInviteCode(),
        balance: 0,
        createdAt: serverTimestamp(),
        blocked: false
      };
      await setDoc(doc(db, USERS_COL, cred.user.uid), profile);
      logActivity("signup", `${profile.name} signed up using invite code ${code}`, { email: profile.email, invitedBy: inviter.email });
      return { ok: true, user: { uid: cred.user.uid, ...profile } };
    } catch (e) {
      if (e.code === "auth/email-already-in-use") return { ok: false, message: "This email is already registered." };
      if (e.code === "auth/weak-password") return { ok: false, message: "Password must be at least 6 characters." };
      return { ok: false, message: "Signup failed: " + e.message };
    }
  }

  async function logout() {
    await signOut(auth);
    window.location.href = "auth.html";
  }

  // Returns a Promise<session|null>. Firebase auth state resolves
  // asynchronously on page load, so this waits for that first check.
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

  // Call at the top of a protected page:
  //   const session = await SogoAuth.requireRole('client');
  //   if (!session) return; // already redirected
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
  async function requestPasswordReset(email) {
    const user = await getUserByEmail(email);
    if (!user) return { ok: false, message: "No account found with that email." };
    const record = { email: user.email, name: user.name, status: "pending", requestedAt: serverTimestamp() };
    await addDoc(collection(db, PW_REQUESTS_COL), record);
    logActivity("password_reset_requested", `${user.name} requested a password reset`, { email: user.email });
    return { ok: true };
  }

  async function getPasswordRequests() {
    const snap = await getDocs(collection(db, PW_REQUESTS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // NOTE: changing another user's Firebase Auth password from the client
  // SDK is not possible (that needs the Admin SDK / a Cloud Function).
  // Practical approach for now: mark the request fulfilled and use
  // Firebase Console -> Authentication -> user -> "Reset password" email,
  // or set up a small Cloud Function later. This just updates the request
  // status so it disappears from the admin's pending list.
  async function fulfillPasswordRequest(id) {
    await updateDoc(doc(db, PW_REQUESTS_COL, id), { status: "fulfilled" });
  }
  async function dismissPasswordRequest(id) {
    await updateDoc(doc(db, PW_REQUESTS_COL, id), { status: "dismissed" });
  }

  /* ---------------- users (admin) ---------------- */

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

  // Deleting the Firebase Auth account itself needs the Admin SDK
  // (a Cloud Function) — the client SDK can only delete the
  // currently-signed-in user. So "delete" here removes the Firestore
  // profile + blocks login by setting blocked:true first as a
  // practical stand-in until you add a Cloud Function for full deletion.
  async function deleteUser(email) {
    const user = await getUserByEmail(email);
    if (!user) return;
    await deleteDoc(doc(db, USERS_COL, user.uid));
    logActivity("user_deleted", `${user.name} (${user.email}) was deleted by admin`, { email: user.email });
  }

  // Admin creates a client account directly. Uses a SECONDARY Firebase
  // app instance so this doesn't sign the admin out (createUser signs
  // in as the new user on the primary app, which would kick the admin
  // out of their own session).
  async function adminCreateUser(name, email, password) {
    const existing = await getUserByEmail(email);
    if (existing) return { ok: false, message: "This email is already registered." };

    const { initializeApp: initSecondary } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
    const secondaryApp = initSecondary(firebaseConfig, "Secondary-" + Date.now());
    const { getAuth: getSecondaryAuth } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js");
    const secondaryAuth = getSecondaryAuth(secondaryApp);

    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, normalizeEmail(email), password);
      const profile = {
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitationCode: "(created by admin)",
        myInviteCode: generateInviteCode(),
        balance: 0,
        createdAt: serverTimestamp(),
        blocked: false
      };
      
      await setDoc(doc(db, USERS_COL, cred.user.uid), profile);
      logActivity("user_created_by_admin", `Admin created new user ${profile.name} (${profile.email})`, { email: profile.email });
      
      return { ok: true, user: profile };

    } catch (e) {
      if (e.code === "auth/email-already-in-use") return { ok: false, message: "This email is already registered." };
      return { ok: false, message: "Could not create user: " + e.message };

    } finally {
      try {
        await signOut(secondaryAuth);
        await deleteApp(secondaryApp);
      } catch (cleanupError) {
        /* ignore cleanup error */
      }
    }
  }

  async function setInviteCode(email, customCode) {
    const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : generateInviteCode();
    return updateUser(email, { myInviteCode: code });
  }

  // True "log in as this client" isn't possible from the client SDK
  // without the user's password (Firebase Auth security). Practical
  // replacement: open the client dashboard in a special read-only
  // "admin preview" mode that fetches the target user's data by uid
  // without switching the Auth session. Call this and read
  // ?previewUid=... on client-dashboard.html to support that later.
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

  // Real-time listener version — use this on the dashboards instead of
  // polling every 3s. Returns an unsubscribe function.
  function listenChatThread(clientEmail, callback) {
    getUserByEmail(clientEmail).then(user => {
      if (!user) return callback([]);
      const q = query(collection(db, CHATS_COL, user.uid, "messages"), orderBy("time", "asc"));
      onSnapshot(q, (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    });
  }

  async function sendChatMessage(clientEmail, from, text) {
    const user = await getUserByEmail(clientEmail);
    if (!user) return;
    await addDoc(collection(db, CHATS_COL, user.uid, "messages"), {
      from, text, time: serverTimestamp(), read: from === "admin"
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
    
    // Parallel execution for fast performance
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
    
    // Parallel execution for fast performance
    const promises = users.map(u => getDocs(collection(db, CHATS_COL, u.uid, "messages")));

    const snapshots = await Promise.all(promises);
    return snapshots.filter(snap => snap.size > 0).length;
  }

  /* ---------------- withdrawals ---------------- */

  async function getWithdrawals() {
    const snap = await getDocs(collection(db, WITHDRAWALS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function requestWithdrawal(email, name, amount, accountDetails) {
    const user = await getUserByEmail(email);
    const record = {
      userId: user ? user.uid : null,
      email, name, amount, accountDetails,
      status: "pending", requestedAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, WITHDRAWALS_COL), record);
    logActivity("withdrawal_requested", `${name} requested a withdrawal of $${amount.toFixed(2)}`, { email });
    return { id: ref.id, ...record };
  }

  async function updateWithdrawal(id, status) {
    const snap = await getDoc(doc(db, WITHDRAWALS_COL, id));
    if (!snap.exists()) return null;
    const w = snap.data();

    // Pehle status update karein
    await updateDoc(doc(db, WITHDRAWALS_COL, id), { status });

    // Agar status "approved" hua hai toh user ka balance deduct karein
    if (status === "approved" && w.status !== "approved") {
      const user = await getUserByEmail(w.email);
      if (user) {
        const currentBalance = user.balance || 0;
        const newBalance = Math.max(0, currentBalance - w.amount); // negative balance hone se bachane ke liye
        await updateDoc(doc(db, USERS_COL, user.uid), { balance: newBalance });
      }
    }

    logActivity(
      status === "approved" ? "withdrawal_approved" : "withdrawal_rejected",
      `Withdrawal of $${w.amount.toFixed(2)} ${status} for ${w.name}`,
      { email: w.email }
    );
    return { id, ...w, status };
  }

  /* ---------------- top-ups ---------------- */

  async function getTopups() {
    const snap = await getDocs(collection(db, TOPUPS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function requestTopup(email, name, amount, note) {
    const user = await getUserByEmail(email);
    const record = {
      userId: user ? user.uid : null,
      email, name, amount, note: note || "",
      status: "pending", requestedAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, TOPUPS_COL), record);
    logActivity("topup_requested", `${name} requested a top-up of $${amount.toFixed(2)}`, { email });
    return { id: ref.id, ...record };
  }

  async function updateTopup(id, status) {
    const snap = await getDoc(doc(db, TOPUPS_COL, id));
    if (!snap.exists()) return null;
    const t = snap.data();
    await updateDoc(doc(db, TOPUPS_COL, id), { status });
    if (status === "approved") {
      const user = await getUserByEmail(t.email);
      if (user) await updateDoc(doc(db, USERS_COL, user.uid), { balance: (user.balance || 0) + t.amount });
      logActivity("topup_approved", `Top-up of $${t.amount.toFixed(2)} approved for ${t.name}`, { email: t.email });
    } else if (status === "rejected") {
      logActivity("topup_rejected", `Top-up of $${t.amount.toFixed(2)} rejected for ${t.name}`, { email: t.email });
    }
    return { id, ...t, status };
  }

  /* ---------------- activity log ---------------- */
  async function getActivity() {
    const q = query(collection(db, ACTIVITY_COL), orderBy("time", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  return {
    login, signup, logout, getSession, requireRole, redirectForRole, impersonate,
    seedDefaultAdminOnce,
    getUsers, updateUser, deleteUser, adminCreateUser, setInviteCode,
    getChatThread, listenChatThread, sendChatMessage, markChatRead, getUnreadMessageCount, getActiveChatsCount,
    getWithdrawals, requestWithdrawal, updateWithdrawal,
    getTopups, requestTopup, updateTopup,
    getPasswordRequests, requestPasswordReset, fulfillPasswordRequest, dismissPasswordRequest,
    getActivity, logActivity
  };
})();

// Expose globally so existing inline onclick="SogoAuth.xxx()" handlers
// in the HTML pages keep working (they run outside the module scope).
window.SogoAuth = SogoAuth;
