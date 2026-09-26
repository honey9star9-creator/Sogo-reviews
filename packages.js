/* SOGO REVIEWS — Packages Management Logic (Supabase Version)
   (Adds: notification hooks on join/proof-upload/deposit/review/admin actions) */

import { supabase } from "./supabase-config.js";

const NOTIFICATIONS_COL = "notifications";

function escAttr(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Lock array me se next lock requirement fetch karne ke liye helper
function findNextLock(pkg, unlockedCount) {
  if (!pkg || !pkg.locks || !Array.isArray(pkg.locks)) return null;
  const sortedLocks = [...pkg.locks].sort((a, b) => a.afterIndex - b.afterIndex);
  return sortedLocks.find(l => l.afterIndex >= unlockedCount) || null;
}

/* ---------------- notifications (local helpers) ---------------- */
async function notifyUserPkg(userId, type, title, message, meta) {
  if (!userId) return;
  try {
    await supabase.from(NOTIFICATIONS_COL).insert([{
      user_id: userId, type, title, message, meta: meta || {}
    }]);
  } catch (e) { /* non-fatal */ }
}

async function getAdminUserIdsPkg() {
  try {
    const { data } = await supabase.from('users').select('id').eq('role', 'admin');
    return (data || []).map(u => u.id);
  } catch (e) { return []; }
}

async function notifyAllAdminsPkg(type, title, message, meta) {
  const adminIds = await getAdminUserIdsPkg();
  await Promise.all(adminIds.map(id => notifyUserPkg(id, type, title, message, meta)));
}

// Tracks whether the builder form is creating a new package or editing one.
window.editingPackageId = null;
window.__prefillProducts = [];

// 1. Dynamic Product Rows Generate Karein (supports prefill for edit mode)
window.generateProductRows = function() {
  const count = parseInt(document.getElementById('pkg-count').value) || 0;
  const container = document.getElementById('builder-product-rows');
  if (!container) return;
  container.innerHTML = '';

  const prefill = window.__prefillProducts || [];

  for (let i = 1; i <= count; i++) {
    const existing = prefill[i - 1] || {};
    const div = document.createElement('div');
    div.className = 'product-row-builder';
    if (existing.image) div.dataset.existingImage = existing.image;

    div.innerHTML = `
      <span style="font-weight: 700; color: var(--text-muted);">#${i}</span>
      <input type="text" class="form-input pkg-prod-name" placeholder="Product Name #${i}" value="${escAttr(existing.name || '')}">
      <input type="number" class="form-input pkg-prod-comm" placeholder="Commission ($)" step="0.01" value="${existing.commission != null ? existing.commission : ''}">
      <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
        <input type="file" class="pkg-prod-img" accept="image/*" style="max-width:160px; font-size:0.7rem;">
        ${existing.image ? `<img src="${escAttr(existing.image)}" alt="current" style="width:30px;height:30px;object-fit:cover;border-radius:4px;border:1px solid var(--border-color);">` : ''}
      </div>
    `;
    container.appendChild(div);
  }
  calculateAutoSplit();
};

// 2. Auto Split Commission Calculate Karein
window.calculateAutoSplit = function() {
  const count = parseInt(document.getElementById('pkg-count').value) || 0;
  const totalComm = parseFloat(document.getElementById('pkg-total-comm').value) || 0;
  if (count <= 0) return;

  const commPerItem = (totalComm / count).toFixed(2);
  const rows = document.querySelectorAll('.product-row-builder .pkg-prod-comm');
  rows.forEach(input => {
    if (!input.value) input.value = commPerItem;
  });
};

// 3. Lock Row Add Karein
window.addLockRow = function() {
  const container = document.getElementById('locks-container');
  if (!container) return;
  const lockIndex = container.children.length + 1;
  const div = document.createElement('div');
  div.style.cssText = "display: flex; gap: 12px; align-items: center; margin-bottom: 10px;";
  div.innerHTML = `
    <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">#${lockIndex} After review</span>
    <input type="number" class="form-input pkg-lock-after" value="${lockIndex * 5}" style="width: 100px;">
    <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">— deposit $</span>
    <input type="number" class="form-input pkg-lock-deposit" value="400" style="width: 140px;">
    <button class="btn-sm btn-sm-danger" onclick="this.parentElement.remove()">Remove</button>
  `;
  container.appendChild(div);
};

// 3b. Builder ko reset karke "create mode" me wapas laayein
window.resetPackageBuilder = function() {
  window.editingPackageId = null;
  window.__prefillProducts = [];

  const nameEl = document.getElementById('pkg-name');
  const priceEl = document.getElementById('pkg-price');
  const descEl = document.getElementById('pkg-description');
  const countEl = document.getElementById('pkg-count');
  const totalCommEl = document.getElementById('pkg-total-comm');
  if (nameEl) nameEl.value = '';
  if (priceEl) priceEl.value = 100;
  if (descEl) descEl.value = '';
  if (countEl) countEl.value = 15;
  if (totalCommEl) totalCommEl.value = 2400;

  window.generateProductRows();

  const locksContainer = document.getElementById('locks-container');
  if (locksContainer) {
    locksContainer.innerHTML = `
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 10px;">
        <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">#1 After review</span>
        <input type="number" class="form-input pkg-lock-after" value="5" style="width: 100px;">
        <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">— deposit $</span>
        <input type="number" class="form-input pkg-lock-deposit" id="pkg-deposit" value="400" style="width: 140px;">
      </div>
    `;
  }

  const btn = document.getElementById('createPackageBtn');
  if (btn) btn.textContent = 'Create package';
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  const msg = document.getElementById('createPackageMsg');
  if (msg) msg.style.display = 'none';
};

// 3c. Kisi maujooda package ko builder me load karein (edit mode)
window.loadPackageIntoBuilder = function(pkg) {
  if (!pkg) return;
  window.editingPackageId = pkg.id;
  window.__prefillProducts = pkg.products || [];

  document.getElementById('pkg-name').value = pkg.name || '';
  document.getElementById('pkg-price').value = pkg.price || 0;
  document.getElementById('pkg-description').value = pkg.description || '';
  document.getElementById('pkg-count').value = (pkg.products || []).length || 1;
  document.getElementById('pkg-total-comm').value = pkg.totalCommission || 0;

  window.generateProductRows();

  const locksContainer = document.getElementById('locks-container');
  const locks = (pkg.locks && pkg.locks.length) ? pkg.locks : [{ afterReview: 5, depositRequired: 400 }];
  locksContainer.innerHTML = '';
  locks.forEach((lock, idx) => {
    const div = document.createElement('div');
    div.style.cssText = "display: flex; gap: 12px; align-items: center; margin-bottom: 10px;";
    div.innerHTML = `
      <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">#${idx + 1} After review</span>
      <input type="number" class="form-input pkg-lock-after" value="${lock.afterReview}" style="width: 100px;">
      <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">— deposit $</span>
      <input type="number" class="form-input pkg-lock-deposit" value="${lock.depositRequired}" style="width: 140px;">
      ${idx > 0 ? '<button class="btn-sm btn-sm-danger" onclick="this.parentElement.remove()">Remove</button>' : ''}
    `;
    locksContainer.appendChild(div);
  });

  const btn = document.getElementById('createPackageBtn');
  if (btn) btn.textContent = 'Update package';
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'inline-block';
  const msg = document.getElementById('createPackageMsg');
  if (msg) msg.style.display = 'none';

  document.getElementById('pkg-name').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// 4. Supabase me Package Create/Update Karein (with real image upload)
window.createPackageNow = async function() {
  const btn = document.getElementById('createPackageBtn');
  const msg = document.getElementById('createPackageMsg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }

  const name = document.getElementById('pkg-name').value.trim();
  const price = parseFloat(document.getElementById('pkg-price').value) || 0;
  const description = document.getElementById('pkg-description').value.trim();
  const totalComm = parseFloat(document.getElementById('pkg-total-comm').value) || 0;
  const isEditing = !!window.editingPackageId;

  if (!name) {
    if (msg) { msg.style.display = 'block'; msg.style.color = '#dc2626'; msg.textContent = 'Package name is required.'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = isEditing ? 'Updating...' : 'Creating...';

  try {
    const prodRows = Array.from(document.querySelectorAll('.product-row-builder'));
    const products = [];

    // for...of so we can safely await each image upload in order
    let idx = 0;
    for (const row of prodRows) {
      const pName = row.querySelector('.pkg-prod-name').value.trim() || `Product #${idx + 1}`;
      const pComm = parseFloat(row.querySelector('.pkg-prod-comm').value) || 0;
      const fileInput = row.querySelector('.pkg-prod-img');
      const file = fileInput && fileInput.files && fileInput.files[0];
      let imageUrl = row.dataset.existingImage || '';

      if (file) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${Date.now()}-${idx}-${safeName}`;
        const { error: uploadErr } = await supabase.storage
          .from('package-images')
          .upload(path, file, { upsert: true });
        if (uploadErr) {
          console.error('Image upload failed for product', idx + 1, uploadErr.message);
        } else {
          const { data: pub } = supabase.storage.from('package-images').getPublicUrl(path);
          if (pub && pub.publicUrl) imageUrl = pub.publicUrl;
        }
      }

      products.push({ id: idx + 1, name: pName, commission: pComm, image: imageUrl });
      idx++;
    }

    const lockAfters = document.querySelectorAll('.pkg-lock-after');
    const lockDeposits = document.querySelectorAll('.pkg-lock-deposit');
    const locks = [];
    lockAfters.forEach((input, i) => {
      const after = parseInt(input.value) || 0;
      const deposit = parseFloat(lockDeposits[i].value) || 0;
      if (after > 0) locks.push({ afterReview: after, depositRequired: deposit });
    });
    locks.sort((a, b) => a.afterReview - b.afterReview);

    const payload = {
      name,
      price,
      description,
      totalCommission: totalComm,
      productCount: products.length,
      products,
      locks,
      published: true
    };

    if (isEditing) {
      const { error } = await supabase.from('packages').update(payload).eq('id', window.editingPackageId);
      if (error) throw error;
      if (msg) { msg.style.display = 'block'; msg.style.color = '#10b981'; msg.textContent = 'Package updated successfully!'; }
    } else {
      const { error } = await supabase.from('packages').insert([payload]);
      if (error) throw error;
      if (msg) { msg.style.display = 'block'; msg.style.color = '#10b981'; msg.textContent = 'Package created successfully!'; }
    }

    window.resetPackageBuilder();
    if (window.refreshPackagesList) await window.refreshPackagesList();
  } catch (e) {
    console.error("Error saving package:", e);
    if (msg) {
      msg.style.display = 'block';
      msg.style.color = '#dc2626';
      msg.textContent = 'Failed to save package: ' + e.message;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = window.editingPackageId ? 'Update package' : 'Create package';
  }
};

// 5. Supabase se Packages Fetch Karein
window.getPackages = async function(options) {
  const opts = options || {};
  let query = supabase.from('packages').select('*').order('id', { ascending: false });
  if (opts.onlyPublished) query = query.eq('published', true);

  const { data, error } = await query;
  if (error) {
    console.error("Error fetching packages:", error);
    return [];
  }
  return data || [];
};

// 6. Supabase se Package Delete Karein
window.deletePackage = async function(pkgId) {
  if (!confirm("Are you sure you want to delete this package?")) return;

  const { error } = await supabase.from('packages').delete().eq('id', pkgId);
  if (error) {
    alert("Error deleting package: " + error.message);
  } else {
    if (window.editingPackageId === pkgId) window.resetPackageBuilder();
    if (window.refreshPackagesList) await window.refreshPackagesList();
  }
};

// 6b. Package Publish/Unpublish Toggle Karein
window.togglePublishPackage = async function(pkgId, currentlyPublished) {
  const { error } = await supabase.from('packages').update({ published: !currentlyPublished }).eq('id', pkgId);
  if (error) {
    alert("Error updating package: " + error.message);
    return;
  }
  if (window.refreshPackagesList) await window.refreshPackagesList();
};

// ============================================================
// CLIENT-SIDE PACKAGE FUNCTIONS (user_packages table)
// Needed by client-dashboard.html: getUserPackages, joinPackage, uploadPaymentProof
// ============================================================

// 7. Ek client ke joined/pending packages laayein
async function getUserPackages(uid) {
  const { data, error } = await supabase
    .from('user_packages')
    .select('*')
    .eq('userId', uid)
    .order('joinedAt', { ascending: false });

  if (error) {
    console.error("Error fetching user packages:", error);
    return [];
  }

  return (data || []).map(row => ({
    id: row.id,
    packageId: row.packageId,
    packageName: row.packageName,
    price: row.price,
    status: row.status,
    reviewsCompleted: row.reviewsCompleted || 0,
    totalProducts: row.totalProducts || 0,
    unlockedCount: row.unlockedCount || 0,
    paymentProofUrl: row.paymentProofUrl || '',
    note: row.note || '',
    joinedAt: row.joinedAt
  }));
}

// 8. Client ka kisi package ko join karna (pending_payment status se shuru)
async function joinPackage(uid, email, packageId, note) {
  try {
    const { data: pkg, error: pkgErr } = await supabase
      .from('packages')
      .select('*')
      .eq('id', packageId)
      .maybeSingle();
    if (pkgErr || !pkg) return { ok: false, message: 'Package not found.' };

    // Agar pehle se ek active/pending record hai to dobara join na hone dein
   const { data: existingRows } = await supabase
  .from('user_packages')
  .select('id, status')
  .eq('userId', uid)
  .eq('packageId', packageId)
  .order('joinedAt', { ascending: false })
  .limit(1);
const existing = existingRows && existingRows[0];
if (existing && existing.status !== 'rejected') {
  return { ok: false, message: 'You have already joined this package.' };
}

    const locks = pkg.locks || [];
    const totalProducts = (pkg.products || []).length;
    const initialUnlocked = locks.length ? locks[0].afterReview : totalProducts;

    const record = {
      userId: uid,
      userEmail: email,
      packageId: pkg.id,
      packageName: pkg.name,
      price: pkg.price,
      status: 'pending_payment',
      reviewsCompleted: 0,
      totalProducts,
      unlockedCount: initialUnlocked,
      note: note || '',
      joinedAt: new Date().toISOString()
    };

    const { data, error } = await supabase.from('user_packages').insert([record]).select().single();
    if (error) throw error;

    try {
      await supabase.from('activity').insert([{
        type: 'package_joined',
        message: `${email} joined package "${pkg.name}"`,
        meta: { email, packageId: pkg.id },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }

    notifyAllAdminsPkg('package_joined', 'New package join', `${email} joined package "${pkg.name}" — awaiting payment.`, { email, packageId: pkg.id });

    return { ok: true, id: data.id };
  } catch (e) {
    console.error("Error joining package:", e);
    return { ok: false, message: e.message || 'Could not join package.' };
  }
}

// 9. Payment proof file Supabase Storage me upload karein aur record update karein
async function uploadPaymentProof(uid, userPackageId, file) {
  try {
    if (!file) return { ok: false, message: 'No file selected.' };

    const path = `${uid}/${userPackageId}-${Date.now()}-${file.name}`;
    const { error: uploadErr } = await supabase.storage
      .from('payment-proofs')
      .upload(path, file, { upsert: true });
    if (uploadErr) throw uploadErr;

    const { data: pub } = supabase.storage.from('payment-proofs').getPublicUrl(path);
    const publicUrl = pub ? pub.publicUrl : '';

    const { error: updateErr } = await supabase
      .from('user_packages')
      .update({ paymentProofUrl: publicUrl, status: 'pending_verification' })
      .eq('id', userPackageId)
      .eq('userId', uid);
    if (updateErr) throw updateErr;

    try {
      await supabase.from('activity').insert([{
        type: 'payment_proof_uploaded',
        message: `Payment proof uploaded for user package #${userPackageId}`,
        meta: { userId: uid, userPackageId },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }

    notifyAllAdminsPkg('payment_proof_uploaded', 'Payment proof uploaded', `A client uploaded payment proof for package #${userPackageId}. Please verify.`, { userId: uid, userPackageId });

    return { ok: true, message: 'Payment proof uploaded. Waiting for admin verification.' };
  } catch (e) {
    console.error("Error uploading payment proof:", e);
    return { ok: false, message: e.message || 'Upload failed.' };
  }
}

// ============================================================
// ADMIN: SUBSCRIPTIONS MANAGEMENT (user_packages table, admin-wide)
// ============================================================

// 10. Admin ke liye TAMAM users ke packages laayein (har user ka nahi, sab ka)
async function getAllUserPackages() {
  const { data, error } = await supabase
    .from('user_packages')
    .select('*')
    .order('joinedAt', { ascending: false });

  if (error) {
    console.error('Error fetching all user packages:', error);
    return [];
  }
  return data || [];
}

// 11. Kisi subscription ka status seedha set karein (deactivate / reactivate / activate)
async function adminSetUserPackageStatus(userPackageId, status) {
  try {
    await supabase.from('user_packages').update({ status }).eq('id', userPackageId);
    try {
      const { data: up } = await supabase.from('user_packages').select('userId,userEmail,packageName').eq('id', userPackageId).maybeSingle();
      if (up) {
        await supabase.from('activity').insert([{
          type: 'subscription_status_changed',
          message: `${up.userEmail}'s subscription "${up.packageName}" set to ${status}`,
          meta: { email: up.userEmail, status },
          time: new Date().toISOString()
        }]);

        if (status === 'active') {
          notifyUserPkg(up.userId, 'package_activated', 'Package activated', `Your package "${up.packageName}" has been activated. You can start reviewing!`);
        } else if (status === 'deactivated') {
          notifyUserPkg(up.userId, 'package_deactivated', 'Package deactivated', `Your package "${up.packageName}" has been deactivated by support.`);
        } else if (status === 'rejected') {
          notifyUserPkg(up.userId, 'package_rejected', 'Package join rejected', `Your request to join "${up.packageName}" was rejected. Please contact support.`);
        }
      }
    } catch (e) { /* non-fatal */ }
    return { ok: true };
  } catch (e) {
    console.error('adminSetUserPackageStatus failed:', e);
    return { ok: false, message: e.message || 'Could not update subscription.' };
  }
}

// 12. Payment verify karke subscription active karein (pending_payment / pending_verification -> active)
async function adminVerifyUserPackage(userPackageId) {
  return adminSetUserPackageStatus(userPackageId, 'active');
}

// 13. Cap bypass karein — user ab package ke sab products review kar sakta hai, bina deposit ke lock ke
async function adminBypassCap(userPackageId) {
  try {
    const { data: up, error } = await supabase.from('user_packages').select('*').eq('id', userPackageId).maybeSingle();
    if (error || !up) return { ok: false, message: 'Subscription not found.' };
    const total = up.totalProducts || 0;
    await supabase.from('user_packages').update({ unlockedCount: total, capBypassed: true }).eq('id', userPackageId);
    try {
      await supabase.from('activity').insert([{
        type: 'subscription_cap_bypassed',
        message: `Admin bypassed the review cap for ${up.userEmail} on "${up.packageName}"`,
        meta: { email: up.userEmail },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }
    notifyUserPkg(up.userId, 'products_unlocked', 'All products unlocked', `Admin has unlocked all remaining products in "${up.packageName}" for you.`);
    return { ok: true, unlockedCount: total };
  } catch (e) {
    console.error('adminBypassCap failed:', e);
    return { ok: false, message: e.message || 'Could not bypass cap.' };
  }
}

async function adminGrantTopup(userPackageId, opts) {
  const options = opts || {};
  try {
    const { data: up, error: fetchErr } = await supabase
      .from('user_packages')
      .select('*, packages(*)')
      .eq('id', userPackageId)
      .single();

    if (fetchErr || !up) throw new Error('User package not found');

    const pkg = up.packages;
    const currentUnlocked = Number(up.unlockedCount || 0);
    const totalProducts = Number(up.totalProducts || (pkg?.products?.length || 0));

    const nextLock = findNextLock(pkg, currentUnlocked);
    
    let newUnlockedCount = totalProducts;
    if (nextLock && nextLock.afterIndex > currentUnlocked) {
      newUnlockedCount = nextLock.afterIndex;
    } else {
      const sorted = (pkg?.locks || []).sort((a, b) => a.afterIndex - b.afterIndex);
      const nextInLine = sorted.find(l => l.afterIndex > currentUnlocked);
      if (nextInLine) {
        newUnlockedCount = nextInLine.afterIndex;
      }
    }

    const { error: updateErr } = await supabase
      .from('user_packages')
      .update({
        unlockedCount: newUnlockedCount,
        status: 'active'
      })
      .eq('id', userPackageId);

    if (updateErr) throw updateErr;

    // "silent" is passed when this is called as part of a deposit-approval flow,
    // which sends its own more specific "Top-up approved" notification instead.
    if (!options.silent) {
      notifyUserPkg(up.userId, 'products_unlocked', 'More products unlocked', 'Admin granted your top-up. You can continue reviewing.');
    }

    return { ok: true, newUnlockedCount };
  } catch (err) {
    console.error('adminGrantTopup error:', err);
    return { ok: false, message: err.message };
  }
}
// ============================================================
// PACKAGE DEPOSITS ("next tier unlock" flow — NEW)
// Client deposits money for the next lock tier + uploads proof.
// Admin approves it in the Payments tab -> next products unlock.
// ============================================================

// 15. Client submits a deposit + payment screenshot to unlock the next lock tier
async function requestPackageDeposit(uid, email, userPackageId, packageId, amount, file) {
  try {
    if (!file) return { ok: false, message: 'No file selected.' };
    if (!amount || amount <= 0) return { ok: false, message: 'Invalid deposit amount.' };

    const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${uid}/${userPackageId}-deposit-${Date.now()}-${safeName}`;
    const { error: uploadErr } = await supabase.storage
      .from('payment-proofs')
      .upload(path, file, { upsert: true });
    if (uploadErr) throw uploadErr;

    const { data: pub } = supabase.storage.from('payment-proofs').getPublicUrl(path);
    const publicUrl = pub ? pub.publicUrl : '';

    const record = {
      user_package_id: userPackageId,
      user_id: uid,
      user_email: email,
      package_id: packageId,
      amount,
      proof_url: publicUrl,
      status: 'pending',
      requested_at: new Date().toISOString()
    };

    const { data, error } = await supabase.from('package_deposits').insert([record]).select().single();
    if (error) throw error;

    try {
      await supabase.from('activity').insert([{
        type: 'deposit_requested',
        message: `${email} requested a deposit of $${Number(amount).toFixed(2)} to unlock the next products`,
        meta: { email, userPackageId },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }

    notifyAllAdminsPkg('deposit_requested', 'New deposit request', `${email} requested a deposit of $${Number(amount).toFixed(2)} to unlock the next products.`, { email, userPackageId });

    return { ok: true, id: data.id, message: 'Deposit submitted. Waiting for admin verification.' };
  } catch (e) {
    console.error('requestPackageDeposit failed:', e);
    return { ok: false, message: e.message || 'Could not submit deposit.' };
  }
}

// 16. Logged-in client's own deposit requests (used to show "pending verification" state)
async function getMyPackageDeposits(uid) {
  const { data } = await supabase
    .from('package_deposits')
    .select('*')
    .eq('user_id', uid)
    .order('requested_at', { ascending: false });
  return data || [];
}

// 17. Admin: every deposit request across all users (for the Payments tab)
async function getAllPackageDeposits() {
  const { data } = await supabase
    .from('package_deposits')
    .select('*')
    .order('requested_at', { ascending: false });
  return data || [];
}

// 18. Admin approves/rejects a deposit. Approve => actually unlock next tier via adminGrantTopup.
async function adminDecidePackageDeposit(depositId, decision) {
  try {
    const { data: dep, error } = await supabase.from('package_deposits').select('*').eq('id', depositId).maybeSingle();
    if (error || !dep) return { ok: false, message: 'Deposit request not found.' };
    if (dep.status !== 'pending') return { ok: true, alreadyDone: true };

    await supabase.from('package_deposits')
      .update({ status: decision, decided_at: new Date().toISOString() })
      .eq('id', depositId);

    if (decision === 'approved') {
      const unlockResult = await adminGrantTopup(dep.user_package_id, { silent: true });
      notifyUserPkg(dep.user_id, 'topup_approved', 'Top-up approved', `$${Number(dep.amount || 0).toFixed(2)} top-up approved. More products unlocked.`);
      try {
        await supabase.from('activity').insert([{
          type: 'deposit_approved',
          message: `Deposit of $${Number(dep.amount || 0).toFixed(2)} approved for ${dep.user_email} — next products unlocked`,
          meta: { email: dep.user_email },
          time: new Date().toISOString()
        }]);
      } catch (e) { /* non-fatal */ }
      return unlockResult && unlockResult.ok === false ? unlockResult : { ok: true };
    }

    notifyUserPkg(dep.user_id, 'deposit_rejected', 'Deposit rejected', `Your deposit request of $${Number(dep.amount || 0).toFixed(2)} was rejected. Please contact support.`);
    try {
      await supabase.from('activity').insert([{
        type: 'deposit_rejected',
        message: `Deposit request of $${Number(dep.amount || 0).toFixed(2)} rejected for ${dep.user_email}`,
        meta: { email: dep.user_email },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }
    return { ok: true };
  } catch (e) {
    console.error('adminDecidePackageDeposit failed:', e);
    return { ok: false, message: e.message || 'Could not update deposit request.' };
  }
}

// ============================================================
// REVIEWS (reviews table) — client submits, admin approves/rejects/asks rewrite
// ============================================================

// Recompute a user_package's reviewsCompleted (submitted, not counting ones sent back
// for rewrite) and flip it to "completed" once every product has an approved review.
async function recalcUserPackageProgress(userPackageId) {
  try {
    const { data: reviews } = await supabase.from('reviews').select('status').eq('userPackageId', userPackageId);
    const list = reviews || [];
    const reviewsCompleted = list.filter(r => r.status !== 'rewrite').length;
    const approvedCount = list.filter(r => r.status === 'approved').length;

    const { data: up } = await supabase.from('user_packages').select('totalProducts,status').eq('id', userPackageId).maybeSingle();
    const updates = { reviewsCompleted };
    if (up && up.totalProducts && approvedCount >= up.totalProducts && up.status !== 'deactivated') {
      updates.status = 'completed';
    }
    await supabase.from('user_packages').update(updates).eq('id', userPackageId);
  } catch (e) {
    console.error('recalcUserPackageProgress failed:', e);
  }
}

// 15. Client ek product ke liye review submit (ya rewrite ke baad resubmit) karta hai
async function submitReview(payload) {
  try {
    const {
      uid, userEmail, userName, userPackageId, packageId, packageName,
      productIndex, productName, productImage, commission, rating, reviewText
    } = payload;

    if (!rating || rating < 1 || rating > 5) return { ok: false, message: 'Please choose a star rating.' };

    const { data: existing } = await supabase
      .from('reviews')
      .select('id,status')
      .eq('userPackageId', userPackageId)
      .eq('productIndex', productIndex)
      .maybeSingle();

    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      return { ok: false, message: 'This product already has a review submitted.' };
    }

    const record = {
      userId: uid,
      userEmail,
      userName,
      userPackageId,
      packageId,
      packageName,
      productIndex,
      productName,
      productImage: productImage || '',
      commission: commission || 0,
      rating,
      reviewText: reviewText || '',
      status: 'pending',
      submittedAt: new Date().toISOString()
    };

  if (existing && existing.id) {
  const { error: updateErr } = await supabase.from('reviews').update(record).eq('id', existing.id);
  if (updateErr) throw updateErr;
} else {
  const { error: insertErr } = await supabase.from('reviews').insert([record]);
  if (insertErr) throw insertErr;
}

    await recalcUserPackageProgress(userPackageId);

    try {
      await supabase.from('activity').insert([{
        type: 'review_submitted',
        message: `${userName} submitted a review for "${productName}"`,
        meta: { email: userEmail, packageId },
        time: new Date().toISOString()
      }]);
    } catch (e) { /* non-fatal */ }

    notifyAllAdminsPkg('review_submitted', 'New review submitted', `${userName} submitted a review for "${productName}".`, { email: userEmail, packageId });

    return { ok: true };
  } catch (e) {
    console.error('submitReview failed:', e);
    return { ok: false, message: e.message || 'Could not submit review.' };
  }
}

// 16. Ek specific user_package ke sab reviews laayein (client-side product list ke liye)
async function getReviewsForUserPackage(userPackageId) {
  const { data } = await supabase.from('reviews').select('*').eq('userPackageId', userPackageId);
  return data || [];
}

// 17. Login client ke apne sab reviews (har package milaakar) — Reviews tab ke liye
async function getMyReviews(uid) {
  const { data } = await supabase.from('reviews').select('*').eq('userId', uid).order('submittedAt', { ascending: false });
  return data || [];
}

// 18. Admin ke liye TAMAM reviews (Received Reviews tab)
async function getAllReviews() {
  const { data } = await supabase.from('reviews').select('*').order('submittedAt', { ascending: false });
  return data || [];
}

// 19. Admin: approve / reject / rewrite — commission sirf approve par credit hota hai
async function adminDecideReview(reviewId, decision) {
  try {
    const { data: review, error } = await supabase.from('reviews').select('*').eq('id', reviewId).maybeSingle();
    if (error || !review) return { ok: false, message: 'Review not found.' };
    if (review.status === decision) return { ok: true, alreadyDone: true };

    await supabase.from('reviews').update({ status: decision, decidedAt: new Date().toISOString() }).eq('id', reviewId);

    if (decision === 'approved') {
      const { data: userData } = await supabase.from('users').select('balance').eq('id', review.userId).maybeSingle();
      const newBalance = (userData ? (userData.balance || 0) : 0) + Number(review.commission || 0);
      await supabase.from('users').update({ balance: newBalance }).eq('id', review.userId);

      try {
        await supabase.from('activity').insert([{
          type: 'review_approved',
          message: `Review for "${review.productName}" approved — $${Number(review.commission || 0).toFixed(2)} credited to ${review.userEmail}`,
          meta: { email: review.userEmail },
          time: new Date().toISOString()
        }]);
      } catch (e) { /* non-fatal */ }

      notifyUserPkg(review.userId, 'review_approved', 'Review approved', `Your review for product #${review.productIndex + 1} was approved. $${Number(review.commission || 0).toFixed(2)} commission has been credited.`);
    } else if (decision === 'rejected') {
      try {
        await supabase.from('activity').insert([{
          type: 'review_rejected',
          message: `Review for "${review.productName}" rejected for ${review.userEmail}`,
          meta: { email: review.userEmail },
          time: new Date().toISOString()
        }]);
      } catch (e) { /* non-fatal */ }
      notifyUserPkg(review.userId, 'review_rejected', 'Review rejected', `Your review for product #${review.productIndex + 1} was rejected. You may resubmit.`);
    } else if (decision === 'rewrite') {
      try {
        await supabase.from('activity').insert([{
          type: 'review_rewrite_requested',
          message: `Rewrite requested for "${review.productName}" from ${review.userEmail}`,
          meta: { email: review.userEmail },
          time: new Date().toISOString()
        }]);
      } catch (e) { /* non-fatal */ }
      notifyUserPkg(review.userId, 'review_rewrite', 'Rewrite requested', `Please rewrite your review for product #${review.productIndex + 1} and resubmit.`);
    }

    await recalcUserPackageProgress(review.userPackageId);
    return { ok: true };
  } catch (e) {
    console.error('adminDecideReview failed:', e);
    return { ok: false, message: e.message || 'Could not update review.' };
  }
}

// 20. Bulk approve/reject/rewrite — admin selects multiple rows and applies one action
async function adminBulkDecideReviews(reviewIds, decision) {
  const results = await Promise.all((reviewIds || []).map(id => adminDecideReview(id, decision)));
  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, failedCount: failed.length };
}

// Client Dashboard helpers
export const SogoPackages = {
  getPackages: window.getPackages,
  deletePackage: window.deletePackage,
  getUserPackages,
  joinPackage,
  uploadPaymentProof,
  getAllUserPackages,
  adminSetUserPackageStatus,
  adminVerifyUserPackage,
  adminBypassCap,
  adminGrantTopup,
  requestPackageDeposit,
  getMyPackageDeposits,
  getAllPackageDeposits,
  adminDecidePackageDeposit,
  submitReview,
  getReviewsForUserPackage,
  getMyReviews,
  getAllReviews,
  adminDecideReview,
  adminBulkDecideReviews
};
window.SogoPackages = SogoPackages;
