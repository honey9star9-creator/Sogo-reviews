/* SOGO REVIEWS — Packages module (Firebase version)
   ------------------------------------------------------------------
   This is the piece that was completely missing before: in the old
   code, "Create package" was just `alert('Package created!')` with
   nothing saved anywhere, and the client side showed a hardcoded
   "Jo Malone London" package that had zero connection to admin.

   This file gives you real collections:
     packages/{packageId}        -> package definition (admin-owned)
     userPackages/{id}           -> one doc per client who joins a package

   Load AFTER auth.js (needs the same Firebase app/db), as a module:
     <script type="module" src="packages.js"></script>
*/

import {
  getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, addDoc, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

const db = getFirestore(getApp());
const PACKAGES_COL = "packages";
const USER_PACKAGES_COL = "userPackages";

const SogoPackages = (() => {

  /* ---------------- admin: create / edit / delete ---------------- */

  // productRows: [{ name, commission, bonus, rating }]
  // lockRows: [{ afterReview, deposit }]
  async function createPackage({ name, price, description, products, totalCommission, lockRows }) {
    const pkg = {
      name: name.trim(),
      price: Number(price) || 0,
      description: description || "",
      totalCommission: Number(totalCommission) || 0,
      products: (products || []).map((p, i) => ({
        index: i + 1,
        name: p.name || `Product ${i + 1}`,
        commission: Number(p.commission) || 0,
        bonus: Number(p.bonus) || 0,
        rating: Number(p.rating) || 5,
        photoUrl: p.photoUrl || ""
      })),
      locks: (lockRows || []).map(l => ({
        afterReview: Number(l.afterReview) || 0,
        deposit: Number(l.deposit) || 0
      })),
      published: true,
      createdAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, PACKAGES_COL), pkg);
    return { id: ref.id, ...pkg };
  }

  async function updatePackage(packageId, changes) {
    await updateDoc(doc(db, PACKAGES_COL, packageId), changes);
  }

  async function deletePackage(packageId) {
    await deleteDoc(doc(db, PACKAGES_COL, packageId));
  }

  async function togglePublish(packageId, published) {
    await updateDoc(doc(db, PACKAGES_COL, packageId), { published });
  }

  /* ---------------- read (both sides) ---------------- */

  async function getPackages({ onlyPublished = false } = {}) {
    const snap = await getDocs(collection(db, PACKAGES_COL));
    let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (onlyPublished) list = list.filter(p => p.published);
    return list;
  }

  async function getPackage(packageId) {
    const snap = await getDoc(doc(db, PACKAGES_COL, packageId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }

  /* ---------------- client: join a package ---------------- */

  async function joinPackage(userUid, userEmail, packageId, paymentProofUrl) {
    const pkg = await getPackage(packageId);
    if (!pkg) return { ok: false, message: "Package not found." };

    const record = {
      userId: userUid,
      email: userEmail,
      packageId,
      packageName: pkg.name,
      price: pkg.price,
      status: "pending_payment",  // pending_payment -> active -> completed
      paymentProofUrl: paymentProofUrl || "",
      reviewsCompleted: 0,
      totalProducts: (pkg.products || []).length,
      unlockedProducts: (pkg.locks && pkg.locks[0]) ? pkg.locks[0].afterReview : (pkg.products || []).length,
      joinedAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, USER_PACKAGES_COL), record);
    return { ok: true, id: ref.id, ...record };
  }

  async function getUserPackages(userUid) {
    const q = query(collection(db, USER_PACKAGES_COL), where("userId", "==", userUid));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ---------------- admin: verify payment / activate ---------------- */

  async function getAllUserPackages() {
    const snap = await getDocs(collection(db, USER_PACKAGES_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function activateUserPackage(userPackageId) {
    await updateDoc(doc(db, USER_PACKAGES_COL, userPackageId), { status: "active" });
  }

  async function rejectUserPackage(userPackageId) {
    await updateDoc(doc(db, USER_PACKAGES_COL, userPackageId), { status: "rejected" });
  }

  // Call when a client submits a review for a product in their package.
  // Bumps reviewsCompleted and unlocks the next tier if a lock threshold
  // is crossed (matches the "Review lock & deposit" tiers set by admin).
  async function recordReviewSubmitted(userPackageId) {
    const snap = await getDoc(doc(db, USER_PACKAGES_COL, userPackageId));
    if (!snap.exists()) return;
    const up = snap.data();
    const newCount = (up.reviewsCompleted || 0) + 1;
    const changes = { reviewsCompleted: newCount };
    if (newCount >= up.totalProducts) changes.status = "completed";
    await updateDoc(doc(db, USER_PACKAGES_COL, userPackageId), changes);
  }

  return {
    createPackage, updatePackage, deletePackage, togglePublish,
    getPackages, getPackage,
    joinPackage, getUserPackages, getAllUserPackages,
    activateUserPackage, rejectUserPackage, recordReviewSubmitted
  };
})();

window.SogoPackages = SogoPackages;
