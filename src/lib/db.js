import { createClient } from "@supabase/supabase-js";
import { DEFAULT_RULES } from "./constants.js";
import { MOCK_MEMBERS, MOCK_RULES, MOCK_HOLIDAYS, MOCK_PAIRS } from "./mockData.js";

const MOCK_MODE = !import.meta.env.VITE_SUPABASE_URL;

// ── Mock Supabase client（無 .env 時使用）──────────────────────
function makeMockQuery(resolveData = []) {
  const q = {
    select:      () => q,
    eq:          () => q,
    order:       () => q,
    in:          () => q,
    delete:      () => q,
    update:      () => q,
    maybeSingle: () => Promise.resolve({ data: null,       error: null }),
    single:      () => Promise.resolve({ data: null,       error: null }),
    then: (ok, fail) => Promise.resolve({ data: resolveData, error: null }).then(ok, fail),
    catch: (fail)    => Promise.resolve({ data: resolveData, error: null }).catch(fail),
  };
  return q;
}

// Members query with email filter support (for currentUser lookup after mock login)
function makeMockMembersQuery(filterEmail = null) {
  const q = {
    select: () => q,
    eq: (col, val) => col === 'email' ? makeMockMembersQuery(val) : q,
    order: () => q,
    in: () => q,
    delete: () => q,
    update: () => q,
    maybeSingle: () => Promise.resolve({
      data: filterEmail ? (MOCK_MEMBERS.find(m => m.email === filterEmail) || null) : null,
      error: null,
    }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (ok, fail) => Promise.resolve({ data: MOCK_MEMBERS, error: null }).then(ok, fail),
    catch: (fail)    => Promise.resolve({ data: MOCK_MEMBERS, error: null }).catch(fail),
  };
  return q;
}

const MOCK_ADMIN_SESSION = { user: { email: 'admin@test.com', id: 'mock-admin' } };
let _mockAuthCb = null;

const mockSupabase = {
  auth: {
    // Auto-login as admin in mock mode
    getSession: () => Promise.resolve({ data: { session: MOCK_ADMIN_SESSION } }),
    onAuthStateChange: (cb) => {
      _mockAuthCb = cb;
      cb('SIGNED_IN', MOCK_ADMIN_SESSION);
      return { data: { subscription: { unsubscribe: () => { _mockAuthCb = null; } } } };
    },
    signInWithPassword: ({ email }) => {
      const session = { user: { email, id: 'mock-admin' } };
      if (_mockAuthCb) _mockAuthCb('SIGNED_IN', session);
      return Promise.resolve({ data: { session }, error: null });
    },
    signOut: () => {
      if (_mockAuthCb) _mockAuthCb('SIGNED_OUT', null);
      return Promise.resolve({});
    },
    signUp: () => Promise.resolve({ error: { message: '本機測試模式：請設定 .env 後才能使用' } }),
  },
  from: (table) => table === 'members' ? makeMockMembersQuery() : makeMockQuery(),
};

export const supabase = MOCK_MODE
  ? mockSupabase
  : createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

// ── Data fetchers ──────────────────────────────────────────────
export async function dbFetchMembers() {
  if (MOCK_MODE) return MOCK_MEMBERS;
  const { data, error } = await supabase.from("members").select("*").order("sort_order");
  if (error) throw error;
  return data;
}

export async function dbFetchSchedule(year, month) {
  if (MOCK_MODE) return { schedule: {}, lockedDays: new Set(), manualSchedule: {} };
  const { data, error } = await supabase
    .from("schedules").select("day, member_id, manually_set")
    .eq("year", year).eq("month", month);
  if (error) throw error;
  const schedule = {};
  const lockedDays = new Set();
  const manualSchedule = {};
  for (const row of data) {
    (schedule[row.day] = schedule[row.day] || []).push(row.member_id);
    if (row.manually_set) {
      lockedDays.add(row.day);
      (manualSchedule[row.day] = manualSchedule[row.day] || []).push(row.member_id);
    }
  }
  return { schedule, lockedDays, manualSchedule };
}

export async function dbFetchLeave(year, month) {
  if (MOCK_MODE) return {};
  const { data, error } = await supabase
    .from("leaves").select("day, member_id")
    .eq("year", year).eq("month", month);
  if (error) throw error;
  const result = {};
  for (const row of data) {
    if (!result[row.day]) result[row.day] = [];
    result[row.day].push(row.member_id);
  }
  return result;
}

export async function dbFetchHolidays(year) {
  if (MOCK_MODE) return MOCK_HOLIDAYS.filter(h => h.year === year);
  const { data, error } = await supabase
    .from("holidays").select("*").eq("year", year).order("month").order("day");
  if (error) throw error;
  return data;
}

export async function dbFetchRules() {
  if (MOCK_MODE) return MOCK_RULES;
  const { data, error } = await supabase.from("schedule_rules").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data || DEFAULT_RULES;
}

export async function dbFetchPairs() {
  if (MOCK_MODE) return MOCK_PAIRS;
  const { data, error } = await supabase.from("member_pairs").select("*");
  if (error) throw error;
  return data;
}
