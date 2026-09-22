# SOGO REVIEWS — Firebase Migration (Step 1)

Ye files aapke purane `auth.js` ki jagah lengi, jo **localStorage** ki jagah
ek real **Firebase backend** (Authentication + Firestore database) use
karti hain — isliye admin aur client, chahe alag browser/device/incognito
mein hon, ek hi real data dekhenge.

## Naye/updated files (is message mein diye gaye)
- `firebase-config.js` — aapke Firebase project ki keys yahan jayengi
- `auth.js` — purana localStorage wala auth.js replace karega (login, signup,
  users, chat — ab realtime, withdrawals, top-ups, password resets)
- `packages.js` — **naya** module: packages ka real create/edit/delete
  (admin) aur join/track (client) — purane code mein ye tha hi nahi
- `auth.html` — updated example dikhata hai ke sync code ko async mein
  kaise convert karna hai (login/signup/reset)

## Step-by-step setup

1. **Firebase project banayein**
   [console.firebase.google.com](https://console.firebase.google.com) →
   "Add project" → naam dein → continue.

2. **Authentication enable karein**
   Left menu → Build → Authentication → "Get started" → Sign-in method tab
   → **Email/Password** ko enable karein.

3. **Firestore Database banayein**
   Left menu → Build → Firestore Database → "Create database" → **Start in
   production mode** → apne users ke qareeb wala region choose karein.

4. **Security rules paste karein**
   Firestore → Rules tab → `firebase-config.js` ke aakhir mein jo rules
   comment mein diye hain wo paste karein → Publish. (Ye rules ke bina koi
   bhi browser se seedha sab ka data parh/badal sakta hai.)

5. **Web app register karein aur config copy karein**
   Project Settings (gear icon) → General → "Your apps" → Web icon (`</>`)
   → app register karein → mila config object `firebase-config.js` mein
   paste karein (apiKey, authDomain, projectId, waghera).

6. **Pehla admin account banayein**
   Browser console mein (ya ek temporary button laga kar) ek dafa ye chalayein:
   ```js
   import { SogoAuth } from "./auth.js"; // ya window.SogoAuth agar module load ho chuka
   await SogoAuth.seedDefaultAdminOnce("Vitto@gmail.com", "Vitto123", "Admin");
   ```
   Ye Firebase Auth mein account banayega aur Firestore mein role: "admin"
   wali profile save karega. Iske baad `auth.html` se normal login karein.

7. **`auth.html` ko replace karein** — attached version already updated hai
   (async calls + `type="module"` script tag).

## Ab bhi pending (Step 2 — agle message mein)

`client-dashboard.html` aur `master-admin.html` abhi bhi purane
**synchronous** `SogoAuth.xxx()` calls use kar rahe hain (localStorage
wale). Firebase version async hai, isliye in dono files ke har function
mein `await` add karna hoga — jaisa `auth.html` mein dikhaya gaya hai.
Saath hi:

- **Packages tab (admin)**: "Create package" button ko real form data ke
  saath `SogoPackages.createPackage(...)` call karna, aur neeche list ko
  `SogoPackages.getPackages()` se render karna (hardcoded "Jo Malone
  London" card hatana).
- **Packages tab (client)**: Hardcoded package HTML hatakar
  `SogoPackages.getPackages({ onlyPublished: true })` se render karna,
  aur "Select package" par `SogoPackages.joinPackage(...)` call karna.
- **Chat**: `listenChatThread()` (realtime) use karna taake polling
  (`setInterval`) ki zaroorat na rahe — turant deliver hoga.
- **Notification bell**: client dashboard mein bell icon ko
  `getUnreadMessageCount()`-jaisi cheez se wire karna (filhal koi aisa
  function nahi hai, packages ke saath add kar denge).

Bata dein jab is Step 1 ko apne Firebase project pe try kar lein, phir main
client-dashboard.html aur master-admin.html dono ko poori tarah in naye
async + packages functions ke sath rewire kar deta hoon.
