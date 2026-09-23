import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyC3iwdTJnX8nDuaQgxZrqWqYTZOyqSkzCQ",
  authDomain: "sogo-reviews-32cf0.firebaseapp.com",
  projectId: "sogo-reviews-32cf0",
  storageBucket: "sogo-reviews-32cf0.firebasestorage.app",
  messagingSenderId: "689206575129",
  appId: "1:689206575129:web:4e9eca780ad01d6316ea88"
};

// Initialize Firebase — this is the ONLY place initializeApp() should be
// called for the primary app. auth.js and packages.js import `auth`/`db`
// from here instead of calling initializeApp() again (calling it twice
// on the default app crashes with "app/duplicate-app").
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  onAuthStateChanged,
  signOut,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  orderBy
};

// ============================================================
// FIRESTORE SECURITY RULES — already published by you, unchanged here.
// ============================================================
/*
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function isOwner(uid) { return isSignedIn() && request.auth.uid == uid; }
    function isAdmin() {
      return isSignedIn() &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    match /users/{uid} {
      allow read: if isOwner(uid) || isAdmin();
      allow create: if isSignedIn();
      allow update: if isOwner(uid) || isAdmin();
      allow delete: if isAdmin();
    }

    match /inviteCodes/{code} {
      allow read: if true;
      allow write: if isSignedIn();
    }

    match /packages/{pkgId} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }

    match /userPackages/{docId} {
      allow read: if isSignedIn() && (resource.data.userId == request.auth.uid || isAdmin());
      allow create: if isSignedIn() && request.resource.data.userId == request.auth.uid;
      allow update: if isAdmin() || (isSignedIn() && resource.data.userId == request.auth.uid);
    }

    match /chats/{userId}/messages/{msgId} {
      allow read: if isOwner(userId) || isAdmin();
      allow create: if isOwner(userId) || isAdmin();
      allow update: if isAdmin();
    }

    match /withdrawals/{docId} {
      allow read: if isSignedIn() && (resource.data.userId == request.auth.uid || isAdmin());
      allow create: if isSignedIn() && request.resource.data.userId == request.auth.uid;
      allow update: if isAdmin();
    }

    match /topups/{docId} {
      allow read: if isSignedIn() && (resource.data.userId == request.auth.uid || isAdmin());
      allow create: if isSignedIn() && request.resource.data.userId == request.auth.uid;
      allow update: if isAdmin();
    }

    match /passwordRequests/{docId} {
      allow read: if isAdmin();
      allow create: if true;
      allow update: if isAdmin();
    }

    match /activity/{docId} {
      allow read: if isAdmin();
      allow create: if isSignedIn();
    }
  }
}
*/
