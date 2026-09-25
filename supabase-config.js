import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Supabase project details
const SUPABASE_URL = "https://oeszlbocpmrvyoqybfpi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_9KgoUhOYC_IfGRwhEpbGHw_cn06ZytT";

// Initialize Supabase Client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Attach to window object for global script access
window.supabase = supabase;

// ===================================================
// HELPER FUNCTIONS FOR AUTHENTICATION & SESSION
// ===================================================

// Auth State Change listener
export const onAuthStateChanged = (callback) => {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(session ? session.user : null, session);
  });
};

// Sign Out function
export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

// Current logged in user lene ke liye helper
export const getCurrentUser = async () => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) return null;
  return user;
};
// ============================================================
// SUPABASE RLS (ROW LEVEL SECURITY) RULES EXPLANATION
// ============================================================
/*
Firestore Security Rules ki jagah Supabase me PostgreSQL Row Level Security (RLS) use hoti hai.
Aap apne Supabase SQL Editor me ye RLS Policies apply kar sakte hain:

1. USERS TABLE:
   - Enable RLS: ALTER TABLE users ENABLE ROW LEVEL SECURITY;
   - Read Policy: CREATE POLICY "Users read self or admin" ON users FOR SELECT USING (auth.uid() = id OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin');
   - Update Policy: CREATE POLICY "Users update own profile" ON users FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

2. PACKAGES TABLE:
   - Read Policy: CREATE POLICY "Anyone authenticated can read packages" ON packages FOR SELECT USING (auth.role() = 'authenticated');
   - Admin Write: CREATE POLICY "Only admin can edit packages" ON packages FOR ALL USING ((SELECT role FROM users WHERE id = auth.uid()) = 'admin');

3. USER PACKAGES TABLE:
   - Read Policy: CREATE POLICY "User can read own packages" ON user_packages FOR SELECT USING (auth.uid() = user_id OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin');
   - Insert Policy: CREATE POLICY "User can insert own packages" ON user_packages FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'pending_payment');

4. CHATS TABLE:
   - Read/Insert Policy: CREATE POLICY "User or admin access chat" ON chats FOR ALL USING (auth.uid() = user_id OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin');

5. WITHDRAWALS & TOPUPS TABLES:
   - Read/Insert Policy: CREATE POLICY "User view and create withdrawal" ON withdrawals FOR ALL USING (auth.uid() = user_id OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin');
   6. REVIEWS TABLE:
   - Enable RLS: ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
   - Policy: CREATE POLICY "Users manage own reviews" ON reviews FOR ALL USING (auth.uid() = "userId" OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin') WITH CHECK (auth.uid() = "userId" OR (SELECT role FROM users WHERE id = auth.uid()) = 'admin');
*/