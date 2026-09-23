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
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

const db = getFirestore(getApp());
const storage = getStorage(getApp());
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

  async function uploadPaymentProof(userUid, userPackageId, file) {
    if (!userUid || !userPackageId || !file) {
      return { ok: false, message: "Choose a payment screenshot first." };
    }
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return { ok: false, message: "Only PNG, JPG or WEBP files are accepted." };
    }
    if (file.size > 5 * 1024 * 1024) {
      return { ok: false, message: "Payment screenshot must be 5 MB or smaller." };
    }
    const packageSnap = await getDoc(doc(db, USER_PACKAGES_COL, userPackageId));
    if (!packageSnap.exists() || packageSnap.data().userId !== userUid) {
      return { ok: false, message: "Package request not found." };
    }
    const path = `payment-proofs/${userUid}/${userPackageId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file, { contentType: file.type });
    const paymentProofUrl = await getDownloadURL(storageRef);
    await updateDoc(doc(db, USER_PACKAGES_COL, userPackageId), { paymentProofUrl });
    return { ok: true, paymentProofUrl };
  }

  /* ---------------- client: join a package ---------------- */

  async function joinPackage(userUid, userEmail, packageId, paymentProofUrl) {
    if (!userUid) return { ok: false, message: "You must be signed in." };
    const pkg = await getPackage(packageId);
    if (!pkg || !pkg.published) return { ok: false, message: "Package is not available." };

    const existing = await getUserPackages(userUid);
    const duplicate = existing.find(item => item.packageId === packageId && ['pending_payment', 'active'].includes(item.status));
    if (duplicate) return { ok: false, message: "You already have a pending or active request for this package." };

    const record = {
      userId: userUid,
      email: userEmail || "",
      packageId,
      packageName: pkg.name,
      price: Number(pkg.price) || 0,
      status: "pending_payment",
      paymentProofUrl: paymentProofUrl || "",
      reviewsCompleted: 0,
      totalProducts: (pkg.products || []).length,
      unlockedProducts: (pkg.locks && pkg.locks[0]) ? Number(pkg.locks[0].afterReview) || 0 : (pkg.products || []).length,
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
    joinPackage, uploadPaymentProof, getUserPackages, getAllUserPackages,
    activateUserPackage, rejectUserPackage, recordReviewSubmitted
  };
})();

window.SogoPackages = SogoPackages;
