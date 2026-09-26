/* SOGO REVIEWS — Shared Auth + Data Logic (Supabase version)
    ------------------------------------------------------------------
    FULL UPDATED VERSION - ZERO CODE OMITTED
    (Adds: notifications system — read/mark-read/manual-send helpers,
    plus notify hooks on withdrawal/topup/password-reset flows)
*/

import { supabase } from "./supabase-config.js";

const USERS_COL = "users";
const INVITE_CODES_COL = "invite_codes";
const MESSAGES_COL = "messages";
const WITHDRAWALS_COL = "withdrawals";
const TOPUPS_COL = "topups";
const PW_REQUESTS_COL = "password_requests";
const ACTIVITY_COL = "activity";
const NOTIFICATIONS_COL = "notifications";

const SogoAuth = (() => {

  /* ---------------- helpers ---------------- */
  function normalizeEmail(email) { return (email || "").trim().toLowerCase(); }
  function generateInviteCode() { return Math.random().toString(36).substring(2, 10).toUpperCase(); }

  async function logActivity(type, message, meta) {
    try {
      await supabase.from(ACTIVITY_COL).insert([{
        type, message, meta: meta || {}, time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }
  }

  /* ---------------- notifications ---------------- */
  async function notifyUser(userId, type, title, message, meta) {
    if (!userId) return;
    try {
      await supabase.from(NOTIFICATIONS_COL).insert([{
        user_id: userId, type, title, message, meta: meta || {}
      }]);
    } catch (e) { /* non-fatal */ }
  }

  async function getAdminUserIds() {
    try {
      const { data } = await supabase.from(USERS_COL).select('id').eq('role', 'admin');
      return (data || []).map(u => u.id);
    } catch (e) { return []; }
  }

  async function notifyAllAdmins(type, title, message, meta) {
    const adminIds = await getAdminUserIds();
    await Promise.all(adminIds.map(id => notifyUser(id, type, title, message, meta)));
  }

  async function getMyNotifications(uid) {
    if (!uid) return [];
    const { data } = await supabase
      .from(NOTIFICATIONS_COL)
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(50);
    return data || [];
  }

  async function getUnreadNotificationCount(uid) {
    if (!uid) return 0;
    const { count } = await supabase
      .from(NOTIFICATIONS_COL)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid)
      .eq('read', false);
    return count || 0;
  }

  async function markAllNotificationsRead(uid) {
    if (!uid) return;
    await supabase.from(NOTIFICATIONS_COL).update({ read: true }).eq('user_id', uid).eq('read', false);
  }

  async function sendManualNotification(uid, title, message) {
    if (!uid) return { ok: false, message: 'No user selected.' };
    if (!title || !title.trim()) return { ok: false, message: 'Please enter a title.' };
    if (!message || !message.trim()) return { ok: false, message: 'Please enter a message.' };
    try {
      await notifyUser(uid, 'manual', title.trim(), message.trim());
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message || 'Could not send notification.' };
    }
  }

  async function getUserDoc(uid) {
    const { data, error } = await supabase.from(USERS_COL).select('*').eq('id', uid).maybeSingle();
    if (error || !data) return null;
    return { uid: data.id, ...data };
  }

  async function getUserByEmail(email) {
    const { data, error } = await supabase.from(USERS_COL).select('*').eq('email', normalizeEmail(email)).maybeSingle();
    if (error || !data) return null;
    return { uid: data.id, ...data };
  }

  async function getInviteCodeOwner(code) {
    const { data, error } = await supabase.from(INVITE_CODES_COL).select('*').eq('code', code.toUpperCase()).maybeSingle();
    if (error || !data) return null;
    return data;
  }

  async function registerInviteCode(code, uid, email) {
    await supabase.from(INVITE_CODES_COL).upsert({
      code: code.toUpperCase(),
      owner_uid: uid,
      owner_email: normalizeEmail(email)
    });
  }

  /* ---------------- one-time admin seed ---------------- */
  async function seedDefaultAdminOnce(email, password, name) {
    const { data, error } = await supabase.auth.signUp({
      email: normalizeEmail(email),
      password
    });
    if (error) return { ok: false, message: error.message };
    const uid = data.user.id;

    await supabase.from(USERS_COL).upsert({
      id: uid,
      name: name || "Admin",
      email: normalizeEmail(email),
      role: "admin",
      invitation_code: "",
      my_invite_code: "ADMIN0001",
      balance: 0,
      created_at: new Date().toISOString(),
      blocked: false
    });
    await registerInviteCode("ADMIN0001", uid, email);
    await supabase.auth.signOut();
    return { ok: true };
  }

  /* ---------------- auth: login / signup / logout ---------------- */

  async function login(email, password) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizeEmail(email),
        password
      });
      if (error) throw error;

      const profile = await getUserDoc(data.user.id);
      if (!profile) {
        await supabase.auth.signOut();
        return { ok: false, message: "Account profile not found." };
      }
      if (profile.blocked) {
        await supabase.auth.signOut();
        return { ok: false, message: "This account has been blocked. Please contact support." };
      }
      logActivity("login", `${profile.name} logged in`, { email: profile.email, role: profile.role });
      return { ok: true, user: profile };
    } catch (e) {
      console.error("SogoAuth.login failed:", e.message);
      return { ok: false, message: "Incorrect email/phone or password. (" + (e.message || "unknown") + ")" };
    }
  }

  async function signup({ name, email, password, invitationCode }) {
    const code = (invitationCode || "").trim();
    if (!code) return { ok: false, message: "Invitation code is required." };

    const inviter = await getInviteCodeOwner(code);
    if (!inviter) return { ok: false, message: "Invalid invitation code." };

    try {
      const { data, error } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password
      });
      if (error) throw error;

      const uid = data.user.id;
      const myCode = generateInviteCode();
      const profile = {
        id: uid,
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitation_code: code,
        invited_by_email: inviter.owner_email || inviter.ownerEmail,
        my_invite_code: myCode,
        balance: 0,
        created_at: new Date().toISOString(),
        blocked: false
      };
      await supabase.from(USERS_COL).upsert(profile);
      await registerInviteCode(myCode, uid, email);
      logActivity("signup", `${profile.name} signed up using invite code ${code}`, { email: profile.email, invitedBy: profile.invited_by_email });
      return { ok: true, user: { uid, ...profile } };
    } catch (e) {
      if (e.message && e.message.includes("already registered")) return { ok: false, message: "This email is already registered." };
      if (e.message && e.message.includes("Password")) return { ok: false, message: "Password must be at least 6 characters." };
      return { ok: false, message: "Signup failed: " + e.message };
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "auth.html";
  }

  async function getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user) return null;
    const profile = await getUserDoc(session.user.id);
    if (!profile) return null;
    return { uid: session.user.id, email: profile.email, name: profile.name, role: profile.role };
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
    await supabase.from(PW_REQUESTS_COL).insert([{
      email: cleanEmail, name: cleanEmail, status: "pending", requested_at: new Date().toISOString()
    }]);
    logActivity("password_reset_requested", `${cleanEmail} requested a password reset`, { email: cleanEmail });
    notifyAllAdmins("password_reset_requested", "Password reset requested", `${cleanEmail} requested a password reset.`, { email: cleanEmail });
    return { ok: true };
  }

  async function getPasswordRequests() {
    const { data } = await supabase.from(PW_REQUESTS_COL).select('*');
    return data || [];
  }

  async function fulfillPasswordRequest(id) {
    await supabase.from(PW_REQUESTS_COL).update({ status: "fulfilled" }).eq('id', id);
  }
  async function dismissPasswordRequest(id) {
    await supabase.from(PW_REQUESTS_COL).update({ status: "dismissed" }).eq('id', id);
  }

  /* ---------------- users (admin) ---------------- */

  async function updateUserByUid(uid, changes) {
    if (!uid) return null;
    await supabase.from(USERS_COL).update(changes).eq('id', uid);
    return getUserDoc(uid);
  }

  async function getUsers() {
    const { data } = await supabase.from(USERS_COL).select('*');
    return (data || []).map(d => ({ uid: d.id, ...d }));
  }

  async function updateUser(email, changes) {
    const user = await getUserByEmail(email);
    if (!user) return null;
    await supabase.from(USERS_COL).update(changes).eq('id', user.uid);
    return { ...user, ...changes };
  }

  async function deleteUser(email) {
    const user = await getUserByEmail(email);
    if (!user) return;
    await supabase.from(USERS_COL).delete().eq('id', user.uid);
    logActivity("user_deleted", `${user.name} (${user.email}) was deleted by admin`, { email: user.email });
  }

  async function adminCreateUser(name, email, password) {
    const existing = await getUserByEmail(email);
    if (existing) return { ok: false, message: "This email is already registered." };

    try {
      const { data, error } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password
      });
      if (error) throw error;
      const uid = data.user.id;
      const myCode = generateInviteCode();
      const profile = {
        id: uid,
        name: name || "New User",
        email: normalizeEmail(email),
        role: "client",
        invitation_code: "(created by admin)",
        my_invite_code: myCode,
        balance: 0,
        created_at: new Date().toISOString(),
        blocked: false
      };
      await supabase.from(USERS_COL).upsert(profile);
      await registerInviteCode(myCode, uid, email);
      logActivity("user_created_by_admin", `Admin created new user ${profile.name} (${profile.email})`, { email: profile.email });
      return { ok: true, user: profile };
    } catch (e) {
      return { ok: false, message: "Could not create user: " + e.message };
    }
  }

  async function setInviteCode(email, customCode) {
    const user = await getUserByEmail(email);
    if (!user) return null;
    const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : generateInviteCode();
    const oldCode = user.my_invite_code || user.myInviteCode;
    await supabase.from(USERS_COL).update({ my_invite_code: code }).eq('id', user.uid);
    await registerInviteCode(code, user.uid, user.email);
    if (oldCode && oldCode !== code) {
      try { await supabase.from(INVITE_CODES_COL).delete().eq('code', oldCode.toUpperCase()); } catch (_) {}
    }
    return { ...user, my_invite_code: code };
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
    const { data } = await supabase
      .from(MESSAGES_COL)
      .select('*')
      .eq('user_id', user.uid)
      .order('time', { ascending: true });
    return data || [];
  }

  function listenChatThread(clientEmail, callback) {
    getUserByEmail(clientEmail).then(user => {
      if (!user) return callback([]);
      getChatThread(clientEmail).then(callback);
      supabase
        .channel(`public:messages:${user.uid}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: MESSAGES_COL,
          filter: `user_id=eq.${user.uid}`
        }, () => {
          getChatThread(clientEmail).then(callback);
        })
        .subscribe();
    });
  }

  async function sendChatMessage(clientEmail, from, text) {
    const user = await getUserByEmail(clientEmail);
    if (!user) return;
    await supabase.from(MESSAGES_COL).insert([{
      user_id: user.uid,
      from,
      text,
      time: new Date().toISOString(),
      read: from === "admin"
    }]);
  }

  async function markChatRead(clientEmail) {
    const user = await getUserByEmail(clientEmail);
    if (!user) return;
    await supabase
      .from(MESSAGES_COL)
      .update({ read: true })
      .eq('user_id', user.uid)
      .eq('from', 'client')
      .eq('read', false);
  }

  /* Uploads an image/file to the 'chat-attachments' storage bucket and sends it
     as a chat message. The message "text" is set to the public file URL; the
     UI layer detects image URLs (by extension) and renders them as images. */
  async function sendChatAttachment(clientEmail, from, file) {
    try {
      const user = await getUserByEmail(clientEmail);
      if (!user) return { ok: false, message: 'User not found.' };
      if (!file) return { ok: false, message: 'No file selected.' };

      const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${user.uid}/${Date.now()}-${safeName}`;
      const { error: uploadErr } = await supabase.storage
        .from('chat-attachments')
        .upload(path, file, { upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: pub } = supabase.storage.from('chat-attachments').getPublicUrl(path);
      const publicUrl = pub ? pub.publicUrl : '';
      if (!publicUrl) throw new Error('Could not get public URL for uploaded file.');

      await supabase.from(MESSAGES_COL).insert([{
        user_id: user.uid,
        from,
        text: publicUrl,
        time: new Date().toISOString(),
        read: from === 'admin'
      }]);

      return { ok: true, url: publicUrl };
    } catch (e) {
      console.error('sendChatAttachment failed:', e.message);
      return { ok: false, message: e.message || 'Upload failed.' };
    }
  }

  async function getUnreadMessageCount() {
    const users = (await getUsers()).filter(u => u.role === "client");
    let totalUnread = 0;
    for (const u of users) {
      const { count } = await supabase
        .from(MESSAGES_COL)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', u.uid)
        .eq('from', 'client')
        .eq('read', false);
      if (count) totalUnread += count;
    }
    return totalUnread;
  }

  async function getActiveChatsCount() {
    const users = (await getUsers()).filter(u => u.role === "client");
    let activeCount = 0;
    for (const u of users) {
      const { count } = await supabase
        .from(MESSAGES_COL)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', u.uid);
      if (count && count > 0) activeCount++;
    }
    return activeCount;
  }

  /* ---------------- withdrawals ---------------- */

  async function getWithdrawals() {
    const { data } = await supabase.from(WITHDRAWALS_COL).select('*');
    return data || [];
  }

  async function requestWithdrawal(email, name, amount, accountDetails) {
    const user = await getUserByEmail(email);
    const record = {
      user_id: user ? user.uid : null,
      email, name, amount, account_details: accountDetails,
      status: "pending", requested_at: new Date().toISOString()
    };
    const { data } = await supabase.from(WITHDRAWALS_COL).insert([record]).select().single();
    logActivity("withdrawal_requested", `${name} requested a withdrawal of $${Number(amount).toFixed(2)}`, { email });
    notifyAllAdmins("withdrawal_requested", "New withdrawal request", `${name} requested a withdrawal of $${Number(amount).toFixed(2)}.`, { email });
    return data ? { id: data.id, ...record } : record;
  }

  async function updateWithdrawal(id, status) {
    if (status !== "approved") {
      const { data: w } = await supabase.from(WITHDRAWALS_COL).select('*').eq('id', id).single();
      if (!w) return null;
      if (w.status === "approved") return w;
      await supabase.from(WITHDRAWALS_COL).update({ status }).eq('id', id);
      logActivity("withdrawal_rejected", `Withdrawal of $${Number(w.amount || 0).toFixed(2)} rejected for ${w.name}`, { email: w.email });
      if (status === "rejected") {
        notifyUser(w.user_id, "withdrawal_rejected", "Withdrawal rejected", `Your withdrawal request of $${Number(w.amount || 0).toFixed(2)} was rejected.`);
      }
      return { ...w, status };
    }

    try {
      const { data: w, error: wErr } = await supabase.from(WITHDRAWALS_COL).select('*').eq('id', id).single();
      if (wErr || !w) throw new Error("Withdrawal request not found.");
      if (w.status === "approved") return { ...w, alreadyApproved: true };
      if (!(Number(w.amount) > 0)) throw new Error("This withdrawal has an invalid amount and cannot be approved.");

      const user = await getUserByEmail(w.email);
      if (!user) throw new Error("User not found.");

      const { data: userData, error: uErr } = await supabase.from(USERS_COL).select('balance').eq('id', user.uid).single();
      if (uErr || !userData) throw new Error("User balance not found.");
      const currentBalance = userData.balance || 0;

      if (currentBalance < w.amount) {
        throw new Error(`Insufficient balance: user has $${currentBalance.toFixed(2)}, withdrawal is $${Number(w.amount).toFixed(2)}.`);
      }

      await supabase.from(USERS_COL).update({ balance: currentBalance - w.amount }).eq('id', user.uid);
      await supabase.from(WITHDRAWALS_COL).update({ status: "approved" }).eq('id', id);

      logActivity("withdrawal_approved", `Withdrawal of $${Number(w.amount || 0).toFixed(2)} approved for ${w.name}`, { email: w.email });
      notifyUser(user.uid, "withdrawal_approved", "Withdrawal approved", `Your withdrawal of $${Number(w.amount || 0).toFixed(2)} was approved.`);
      return { ...w, status: "approved" };
    } catch (e) {
      return { ok: false, message: e.message || "Could not approve withdrawal." };
    }
  }

  /* ---------------- top-ups ---------------- */

  async function getTopups() {
    const { data } = await supabase.from(TOPUPS_COL).select('*');
    return data || [];
  }

  async function requestTopup(email, name, amount, note) {
    const user = await getUserByEmail(email);
    const record = {
      user_id: user ? user.uid : null,
      email, name, amount, note: note || "",
      status: "pending", requested_at: new Date().toISOString()
    };
    const { data } = await supabase.from(TOPUPS_COL).insert([record]).select().single();
    logActivity("topup_requested", `${name} requested a top-up of $${Number(amount).toFixed(2)}`, { email });
    notifyAllAdmins("topup_requested", "New top-up request", `${name} requested a top-up of $${Number(amount).toFixed(2)}.`, { email });
    return data ? { id: data.id, ...record } : record;
  }

  async function updateTopup(id, status) {
    if (status !== "approved") {
      const { data: t } = await supabase.from(TOPUPS_COL).select('*').eq('id', id).single();
      if (!t) return null;
      if (t.status === "approved") return t;
      await supabase.from(TOPUPS_COL).update({ status }).eq('id', id);
      logActivity("topup_rejected", `Top-up of $${Number(t.amount || 0).toFixed(2)} rejected for ${t.name}`, { email: t.email });
      if (status === "rejected") {
        notifyUser(t.user_id, "topup_rejected", "Top-up rejected", `Your top-up request of $${Number(t.amount || 0).toFixed(2)} was rejected.`);
      }
      return { ...t, status };
    }

    try {
      const { data: t, error: tErr } = await supabase.from(TOPUPS_COL).select('*').eq('id', id).single();
      if (tErr || !t) throw new Error("Top-up request not found.");
      if (t.status === "approved") return { ...t, alreadyApproved: true };
      if (!(Number(t.amount) > 0)) throw new Error("This top-up has an invalid amount and cannot be approved.");

      const user = await getUserByEmail(t.email);
      if (!user) throw new Error("User not found.");

      const { data: userData, error: uErr } = await supabase.from(USERS_COL).select('balance').eq('id', user.uid).single();
      if (uErr || !userData) throw new Error("User balance not found.");
      const currentBalance = userData.balance || 0;

      await supabase.from(USERS_COL).update({ balance: currentBalance + t.amount }).eq('id', user.uid);
      await supabase.from(TOPUPS_COL).update({ status: "approved" }).eq('id', id);

      logActivity("topup_approved", `Top-up of $${Number(t.amount || 0).toFixed(2)} approved for ${t.name}`, { email: t.email });
      notifyUser(user.uid, "topup_approved", "Top-up approved", `Your top-up of $${Number(t.amount || 0).toFixed(2)} was approved and added to your balance.`);
      return { ...t, status: "approved" };
    } catch (e) {
      return { ok: false, message: e.message || "Could not approve top-up." };
    }
  }

  /* ---------------- activity log ---------------- */
  async function getActivity() {
    const { data } = await supabase.from(ACTIVITY_COL).select('*').order('time', { ascending: false });
    return data || [];
  }

  return {
    login, signup, logout, getSession, requireRole, redirectForRole, impersonate,
    getUserDoc, getUserByEmail, updateUserByUid, seedDefaultAdminOnce,
    getUsers, updateUser, deleteUser, adminCreateUser, setInviteCode,
    getChatThread, listenChatThread, sendChatMessage, sendChatAttachment, markChatRead, getUnreadMessageCount, getActiveChatsCount,
    getWithdrawals, requestWithdrawal, updateWithdrawal,
    getTopups, requestTopup, updateTopup,
    getPasswordRequests, requestPasswordReset, fulfillPasswordRequest, dismissPasswordRequest,
    getActivity, logActivity,
    getMyNotifications, getUnreadNotificationCount, markAllNotificationsRead, sendManualNotification, notifyUser, notifyAllAdmins
  };
})();

window.SogoAuth = SogoAuth;
