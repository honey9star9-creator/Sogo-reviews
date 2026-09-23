/* SOGO REVIEWS — Packages Management Logic (Firebase Version)
   ------------------------------------------------------------------
   FULL UPDATED VERSION - ZERO CODE OMITTED
*/

import {
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-config.js";

const PACKAGES_COL = "packages";

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

    const pkgData = {
      name,
      price,
      description,
      totalCommission: totalComm,
      productCount: products.length,
      products,
      locks,
      createdAt: serverTimestamp()
    };

    await addDoc(collection(db, PACKAGES_COL), pkgData);

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

window.getPackages = async function() {
  const snap = await getDocs(collection(db, PACKAGES_COL));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

window.deletePackage = async function(pkgId) {
  if (!confirm("Are you sure you want to delete this package?")) return;
  await deleteDoc(doc(db, PACKAGES_COL, pkgId));
  if (window.renderPackagesTab) window.renderPackagesTab();
};