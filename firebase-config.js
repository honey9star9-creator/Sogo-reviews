import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
// ============================================================
// SOGO REVIEWS — Firebase Project Configuration
// ============================================================
// Firebase Console -> Project Settings -> General -> "Your apps"
// -> Web app (</>) -> yahan se config copy karke neeche paste karein.
//
// Agar abhi Firebase project nahi banaya, steps:
// 1. https://console.firebase.google.com kholein
// 2. "Add project" -> naam den (e.g. sogo-reviews) -> continue
// 3. Left menu -> Build -> Authentication -> Get started ->
//    "Email/Password" provider ko Enable karein
// 4. Left menu -> Build -> Firestore Database -> Create database ->
//    "Start in production mode" (rules neeche di gayi hain) ->
//    region choose karein (jo aapke users ke qareeb ho)
// 5. Project Settings (gear icon) -> General -> scroll down to
//    "Your apps" -> Web icon (</>) -> app register karein ->
//    config object copy karein aur neeche paste karein
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyAnRvEjCBtJ6makOpL1swXwadU7I3_f-8k",
  authDomain: "sogo-reviews-32cf0.firebaseapp.com",
  projectId: "sogo-reviews-32cf0",
  storageBucket: "sogo-reviews-32cf0.firebasestorage.app",
  messagingSenderId: "689206575129",
  appId: "1:689206575129:web:4e9eca780ad01d6316ea88"
};
// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Export Firestore & Auth Helpers
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
// FIRESTORE SECURITY RULES — ye rules Firebase Console ->
// Firestore Database -> Rules tab mein paste karein (default rules
// se replace karke "Publish" dabayein). In rules ke bina koi bhi
// user seedha database se sabka data parh/badal sakta hai.
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
