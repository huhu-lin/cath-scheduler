import { DEFAULT_RULES } from "./constants.js";

// ── Storage keys ──────────────────────────────────────────────
const LS = {
  members:        'cath_members',
  schedules:      'cath_schedules',
  leaves:         'cath_leaves',
  holidays:       'cath_holidays',
  schedule_rules: 'cath_rules',
  member_pairs:   'cath_pairs',
  session:        'cath_session',
  adminPin:       'cath_admin_pin',
};

const DEFAULT_PIN = '1234';

// ── Helpers ───────────────────────────────────────────────────
function lsGet(table) {
  try {
    const raw = localStorage.getItem(LS[table]);
    if (raw === null) {
      return table === 'schedule_rules' ? { ...DEFAULT_RULES } : [];
    }
    return JSON.parse(raw);
  } catch {
    return table === 'schedule_rules' ? { ...DEFAULT_RULES } : [];
  }
}

function lsSet(table, data) {
  localStorage.setItem(LS[table], JSON.stringify(data));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

function matchesFilters(row, filters) {
  return filters.every(f => {
    if (f.op === 'eq') return row[f.field] === f.value;
    if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(row[f.field]);
    return true;
  });
}

// ── Auth ──────────────────────────────────────────────────────
let _authCbs = [];

function readSession() {
  try {
    const s = localStorage.getItem(LS.session);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

// ── Query builder ─────────────────────────────────────────────
function makeQuery(table) {
  const q = {
    _table: table,
    _op: 'select',
    _filters: [],
    _data: null,
    _returnMode: 'array',

    select() { return q; },
    eq(field, value) { q._filters.push({ op: 'eq', field, value }); return q; },
    in(field, value) { q._filters.push({ op: 'in', field, value }); return q; },
    order() { return q; },

    insert(data) { q._op = 'insert'; q._data = data; return q; },
    update(data) { q._op = 'update'; q._data = data; return q; },
    delete() { q._op = 'delete'; return q; },
    upsert(data) { q._op = 'upsert'; q._data = data; return q; },

    single() { q._returnMode = 'single'; return execQuery(q); },
    maybeSingle() { q._returnMode = 'maybe'; return execQuery(q); },

    then(res, rej) { return execQuery(q).then(res, rej); },
    catch(rej) { return execQuery(q).catch(rej); },
  };
  return q;
}

function execQuery(q) {
  try {
    const { _table, _op, _filters, _data, _returnMode } = q;

    if (_op === 'select') {
      let rows = lsGet(_table);
      if (!Array.isArray(rows)) rows = rows ? [rows] : [];
      const matches = rows.filter(r => matchesFilters(r, _filters));
      if (_returnMode === 'single' || _returnMode === 'maybe') {
        return Promise.resolve({ data: matches[0] ?? null, error: null });
      }
      return Promise.resolve({ data: matches, error: null });
    }

    if (_op === 'insert') {
      const items = Array.isArray(_data) ? _data : [_data];
      const saved = items.map(r => ({ ...r, id: r.id ?? genId() }));
      if (_table === 'schedule_rules') {
        lsSet(_table, saved[0]);
      } else {
        const existing = lsGet(_table);
        lsSet(_table, [...(Array.isArray(existing) ? existing : []), ...saved]);
      }
      if (_returnMode === 'single') return Promise.resolve({ data: saved[0], error: null });
      return Promise.resolve({ data: saved, error: null });
    }

    if (_op === 'update') {
      let rows = lsGet(_table);
      if (!Array.isArray(rows)) rows = [];
      lsSet(_table, rows.map(r => matchesFilters(r, _filters) ? { ...r, ..._data } : r));
      return Promise.resolve({ data: null, error: null });
    }

    if (_op === 'delete') {
      if (_table === 'schedule_rules') return Promise.resolve({ data: null, error: null });
      let rows = lsGet(_table);
      if (!Array.isArray(rows)) rows = [];
      lsSet(_table, rows.filter(r => !matchesFilters(r, _filters)));
      return Promise.resolve({ data: null, error: null });
    }

    if (_op === 'upsert') {
      if (_table === 'schedule_rules') {
        lsSet(_table, { ...lsGet(_table), ..._data });
      } else {
        let rows = lsGet(_table);
        if (!Array.isArray(rows)) rows = [];
        const idx = rows.findIndex(r => r.id === _data.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ..._data };
        else rows.push({ id: _data.id ?? genId(), ..._data });
        lsSet(_table, rows);
      }
      return Promise.resolve({ data: _data, error: null });
    }

    return Promise.resolve({ data: null, error: null });
  } catch (err) {
    return Promise.resolve({ data: null, error: { message: err.message } });
  }
}

// ── Supabase-compatible client ────────────────────────────────
export const supabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: readSession() } }),

    onAuthStateChange: (cb) => {
      _authCbs.push(cb);
      const session = readSession();
      if (session) setTimeout(() => cb('SIGNED_IN', session), 0);
      return {
        data: {
          subscription: {
            unsubscribe: () => { _authCbs = _authCbs.filter(x => x !== cb); }
          }
        }
      };
    },

    // Offline: email field = memberId (or '__admin__' for bootstrap), password = PIN
    signInWithPassword: ({ email: memberId, password: pin }) => {
      const stored = localStorage.getItem(LS.adminPin) ?? DEFAULT_PIN;
      if (pin !== stored) {
        return Promise.resolve({ data: null, error: { message: 'PIN 碼錯誤' } });
      }
      if (memberId === '__admin__') {
        const session = { user: { id: '__admin__', name: '管理員', email: '__admin__' } };
        localStorage.setItem(LS.session, JSON.stringify(session));
        _authCbs.forEach(cb => cb('SIGNED_IN', session));
        return Promise.resolve({ data: { session }, error: null });
      }
      const members = lsGet('members');
      const member = Array.isArray(members) ? members.find(m => m.id === memberId) : null;
      if (!member) return Promise.resolve({ data: null, error: { message: '找不到此成員' } });
      if (!member.is_admin) return Promise.resolve({ data: null, error: { message: '此成員無管理員權限' } });
      const session = { user: { id: memberId, name: member.name, email: memberId } };
      localStorage.setItem(LS.session, JSON.stringify(session));
      _authCbs.forEach(cb => cb('SIGNED_IN', session));
      return Promise.resolve({ data: { session }, error: null });
    },

    signOut: () => {
      localStorage.removeItem(LS.session);
      _authCbs.forEach(cb => cb('SIGNED_OUT', null));
      return Promise.resolve({});
    },

    signUp: () => Promise.resolve({
      error: { message: '離線模式：帳號由人員管理設定，無需另行註冊。' }
    }),
  },

  from: (table) => makeQuery(table),
};

// ── Data fetchers (same interface as db.js) ───────────────────
export async function dbFetchMembers() {
  const data = lsGet('members');
  return Array.isArray(data)
    ? data.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    : [];
}

export async function dbFetchSchedule(year, month) {
  const all = lsGet('schedules');
  const data = Array.isArray(all) ? all.filter(s => s.year === year && s.month === month) : [];
  const schedule = {}, lockedDays = new Set(), manualSchedule = {};
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
  const all = lsGet('leaves');
  const data = Array.isArray(all) ? all.filter(l => l.year === year && l.month === month) : [];
  const result = {};
  for (const row of data) {
    (result[row.day] = result[row.day] || []).push(row.member_id);
  }
  return result;
}

export async function dbFetchHolidays(year) {
  const all = lsGet('holidays');
  return Array.isArray(all)
    ? all.filter(h => h.year === year).sort((a, b) => a.month - b.month || a.day - b.day)
    : [];
}

export async function dbFetchRules() {
  const data = lsGet('schedule_rules');
  if (!data || Array.isArray(data) || typeof data !== 'object') return { ...DEFAULT_RULES };
  return data;
}

export async function dbFetchPairs() {
  const data = lsGet('member_pairs');
  return Array.isArray(data) ? data : [];
}

// ── Backup helpers ────────────────────────────────────────────
export function exportData() {
  return JSON.stringify({
    members:   lsGet('members'),
    schedules: lsGet('schedules'),
    leaves:    lsGet('leaves'),
    holidays:  lsGet('holidays'),
    rules:     lsGet('schedule_rules'),
    pairs:     lsGet('member_pairs'),
    exportedAt: new Date().toISOString(),
  }, null, 2);
}

export function importData(jsonStr) {
  const d = JSON.parse(jsonStr);
  if (d.members)   lsSet('members',        d.members);
  if (d.schedules) lsSet('schedules',       d.schedules);
  if (d.leaves)    lsSet('leaves',          d.leaves);
  if (d.holidays)  lsSet('holidays',        d.holidays);
  if (d.rules)     lsSet('schedule_rules',  d.rules);
  if (d.pairs)     lsSet('member_pairs',    d.pairs);
}

export function getAdminPin() {
  return localStorage.getItem(LS.adminPin) ?? DEFAULT_PIN;
}

export function setAdminPin(pin) {
  localStorage.setItem(LS.adminPin, pin);
}
