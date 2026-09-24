/* SOGO REVIEWS — Packages Management Logic (Supabase Version) */

import { supabase } from "./supabase-config.js";

// 1. Dynamic Product Rows Generate Karein
window.generateProductRows = function() {
  const count = parseInt(document.getElementById('pkg-count').value) || 0;
  const container = document.getElementById('builder-product-rows');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 1; i <= count; i++) {
    const div = document.createElement('div');
    div.className = 'product-row-builder';
    div.innerHTML = `
      <span style="font-weight: 700; color: var(--text-muted);">#${i}</span>
      <input type="text" class="form-input pkg-prod-name" placeholder="Product Name #${i}">
      <input type="number" class="form-input pkg-prod-comm" placeholder="Commission ($)" step="0.01">
      <input type="file" class="pkg-prod-img" accept="image/*">
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

// 4. Supabase me Package Create Karein
window.createPackageNow = async function() {
  const btn = document.getElementById('createPackageBtn');
  const msg = document.getElementById('createPackageMsg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }

  const name = document.getElementById('pkg-name').value.trim();
  const price = parseFloat(document.getElementById('pkg-price').value) || 0;
  const description = document.getElementById('pkg-description').value.trim();
  const totalComm = parseFloat(document.getElementById('pkg-total-comm').value) || 0;

  if (!name) {
    if (msg) { msg.style.display = 'block'; msg.style.color = '#dc2626'; msg.textContent = 'Package name is required.'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const prodRows = document.querySelectorAll('.product-row-builder');
    const products = [];
    prodRows.forEach((row, idx) => {
      const pName = row.querySelector('.pkg-prod-name').value.trim() || `Product #${idx + 1}`;
      const pComm = parseFloat(row.querySelector('.pkg-prod-comm').value) || 0;
      products.push({ id: idx + 1, name: pName, commission: pComm });
    });

    const lockAfters = document.querySelectorAll('.pkg-lock-after');
    const lockDeposits = document.querySelectorAll('.pkg-lock-deposit');
    const locks = [];
    lockAfters.forEach((input, idx) => {
      const after = parseInt(input.value) || 0;
      const deposit = parseFloat(lockDeposits[idx].value) || 0;
      if (after > 0) locks.push({ afterReview: after, depositRequired: deposit });
    });

    // Supabase Insert
    const { error } = await supabase.from('packages').insert([
      {
        name,
        price,
        description,
        totalCommission: totalComm,
        productCount: products.length,
        products,
        locks,
        published: true
      }
    ]);

    if (error) throw error;

    if (msg) {
      msg.style.display = 'block';
      msg.style.color = '#10b981';
      msg.textContent = 'Package created successfully!';
    }
    if (window.renderPackagesTab) window.renderPackagesTab();
  } catch (e) {
    console.error("Error creating package:", e);
    if (msg) {
      msg.style.display = 'block';
      msg.style.color = '#dc2626';
      msg.textContent = 'Failed to create package: ' + e.message;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create package';
  }
};

// 5. Supabase se Packages Fetch Karein
window.getPackages = async function(options) {
  const opts = options || {};
  let query = supabase.from('packages').select('*');
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
    if (window.renderPackagesTab) window.renderPackagesTab();
  }
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
    const { data: existing } = await supabase
      .from('user_packages')
      .select('id, status')
      .eq('userId', uid)
      .eq('packageId', packageId)
      .maybeSingle();
    if (existing && existing.status !== 'rejected') {
      return { ok: false, message: 'You have already joined this package.' };
    }

    const record = {
      userId: uid,
      userEmail: email,
      packageId: pkg.id,
      packageName: pkg.name,
      price: pkg.price,
      status: 'pending_payment',
      reviewsCompleted: 0,
      totalProducts: (pkg.products || []).length,
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

    return { ok: true, message: 'Payment proof uploaded. Waiting for admin verification.' };
  } catch (e) {
    console.error("Error uploading payment proof:", e);
    return { ok: false, message: e.message || 'Upload failed.' };
  }
}

// Client Dashboard helpers
export const SogoPackages = {
  getPackages: window.getPackages,
  deletePackage: window.deletePackage,
  getUserPackages,
  joinPackage,
  uploadPaymentProof
};
window.SogoPackages = SogoPackages;