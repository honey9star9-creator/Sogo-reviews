/* SOGO REVIEWS — Shared Auth Logic (localStorage-based demo auth)
   ------------------------------------------------------------------
   This is a FRONTEND-ONLY demo auth system. It stores users in the
   browser's localStorage so the site is fully clickable end-to-end
   without a real backend yet.

   IMPORTANT: This is NOT secure for a real production site — anyone
   can open devtools and read/edit localStorage. When you're ready,
   swap SogoAuth's internals for real API calls to your own backend
   (Firebase, Supabase, Node/Express, etc.) and keep the same function
   names so the rest of your pages don't need to change.
*/

const SogoAuth = (() => {
  const USERS_KEY = 'sogo_users';
  const SESSION_KEY = 'sogo_session';

  // Seed a default admin account the very first time the site loads.
  function seedDefaultAdmin() {
    const users = getUsers();
    const adminIdx = users.findIndex(u => u.role === 'admin');
    if (adminIdx === -1) {
      users.push({
        name: 'Admin',
        email: 'Vitto@gmail.com',
        password: 'Vitto123',
        role: 'admin',
        invitationCode: '',
        myInviteCode: 'ADMIN0001',
        createdAt: new Date().toISOString(),
        blocked: false
      });
      saveUsers(users);
    } else if (!users[adminIdx].myInviteCode) {
      // Migration: older saved data may be missing this field.
      users[adminIdx].myInviteCode = users[adminIdx].invitationCode || 'ADMIN0001';
      users[adminIdx].createdAt = users[adminIdx].createdAt || new Date().toISOString();
      users[adminIdx].blocked = !!users[adminIdx].blocked;
      saveUsers(users);
    }

    // Migration: patch any user missing newer fields (createdAt, blocked, myInviteCode).
    let changed = false;
    users.forEach(u => {
      if (!u.createdAt) { u.createdAt = new Date().toISOString(); changed = true; }
      if (u.blocked === undefined) { u.blocked = false; changed = true; }
      if (!u.myInviteCode) { u.myInviteCode = generateInviteCode(); changed = true; }
    });
    if (changed) saveUsers(users);
  }

  function getUsers() {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function updateUser(email, changes) {
    const users = getUsers();
    const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
    if (idx === -1) return null;
    users[idx] = Object.assign({}, users[idx], changes);
    saveUsers(users);
    return users[idx];
  }

  function deleteUser(email) {
    const target = getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
    const users = getUsers().filter(u => u.email.toLowerCase() !== email.toLowerCase());
    saveUsers(users);
    // Clean up related data too.
    const chats = getChats();
    delete chats[email.toLowerCase()];
    localStorage.setItem(CHAT_KEY, JSON.stringify(chats));
    const withdrawals = getWithdrawals().filter(w => w.email.toLowerCase() !== email.toLowerCase());
    localStorage.setItem(WITHDRAWALS_KEY, JSON.stringify(withdrawals));
    if (target) logActivity('user_deleted', `${target.name} (${target.email}) was deleted by admin`, { email: target.email });
  }

  // Admin creates a client account directly (no invitation code needed).
  function adminCreateUser(name, email, password) {
    const users = getUsers();
    if (users.some(u => normalizeEmail(u.email) === normalizeEmail(email))) {
      return { ok: false, message: 'This email is already registered.' };
    }
    const newUser = {
      name: name || 'New User',
      email,
      password,
      role: 'client',
      invitationCode: '(created by admin)',
      myInviteCode: generateInviteCode(),
      balance: 0,
      createdAt: new Date().toISOString(),
      blocked: false
    };
    users.push(newUser);
    saveUsers(users);
    logActivity('user_created_by_admin', `Admin created new user ${newUser.name} (${newUser.email})`, { email: newUser.email });
    return { ok: true, user: newUser };
  }

  // Regenerate or set a custom invite code for a user (admin or client).
  function setInviteCode(email, customCode) {
    const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : generateInviteCode();
    return updateUser(email, { myInviteCode: code });
  }

  /* ---------------- Chat (client <-> admin) ---------------- */
  const CHAT_KEY = 'sogo_chats'; // { [clientEmail]: [ {from, text, time} ] }

  function getChats() {
    try {
      return JSON.parse(localStorage.getItem(CHAT_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function getChatThread(clientEmail) {
    const chats = getChats();
    return chats[clientEmail.toLowerCase()] || [];
  }

  function sendChatMessage(clientEmail, from, text) {
    const chats = getChats();
    const key = clientEmail.toLowerCase();
    if (!chats[key]) chats[key] = [];
    chats[key].push({ from, text, time: new Date().toISOString(), read: from === 'admin' });
    localStorage.setItem(CHAT_KEY, JSON.stringify(chats));
  }

  // Mark all of a client's messages as read (admin opened the thread).
  function markChatRead(clientEmail) {
    const chats = getChats();
    const key = clientEmail.toLowerCase();
    if (!chats[key]) return;
    chats[key].forEach(m => { if (m.from === 'client') m.read = true; });
    localStorage.setItem(CHAT_KEY, JSON.stringify(chats));
  }

  function getUnreadMessageCount() {
    const chats = getChats();
    let count = 0;
    Object.values(chats).forEach(thread => {
      thread.forEach(m => { if (m.from === 'client' && !m.read) count++; });
    });
    return count;
  }

  function getActiveChatsCount() {
    const chats = getChats();
    return Object.values(chats).filter(thread => thread.length > 0).length;
  }

  /* ---------------- Withdrawals ---------------- */
  const WITHDRAWALS_KEY = 'sogo_withdrawals';

  function getWithdrawals() {
    try {
      return JSON.parse(localStorage.getItem(WITHDRAWALS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function requestWithdrawal(email, name, amount, accountDetails) {
    const list = getWithdrawals();
    const record = {
      id: 'w_' + Date.now(),
      email, name, amount, accountDetails,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };
    list.push(record);
    localStorage.setItem(WITHDRAWALS_KEY, JSON.stringify(list));
    logActivity('withdrawal_requested', `${name} requested a withdrawal of $${amount.toFixed(2)}`, { email });
    return record;
  }

  function updateWithdrawal(id, status) {
    const list = getWithdrawals();
    const idx = list.findIndex(w => w.id === id);
    if (idx === -1) return null;
    list[idx].status = status;
    localStorage.setItem(WITHDRAWALS_KEY, JSON.stringify(list));
    logActivity(
      status === 'approved' ? 'withdrawal_approved' : 'withdrawal_rejected',
      `Withdrawal of $${list[idx].amount.toFixed(2)} ${status} for ${list[idx].name}`,
      { email: list[idx].email }
    );
    return list[idx];
  }

  /* ---------------- Top-up requests ---------------- */
  const TOPUPS_KEY = 'sogo_topups';

  function getTopups() {
    try {
      return JSON.parse(localStorage.getItem(TOPUPS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function requestTopup(email, name, amount, note) {
    const list = getTopups();
    const record = {
      id: 't_' + Date.now(),
      email, name, amount, note: note || '',
      status: 'pending',
      requestedAt: new Date().toISOString()
    };
    list.push(record);
    localStorage.setItem(TOPUPS_KEY, JSON.stringify(list));
    logActivity('topup_requested', `${name} requested a top-up of $${amount.toFixed(2)}`, { email });
    return record;
  }

  function updateTopup(id, status) {
    const list = getTopups();
    const idx = list.findIndex(t => t.id === id);
    if (idx === -1) return null;
    list[idx].status = status;
    localStorage.setItem(TOPUPS_KEY, JSON.stringify(list));
    if (status === 'approved') {
      const user = getUsers().find(u => u.email.toLowerCase() === list[idx].email.toLowerCase());
      if (user) updateUser(user.email, { balance: (user.balance || 0) + list[idx].amount });
      logActivity('topup_approved', `Top-up of $${list[idx].amount.toFixed(2)} approved for ${list[idx].name}`, { email: list[idx].email });
    } else if (status === 'rejected') {
      logActivity('topup_rejected', `Top-up of $${list[idx].amount.toFixed(2)} rejected for ${list[idx].name}`, { email: list[idx].email });
    }
    return list[idx];
  }

  /* ---------------- Password reset requests ---------------- */
  const PW_REQUESTS_KEY = 'sogo_password_requests';

  function getPasswordRequests() {
    try {
      return JSON.parse(localStorage.getItem(PW_REQUESTS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function requestPasswordReset(email) {
    const users = getUsers();
    const user = users.find(u => normalizeEmail(u.email) === normalizeEmail(email));
    if (!user) {
      return { ok: false, message: 'No account found with that email.' };
    }
    const list = getPasswordRequests();
    const record = {
      id: 'p_' + Date.now(),
      email: user.email, name: user.name,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };
    list.push(record);
    localStorage.setItem(PW_REQUESTS_KEY, JSON.stringify(list));
    logActivity('password_reset_requested', `${user.name} requested a password reset`, { email: user.email });
    return { ok: true, record };
  }

  function fulfillPasswordRequest(id, newPassword) {
    const list = getPasswordRequests();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;
    list[idx].status = 'fulfilled';
    localStorage.setItem(PW_REQUESTS_KEY, JSON.stringify(list));
    updateUser(list[idx].email, { password: newPassword });
    logActivity('password_reset_fulfilled', `Password reset for ${list[idx].name}`, { email: list[idx].email });
    return list[idx];
  }

  function dismissPasswordRequest(id) {
    const list = getPasswordRequests();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;
    list[idx].status = 'dismissed';
    localStorage.setItem(PW_REQUESTS_KEY, JSON.stringify(list));
    return list[idx];
  }

  /* ---------------- Activity / access log ---------------- */
  const ACTIVITY_KEY = 'sogo_activity';

  function getActivity() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVITY_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function logActivity(type, message, meta) {
    const list = getActivity();
    list.push({ type, message, meta: meta || {}, time: new Date().toISOString() });
    // Keep the log from growing forever.
    if (list.length > 300) list.splice(0, list.length - 300);
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(list));
  }

  function normalizeEmail(email) {
    return (email || '').trim().toLowerCase();
  }

  function generateInviteCode() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  }

  // Returns { ok: true, user } or { ok: false, message }
  function login(email, password) {
    const users = getUsers();
    const found = users.find(
      u => normalizeEmail(u.email) === normalizeEmail(email) && u.password === password
    );
    if (!found) {
      return { ok: false, message: 'Incorrect email/phone or password.' };
    }
    if (found.blocked) {
      return { ok: false, message: 'This account has been blocked. Please contact support.' };
    }
    setSession(found);
    logActivity('login', `${found.name} logged in`, { email: found.email, role: found.role });
    return { ok: true, user: found };
  }

  // Returns { ok: true, user } or { ok: false, message }
  function signup({ name, email, password, invitationCode }) {
    const users = getUsers();
    if (users.some(u => normalizeEmail(u.email) === normalizeEmail(email))) {
      return { ok: false, message: 'This email is already registered.' };
    }
    const code = (invitationCode || '').trim();
    if (!code) {
      return { ok: false, message: 'Invitation code is required.' };
    }
    const inviter = users.find(u => (u.myInviteCode || '').toUpperCase() === code.toUpperCase());
    if (!inviter) {
      return { ok: false, message: 'Invalid invitation code.' };
    }
    const newUser = {
      name: name || 'New User',
      email,
      password,
      role: 'client',
      invitationCode: code,
      invitedByEmail: inviter.email,
      myInviteCode: generateInviteCode(),
      balance: 0,
      createdAt: new Date().toISOString(),
      blocked: false
    };
    users.push(newUser);
    saveUsers(users);
    setSession(newUser);
    logActivity('signup', `${newUser.name} signed up using invite code ${code}`, { email: newUser.email, invitedBy: inviter.email });
    return { ok: true, user: newUser };
  }

  function setSession(user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      email: user.email,
      name: user.name,
      role: user.role
    }));
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (e) {
      return null;
    }
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = 'auth.html';
  }

  // Call at the top of a protected page. If not logged in, or logged in
  // with the wrong role, redirects to auth.html automatically.
  function requireRole(role) {
    const session = getSession();
    if (!session || session.role !== role) {
      window.location.href = 'auth.html';
      return null;
    }
    // If an admin blocked this user mid-session, kick them out too.
    const freshUser = getUsers().find(u => u.email.toLowerCase() === session.email.toLowerCase());
    if (!freshUser || freshUser.blocked) {
      logout();
      return null;
    }
    return session;
  }

  function redirectForRole(role) {
    if (role === 'admin') {
      window.location.href = 'master-admin.html';
    } else {
      window.location.href = 'client-dashboard.html';
    }
  }

  // Admin-only: temporarily view the site as a given client.
  // NOTE: since this is localStorage-based, this changes the session for
  // THIS browser — the admin will need to log back in afterwards.
  function impersonate(email) {
    const user = getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return false;
    setSession(user);
    logActivity('admin_access', `Admin accessed ${user.name}'s account (${user.email})`, { email: user.email });
    window.location.href = 'client-dashboard.html';
    return true;
  }

  seedDefaultAdmin();

  return {
    login, signup, logout, getSession, requireRole, redirectForRole, impersonate,
    getUsers, updateUser, deleteUser, adminCreateUser, setInviteCode,
    getChatThread, sendChatMessage, markChatRead, getUnreadMessageCount, getActiveChatsCount,
    getWithdrawals, requestWithdrawal, updateWithdrawal,
    getTopups, requestTopup, updateTopup,
    getPasswordRequests, requestPasswordReset, fulfillPasswordRequest, dismissPasswordRequest,
    getActivity, logActivity
  };
})();
