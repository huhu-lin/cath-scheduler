import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://qrkichzuegngsxnvwhgx.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFya2ljaHp1ZWduZ3N4bnZ3aGd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0OTU4NjAsImV4cCI6MjA5NDA3MTg2MH0.5V61Looj6JHVtMEaFArUIBNOnmXCblF-Xc8o32i_NIc"
);

const ROLES = ["doctor", "radiologist", "nurse", "other"];
const ROLE_LABELS = { doctor: "醫師", radiologist: "放射師", nurse: "護理師", other: "其他" };
const ROLE_COLORS = { doctor: "#dc2626", radiologist: "#0891b2", nurse: "#7c3aed", other: "#64748b" };
const DEFAULT_COLORS = ["#0891b2","#7c3aed","#dc2626","#16a34a","#d97706","#db2777","#0284c7","#9333ea"];
const DEFAULT_RULES = { weekday_doctor:1, weekday_rad_nurse:3, weekend_doctor:1, weekend_radiologist:1, weekend_nurse:1, max_consecutive:2 };

function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getDow(y, m, d) { return new Date(y, m, d).getDay(); }
function isWeekend(dow) { return dow === 0 || dow === 6; }
function isFriday(dow) { return dow === 5; }

// Consecutive weekday streak — weekends and national holidays break/reset the streak
function getStreak(sched, day, memberId, year, month, holidayDays) {
  let s = 0;
  for (let d = day - 1; d >= 1; d--) {
    const dow = getDow(year, month, d);
    if (isWeekend(dow) || (holidayDays && holidayDays.has(d))) break;
    if ((sched[d] || []).includes(memberId)) s++;
    else break;
  }
  return s;
}

// Sort pool: higher preference_weight = scheduled first; among same weight, fewer calls = first
function sortByScore(pool, cnt) {
  return pool.slice().sort((a, b) => {
    const sa = cnt[a.id] - (a.preference_weight || 0) * 100;
    const sb = cnt[b.id] - (b.preference_weight || 0) * 100;
    return sa - sb;
  });
}

// Pick N people from pool, falling back to full pool if not enough eligible
function pick(pool, cnt, n, fallback) {
  const sorted = sortByScore(pool, cnt);
  return sorted.length >= n ? sorted.slice(0, n) : sortByScore(fallback, cnt).slice(0, n);
}

function autoGenerate(year, month, members, leave, existingSched, lockedDays, holidayDays, rules) {
  const r = rules || DEFAULT_RULES;
  const days = getDaysInMonth(year, month);
  const sched = {};
  const cnt = Object.fromEntries(members.map(m => [m.id, 0]));

  for (let d = 1; d <= days; d++) {
    // Locked days: keep as-is
    if (lockedDays && lockedDays.has(d)) {
      sched[d] = existingSched[d] || [];
      sched[d].forEach(id => { if (cnt[id] !== undefined) cnt[id]++; });
      continue;
    }
    // National holidays: keep existing (manually scheduled)
    if (holidayDays && holidayDays.has(d)) {
      sched[d] = existingSched[d] || [];
      continue;
    }

    const dow = getDow(year, month, d);
    const lv = leave[d] || [];
    const avail = members.filter(m => !lv.includes(m.id));
    const used = new Set();
    const result = [];

    if (isWeekend(dow)) {
      // Weekend: weekday_doctor doctors + weekend_radiologist rads + weekend_nurse nurses
      const doctors = pick(
        avail.filter(m => m.role === "doctor"),
        cnt, r.weekend_doctor,
        avail.filter(m => m.role === "doctor")
      );
      doctors.forEach(m => { result.push(m.id); used.add(m.id); });

      const rads = pick(
        avail.filter(m => m.role === "radiologist" && !used.has(m.id)),
        cnt, r.weekend_radiologist,
        avail.filter(m => m.role === "radiologist")
      );
      rads.forEach(m => { result.push(m.id); used.add(m.id); });

      const nurses = pick(
        avail.filter(m => m.role === "nurse" && !used.has(m.id)),
        cnt, r.weekend_nurse,
        avail.filter(m => m.role === "nurse")
      );
      nurses.forEach(m => { result.push(m.id); used.add(m.id); });

    } else {
      // Weekday: weekday_doctor doctors + weekday_rad_nurse from rad+nurse pool
      // Consecutive limit applies; exempt on national holidays (already handled above)
      const maxC = r.max_consecutive;

      const docPool = avail.filter(m => m.role === "doctor");
      const docEligible = docPool.filter(m => getStreak(sched, d, m.id, year, month, holidayDays) < maxC);
      const doctors = pick(docEligible, cnt, r.weekday_doctor, docPool);
      doctors.forEach(m => { result.push(m.id); used.add(m.id); });

      const rnPool = avail.filter(m => (m.role === "radiologist" || m.role === "nurse") && !used.has(m.id));
      const rnEligible = rnPool.filter(m => getStreak(sched, d, m.id, year, month, holidayDays) < maxC);
      const rn = pick(rnEligible, cnt, r.weekday_rad_nurse, rnPool);
      rn.forEach(m => { result.push(m.id); used.add(m.id); });
    }

    sched[d] = result;
    result.forEach(id => { if (cnt[id] !== undefined) cnt[id]++; });
  }
  return sched;
}

// ── DB helpers ──────────────────────────────────────────────
async function dbFetchMembers() {
  const { data, error } = await supabase.from("members").select("*").order("sort_order");
  if (error) throw error;
  return data;
}

async function dbFetchSchedule(year, month) {
  const { data, error } = await supabase
    .from("schedules").select("day, member_id, manually_set")
    .eq("year", year).eq("month", month);
  if (error) throw error;
  const schedule = {};
  const lockedDays = new Set();
  for (const row of data) {
    if (!schedule[row.day]) schedule[row.day] = [];
    schedule[row.day].push(row.member_id);
    if (row.manually_set) lockedDays.add(row.day);
  }
  return { schedule, lockedDays };
}

async function dbFetchLeave(year, month) {
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

async function dbFetchHolidays(year) {
  const { data, error } = await supabase
    .from("holidays").select("*").eq("year", year).order("month").order("day");
  if (error) throw error;
  return data;
}

async function dbFetchRules() {
  const { data, error } = await supabase.from("schedule_rules").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data || DEFAULT_RULES;
}

// ── Constants ───────────────────────────────────────────────
const DOW_LABELS = ["日","一","二","三","四","五","六"];
const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
const PREF_LABELS = ["一般", "偏好", "優先"];

// ── MemberForm ───────────────────────────────────────────────
function MemberForm({ member, onChange, onSave, onCancel, saving }) {
  return (
    <div style={S.formBox}>
      <div style={S.formRow}>
        <label style={S.formLabel}>姓名</label>
        <input style={S.formInput} value={member.name} onChange={e => onChange({ ...member, name: e.target.value })} />
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>職類</label>
        <select style={S.formSelect} value={member.role} onChange={e => onChange({ ...member, role: e.target.value })}>
          {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>電話</label>
        <input style={S.formInput} value={member.phone || ""} onChange={e => onChange({ ...member, phone: e.target.value })} placeholder="選填" />
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>Email</label>
        <input style={S.formInput} type="email" value={member.email || ""} onChange={e => onChange({ ...member, email: e.target.value })} placeholder="管理員帳號用" />
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>排班優先</label>
        <select style={S.formSelect} value={member.preference_weight || 0} onChange={e => onChange({ ...member, preference_weight: parseInt(e.target.value) })}>
          {PREF_LABELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
        </select>
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>顏色</label>
        <input type="color" value={member.color} onChange={e => onChange({ ...member, color: e.target.value })} style={{ width: 40, height: 32, border: "none", cursor: "pointer" }} />
      </div>
      <div style={S.formRow}>
        <label style={S.formLabel}>管理員</label>
        <input type="checkbox" checked={!!member.is_admin} onChange={e => onChange({ ...member, is_admin: e.target.checked })} style={{ width: 18, height: 18, cursor: "pointer" }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button style={S.btnPrimary} onClick={onSave} disabled={saving || !member.name.trim()}>
          {saving ? "儲存中…" : "✓ 儲存"}
        </button>
        <button style={S.btnSecondary} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────
export default function CathScheduler() {
  const today = new Date();
  const [year, setYear]     = useState(today.getFullYear());
  const [month, setMonth]   = useState(today.getMonth());
  const [members, setMembers]       = useState([]);
  const [schedule, setSchedule]     = useState({});
  const [leaveMap, setLeaveMap]     = useState({});
  const [lockedDays, setLockedDays] = useState(new Set());
  const [holidays, setHolidays]     = useState([]);
  const [rules, setRules]           = useState(DEFAULT_RULES);
  const [view, setView]         = useState("calendar");
  const [adminTab, setAdminTab] = useState("members");
  const [selectedDay, setSelectedDay] = useState(null);
  const [editMode, setEditMode]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);

  // Auth
  const [session, setSession]         = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [showUserPicker, setShowUserPicker] = useState(false);
  const [showAuthModal, setShowAuthModal]   = useState(false);
  const [authMode, setAuthMode]   = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError]   = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Member admin
  const [editingMember, setEditingMember] = useState(null);
  const [newMember, setNewMember]         = useState(null);
  const [memberSaving, setMemberSaving]   = useState(false);
  const [newHoliday, setNewHoliday] = useState({ month: today.getMonth() + 1, day: "", name: "" });
  const [holidaySaving, setHolidaySaving] = useState(false);

  // Rules editing
  const [editingRules, setEditingRules] = useState(null);
  const [rulesSaving, setRulesSaving]   = useState(false);

  const isAdmin = !!session && (currentUser?.is_admin ?? false);

  const notify = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Auth ────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) setCurrentUser(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user?.email) {
      supabase.from("members").select("*").eq("email", session.user.email).maybeSingle()
        .then(({ data }) => { if (data) setCurrentUser(data); });
    }
  }, [session]);

  async function handleAuth() {
    setAuthError(""); setAuthLoading(true);
    try {
      if (authMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
      } else {
        const { data: member } = await supabase.from("members")
          .select("id").eq("email", authEmail).eq("is_admin", true).maybeSingle();
        if (!member) throw new Error("此 email 未與任何管理員成員關聯，請先在成員資料中設定 email");
        const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
        notify("📧 已送出確認信，請至信箱驗證後再登入");
      }
      setShowAuthModal(false); setAuthEmail(""); setAuthPassword("");
    } catch (e) { setAuthError(e.message); }
    setAuthLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setCurrentUser(null); setView("calendar");
  }

  // ── Data loading ────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [mData, { schedule: sData, lockedDays: ld }, lData, hData, rData] = await Promise.all([
        dbFetchMembers(),
        dbFetchSchedule(year, month),
        dbFetchLeave(year, month),
        dbFetchHolidays(year),
        dbFetchRules(),
      ]);
      setMembers(mData); setSchedule(sData); setLockedDays(ld);
      setLeaveMap(lData); setHolidays(hData); setRules(rData);
    } catch (e) { notify("⚠️ 載入失敗：" + e.message, "err"); }
    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Schedule ops ────────────────────────────────────────────
  async function saveFullSchedule(newSched) {
    setSaving(true);
    try {
      await supabase.from("schedules").delete()
        .eq("year", year).eq("month", month).eq("manually_set", false);
      const rows = [];
      for (const [day, ids] of Object.entries(newSched)) {
        if (lockedDays.has(parseInt(day))) continue;
        for (const member_id of ids)
          rows.push({ year, month, day: parseInt(day), member_id, manually_set: false });
      }
      if (rows.length > 0) {
        const { error } = await supabase.from("schedules").insert(rows);
        if (error) throw error;
      }
      const merged = { ...newSched };
      lockedDays.forEach(d => { merged[d] = schedule[d] || []; });
      setSchedule(merged);
      notify("✅ 班表已儲存");
    } catch (e) { notify("❌ 儲存失敗：" + e.message, "err"); }
    setSaving(false);
  }

  async function toggleAssign(day, memberId) {
    if (saving || !isAdmin) return;
    const arr = schedule[day] ? [...schedule[day]] : [];
    const isOn = arr.includes(memberId);
    setSaving(true);
    try {
      if (isOn) {
        const { error } = await supabase.from("schedules").delete()
          .eq("year", year).eq("month", month).eq("day", day).eq("member_id", memberId);
        if (error) throw error;
        const newArr = arr.filter(x => x !== memberId);
        setSchedule(prev => ({ ...prev, [day]: newArr }));
        if (newArr.length === 0)
          setLockedDays(prev => { const s = new Set(prev); s.delete(day); return s; });
      } else {
        const { error } = await supabase.from("schedules").insert({ year, month, day, member_id: memberId, manually_set: true });
        if (error) throw error;
        await supabase.from("schedules").update({ manually_set: true })
          .eq("year", year).eq("month", month).eq("day", day);
        setSchedule(prev => ({ ...prev, [day]: [...arr, memberId] }));
        setLockedDays(prev => new Set([...prev, day]));
      }
    } catch (e) { notify("❌ 操作失敗：" + e.message, "err"); }
    setSaving(false);
  }

  async function toggleLeave(day, memberId) {
    if (saving) return;
    const arr = leaveMap[day] ? [...leaveMap[day]] : [];
    const isOnLeave = arr.includes(memberId);
    setSaving(true);
    try {
      if (isOnLeave) {
        const { error } = await supabase.from("leaves").delete()
          .eq("year", year).eq("month", month).eq("day", day).eq("member_id", memberId);
        if (error) throw error;
        setLeaveMap(prev => ({ ...prev, [day]: arr.filter(x => x !== memberId) }));
      } else {
        const { error } = await supabase.from("leaves").insert({ year, month, day, member_id: memberId });
        if (error) throw error;
        setLeaveMap(prev => ({ ...prev, [day]: [...arr, memberId] }));
        if (schedule[day]?.includes(memberId)) {
          await supabase.from("schedules").delete()
            .eq("year", year).eq("month", month).eq("day", day).eq("member_id", memberId);
          setSchedule(prev => ({ ...prev, [day]: (prev[day] || []).filter(x => x !== memberId) }));
        }
      }
      notify("📅 預假已更新");
    } catch (e) { notify("❌ 操作失敗：" + e.message, "err"); }
    setSaving(false);
  }

  function handleAutoGenerate() {
    const holidayDays = new Set(
      holidays.filter(h => h.year === year && h.month === month + 1).map(h => h.day)
    );
    const gen = autoGenerate(year, month, members, leaveMap, schedule, lockedDays, holidayDays, rules);
    saveFullSchedule(gen);
  }

  // ── Member CRUD ─────────────────────────────────────────────
  async function saveMember(m) {
    setMemberSaving(true);
    try {
      if (m.id) {
        const { error } = await supabase.from("members").update({
          name: m.name, role: m.role, phone: m.phone || "", email: m.email || "",
          color: m.color, is_admin: !!m.is_admin, preference_weight: m.preference_weight || 0,
        }).eq("id", m.id);
        if (error) throw error;
        setMembers(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x));
        if (currentUser?.id === m.id) setCurrentUser(prev => ({ ...prev, ...m }));
      } else {
        const newId = Math.random().toString(36).slice(2, 10);
        const maxOrder = members.reduce((max, x) => Math.max(max, x.sort_order || 0), 0);
        const { data, error } = await supabase.from("members").insert({
          id: newId, name: m.name, role: m.role, phone: m.phone || "", email: m.email || "",
          color: m.color, is_admin: !!m.is_admin, preference_weight: m.preference_weight || 0,
          sort_order: maxOrder + 1,
        }).select().single();
        if (error) throw error;
        setMembers(prev => [...prev, data]);
      }
      setEditingMember(null); setNewMember(null);
      notify("✅ 成員已儲存");
    } catch (e) { notify("❌ 儲存失敗：" + e.message, "err"); }
    setMemberSaving(false);
  }

  async function deleteMember(id) {
    if (!window.confirm("確定刪除此成員？相關排班記錄也會一併移除。")) return;
    setMemberSaving(true);
    try {
      await supabase.from("schedules").delete().eq("member_id", id);
      await supabase.from("leaves").delete().eq("member_id", id);
      const { error } = await supabase.from("members").delete().eq("id", id);
      if (error) throw error;
      setMembers(prev => prev.filter(x => x.id !== id));
      notify("🗑️ 成員已刪除");
    } catch (e) { notify("❌ 刪除失敗：" + e.message, "err"); }
    setMemberSaving(false);
  }

  // ── Holiday CRUD ────────────────────────────────────────────
  async function addHoliday() {
    if (!newHoliday.day || !newHoliday.name) { notify("請填寫日期和名稱", "err"); return; }
    setHolidaySaving(true);
    try {
      const { data, error } = await supabase.from("holidays").insert({
        year, month: parseInt(newHoliday.month), day: parseInt(newHoliday.day), name: newHoliday.name,
      }).select().single();
      if (error) throw error;
      setHolidays(prev => [...prev, data].sort((a, b) => a.month - b.month || a.day - b.day));
      setNewHoliday({ month: today.getMonth() + 1, day: "", name: "" });
      notify("✅ 假日已新增");
    } catch (e) { notify("❌ 新增失敗：" + e.message, "err"); }
    setHolidaySaving(false);
  }

  async function deleteHoliday(id) {
    try {
      const { error } = await supabase.from("holidays").delete().eq("id", id);
      if (error) throw error;
      setHolidays(prev => prev.filter(h => h.id !== id));
      notify("🗑️ 假日已刪除");
    } catch (e) { notify("❌ 刪除失敗：" + e.message, "err"); }
  }

  // ── Rules CRUD ──────────────────────────────────────────────
  async function saveRules(r) {
    setRulesSaving(true);
    try {
      const { error } = await supabase.from("schedule_rules").upsert({ id: 1, ...r });
      if (error) throw error;
      setRules(r); setEditingRules(null);
      notify("✅ 排班規則已儲存");
    } catch (e) { notify("❌ 儲存失敗：" + e.message, "err"); }
    setRulesSaving(false);
  }

  // ── Helpers ─────────────────────────────────────────────────
  function getMember(id) { return members.find(m => m.id === id); }

  function buildCalendar() {
    const days = getDaysInMonth(year, month);
    const firstDow = getDow(year, month, 1);
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    return cells;
  }

  const cells = buildCalendar();
  const isToday = d => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  const callCount = {};
  members.forEach(m => { callCount[m.id] = 0; });
  Object.values(schedule).forEach(ids => ids.forEach(id => { if (callCount[id] !== undefined) callCount[id]++; }));

  const holidayMap = {};
  holidays.filter(h => h.year === year && h.month === month + 1).forEach(h => { holidayMap[h.day] = h.name; });

  // ── Render ──────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {toast && <div style={{ ...S.toast, background: toast.type === "err" ? "#dc2626" : "#0891b2" }}>{toast.msg}</div>}

      {/* Header */}
      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.logo}>🫀</span>
          <div>
            <div style={S.title}>心導管室 On-Call</div>
            <div style={S.subtitle}>排班系統</div>
          </div>
        </div>
        <div style={S.headerRight}>
          {saving && <span style={S.savingTxt}>⟳ 儲存中...</span>}
          {session ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={S.userInfo}>
                {currentUser && <span style={{ ...S.dot, background: currentUser.color }} />}
                <span style={S.userName}>{currentUser?.name ?? session.user.email}</span>
                <span style={S.adminBadge}>管理員</span>
              </div>
              <button style={S.logoutBtn} onClick={handleLogout}>登出</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button style={S.userBtn} onClick={() => setShowUserPicker(true)}>
                {currentUser ? <><span style={{ ...S.dot, background: currentUser.color }} />{currentUser.name}</> : "選擇身份"}
              </button>
              <button style={S.adminLoginBtn} onClick={() => { setShowAuthModal(true); setAuthError(""); }}>
                🔐 管理員登入
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Identity picker */}
      {showUserPicker && (
        <div style={S.modalOverlay} onClick={() => setShowUserPicker(false)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>選擇身份（預假用）</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>選擇身份後可在「🙋 預假」頁提交請假</div>
            <div style={S.modalGrid}>
              {members.map(m => (
                <button key={m.id} style={{ ...S.memberPickBtn, borderColor: m.color + "80" }}
                  onClick={() => { setCurrentUser(m); setShowUserPicker(false); }}>
                  <span style={{ ...S.dot, background: m.color }} />
                  <span style={S.pickName}>{m.name}</span>
                  <span style={{ ...S.roleTag, background: ROLE_COLORS[m.role] + "18", color: ROLE_COLORS[m.role] }}>{ROLE_LABELS[m.role]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Auth modal */}
      {showAuthModal && (
        <div style={S.modalOverlay} onClick={() => setShowAuthModal(false)}>
          <div style={{ ...S.modalBox, maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>{authMode === "login" ? "🔐 管理員登入" : "📝 建立管理員帳號"}</div>
            {authMode === "signup" && (
              <div style={S.authHint}>建立帳號前，請先在「⚙️ 管理 → 人員管理」中，將你的 email 填入對應成員資料並勾選管理員。</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input style={S.authInput} type="email" placeholder="Email" value={authEmail}
                onChange={e => setAuthEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAuth()} autoFocus />
              <input style={S.authInput} type="password" placeholder="密碼" value={authPassword}
                onChange={e => setAuthPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAuth()} />
              {authError && <div style={S.authError}>{authError}</div>}
              <button style={S.btnPrimary} onClick={handleAuth} disabled={authLoading || !authEmail || !authPassword}>
                {authLoading ? "處理中…" : authMode === "login" ? "登入" : "建立帳號"}
              </button>
              <button style={S.authSwitchBtn} onClick={() => { setAuthMode(m => m === "login" ? "signup" : "login"); setAuthError(""); }}>
                {authMode === "login" ? "尚未建立帳號？建立管理員帳號" : "已有帳號？返回登入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav style={S.nav}>
        {[["calendar","📅 班表"],["leave","🙋 預假"],["stats","📊 統計"]].map(([v, l]) => (
          <button key={v} style={{ ...S.navBtn, ...(view === v ? S.navActive : {}) }}
            onClick={() => { setView(v); setSelectedDay(null); setEditMode(false); }}>{l}</button>
        ))}
        {isAdmin && (
          <button style={{ ...S.navBtn, ...(view === "admin" ? S.navActive : {}) }}
            onClick={() => { setView("admin"); setSelectedDay(null); setEditMode(false); }}>⚙️ 管理</button>
        )}
      </nav>

      {/* Month nav */}
      <div style={S.monthNav}>
        <button style={S.arrowBtn} onClick={() => {
          setSelectedDay(null); setEditMode(false);
          if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
        }}>‹</button>
        <span style={S.monthLabel}>{year} 年 {MONTH_NAMES[month]}</span>
        <button style={S.arrowBtn} onClick={() => {
          setSelectedDay(null); setEditMode(false);
          if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
        }}>›</button>
        {view === "calendar" && isAdmin && (
          <>
            <button style={S.genBtn} onClick={handleAutoGenerate} disabled={saving || loading}>⚡ 自動排班</button>
            <button style={{ ...S.editToggleBtn, ...(editMode ? S.editToggleBtnActive : {}) }}
              onClick={() => { setEditMode(e => !e); setSelectedDay(null); }}>
              ✏️ {editMode ? "完成編輯" : "手動調整"}
            </button>
          </>
        )}
        <button style={S.reloadBtn} onClick={loadAll} disabled={loading}>↺</button>
      </div>

      {loading && <div style={S.loadingBar}><div style={S.loadingFill} /></div>}
      {editMode && view === "calendar" && (
        <div style={S.editBanner}>✏️ 手動調整模式：點擊格子中的人員來加入 / 移除（🔒 已鎖定日期不受自動排班影響）</div>
      )}

      {/* ── Calendar ── */}
      {view === "calendar" && (
        <div style={S.content}>
          <div style={S.calGrid}>
            {DOW_LABELS.map((d, i) => (
              <div key={d} style={{ ...S.dowHeader, color: i === 0 ? "#dc2626" : i === 6 ? "#2563eb" : "#64748b" }}>{d}</div>
            ))}
          </div>
          <div style={S.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={S.emptyCell} />;
              const dow = getDow(year, month, d);
              const assigned = schedule[d] || [];
              const leaves = leaveMap[d] || [];
              const wg = isWeekend(dow);
              const fri = isFriday(dow);
              const isSelected = selectedDay === d;
              const isLocked = lockedDays.has(d);
              const holName = holidayMap[d];
              return (
                <div key={d}
                  style={{ ...S.cell, ...(wg ? S.cellWG : {}), ...(fri ? S.cellFri : {}), ...(holName ? S.cellHoliday : {}), ...(isToday(d) ? S.cellToday : {}), ...(isSelected && !editMode ? S.cellSelected : {}), ...(editMode ? S.cellEditMode : {}) }}
                  onClick={() => { if (!editMode) setSelectedDay(isSelected ? null : d); }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <div style={{ ...S.cellDay, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>{d}</div>
                    {isLocked && <span title="手動排定" style={S.lockIcon}>🔒</span>}
                  </div>
                  <div style={S.cellDow}>{DOW_LABELS[dow]}{wg ? " 🌙" : fri ? " ★" : ""}</div>
                  {holName && <div style={S.holidayLabel}>{holName}</div>}
                  <div style={S.cellMembers}>
                    {assigned.map(id => {
                      const mbr = getMember(id);
                      if (!mbr) return null;
                      return (
                        <span key={id}
                          style={{ ...S.chip, background: mbr.color + "22", color: mbr.color, border: `1.5px solid ${mbr.color}55`, ...(editMode && isAdmin ? S.chipEditable : {}) }}
                          onClick={editMode && isAdmin ? (e) => { e.stopPropagation(); toggleAssign(d, id); } : undefined}
                          title={editMode && isAdmin ? "點擊移除" : undefined}>
                          {editMode && isAdmin && <span style={S.chipRemove}>✕ </span>}
                          {mbr.name}
                        </span>
                      );
                    })}
                    {editMode && isAdmin && (
                      <span style={S.chipAdd} onClick={(e) => { e.stopPropagation(); setSelectedDay(d === selectedDay ? null : d); }}>+ 加入</span>
                    )}
                  </div>
                  {leaves.length > 0 && <div style={S.leaveHint}>休 {leaves.length}</div>}
                </div>
              );
            })}
          </div>

          {selectedDay && !editMode && isAdmin && (
            <div style={S.panel}>
              <div style={S.panelHeader}>
                <div style={S.panelTitle}>
                  {month + 1}/{selectedDay}（{DOW_LABELS[getDow(year, month, selectedDay)]}）
                  {isWeekend(getDow(year, month, selectedDay)) && <span style={S.panelBadgeWG}>🌙 週末</span>}
                  {lockedDays.has(selectedDay) && <span style={S.panelBadgeLock}>🔒 已鎖定</span>}
                  {holidayMap[selectedDay] && <span style={S.panelBadgeHol}>🎌 {holidayMap[selectedDay]}</span>}
                </div>
                <button style={S.panelClose} onClick={() => setSelectedDay(null)}>✕</button>
              </div>
              <div style={S.panelLabel}>📋 On-Call 人員</div>
              <div style={S.memberRow}>
                {members.map(mbr => {
                  const on = (schedule[selectedDay] || []).includes(mbr.id);
                  const lv = (leaveMap[selectedDay] || []).includes(mbr.id);
                  return (
                    <button key={mbr.id} disabled={lv || saving} title={lv ? "請假中" : on ? "點擊移除" : "點擊加入"}
                      style={{ ...S.memberToggle, ...(on ? { background: mbr.color, color: "#fff", borderColor: mbr.color, boxShadow: `0 2px 8px ${mbr.color}50` } : {}), ...(lv ? S.memberOnLeave : {}) }}
                      onClick={() => !lv && !saving && toggleAssign(selectedDay, mbr.id)}>
                      <span>{lv ? "🚫" : on ? "✓ " : "+ "}</span>
                      <span>{mbr.name}</span>
                      <span style={{ ...S.roleTag, background: on ? "#fff3" : ROLE_COLORS[mbr.role] + "18", color: on ? "#fff" : ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedDay && editMode && isAdmin && (
            <div style={{ ...S.panel, borderColor: "#f59e0b60" }}>
              <div style={S.panelHeader}>
                <div style={{ ...S.panelTitle, color: "#b45309" }}>✏️ {month + 1}/{selectedDay} — 新增人員</div>
                <button style={S.panelClose} onClick={() => setSelectedDay(null)}>✕</button>
              </div>
              <div style={S.memberRow}>
                {members.map(mbr => {
                  const on = (schedule[selectedDay] || []).includes(mbr.id);
                  const lv = (leaveMap[selectedDay] || []).includes(mbr.id);
                  if (on || lv) return null;
                  return (
                    <button key={mbr.id} disabled={saving} style={S.memberToggle}
                      onClick={() => { toggleAssign(selectedDay, mbr.id); setSelectedDay(null); }}>
                      + {mbr.name}
                      <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Leave ── */}
      {view === "leave" && (
        <div style={S.content}>
          <div style={S.leaveNote}>{currentUser ? `身份：${currentUser.name}　點擊自己的名字來預假 / 取消` : "⬆ 請先點右上角「選擇身份」，再操作預假"}</div>
          <div style={S.calGrid}>
            {DOW_LABELS.map((d, i) => (
              <div key={d} style={{ ...S.dowHeader, color: i === 0 ? "#dc2626" : i === 6 ? "#2563eb" : "#64748b" }}>{d}</div>
            ))}
          </div>
          <div style={S.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={S.emptyCell} />;
              const dow = getDow(year, month, d);
              const leaves = leaveMap[d] || [];
              const holName = holidayMap[d];
              return (
                <div key={d} style={{ ...S.cell, ...(isToday(d) ? S.cellToday : {}), ...(holName ? S.cellHoliday : {}), minHeight: 88 }}>
                  <div style={{ ...S.cellDay, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>{d}</div>
                  <div style={S.cellDow}>{DOW_LABELS[dow]}</div>
                  {holName && <div style={S.holidayLabel}>{holName}</div>}
                  <div style={S.cellMembers}>
                    {members.map(mbr => {
                      const onLeave = leaves.includes(mbr.id);
                      const isMe = currentUser?.id === mbr.id;
                      return (
                        <span key={mbr.id} onClick={() => isMe && toggleLeave(d, mbr.id)}
                          title={isMe ? "點擊預假/取消" : "只能操作自己的假"}
                          style={{ ...S.chip, background: onLeave ? "#fee2e2" : "#f1f5f9", color: onLeave ? "#dc2626" : isMe ? "#334155" : "#94a3b8", border: `1.5px solid ${onLeave ? "#fca5a5" : isMe ? "#cbd5e1" : "#e2e8f0"}`, cursor: isMe ? "pointer" : "default", opacity: isMe || !currentUser ? 1 : 0.45, fontWeight: isMe ? 700 : 400 }}>
                          {onLeave ? "🚫 " : ""}{mbr.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Stats ── */}
      {view === "stats" && (
        <div style={S.content}>
          <div style={S.statsGrid}>
            {members.map(mbr => {
              const cnt = callCount[mbr.id] || 0;
              const max = Math.max(...Object.values(callCount), 1);
              return (
                <div key={mbr.id} style={S.statCard}>
                  <div style={{ ...S.statBar, width: `${(cnt / max) * 100}%`, background: mbr.color + "28" }} />
                  <div style={S.statInfo}>
                    <span style={{ ...S.dot, background: mbr.color, width: 14, height: 14 }} />
                    <span style={S.statName}>{mbr.name}</span>
                    <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                    {(mbr.preference_weight || 0) > 0 && (
                      <span style={S.prefBadge}>{PREF_LABELS[mbr.preference_weight]}</span>
                    )}
                  </div>
                  <div style={{ ...S.statCount, color: mbr.color }}>{cnt} 次</div>
                </div>
              );
            })}
          </div>
          <div style={S.statsNote}>
            本月平均：{members.length > 0
              ? (Object.values(callCount).reduce((a, b) => a + b, 0) / members.length).toFixed(1) : 0} 次／人
          </div>
        </div>
      )}

      {/* ── Admin ── */}
      {view === "admin" && isAdmin && (
        <div style={S.content}>
          <div style={S.adminTabs}>
            {[["members","👥 人員管理"],["rules","📋 排班規則"],["holidays","🎌 國定假日"]].map(([t, l]) => (
              <button key={t} style={{ ...S.adminTabBtn, ...(adminTab === t ? S.adminTabActive : {}) }}
                onClick={() => setAdminTab(t)}>{l}</button>
            ))}
          </div>

          {/* Members tab */}
          {adminTab === "members" && (
            <div style={S.adminSection}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={S.sectionTitle}>成員名單</div>
                {!newMember && (
                  <button style={S.btnPrimary} onClick={() => setNewMember({
                    name: "", role: "nurse", phone: "", email: "", preference_weight: 0,
                    color: DEFAULT_COLORS[members.length % DEFAULT_COLORS.length], is_admin: false,
                  })}>+ 新增成員</button>
                )}
              </div>
              {newMember && (
                <div style={{ ...S.memberCard, borderColor: "#0891b2" }}>
                  <div style={{ ...S.sectionTitle, color: "#0891b2", marginBottom: 10 }}>新增成員</div>
                  <MemberForm member={newMember} onChange={setNewMember} onSave={() => saveMember(newMember)} onCancel={() => setNewMember(null)} saving={memberSaving} />
                </div>
              )}
              {members.map(m => (
                <div key={m.id} style={S.memberCard}>
                  {editingMember?.id === m.id ? (
                    <MemberForm member={editingMember} onChange={setEditingMember} onSave={() => saveMember(editingMember)} onCancel={() => setEditingMember(null)} saving={memberSaving} />
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ ...S.dot, background: m.color, width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 60 }}>{m.name}</span>
                      <span style={{ ...S.roleTag, background: ROLE_COLORS[m.role] + "18", color: ROLE_COLORS[m.role] }}>{ROLE_LABELS[m.role]}</span>
                      {m.is_admin && <span style={S.adminBadge}>管理員</span>}
                      {(m.preference_weight || 0) > 0 && <span style={S.prefBadge}>{PREF_LABELS[m.preference_weight]}</span>}
                      {m.email && <span style={{ fontSize: 12, color: "#94a3b8" }}>✉ {m.email}</span>}
                      {m.phone && <span style={{ fontSize: 13, color: "#64748b" }}>📞 {m.phone}</span>}
                      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                        <button style={S.btnSmall} onClick={() => setEditingMember({ ...m })}>編輯</button>
                        <button style={{ ...S.btnSmall, color: "#dc2626", borderColor: "#fca5a5" }} onClick={() => deleteMember(m.id)}>刪除</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Rules tab */}
          {adminTab === "rules" && (
            <div style={S.adminSection}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={S.sectionTitle}>排班規則設定</div>
                {!editingRules && (
                  <button style={S.btnPrimary} onClick={() => setEditingRules({ ...rules })}>✏️ 編輯規則</button>
                )}
              </div>

              {editingRules ? (
                <div style={S.formBox}>
                  {/* Weekday rules */}
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>📆 平日規則（週一至週五）</div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>醫師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekday_doctor}
                        onChange={e => setEditingRules(r => ({ ...r, weekday_doctor: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位</span>
                    </div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>放射師＋護理師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekday_rad_nurse}
                        onChange={e => setEditingRules(r => ({ ...r, weekday_rad_nurse: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位（合計）</span>
                    </div>
                  </div>

                  {/* Weekend/holiday rules */}
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🌙 假日／週末規則</div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>醫師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekend_doctor}
                        onChange={e => setEditingRules(r => ({ ...r, weekend_doctor: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位</span>
                    </div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>放射師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekend_radiologist}
                        onChange={e => setEditingRules(r => ({ ...r, weekend_radiologist: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位</span>
                    </div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>護理師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekend_nurse}
                        onChange={e => setEditingRules(r => ({ ...r, weekend_nurse: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位</span>
                    </div>
                  </div>

                  {/* Consecutive limit */}
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🔁 連續值班限制</div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>最長連續值班</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="1" max="30"
                        value={editingRules.max_consecutive}
                        onChange={e => setEditingRules(r => ({ ...r, max_consecutive: parseInt(e.target.value) || 1 }))} />
                      <span style={S.ruleUnit}>天</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, marginLeft: 80 }}>
                      ＊國定假日與週末不計入連續天數（豁免）
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button style={S.btnPrimary} onClick={() => saveRules(editingRules)} disabled={rulesSaving}>
                      {rulesSaving ? "儲存中…" : "✓ 儲存規則"}
                    </button>
                    <button style={S.btnSecondary} onClick={() => setEditingRules(null)}>取消</button>
                  </div>
                </div>
              ) : (
                // Read-only display
                <div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>📆 平日規則</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>醫師</span><span style={S.ruleValue}>{rules.weekday_doctor} 位</span></div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>放射師＋護理師合計</span><span style={S.ruleValue}>{rules.weekday_rad_nurse} 位</span></div>
                  </div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🌙 假日／週末規則</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>醫師</span><span style={S.ruleValue}>{rules.weekend_doctor} 位</span></div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>放射師</span><span style={S.ruleValue}>{rules.weekend_radiologist} 位</span></div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>護理師</span><span style={S.ruleValue}>{rules.weekend_nurse} 位</span></div>
                  </div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🔁 連續值班限制</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>最長連續值班</span><span style={S.ruleValue}>{rules.max_consecutive} 天</span></div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>＊國定假日與週末不計入連續天數</div>
                  </div>
                  <div style={{ ...S.ruleSection, borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
                    <div style={S.ruleSectionTitle}>⭐ 排班優先設定</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>在人員管理中為每位成員設定排班優先等級，優先等級高者在自動排班時會被優先分配。</div>
                    {members.filter(m => (m.preference_weight || 0) > 0).length === 0
                      ? <div style={{ fontSize: 13, color: "#94a3b8" }}>目前所有成員均為「一般」優先</div>
                      : members.filter(m => (m.preference_weight || 0) > 0).map(m => (
                        <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                          <span style={{ ...S.dot, background: m.color, width: 10, height: 10 }} />
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                          <span style={S.prefBadge}>{PREF_LABELS[m.preference_weight]}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Holidays tab */}
          {adminTab === "holidays" && (
            <div style={S.adminSection}>
              <div style={S.sectionTitle}>{year} 年國定假日</div>
              <div style={S.formBox}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <div style={S.formLabel}>月份</div>
                    <select style={{ ...S.formSelect, width: 80 }} value={newHoliday.month}
                      onChange={e => setNewHoliday(h => ({ ...h, month: e.target.value }))}>
                      {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 月</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={S.formLabel}>日期</div>
                    <input style={{ ...S.formInput, width: 64 }} type="number" min="1" max="31" placeholder="日"
                      value={newHoliday.day} onChange={e => setNewHoliday(h => ({ ...h, day: e.target.value }))} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={S.formLabel}>名稱</div>
                    <input style={S.formInput} placeholder="假日名稱" value={newHoliday.name}
                      onChange={e => setNewHoliday(h => ({ ...h, name: e.target.value }))} />
                  </div>
                  <button style={S.btnPrimary} onClick={addHoliday} disabled={holidaySaving}>
                    {holidaySaving ? "新增中…" : "+ 新增"}
                  </button>
                </div>
              </div>
              {holidays.filter(h => h.year === year).length === 0 && (
                <div style={{ color: "#94a3b8", fontSize: 14, padding: "12px 0" }}>尚未設定任何假日</div>
              )}
              {holidays.filter(h => h.year === year).map(h => (
                <div key={h.id} style={{ ...S.memberCard, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 18 }}>🎌</span>
                  <span style={{ fontWeight: 700, color: "#dc2626", minWidth: 60 }}>{h.month}/{h.day}</span>
                  <span style={{ flex: 1, fontSize: 14 }}>{h.name}</span>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>({DOW_LABELS[getDow(h.year, h.month - 1, h.day)]})</span>
                  <button style={{ ...S.btnSmall, color: "#dc2626", borderColor: "#fca5a5" }} onClick={() => deleteHoliday(h.id)}>刪除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────
const S = {
  root: { minHeight: "100vh", background: "#f1f5f9", color: "#0f172a", fontFamily: "'Noto Sans TC', 'Microsoft JhengHei', sans-serif" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", padding: "10px 24px", borderRadius: 24, color: "#fff", fontWeight: 700, fontSize: 15, zIndex: 999, boxShadow: "0 4px 20px #0003", whiteSpace: "nowrap" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "#fff", borderBottom: "2px solid #e2e8f0", boxShadow: "0 1px 4px #0001" },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 34, lineHeight: 1 },
  title: { fontSize: 20, fontWeight: 800, color: "#0891b2" },
  subtitle: { fontSize: 12, color: "#94a3b8", letterSpacing: 2, textTransform: "uppercase" },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  savingTxt: { fontSize: 13, color: "#0891b2", fontWeight: 600 },
  userInfo: { display: "flex", alignItems: "center", gap: 6 },
  userName: { fontWeight: 700, fontSize: 14, color: "#1e293b" },
  adminBadge: { fontSize: 10, padding: "1px 6px", borderRadius: 6, background: "#fef3c7", color: "#92400e", fontWeight: 700, border: "1px solid #fde68a" },
  prefBadge: { fontSize: 10, padding: "1px 6px", borderRadius: 6, background: "#f0fdf4", color: "#16a34a", fontWeight: 700, border: "1px solid #86efac" },
  userBtn: { display: "flex", alignItems: "center", gap: 6, background: "#f0f9ff", border: "1.5px solid #bae6fd", color: "#0369a1", padding: "7px 14px", borderRadius: 20, fontSize: 14, cursor: "pointer", fontWeight: 600 },
  adminLoginBtn: { display: "flex", alignItems: "center", gap: 4, background: "#fef3c7", border: "1.5px solid #fde68a", color: "#92400e", padding: "7px 14px", borderRadius: 20, fontSize: 13, cursor: "pointer", fontWeight: 700 },
  logoutBtn: { padding: "6px 14px", background: "#f1f5f9", border: "1.5px solid #e2e8f0", color: "#64748b", borderRadius: 20, fontSize: 13, cursor: "pointer", fontWeight: 600 },
  dot: { borderRadius: "50%", display: "inline-block", flexShrink: 0, width: 10, height: 10 },
  nav: { display: "flex", gap: 4, padding: "10px 16px", background: "#fff", borderBottom: "1px solid #e2e8f0" },
  navBtn: { padding: "8px 18px", borderRadius: 20, border: "1.5px solid transparent", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  navActive: { background: "#e0f2fe", color: "#0891b2", borderColor: "#bae6fd" },
  monthNav: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" },
  arrowBtn: { width: 34, height: 34, borderRadius: "50%", border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#475569", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  monthLabel: { fontWeight: 800, fontSize: 17, color: "#1e293b", minWidth: 130, textAlign: "center" },
  genBtn: { marginLeft: "auto", padding: "8px 16px", background: "#0891b2", color: "#fff", border: "none", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 14, boxShadow: "0 2px 8px #0891b230" },
  editToggleBtn: { padding: "8px 16px", background: "#fff", color: "#92400e", border: "1.5px solid #fcd34d", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 14 },
  editToggleBtnActive: { background: "#fef3c7", color: "#92400e", borderColor: "#f59e0b", boxShadow: "0 2px 8px #f59e0b30" },
  reloadBtn: { width: 34, height: 34, borderRadius: "50%", border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#94a3b8", cursor: "pointer", fontSize: 17, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  loadingBar: { height: 3, background: "#e0f2fe", overflow: "hidden" },
  loadingFill: { height: "100%", width: "60%", background: "#0891b2" },
  editBanner: { background: "#fffbeb", borderBottom: "1px solid #fcd34d", padding: "8px 16px", fontSize: 13, color: "#92400e", fontWeight: 600 },
  content: { padding: "8px 10px 48px" },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 3 },
  dowHeader: { textAlign: "center", fontSize: 13, padding: "6px 0", fontWeight: 700 },
  emptyCell: { minHeight: 80 },
  cell: { background: "#fff", borderRadius: 8, padding: "7px 6px", minHeight: 80, cursor: "pointer", border: "1.5px solid #e2e8f0", transition: "border-color 0.15s, box-shadow 0.15s", position: "relative", overflow: "hidden", boxShadow: "0 1px 2px #0001" },
  cellWG: { background: "#eff6ff", borderColor: "#bfdbfe" },
  cellFri: { background: "#fffbeb", borderColor: "#fde68a" },
  cellHoliday: { background: "#fff1f2", borderColor: "#fecdd3" },
  cellToday: { borderColor: "#0891b2", boxShadow: "0 0 0 2px #0891b230" },
  cellSelected: { borderColor: "#0891b2", background: "#e0f2fe" },
  cellEditMode: { cursor: "default", borderColor: "#fcd34d" },
  cellDay: { fontSize: 15, fontWeight: 800, lineHeight: 1.2 },
  cellDow: { fontSize: 10, color: "#94a3b8", marginBottom: 2 },
  lockIcon: { fontSize: 10, lineHeight: 1 },
  holidayLabel: { fontSize: 10, color: "#dc2626", fontWeight: 700, background: "#ffe4e6", borderRadius: 4, padding: "1px 4px", display: "inline-block", marginBottom: 2 },
  cellMembers: { display: "flex", flexWrap: "wrap", gap: 3 },
  chip: { fontSize: 11, padding: "2px 7px", borderRadius: 8, fontWeight: 600, lineHeight: 1.5, display: "inline-flex", alignItems: "center", gap: 2 },
  chipEditable: { cursor: "pointer", outline: "none" },
  chipRemove: { fontSize: 9, opacity: 0.7 },
  chipAdd: { fontSize: 10, padding: "2px 6px", borderRadius: 8, fontWeight: 600, background: "#f0fdf4", color: "#16a34a", border: "1.5px dashed #86efac", cursor: "pointer", lineHeight: 1.5 },
  leaveHint: { position: "absolute", top: 4, right: 4, fontSize: 10, color: "#dc2626", fontWeight: 700 },
  panel: { marginTop: 10, background: "#fff", border: "1.5px solid #bae6fd", borderRadius: 12, padding: "14px 16px", boxShadow: "0 2px 12px #0891b210" },
  panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  panelTitle: { fontWeight: 800, fontSize: 16, color: "#0891b2", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  panelBadgeWG: { fontSize: 12, background: "#eff6ff", color: "#2563eb", padding: "2px 8px", borderRadius: 10, fontWeight: 600 },
  panelBadgeLock: { fontSize: 12, background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 10, fontWeight: 600 },
  panelBadgeHol: { fontSize: 12, background: "#fff1f2", color: "#dc2626", padding: "2px 8px", borderRadius: 10, fontWeight: 600 },
  panelClose: { width: 28, height: 28, borderRadius: "50%", border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#94a3b8", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" },
  panelLabel: { fontSize: 13, color: "#64748b", marginBottom: 10, fontWeight: 600 },
  memberRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  memberToggle: { padding: "8px 14px", borderRadius: 20, border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#334155", cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s", display: "flex", alignItems: "center", gap: 5 },
  memberOnLeave: { opacity: 0.3, cursor: "not-allowed" },
  leaveNote: { fontSize: 14, color: "#475569", padding: "10px 4px 6px", fontWeight: 500 },
  statsGrid: { paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 },
  statCard: { background: "#fff", borderRadius: 10, padding: "14px 18px", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", border: "1.5px solid #e2e8f0", boxShadow: "0 1px 3px #0001" },
  statBar: { position: "absolute", left: 0, top: 0, bottom: 0, transition: "width 0.5s" },
  statInfo: { display: "flex", alignItems: "center", gap: 8, flex: 1, position: "relative", flexWrap: "wrap" },
  statName: { fontWeight: 700, fontSize: 15, color: "#0f172a" },
  statCount: { fontWeight: 800, fontSize: 18, position: "relative" },
  statsNote: { textAlign: "center", fontSize: 13, color: "#94a3b8", marginTop: 16 },
  roleTag: { fontSize: 11, padding: "2px 7px", borderRadius: 6, fontWeight: 600, display: "inline-block" },
  modalOverlay: { position: "fixed", inset: 0, background: "#00000066", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" },
  modalBox: { background: "#fff", borderRadius: 16, padding: 24, border: "1px solid #e2e8f0", minWidth: 300, maxWidth: "90vw", boxShadow: "0 8px 32px #0002" },
  modalTitle: { fontWeight: 800, fontSize: 18, marginBottom: 16, color: "#0891b2" },
  modalGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  memberPickBtn: { padding: "10px 12px", borderRadius: 10, background: "#f8fafc", color: "#1e293b", border: "1.5px solid #e2e8f0", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", transition: "background 0.15s" },
  pickName: { fontWeight: 700, fontSize: 14, flex: 1 },
  authInput: { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1.5px solid #cbd5e1", fontSize: 15, outline: "none", boxSizing: "border-box" },
  authError: { fontSize: 13, color: "#dc2626", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px" },
  authHint: { fontSize: 13, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", marginBottom: 12 },
  authSwitchBtn: { background: "none", border: "none", color: "#0891b2", cursor: "pointer", fontSize: 13, textDecoration: "underline", textAlign: "center" },
  adminTabs: { display: "flex", gap: 4, marginBottom: 16 },
  adminTabBtn: { padding: "8px 18px", borderRadius: 20, border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#64748b", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  adminTabActive: { background: "#e0f2fe", color: "#0891b2", borderColor: "#bae6fd" },
  adminSection: { background: "#fff", borderRadius: 12, padding: 16, border: "1.5px solid #e2e8f0" },
  sectionTitle: { fontWeight: 800, fontSize: 16, color: "#1e293b", marginBottom: 12 },
  memberCard: { background: "#f8fafc", borderRadius: 10, padding: "12px 14px", border: "1.5px solid #e2e8f0", marginBottom: 8 },
  formBox: { background: "#f1f5f9", borderRadius: 10, padding: 14, border: "1.5px solid #e2e8f0", marginBottom: 12 },
  formRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  formLabel: { fontSize: 13, fontWeight: 600, color: "#475569", minWidth: 44 },
  formInput: { flex: 1, padding: "7px 10px", borderRadius: 8, border: "1.5px solid #cbd5e1", fontSize: 14, background: "#fff", color: "#1e293b", outline: "none" },
  formSelect: { flex: 1, padding: "7px 10px", borderRadius: 8, border: "1.5px solid #cbd5e1", fontSize: 14, background: "#fff", color: "#1e293b", outline: "none" },
  ruleSection: { borderBottom: "1px solid #e2e8f0", marginBottom: 14, paddingBottom: 14 },
  ruleSectionTitle: { fontWeight: 700, fontSize: 14, color: "#0891b2", marginBottom: 10 },
  ruleRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 },
  ruleLabel: { fontSize: 13, color: "#475569", minWidth: 120 },
  ruleValue: { fontWeight: 700, fontSize: 15, color: "#1e293b" },
  ruleUnit: { fontSize: 13, color: "#64748b", whiteSpace: "nowrap" },
  btnPrimary: { padding: "8px 16px", background: "#0891b2", color: "#fff", border: "none", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 13 },
  btnSecondary: { padding: "8px 16px", background: "#f1f5f9", color: "#475569", border: "1.5px solid #e2e8f0", borderRadius: 20, fontWeight: 600, cursor: "pointer", fontSize: 13 },
  btnSmall: { padding: "5px 12px", background: "#f8fafc", color: "#334155", border: "1.5px solid #e2e8f0", borderRadius: 16, fontWeight: 600, cursor: "pointer", fontSize: 12 },
};
