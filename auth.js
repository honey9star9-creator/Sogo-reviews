/* SOGO REVIEWS — Shared Auth + Data Logic (Firebase version)
   ------------------------------------------------------------------
   FULL UPDATED VERSION - ZERO CODE OMITTED
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

import { auth, db, firebaseConfig } from "./firebase-config.js";

const USERS_COL = "users";
const INVITE_CODES_COL = "inviteCodes";
const CHATS_COL = "chats";
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

  async function getInviteCodeOwner(code) {
    const snap = await getDoc(doc(db, INVITE_CODES_COL, code.toUpperCase()));
    return snap.exists() ? snap.data() : null;
  }

  async function registerInviteCode(code, uid, email) {
    await setDoc(doc(db, INVITE_CODES_COL, code.toUpperCase()), {
      ownerUid: uid, ownerEmail: normalizeEmail(email)
    });
  }

  /* ---------------- one-time admin seed ---------------- */
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
      console.error("SogoAuth.login failed:", e.code, e.message);
      if (e.code === "auth/too-many-requests") {
        return { ok: false, message: "Too many attempts — please wait a few minutes and try again." };
      }
      return { ok: false, message: "Incorrect email/phone or password. (" + (e.code || "unknown") + ")" };
    }
  }

  async function signup({ name, email, password, invitationCode }) {
    const code = (invitationCode || "").trim();
    if (!code) return { ok: false, message: "Invitation code is required." };

    const inviter = await getInviteCodeOwner(code);
    if (!inviter) return { ok: false, message: "Invalid invitation code." };

    try {
      const cred = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
      const myCode = generateInviteCode();
      const profile = {
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitationCode: code,
        invitedByEmail: inviter.ownerEmail,
        myInviteCode: myCode,
        balance: 0,
        createdAt: serverTimestamp(),
        blocked: false
      };
      await setDoc(doc(db, USERS_COL, cred.user.uid), profile);
      await registerInviteCode(myCode, cred.user.uid, email);
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
    const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : generateInviteCode();
    const oldCode = user.myInviteCode;
    await updateDoc(doc(db, USERS_COL, user.uid), { myInviteCode: code });
    await registerInviteCode(code, user.uid, user.email);
    if (oldCode && oldCode !== code) {
      try { await deleteDoc(doc(db, INVITE_CODES_COL, oldCode.toUpperCase())); } catch (_) {}
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
    const withdrawalRef = doc(db, WITHDRAWALS_COL, id);

    if (status !== "approved") {
      const snap = await getDoc(withdrawalRef);
      if (!snap.exists()) return null;
      const w = snap.data();
      if (w.status === "approved") return { id, ...w };
      await updateDoc(withdrawalRef, { status });
      logActivity("withdrawal_rejected", `Withdrawal of $${Number(w.amount || 0).toFixed(2)} rejected for ${w.name}`, { email: w.email });
      return { id, ...w, status };
    }

    try {
      const result = await runTransaction(db, async (tx) => {
        const wSnap = await tx.get(withdrawalRef);
        if (!wSnap.exists()) throw new Error("Withdrawal request not found.");
        const w = wSnap.data();
        if (w.status === "approved") return { alreadyApproved: true, w };
        if (!(Number(w.amount) > 0)) throw new Error("This withdrawal has an invalid amount and cannot be approved.");

        const user = await getUserByEmail(w.email);
        if (!user) throw new Error("User not found.");
        const userRef = doc(db, USERS_COL, user.uid);
        const uSnap = await tx.get(userRef);
        const currentBalance = (uSnap.exists() ? uSnap.data().balance : 0) || 0;

        if (currentBalance < w.amount) {
          throw new Error(`Insufficient balance: user has $${currentBalance.toFixed(2)}, withdrawal is $${Number(w.amount).toFixed(2)}.`);
        }

        tx.update(userRef, { balance: currentBalance - w.amount });
        tx.update(withdrawalRef, { status: "approved" });
        return { alreadyApproved: false, w };
      });

      if (!result.alreadyApproved) {
        logActivity("withdrawal_approved", `Withdrawal of $${Number(result.w.amount || 0).toFixed(2)} approved for ${result.w.name}`, { email: result.w.email });
      }
      return { id, ...result.w, status: "approved" };
    } catch (e) {
      return { ok: false, message: e.message || "Could not approve withdrawal." };
    }
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
    const topupRef = doc(db, TOPUPS_COL, id);

    if (status !== "approved") {
      const snap = await getDoc(topupRef);
      if (!snap.exists()) return null;
      const t = snap.data();
      if (t.status === "approved") return { id, ...t };
      await updateDoc(topupRef, { status });
      logActivity("topup_rejected", `Top-up of $${Number(t.amount || 0).toFixed(2)} rejected for ${t.name}`, { email: t.email });
      return { id, ...t, status };
    }

    try {
      const result = await runTransaction(db, async (tx) => {
        const tSnap = await tx.get(topupRef);
        if (!tSnap.exists()) throw new Error("Top-up request not found.");
        const t = tSnap.data();
        if (t.status === "approved") return { alreadyApproved: true, t };
        if (!(Number(t.amount) > 0)) throw new Error("This top-up has an invalid amount and cannot be approved.");

        const user = await getUserByEmail(t.email);
        if (!user) throw new Error("User not found.");
        const userRef = doc(db, USERS_COL, user.uid);
        const uSnap = await tx.get(userRef);
        const currentBalance = (uSnap.exists() ? uSnap.data().balance : 0) || 0;

        tx.update(userRef, { balance: currentBalance + t.amount });
        tx.update(topupRef, { status: "approved" });
        return { alreadyApproved: false, t };
      });

      if (!result.alreadyApproved) {
        logActivity("topup_approved", `Top-up of $${Number(result.t.amount || 0).toFixed(2)} approved for ${result.t.name}`, { email: result.t.email });
      }
      return { id, ...result.t, status: "approved" };
    } catch (e) {
      return { ok: false, message: e.message || "Could not approve top-up." };
    }
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