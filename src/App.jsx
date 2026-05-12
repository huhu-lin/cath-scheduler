import { useState, useEffect, useCallback } from "react";
import { supabase, dbFetchMembers, dbFetchSchedule, dbFetchLeave, dbFetchHolidays, dbFetchRules, dbFetchPairs } from "./lib/db.js";
import { autoGenerate, getDaysInMonth, getDow, isWeekend, isFriday } from "./lib/scheduler.js";
import { ROLES, ROLE_LABELS, ROLE_COLORS, DEFAULT_COLORS, ROLE_ORDER, DEFAULT_RULES, DOW_LABELS, MONTH_NAMES } from "./lib/constants.js";
import { S } from "./styles.js";
import MemberForm from "./components/MemberForm.jsx";

// ── Main component ───────────────────────────────────────────
export default function CathScheduler() {
  const today = new Date();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  const [year, setYear]     = useState(today.getFullYear());
  const [month, setMonth]   = useState(today.getMonth());
  const [members, setMembers]       = useState([]);
  const [schedule, setSchedule]     = useState({});
  const [leaveMap, setLeaveMap]     = useState({});
  const [lockedDays, setLockedDays] = useState(new Set());
  const [manualSchedule, setManualSchedule] = useState({});
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

  // Auto-generate confirm
  const [showGenConfirm, setShowGenConfirm] = useState(false);
  const [genConfirmUseRandom, setGenConfirmUseRandom] = useState(false);

  // Pairs
  const [pairs, setPairs]             = useState([]);
  const [newPair, setNewPair]         = useState({ a: "", b: "" });
  const [pairSaving, setPairSaving]   = useState(false);

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
      const [mData, { schedule: sData, lockedDays: ld, manualSchedule: ms }, lData, hData, rData, pData] = await Promise.all([
        dbFetchMembers(),
        dbFetchSchedule(year, month),
        dbFetchLeave(year, month),
        dbFetchHolidays(year),
        dbFetchRules(),
        dbFetchPairs(),
      ]);
      setMembers(mData); setSchedule(sData); setLockedDays(ld); setManualSchedule(ms);
      setLeaveMap(lData); setHolidays(hData); setRules(rData); setPairs(pData);
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
        const d = parseInt(day);
        const manualSet = new Set(manualSchedule[d] || []);
        for (const member_id of ids) {
          if (!manualSet.has(member_id))
            rows.push({ year, month, day: d, member_id, manually_set: false });
        }
      }
      if (rows.length > 0) {
        const { error } = await supabase.from("schedules").insert(rows);
        if (error) throw error;
      }
      setSchedule(newSched);
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
        setSchedule(prev => ({ ...prev, [day]: arr.filter(x => x !== memberId) }));
        const newManual = (manualSchedule[day] || []).filter(x => x !== memberId);
        setManualSchedule(prev => ({ ...prev, [day]: newManual }));
        if (newManual.length === 0)
          setLockedDays(prev => { const s = new Set(prev); s.delete(day); return s; });
      } else {
        const { error } = await supabase.from("schedules").insert({ year, month, day, member_id: memberId, manually_set: true });
        if (error) throw error;
        setSchedule(prev => ({ ...prev, [day]: [...arr, memberId] }));
        setManualSchedule(prev => ({ ...prev, [day]: [...(prev[day] || []), memberId] }));
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

  function handleAutoGenerate(useRandom = false) {
    const holidayDays = new Set(
      holidays.filter(h => h.year === year && h.month === month + 1).map(h => h.day)
    );
    const gen = autoGenerate(year, month, members, leaveMap, schedule, lockedDays, holidayDays, rules, pairs, manualSchedule, useRandom);
    saveFullSchedule(gen);
  }

  // ── Doctor quick-fill ────────────────────────────────────────
  const [doctorFillOpen, setDoctorFillOpen] = useState(false);
  const [doctorFillDraft, setDoctorFillDraft] = useState({});
  const [leaveSelectedDay, setLeaveSelectedDay] = useState(null);

  function openDoctorFill() {
    const doctorIds = new Set(members.filter(m => m.role === "doctor").map(m => m.id));
    const draft = {};
    for (let d = 1; d <= getDaysInMonth(year, month); d++) {
      const docInDay = (schedule[d] || []).find(id => doctorIds.has(id));
      draft[d] = docInDay || "";
    }
    setDoctorFillDraft(draft);
    setDoctorFillOpen(true);
  }

  async function saveDoctorFill() {
    setSaving(true);
    try {
      const doctorIds = [...members.filter(m => m.role === "doctor").map(m => m.id)];
      if (doctorIds.length > 0) {
        const { error } = await supabase.from("schedules").delete()
          .eq("year", year).eq("month", month).in("member_id", doctorIds);
        if (error) throw error;
      }
      const rows = Object.entries(doctorFillDraft)
        .filter(([, id]) => id)
        .map(([day, member_id]) => ({ year, month, day: parseInt(day), member_id, manually_set: true }));
      if (rows.length > 0) {
        const { error } = await supabase.from("schedules").insert(rows);
        if (error) throw error;
      }
      // Update local state
      const docSet = new Set(doctorIds);
      const newSched = {};
      const newManual = {};
      const newLocked = new Set();
      for (let d = 1; d <= getDaysInMonth(year, month); d++) {
        newSched[d] = (schedule[d] || []).filter(id => !docSet.has(id));
        newManual[d] = (manualSchedule[d] || []).filter(id => !docSet.has(id));
      }
      for (const [day, memberId] of Object.entries(doctorFillDraft)) {
        const d = parseInt(day);
        if (memberId) {
          newSched[d] = [...(newSched[d] || []), memberId];
          newManual[d] = [...(newManual[d] || []), memberId];
        }
      }
      for (let d = 1; d <= getDaysInMonth(year, month); d++) {
        if ((newManual[d] || []).length > 0) newLocked.add(d);
      }
      // Preserve existing locked days for non-doctor manual assignments
      lockedDays.forEach(d => {
        if ((manualSchedule[d] || []).some(id => !docSet.has(id))) newLocked.add(d);
      });
      setSchedule(newSched);
      setManualSchedule(newManual);
      setLockedDays(newLocked);
      setDoctorFillOpen(false);
      notify("✅ 醫師班已儲存");
    } catch (e) { notify("❌ 儲存失敗：" + e.message, "err"); }
    setSaving(false);
  }

  async function handleClearSchedule() {
    if (!window.confirm(`確定要清除 ${year}年${month + 1}月 所有排班（包含手動鎖定）？`)) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("schedules").delete().eq("year", year).eq("month", month);
      if (error) throw error;
      setSchedule({});
      setLockedDays(new Set());
      setManualSchedule({});
      notify("🗑️ 班表已清除");
    } catch (e) { notify("❌ 清除失敗：" + e.message, "err"); }
    setSaving(false);
  }

  // ── Member CRUD ─────────────────────────────────────────────
  async function saveMember(m) {
    setMemberSaving(true);
    try {
      if (m.id) {
        const { error } = await supabase.from("members").update({
          name: m.name, role: m.role, phone: m.phone || "", email: m.email || "",
          color: m.color, is_admin: !!m.is_admin,
        }).eq("id", m.id);
        if (error) throw error;
        setMembers(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x));
        if (currentUser?.id === m.id) setCurrentUser(prev => ({ ...prev, ...m }));
      } else {
        const newId = Math.random().toString(36).slice(2, 10);
        const maxOrder = members.reduce((max, x) => Math.max(max, x.sort_order || 0), 0);
        const { data, error } = await supabase.from("members").insert({
          id: newId, name: m.name, role: m.role, phone: m.phone || "", email: m.email || "",
          color: m.color, is_admin: !!m.is_admin,
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

  // ── Pair CRUD ────────────────────────────────────────────────
  async function addPair() {
    const { a, b } = newPair;
    if (!a || !b || a === b) { notify("請選擇兩位不同的成員", "err"); return; }
    const id1 = a < b ? a : b;
    const id2 = a < b ? b : a;
    if (pairs.some(p => p.member_id_1 === id1 && p.member_id_2 === id2)) {
      notify("此配對已存在", "err"); return;
    }
    setPairSaving(true);
    try {
      const { data, error } = await supabase.from("member_pairs")
        .insert({ member_id_1: id1, member_id_2: id2 }).select().single();
      if (error) throw error;
      setPairs(prev => [...prev, data]);
      setNewPair({ a: "", b: "" });
      notify("✅ 配對已新增");
    } catch (e) { notify("❌ 新增失敗：" + e.message, "err"); }
    setPairSaving(false);
  }

  async function deletePair(id) {
    try {
      const { error } = await supabase.from("member_pairs").delete().eq("id", id);
      if (error) throw error;
      setPairs(prev => prev.filter(p => p.id !== id));
      notify("🗑️ 配對已刪除");
    } catch (e) { notify("❌ 刪除失敗：" + e.message, "err"); }
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
      <header style={{ ...S.header, padding: isMobile ? "10px 12px" : "14px 20px" }}>
        <div style={S.headerLeft}>
          <span style={{ ...S.logo, fontSize: isMobile ? 26 : 34 }}>🫀</span>
          <div>
            <div style={{ ...S.title, fontSize: isMobile ? 16 : 20 }}>心導管室 On-Call</div>
            {!isMobile && <div style={S.subtitle}>排班系統</div>}
          </div>
        </div>
        <div style={S.headerRight}>
          {saving && <span style={S.savingTxt}>⟳ 儲存中...</span>}
          {session ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={S.userInfo}>
                {currentUser && <span style={{ ...S.dot, background: ROLE_COLORS[currentUser.role] }} />}
                <span style={S.userName}>{currentUser?.name ?? session.user.email}</span>
                <span style={S.adminBadge}>管理員</span>
              </div>
              <button style={S.logoutBtn} onClick={handleLogout}>登出</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button style={S.userBtn} onClick={() => setShowUserPicker(true)}>
                {currentUser ? <><span style={{ ...S.dot, background: ROLE_COLORS[currentUser.role] }} />{currentUser.name}</> : "選擇身份"}
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
                <button key={m.id} style={{ ...S.memberPickBtn, borderColor: ROLE_COLORS[m.role] + "80" }}
                  onClick={() => { setCurrentUser(m); setShowUserPicker(false); }}>
                  <span style={{ ...S.dot, background: ROLE_COLORS[m.role] }} />
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
            <button style={S.genBtn} onClick={() => { setGenConfirmUseRandom(false); setShowGenConfirm(true); }} disabled={saving || loading} title="自動排班">
              {isMobile ? "⚡" : "⚡ 自動排班"}
            </button>
            <button style={S.regenBtn} onClick={() => { setGenConfirmUseRandom(true); setShowGenConfirm(true); }} disabled={saving || loading} title="重新產生一份不同的班表">
              {isMobile ? "🔀" : "🔀 重新排班"}
            </button>
            <button style={S.docFillBtn} onClick={openDoctorFill} disabled={saving || loading} title="填醫師班">
              {isMobile ? "👨‍⚕️" : "👨‍⚕️ 填醫師班"}
            </button>
            <button style={{ ...S.editToggleBtn, ...(editMode ? S.editToggleBtnActive : {}) }}
              onClick={() => { setEditMode(e => !e); setSelectedDay(null); }}
              title={editMode ? "完成編輯" : "手動調整"}>
              {isMobile ? (editMode ? "✓" : "✏️") : `✏️ ${editMode ? "完成編輯" : "手動調整"}`}
            </button>
            <button style={S.clearBtn} onClick={handleClearSchedule} disabled={saving || loading} title="清除">
              {isMobile ? "🗑️" : "🗑️ 清除"}
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
        <div style={{ ...S.content, padding: isMobile ? "6px 4px 60px" : "8px 10px 48px" }}>
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
                  style={{ ...S.cell, ...(wg ? S.cellWG : {}), ...(fri ? S.cellFri : {}), ...(holName ? S.cellHoliday : {}), ...(isToday(d) ? S.cellToday : {}), ...(isSelected && !editMode ? S.cellSelected : {}), ...(editMode ? S.cellEditMode : {}), ...(isMobile ? { minHeight: 58, padding: "4px 3px" } : {}) }}
                  onClick={() => { if (!editMode) setSelectedDay(isSelected ? null : d); }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <div style={{ ...S.cellDay, fontSize: isMobile ? 12 : 15, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>{d}</div>
                    {isLocked && <span title="手動排定" style={S.lockIcon}>🔒</span>}
                  </div>
                  {!isMobile && <div style={S.cellDow}>{DOW_LABELS[dow]}{wg ? " 🌙" : fri ? " ★" : ""}</div>}
                  {holName && <div style={{ ...S.holidayLabel, fontSize: isMobile ? 9 : 10 }}>{isMobile ? holName.slice(0, 2) : holName}</div>}
                  <div style={S.cellMembers}>
                    {[...assigned].sort((a, b) => (ROLE_ORDER[getMember(a)?.role] ?? 9) - (ROLE_ORDER[getMember(b)?.role] ?? 9)).map(id => {
                      const mbr = getMember(id);
                      if (!mbr) return null;
                      return (
                        <span key={id}
                          style={{ ...S.chip, ...(isMobile ? { fontSize: 9, padding: "1px 3px", borderRadius: 5 } : {}), background: ROLE_COLORS[mbr.role] + "22", color: ROLE_COLORS[mbr.role], border: `1.5px solid ${ROLE_COLORS[mbr.role]}55`, ...(editMode && isAdmin ? S.chipEditable : {}) }}
                          onClick={editMode && isAdmin ? (e) => { e.stopPropagation(); toggleAssign(d, id); } : undefined}
                          title={editMode && isAdmin ? "點擊移除" : mbr.name}>
                          {editMode && isAdmin && <span style={S.chipRemove}>✕ </span>}
                          {isMobile ? mbr.name.slice(-2) : mbr.name}
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

        </div>
      )}

      {/* ── Day detail modal (all users, non-edit) ── */}
      {selectedDay && !editMode && (
        <div style={S.modalOverlay} onClick={() => setSelectedDay(null)}>
          <div style={{ ...S.modalBox, maxWidth: 480, width: "94vw", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={S.panelHeader}>
              <div style={S.panelTitle}>
                {month + 1}/{selectedDay}（{DOW_LABELS[getDow(year, month, selectedDay)]}）
                {isWeekend(getDow(year, month, selectedDay)) && <span style={S.panelBadgeWG}>🌙 週末</span>}
                {lockedDays.has(selectedDay) && <span style={S.panelBadgeLock}>🔒 已鎖定</span>}
                {holidayMap[selectedDay] && <span style={S.panelBadgeHol}>🎌 {holidayMap[selectedDay]}</span>}
              </div>
              <button style={S.panelClose} onClick={() => setSelectedDay(null)}>✕</button>
            </div>

            <div style={S.panelLabel}>📋 今日 On-Call</div>
            {(schedule[selectedDay] || []).length === 0
              ? <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 12 }}>尚未排班</div>
              : (
                <div style={S.oncallList}>
                  {[...(schedule[selectedDay] || [])].sort((a, b) => (ROLE_ORDER[getMember(a)?.role] ?? 9) - (ROLE_ORDER[getMember(b)?.role] ?? 9)).map(id => {
                    const mbr = getMember(id);
                    if (!mbr) return null;
                    const color = ROLE_COLORS[mbr.role];
                    return (
                      <div key={id} style={{ ...S.oncallCard, borderLeftColor: color }}>
                        <div style={S.oncallCardLeft}>
                          <span style={{ ...S.roleTag, background: color + "18", color }}>{ROLE_LABELS[mbr.role]}</span>
                          <span style={{ fontWeight: 700, fontSize: 15, color: "#1e293b" }}>{mbr.name}</span>
                        </div>
                        {mbr.phone ? (
                          <a href={`tel:${mbr.phone}`} style={{ ...S.phoneBtn, borderColor: color + "60", color }}>
                            📞 {mbr.phone}
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: "#cbd5e1" }}>無電話</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

            {isAdmin && (
              <>
                <div style={{ ...S.panelLabel, marginTop: 14, borderTop: "1px solid #e2e8f0", paddingTop: 14 }}>
                  ✏️ 編輯值班人員
                </div>
                <div style={S.memberRow}>
                  {members.map(mbr => {
                    const on = (schedule[selectedDay] || []).includes(mbr.id);
                    const lv = (leaveMap[selectedDay] || []).includes(mbr.id);
                    return (
                      <button key={mbr.id} disabled={lv || saving} title={lv ? "請假中" : on ? "點擊移除" : "點擊加入"}
                        style={{ ...S.memberToggle, ...(on ? { background: ROLE_COLORS[mbr.role], color: "#fff", borderColor: ROLE_COLORS[mbr.role], boxShadow: `0 2px 8px ${ROLE_COLORS[mbr.role]}50` } : {}), ...(lv ? S.memberOnLeave : {}) }}
                        onClick={() => !lv && !saving && toggleAssign(selectedDay, mbr.id)}>
                        <span>{lv ? "🚫" : on ? "✓ " : "+ "}</span>
                        <span>{mbr.name}</span>
                        <span style={{ ...S.roleTag, background: on ? "#fff3" : ROLE_COLORS[mbr.role] + "18", color: on ? "#fff" : ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Edit mode add-member modal ── */}
      {selectedDay && editMode && isAdmin && (
        <div style={S.modalOverlay} onClick={() => setSelectedDay(null)}>
          <div style={{ ...S.modalBox, maxWidth: 420, width: "94vw" }} onClick={e => e.stopPropagation()}>
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
        </div>
      )}

      {/* ── Auto-generate confirm modal ── */}
      {showGenConfirm && (
        <div style={S.modalOverlay} onClick={() => setShowGenConfirm(false)}>
          <div style={{ ...S.modalBox, maxWidth: 420, width: "94vw" }} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>
              {genConfirmUseRandom ? "🔀 確認重新排班" : "⚡ 確認自動排班"}
            </div>
            <div style={{ background: "#fef3c7", border: "1.5px solid #fcd34d", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 14, color: "#92400e", lineHeight: 1.6 }}>
              ⚠️ 此操作將覆蓋 <strong>{year} 年 {month + 1} 月</strong> 現有的排班內容（手動鎖定的日期除外）。<br />
              {Object.values(schedule).some(arr => arr.length > 0)
                ? `目前已有排班資料，執行後將被新班表取代。`
                : "目前尚無排班資料，將產生全新班表。"}
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
              {lockedDays.size > 0
                ? `🔒 已手動鎖定 ${lockedDays.size} 天，這些日期不受影響。`
                : "目前沒有手動鎖定的日期。"}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={S.btnSecondary} onClick={() => setShowGenConfirm(false)}>取消</button>
              <button
                style={{ ...S.btnPrimary, background: genConfirmUseRandom ? "#7c3aed" : "#0891b2" }}
                onClick={() => { setShowGenConfirm(false); handleAutoGenerate(genConfirmUseRandom); }}>
                {genConfirmUseRandom ? "🔀 確定重新排班" : "⚡ 確定自動排班"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Doctor quick-fill modal ── */}
      {doctorFillOpen && isAdmin && (
        <div style={S.modalOverlay} onClick={() => setDoctorFillOpen(false)}>
          <div style={{ ...S.modalBox, maxWidth: 480, width: "94vw", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <span style={S.modalTitle}>👨‍⚕️ 醫師快速填班 — {year}年{month + 1}月</span>
              <button style={S.modalClose} onClick={() => setDoctorFillOpen(false)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>逐日選擇值班醫師，儲存後醫師班次將鎖定（不受自動排班影響）。</div>
            {Array.from({ length: getDaysInMonth(year, month) }, (_, i) => i + 1).map(d => {
              const dow = getDow(year, month, d);
              const holName = holidays.find(h => h.year === year && h.month === month + 1 && h.day === d)?.name;
              const doctors = members.filter(m => m.role === "doctor");
              return (
                <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>
                    {month + 1}/{d} {DOW_LABELS[dow]}
                  </span>
                  {holName && <span style={{ fontSize: 11, color: "#dc2626", flexShrink: 0 }}>{holName}</span>}
                  <select
                    style={{ flex: 1, padding: "4px 8px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, background: doctorFillDraft[d] ? "#f0fdf4" : "#fff" }}
                    value={doctorFillDraft[d] || ""}
                    onChange={e => setDoctorFillDraft(prev => ({ ...prev, [d]: e.target.value }))}>
                    <option value="">— 未排 —</option>
                    {doctors.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button style={S.btnPrimary} onClick={saveDoctorFill} disabled={saving}>💾 儲存</button>
              <button style={{ ...S.btnPrimary, background: "#64748b" }} onClick={() => setDoctorFillOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Leave ── */}
      {view === "leave" && (
        <div style={{ ...S.content, padding: isMobile ? "6px 4px 60px" : "8px 10px 48px" }}>
          <div style={S.leaveNote}>
            {isAdmin ? "管理員模式：可幫任何人預假／取消" : currentUser ? `身份：${currentUser.name}　點擊自己的名字來預假 / 取消` : "⬆ 請先點右上角「選擇身份」，再操作預假"}
          </div>
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
              const isSelDay = leaveSelectedDay === d;
              return (
                <div key={d}
                  style={{ ...S.cell, ...(isToday(d) ? S.cellToday : {}), ...(holName ? S.cellHoliday : {}), ...(isSelDay ? S.cellSelected : {}), minHeight: isMobile ? 60 : 88, ...(isMobile ? { padding: "4px 3px", cursor: "pointer" } : {}) }}
                  onClick={() => isMobile && setLeaveSelectedDay(isSelDay ? null : d)}>
                  <div style={{ ...S.cellDay, fontSize: isMobile ? 12 : 15, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>{d}</div>
                  {!isMobile && <div style={S.cellDow}>{DOW_LABELS[dow]}</div>}
                  {holName && <div style={{ ...S.holidayLabel, fontSize: isMobile ? 9 : 10 }}>{isMobile ? holName.slice(0, 2) : holName}</div>}
                  {isMobile ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
                      {leaves.map(id => {
                        const mbr = getMember(id);
                        if (!mbr) return null;
                        return <span key={id} style={{ ...S.dot, width: 7, height: 7, background: ROLE_COLORS[mbr.role] }} title={mbr.name} />;
                      })}
                    </div>
                  ) : (
                    <div style={S.cellMembers}>
                      {members.map(mbr => {
                        const onLeave = leaves.includes(mbr.id);
                        const canEdit = isAdmin || currentUser?.id === mbr.id;
                        return (
                          <span key={mbr.id} onClick={() => canEdit && toggleLeave(d, mbr.id)}
                            title={`${mbr.name}：${canEdit ? "點擊預假/取消" : "無權限"}`}
                            style={{ ...S.chip, background: onLeave ? "#fee2e2" : "#f1f5f9", color: onLeave ? "#dc2626" : canEdit ? "#334155" : "#94a3b8", border: `1.5px solid ${onLeave ? "#fca5a5" : canEdit ? "#cbd5e1" : "#e2e8f0"}`, cursor: canEdit ? "pointer" : "default", opacity: canEdit || !currentUser ? 1 : 0.45, fontWeight: canEdit ? 700 : 400 }}>
                            {onLeave ? "🚫 " : ""}{mbr.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Mobile leave day panel */}
          {isMobile && leaveSelectedDay && (
            <div style={{ ...S.panel, marginTop: 10 }}>
              <div style={S.panelHeader}>
                <div style={S.panelTitle}>{leaveSelectedDay} 日　預假</div>
                <button style={S.panelClose} onClick={() => setLeaveSelectedDay(null)}>✕</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {members.map(mbr => {
                  const onLeave = (leaveMap[leaveSelectedDay] || []).includes(mbr.id);
                  const canEdit = isAdmin || currentUser?.id === mbr.id;
                  return (
                    <div key={mbr.id} style={{ ...S.oncallCard, borderLeftColor: ROLE_COLORS[mbr.role], opacity: canEdit ? 1 : 0.5 }}>
                      <div style={S.oncallCardLeft}>
                        <span style={{ ...S.dot, background: ROLE_COLORS[mbr.role], width: 10, height: 10 }} />
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{mbr.name}</span>
                        <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                        {onLeave && <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 700 }}>🚫 請假中</span>}
                      </div>
                      {canEdit && (
                        <button
                          style={{ padding: "6px 14px", borderRadius: 16, border: `1.5px solid ${onLeave ? "#fca5a5" : "#86efac"}`, background: onLeave ? "#fee2e2" : "#f0fdf4", color: onLeave ? "#dc2626" : "#16a34a", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                          onClick={() => toggleLeave(leaveSelectedDay, mbr.id)}>
                          {onLeave ? "取消請假" : "請假"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Stats ── */}
      {view === "stats" && (
        <div style={{ ...S.content, padding: isMobile ? "6px 4px 60px" : "8px 10px 48px" }}>
          <div style={S.statsGrid}>
            {members.map(mbr => {
              const cnt = callCount[mbr.id] || 0;
              const max = Math.max(...Object.values(callCount), 1);
              return (
                <div key={mbr.id} style={S.statCard}>
                  <div style={{ ...S.statBar, width: `${(cnt / max) * 100}%`, background: ROLE_COLORS[mbr.role] + "28" }} />
                  <div style={S.statInfo}>
                    <span style={{ ...S.dot, background: ROLE_COLORS[mbr.role], width: 14, height: 14 }} />
                    <span style={S.statName}>{mbr.name}</span>
                    <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>{ROLE_LABELS[mbr.role]}</span>
                  </div>
                  <div style={{ ...S.statCount, color: ROLE_COLORS[mbr.role] }}>{cnt} 次</div>
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
        <div style={{ ...S.content, padding: isMobile ? "6px 4px 60px" : "8px 10px 48px" }}>
          <div style={S.adminTabs}>
            {[["members","👥 人員管理"],["rules","📋 排班規則"],["pairs","🤝 偏好配對"],["holidays","🎌 國定假日"]].map(([t, l]) => (
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
                    name: "", role: "nurse", phone: "", email: "",
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
                      <span style={{ ...S.dot, background: ROLE_COLORS[m.role], width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 60 }}>{m.name}</span>
                      <span style={{ ...S.roleTag, background: ROLE_COLORS[m.role] + "18", color: ROLE_COLORS[m.role] }}>{ROLE_LABELS[m.role]}</span>
                      {m.is_admin && <span style={S.adminBadge}>管理員</span>}
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
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>📆 平日規則（週一至週五）</div>
                    <div style={S.formRow}>
                      <label style={S.formLabel}>放射師＋護理師</label>
                      <input style={{ ...S.formInput, maxWidth: 64 }} type="number" min="0" max="10"
                        value={editingRules.weekday_rad_nurse}
                        onChange={e => setEditingRules(r => ({ ...r, weekday_rad_nurse: parseInt(e.target.value) || 0 }))} />
                      <span style={S.ruleUnit}>位（合計）</span>
                    </div>
                  </div>

                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🌙 假日／週末規則</div>
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
                <div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>📆 平日規則</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>放射師＋護理師合計</span><span style={S.ruleValue}>{rules.weekday_rad_nurse} 位</span></div>
                  </div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🌙 假日／週末規則</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>放射師</span><span style={S.ruleValue}>{rules.weekend_radiologist} 位</span></div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>護理師</span><span style={S.ruleValue}>{rules.weekend_nurse} 位</span></div>
                  </div>
                  <div style={S.ruleSection}>
                    <div style={S.ruleSectionTitle}>🔁 連續值班限制</div>
                    <div style={S.ruleRow}><span style={S.ruleLabel}>最長連續值班</span><span style={S.ruleValue}>{rules.max_consecutive} 天</span></div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>＊國定假日與週末不計入連續天數</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pairs tab */}
          {adminTab === "pairs" && (
            <div style={S.adminSection}>
              <div style={S.sectionTitle}>偏好配對設定</div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
                配對的兩位成員在自動排班時會被優先安排在同一天值班。
              </div>

              <div style={{ ...S.formBox, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={S.formLabel}>成員 A</div>
                  <select style={S.formSelect} value={newPair.a}
                    onChange={e => setNewPair(p => ({ ...p, a: e.target.value }))}>
                    <option value="">— 選擇 —</option>
                    {members.map(m => (
                      <option key={m.id} value={m.id}>{m.name}（{ROLE_LABELS[m.role]}）</option>
                    ))}
                  </select>
                </div>
                <div style={{ fontSize: 20, paddingBottom: 6, color: "#94a3b8" }}>↔</div>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={S.formLabel}>成員 B</div>
                  <select style={S.formSelect} value={newPair.b}
                    onChange={e => setNewPair(p => ({ ...p, b: e.target.value }))}>
                    <option value="">— 選擇 —</option>
                    {members.filter(m => m.id !== newPair.a).map(m => (
                      <option key={m.id} value={m.id}>{m.name}（{ROLE_LABELS[m.role]}）</option>
                    ))}
                  </select>
                </div>
                <button style={S.btnPrimary} onClick={addPair} disabled={pairSaving || !newPair.a || !newPair.b}>
                  {pairSaving ? "新增中…" : "+ 新增配對"}
                </button>
              </div>

              {pairs.length === 0 && (
                <div style={{ color: "#94a3b8", fontSize: 14, padding: "12px 0" }}>尚未設定任何偏好配對</div>
              )}
              {pairs.map(p => {
                const m1 = getMember(p.member_id_1);
                const m2 = getMember(p.member_id_2);
                if (!m1 || !m2) return null;
                return (
                  <div key={p.id} style={{ ...S.memberCard, display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ ...S.dot, background: ROLE_COLORS[m1.role], width: 10, height: 10 }} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{m1.name}</span>
                    <span style={{ ...S.roleTag, background: ROLE_COLORS[m1.role] + "18", color: ROLE_COLORS[m1.role] }}>{ROLE_LABELS[m1.role]}</span>
                    <span style={{ color: "#94a3b8", fontSize: 18 }}>↔</span>
                    <span style={{ ...S.dot, background: ROLE_COLORS[m2.role], width: 10, height: 10 }} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{m2.name}</span>
                    <span style={{ ...S.roleTag, background: ROLE_COLORS[m2.role] + "18", color: ROLE_COLORS[m2.role] }}>{ROLE_LABELS[m2.role]}</span>
                    <button style={{ ...S.btnSmall, marginLeft: "auto", color: "#dc2626", borderColor: "#fca5a5" }}
                      onClick={() => deletePair(p.id)}>刪除</button>
                  </div>
                );
              })}
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
