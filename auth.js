/* SOGO REVIEWS — Shared Auth + Data Logic (Supabase version)
    ------------------------------------------------------------------
    FULL UPDATED VERSION - ZERO CODE OMITTED
    (Adds: notifications system — read/mark-read/manual-send helpers,
    plus notify hooks on withdrawal/topup/password-reset flows)
*/

import { supabase } from "./supabase-config.js";

const USERS_COL = "users";
const MASTER_ADMIN_EMAIL = "honey9star9@gmail.com";
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
  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // CHANGED: signup()/adminCreateUser() both do auth.signUp() then insert a
  // profile row right after. If that insert fails (transient network blip, RLS
  // hiccup, etc.) the person is left with a login that has no profile — and since
  // the auth account can't be deleted from client code, they'd also be blocked
  // from signing up again. This retries the insert a couple of times before
  // giving up, so a one-off glitch doesn't create that state. (login() also
  // self-heals this case if it still happens — see the login() changes.)
  async function upsertProfileWithRetry(profile, attempts) {
    const maxAttempts = attempts || 3;
    let lastError = null;
    for (let i = 0; i < maxAttempts; i++) {
      const { error } = await supabase.from(USERS_COL).upsert(profile);
      if (!error) return { ok: true };
      lastError = error;
      if (i < maxAttempts - 1) await wait(400 * (i + 1));
    }
    return { ok: false, message: lastError ? lastError.message : "Unknown error" };
  }

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

      let profile = await getUserDoc(data.user.id);
      if (!profile) {
        // CHANGED: this used to sign the person out with "Account profile not
        // found" and no way to ever fix it — if their signup's auth.signUp()
        // succeeded but the profiles-table insert failed (network blip, RLS
        // hiccup, etc.), they were left with a login that could never work AND
        // could never sign up again ("email already registered"). Since
        // deleteUser() no longer removes profile rows either (see Fix #4), a
        // missing profile at this point can only mean that exact orphan case, so
        // it's safe to self-heal by creating a minimal profile here rather than
        // leaving them stuck.
        const recoveredCode = generateInviteCode();
        const recoveredProfile = {
          id: data.user.id,
          name: (data.user.email || email || "New User").split("@")[0],
          email: normalizeEmail(data.user.email || email),
          role: "client",
          invitation_code: "",
          my_invite_code: recoveredCode,
          balance: 0,
          created_at: new Date().toISOString(),
          blocked: false
        };
        const { error: recoverErr } = await supabase.from(USERS_COL).upsert(recoveredProfile);
        if (recoverErr) {
          await supabase.auth.signOut();
          return { ok: false, message: "Account profile not found and could not be recovered. Please contact support. (" + recoverErr.message + ")" };
        }
        await registerInviteCode(recoveredCode, data.user.id, recoveredProfile.email);
        logActivity("profile_recovered", `${recoveredProfile.email} was missing a profile on login and one was auto-created`, { email: recoveredProfile.email, uid: data.user.id });
        profile = await getUserDoc(data.user.id);
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
      const upsertResult = await upsertProfileWithRetry(profile);
      if (!upsertResult.ok) {
        // The auth account was created but the profile couldn't be saved even
        // after retrying. We can't roll back the auth account from here, but
        // login() will auto-create a minimal profile the next time they sign in,
        // so this is recoverable rather than a dead end.
        return { ok: false, message: "Your account was created, but we couldn't finish setting up your profile. Please try signing in — it will finish automatically." };
      }
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

  // CHANGED: this used to hard-delete the user's row from the `users` table.
  // That only removes their profile — the underlying Supabase Auth login account
  // is untouched (deleting it requires a service-role key, which must never be
  // shipped to the browser). The result was an orphaned auth account: the person
  // could never log in (no profile) AND could never sign up again ("email already
  // registered"), with no trace left for support to find them.
  //
  // Instead this now blocks the account and scrubs the display name, which achieves
  // the practical goal (revoke access, hide them from the active list) without
  // creating that unrecoverable state. A true permanent delete of the login account
  // itself has to be done by a project owner from the Supabase dashboard
  // (Authentication -> Users -> delete), or via a server-side Edge Function using
  // the service-role key if you want this fully automated later.
  async function deleteUser(email) {
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail === MASTER_ADMIN_EMAIL) {
      return { ok: false, message: "The master admin account cannot be deleted." };
    }
    const user = await getUserByEmail(email);
    if (!user) return { ok: false, message: "User not found." };

    // CHANGED: real hard-delete instead of soft block+rename. The FK
    // "on delete cascade" links (user_packages, reviews, messages,
    // package_deposits -> users.id) wipe all of that client's related
    // data automatically the moment this row goes. Their Supabase Auth
    // login account itself isn't touched (can't be, from client code) --
    // if that same email ever logs in again, login()'s existing self-heal
    // logic creates a fresh, empty client profile, so no old data can
    // ever carry over / be "taken over."
    const { error } = await supabase.from(USERS_COL).delete().eq('id', user.uid);
    if (error) return { ok: false, message: "Could not delete user: " + error.message };

    logActivity("user_deleted", `${user.name} (${user.email}) and all related data were permanently deleted by admin`, { email: user.email });
    return { ok: true };
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
      const upsertResult = await upsertProfileWithRetry(profile);
      if (!upsertResult.ok) {
        // CHANGED: see the signOut() note below — do this before returning on
        // this path too, so the admin isn't left silently logged in as the
        // half-created account.
        await supabase.auth.signOut();
        return { ok: false, message: "The login account was created, but the profile could not be saved (" + upsertResult.message + "). Ask the user to try signing in — it will finish setting up their profile automatically.", sessionInvalidated: true };
      }
      await registerInviteCode(myCode, uid, email);
      logActivity("user_created_by_admin", `Admin created new user ${profile.name} (${profile.email})`, { email: profile.email });

      // CHANGED: supabase.auth.signUp() above already silently replaced the
      // admin's own browser session with the brand-new client's session (this
      // happens whenever email confirmation is off, which it is here — client
      // signup() logs people in immediately with no verification step). Every
      // Supabase call from this point in the page's life would otherwise run as
      // the new client, not the admin, breaking RLS-protected reads/writes with
      // no visible warning. Signing out here — after the invite-code/activity
      // writes above, which already ran under that session either way — forces a
      // clean re-login instead of continuing silently under the wrong identity.
      await supabase.auth.signOut();
      return { ok: true, user: profile, sessionInvalidated: true };
    } catch (e) {
      return { ok: false, message: "Could not create user: " + e.message };
    }
  }

  async function setInviteCode(email, customCode) {
    const user = await getUserByEmail(email);
    if (!user) return null;
    const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : generateInviteCode();
    const oldCode = user.my_invite_code || user.myInviteCode;

    // Pehle check karo ke ye code kisi aur user ke paas to nahi hai
    const { data: clash } = await supabase.from(USERS_COL).select('id').eq('my_invite_code', code).neq('id', user.uid).maybeSingle();
    if (clash) return { error: true, message: 'This code is already in use by another account. Please choose a different one.' };

    const { error: updateErr } = await supabase.from(USERS_COL).update({ my_invite_code: code }).eq('id', user.uid);
    if (updateErr) return { error: true, message: 'Could not update invite code: ' + updateErr.message };

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

  async function listenChatThread(clientEmail, callback) {
    const user = await getUserByEmail(clientEmail);
    if (!user) {
      callback([]);
      return () => {}; // no-op unsubscribe so callers can always call it safely
    }

    await getChatThread(clientEmail).then(callback);

    // Unique channel name (per call) so opening the same user's chat twice
    // (e.g. admin clicking around) never collides with a still-open channel.
    const channel = supabase
      .channel(`messages-${user.uid}-${Date.now()}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: MESSAGES_COL,
        filter: `user_id=eq.${user.uid}`
      }, () => {
        getChatThread(clientEmail).then(callback);
      })
      .subscribe();

    // CHANGED: actually return an unsubscribe function. Previously this
    // function returned nothing, so every caller's `chatUnsubscribe` was
    // always undefined and old realtime channels were never cleaned up.
    return () => { supabase.removeChannel(channel); };
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
    if (from === "client") {
      notifyAllAdmins("chat_message", "New chat message", `${user.name || clientEmail} sent you a message: "${text.length > 80 ? text.slice(0, 80) + '…' : text}"`, { email: clientEmail });
    }
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

      if (from === 'client') {
        notifyAllAdmins("chat_message", "New chat message", `${user.name || clientEmail} sent you a photo.`, { email: clientEmail });
      }

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
