import { useState, useEffect, useCallback } from "react";

// ══════════════════════════════════════════════════════════
//  ⚙️  設定區 — 部署後把 Apps Script URL 貼在這裡
// ══════════════════════════════════════════════════════════
const API_URL = "https://script.google.com/macros/s/AKfycbwg4QbKaFrieG_71BwF0ZiiBdprVDwfMhlF286eNT5fz1m_cRxY5xjhlWD7YjiGZ5lBTg/exe";

// ─── Scheduling Logic ──────────────────────────────────────
const WEEKDAY_SLOTS = 2;
const WEEKEND_SLOTS = 3;
const MAX_CONSEC = 2;

function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getDow(y, m, d) { return new Date(y, m, d).getDay(); }
function isWG(dow) { return dow === 4 || dow === 5 || dow === 6 || dow === 0; }
function slots(dow) { return isWG(dow) ? WEEKEND_SLOTS : WEEKDAY_SLOTS; }

function getStreak(sched, day, id, y, m) {
  let s = 0;
  for (let d = day - 1; d >= 1; d--) {
    const dow = getDow(y, m, d);
    if (isWG(dow)) break;
    if ((sched[d] || []).includes(id)) s++;
    else break;
  }
  return s;
}

const AFFINITY = [
  { a: "A", b: "B", prefer: true },
  { a: "B", b: "D", prefer: false },
];

function pickGroup(pool, count) {
  if (pool.length <= count) return pool.slice(0, count);
  const result = [], used = new Set();
  for (const p of AFFINITY) {
    if (!p.prefer) continue;
    if (pool.includes(p.a) && pool.includes(p.b) && result.length + 2 <= count) {
      result.push(p.a, p.b); used.add(p.a); used.add(p.b); break;
    }
  }
  for (const id of pool) {
    if (result.length >= count) break;
    if (used.has(id)) continue;
    const bad = AFFINITY.some(p => !p.prefer &&
      ((p.a === id && result.includes(p.b)) || (p.b === id && result.includes(p.a))));
    if (!bad || result.length + 1 === count) { result.push(id); used.add(id); }
  }
  for (const id of pool) {
    if (result.length >= count) break;
    if (!used.has(id)) { result.push(id); used.add(id); }
  }
  return result;
}

function autoGenerate(y, m, members, leave) {
  const days = getDaysInMonth(y, m);
  const sched = {};
  const ids = members.map(x => x.id);
  const cnt = Object.fromEntries(ids.map(id => [id, 0]));
  let wgCache = null;

  for (let d = 1; d <= days; d++) {
    const dow = getDow(y, m, d);
    const sl = slots(dow);
    const lv = leave[d] || [];
    const avail = ids.filter(id => !lv.includes(id));

    if (isWG(dow)) {
      if (dow === 4) wgCache = null;
      if (wgCache && wgCache.every(id => avail.includes(id))) {
        sched[d] = wgCache.slice(0, sl);
      } else {
        const pool = [...avail].sort((a, b) => cnt[a] - cnt[b]);
        sched[d] = pickGroup(pool, sl);
        wgCache = sched[d];
      }
    } else {
      wgCache = null;
      let pool = avail.filter(id => getStreak(sched, d, id, y, m) < MAX_CONSEC);
      if (pool.length < sl) pool = avail;
      pool.sort((a, b) => cnt[a] - cnt[b]);
      sched[d] = pickGroup(pool, sl);
    }
    sched[d].forEach(id => cnt[id]++);
  }
  return sched;
}

// ─── API Layer ─────────────────────────────────────────────
async function apiFetch(params) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  return res.json();
}

async function apiPost(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Color palette for members ─────────────────────────────
const PALETTE = ["#00B5B5","#E05C5C","#E0A05C","#7C5CE0","#5CE07C","#5CB8E0","#E05CB8","#B8E05C","#C0C0C0","#FF9F43","#EE5A24","#009432"];

const DOW_LABELS = ["日","一","二","三","四","五","六"];
const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

// ═══════════════════════════════════════════════════════════
export default function CathScheduler() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [members, setMembers] = useState([]);
  const [schedule, setSchedule] = useState({});
  const [leaveMap, setLeaveMap] = useState({});
  const [view, setView] = useState("calendar");
  const [selectedDay, setSelectedDay] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [showUserPicker, setShowUserPicker] = useState(false);

  const notify = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  // ── Load data ──
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, sRes, lRes] = await Promise.all([
        apiFetch({ action: "getMembers" }),
        apiFetch({ action: "getSchedule", year, month }),
        apiFetch({ action: "getLeave", year, month }),
      ]);
      if (mRes.ok) setMembers(mRes.data);
      if (sRes.ok) setSchedule(sRes.data);
      if (lRes.ok) setLeaveMap(lRes.data);
    } catch {
      notify("⚠️ 無法連線，請確認 API URL 設定", "err");
    }
    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Save schedule ──
  async function saveSchedule(newSched) {
    setSaving(true);
    try {
      const res = await apiPost({ action: "saveSchedule", year, month, schedule: newSched, actor: currentUser?.name || "管理者" });
      if (res.ok) { setSchedule(newSched); notify("✅ 班表已儲存"); }
      else notify("❌ 儲存失敗：" + res.error, "err");
    } catch { notify("❌ 網路錯誤", "err"); }
    setSaving(false);
  }

  // ── Save leave ──
  async function saveLeave(newLeave) {
    setSaving(true);
    try {
      const res = await apiPost({ action: "saveLeave", year, month, leaveMap: newLeave, actor: currentUser?.name || "成員" });
      if (res.ok) { setLeaveMap(newLeave); notify("📅 預假已更新"); }
      else notify("❌ 儲存失敗", "err");
    } catch { notify("❌ 網路錯誤", "err"); }
    setSaving(false);
  }

  function handleAutoGenerate() {
    const gen = autoGenerate(year, month, members, leaveMap);
    saveSchedule(gen);
  }

  function toggleAssign(day, id) {
    const curr = { ...schedule };
    const arr = curr[day] ? [...curr[day]] : [];
    curr[day] = arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
    saveSchedule(curr);
  }

  function toggleLeave(day, id) {
    const curr = { ...leaveMap };
    const arr = curr[day] ? [...curr[day]] : [];
    curr[day] = arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
    // Remove from schedule if on leave
    if (!arr.includes(id)) {
      const s = { ...schedule };
      if (s[day]) s[day] = s[day].filter(x => x !== id);
      setSchedule(s);
    }
    saveLeave(curr);
  }

  function getMember(id) { return members.find(m => m.id === id); }

  // ── Calendar grid ──
  function buildCalendar() {
    const days = getDaysInMonth(year, month);
    const firstDow = getDow(year, month, 1);
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    return cells;
  }

  const cells = buildCalendar();
  const isToday = (d) => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  // ── Stats ──
  const callCount = {};
  members.forEach(m => { callCount[m.id] = 0; });
  Object.values(schedule).forEach(ids => ids.forEach(id => { if (callCount[id] !== undefined) callCount[id]++; }));

  // ─────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* BG grain */}
      <div style={styles.grain} />

      {/* Toast */}
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === "err" ? "#E05C5C" : "#00B5B5" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>🫀</div>
          <div>
            <div style={styles.title}>心導管室 On-Call</div>
            <div style={styles.subtitle}>排班系統</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          {saving && <span style={styles.savingDot}>⟳ 儲存中...</span>}
          <button style={styles.userBtn} onClick={() => setShowUserPicker(true)}>
            {currentUser
              ? <><span style={{ ...styles.dot, background: currentUser.color }} />{currentUser.name}</>
              : "選擇身份"}
          </button>
        </div>
      </header>

      {/* User Picker Modal */}
      {showUserPicker && (
        <div style={styles.modal} onClick={() => setShowUserPicker(false)}>
          <div style={styles.modalBox} onClick={e => e.stopPropagation()}>
            <div style={styles.modalTitle}>你是誰？</div>
            <div style={styles.modalGrid}>
              {members.map(m => (
                <button key={m.id} style={{ ...styles.memberPickBtn, borderColor: m.color }}
                  onClick={() => { setCurrentUser(m); setShowUserPicker(false); }}>
                  <span style={{ ...styles.dot, background: m.color, width: 10, height: 10 }} />
                  {m.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav style={styles.nav}>
        {[["calendar","📅 班表"],["leave","🙋 預假"],["stats","📊 統計"]].map(([v,l]) => (
          <button key={v} style={{ ...styles.navBtn, ...(view === v ? styles.navActive : {}) }}
            onClick={() => { setView(v); setSelectedDay(null); }}>
            {l}
          </button>
        ))}
      </nav>

      {/* Month Navigator */}
      <div style={styles.monthNav}>
        <button style={styles.arrowBtn} onClick={() => {
          if (month === 0) { setYear(y => y - 1); setMonth(11); }
          else setMonth(m => m - 1);
        }}>‹</button>
        <span style={styles.monthLabel}>{year} 年 {MONTH_NAMES[month]}</span>
        <button style={styles.arrowBtn} onClick={() => {
          if (month === 11) { setYear(y => y + 1); setMonth(0); }
          else setMonth(m => m + 1);
        }}>›</button>
        {view === "calendar" && (
          <button style={styles.genBtn} onClick={handleAutoGenerate} disabled={saving}>
            ⚡ 自動排班
          </button>
        )}
        <button style={styles.reloadBtn} onClick={loadAll} disabled={loading}>↺</button>
      </div>

      {loading && <div style={styles.loadingBar}><div style={styles.loadingFill} /></div>}

      {/* ── Calendar View ── */}
      {view === "calendar" && (
        <div style={styles.content}>
          {/* DOW headers */}
          <div style={styles.calGrid}>
            {DOW_LABELS.map(d => <div key={d} style={styles.dowHeader}>{d}</div>)}
          </div>
          <div style={styles.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={styles.emptyCell} />;
              const dow = getDow(year, month, d);
              const assigned = schedule[d] || [];
              const leaves = leaveMap[d] || [];
              const wg = isWG(dow);
              const isSelected = selectedDay === d;
              return (
                <div key={d}
                  style={{
                    ...styles.cell,
                    ...(wg ? styles.cellWG : {}),
                    ...(isToday(d) ? styles.cellToday : {}),
                    ...(isSelected ? styles.cellSelected : {}),
                  }}
                  onClick={() => setSelectedDay(isSelected ? null : d)}>
                  <div style={styles.cellDay}>{d}</div>
                  <div style={styles.cellDow}>{DOW_LABELS[dow]}{wg ? " 🌙" : ""}</div>
                  <div style={styles.cellMembers}>
                    {assigned.map(id => {
                      const m = getMember(id);
                      return m ? (
                        <span key={id} style={{ ...styles.chip, background: m.color + "33", color: m.color, border: `1px solid ${m.color}55` }}>
                          {m.name}
                        </span>
                      ) : null;
                    })}
                  </div>
                  {leaves.length > 0 && (
                    <div style={styles.leaveHint}>休 {leaves.length}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Day Detail Panel */}
          {selectedDay && (
            <div style={styles.panel}>
              <div style={styles.panelTitle}>
                {month + 1}/{selectedDay} ({DOW_LABELS[getDow(year, month, selectedDay)]})
                {isWG(getDow(year, month, selectedDay)) && " — 週末組"}
              </div>
              <div style={styles.panelSection}>
                <div style={styles.panelLabel}>📋 On-Call 人員（點擊切換）</div>
                <div style={styles.memberRow}>
                  {members.map(m => {
                    const on = (schedule[selectedDay] || []).includes(m.id);
                    const lv = (leaveMap[selectedDay] || []).includes(m.id);
                    return (
                      <button key={m.id}
                        disabled={lv}
                        style={{ ...styles.memberToggle, ...(on ? { background: m.color, color: "#000" } : {}), ...(lv ? styles.memberOnLeave : {}) }}
                        onClick={() => toggleAssign(selectedDay, m.id)}>
                        {lv ? "🚫" : on ? "✓" : ""} {m.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Leave View ── */}
      {view === "leave" && (
        <div style={styles.content}>
          <div style={styles.leaveNote}>
            點擊日期格子中的成員姓名來預假 / 取消預假
          </div>
          <div style={styles.calGrid}>
            {DOW_LABELS.map(d => <div key={d} style={styles.dowHeader}>{d}</div>)}
          </div>
          <div style={styles.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={styles.emptyCell} />;
              const dow = getDow(year, month, d);
              const leaves = leaveMap[d] || [];
              return (
                <div key={d} style={{ ...styles.cell, ...(isToday(d) ? styles.cellToday : {}), minHeight: 80 }}>
                  <div style={styles.cellDay}>{d}</div>
                  <div style={styles.cellDow}>{DOW_LABELS[dow]}</div>
                  <div style={styles.cellMembers}>
                    {members.map(m => {
                      const onLeave = leaves.includes(m.id);
                      const isMe = currentUser?.id === m.id;
                      return (
                        <span key={m.id}
                          onClick={() => (isMe || !currentUser) && toggleLeave(d, m.id)}
                          title={isMe ? "點擊預假/取消" : "只能操作自己"}
                          style={{
                            ...styles.chip,
                            background: onLeave ? "#E05C5C33" : "#ffffff08",
                            color: onLeave ? "#E05C5C" : "#555",
                            border: `1px solid ${onLeave ? "#E05C5C55" : "#333"}`,
                            cursor: isMe || !currentUser ? "pointer" : "default",
                            opacity: (!currentUser || isMe) ? 1 : 0.4,
                          }}>
                          {onLeave ? "🚫" : ""}{m.name}
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

      {/* ── Stats View ── */}
      {view === "stats" && (
        <div style={styles.content}>
          <div style={styles.statsGrid}>
            {members.map(m => {
              const cnt = callCount[m.id] || 0;
              const max = Math.max(...Object.values(callCount), 1);
              return (
                <div key={m.id} style={styles.statCard}>
                  <div style={{ ...styles.statBar, width: `${(cnt / max) * 100}%`, background: m.color }} />
                  <div style={styles.statName}>{m.name}</div>
                  <div style={{ ...styles.statCount, color: m.color }}>{cnt} 次</div>
                </div>
              );
            })}
          </div>
          <div style={styles.statsNote}>
            平均 {members.length > 0 ? (Object.values(callCount).reduce((a,b)=>a+b,0) / members.length).toFixed(1) : 0} 次/人
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  Styles
// ═══════════════════════════════════════════════════════════
const styles = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#f0f0f0",
    fontFamily: "'Noto Sans TC', sans-serif",
    position: "relative",
    overflowX: "hidden",
  },
  grain: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E\")",
  },
  toast: {
    position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
    padding: "10px 24px", borderRadius: 24, color: "#000", fontWeight: 700,
    fontSize: 14, zIndex: 999, boxShadow: "0 4px 24px #0008",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "20px 20px 12px", borderBottom: "1px solid #1e1e1e", position: "relative", zIndex: 1,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 32 },
  title: { fontSize: 18, fontWeight: 800, color: "#00B5B5", letterSpacing: 1 },
  subtitle: { fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase" },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  savingDot: { fontSize: 12, color: "#888", animation: "spin 1s linear infinite" },
  userBtn: {
    display: "flex", alignItems: "center", gap: 6,
    background: "#1a1a1a", border: "1px solid #2a2a2a", color: "#ccc",
    padding: "6px 14px", borderRadius: 20, fontSize: 13, cursor: "pointer",
  },
  dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  nav: { display: "flex", gap: 2, padding: "8px 16px", borderBottom: "1px solid #1a1a1a", position: "relative", zIndex: 1 },
  navBtn: {
    padding: "7px 16px", borderRadius: 20, border: "none",
    background: "transparent", color: "#555", cursor: "pointer", fontSize: 13, fontWeight: 600,
  },
  navActive: { background: "#00B5B515", color: "#00B5B5", border: "1px solid #00B5B530" },
  monthNav: {
    display: "flex", alignItems: "center", gap: 8, padding: "12px 16px",
    position: "relative", zIndex: 1,
  },
  arrowBtn: {
    width: 32, height: 32, borderRadius: "50%", border: "1px solid #2a2a2a",
    background: "#1a1a1a", color: "#888", cursor: "pointer", fontSize: 18, lineHeight: 1,
  },
  monthLabel: { fontWeight: 800, fontSize: 16, color: "#e0e0e0", minWidth: 120, textAlign: "center" },
  genBtn: {
    marginLeft: "auto", padding: "7px 16px", background: "#00B5B5", color: "#000",
    border: "none", borderRadius: 20, fontWeight: 800, cursor: "pointer", fontSize: 13,
  },
  reloadBtn: {
    width: 32, height: 32, borderRadius: "50%", border: "1px solid #2a2a2a",
    background: "#1a1a1a", color: "#555", cursor: "pointer", fontSize: 16,
  },
  loadingBar: { height: 2, background: "#1a1a1a", overflow: "hidden" },
  loadingFill: { height: "100%", width: "60%", background: "#00B5B5", animation: "slide 1s ease infinite" },
  content: { padding: "0 12px 40px", position: "relative", zIndex: 1 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 },
  dowHeader: { textAlign: "center", fontSize: 11, color: "#444", padding: "4px 0", fontWeight: 700 },
  emptyCell: { background: "transparent", minHeight: 72 },
  cell: {
    background: "#111", borderRadius: 6, padding: "6px 5px", minHeight: 72,
    cursor: "pointer", border: "1px solid #1a1a1a", transition: "all 0.15s",
    position: "relative", overflow: "hidden",
  },
  cellWG: { background: "#0d1a1a", borderColor: "#00B5B520" },
  cellToday: { borderColor: "#00B5B5", boxShadow: "0 0 0 1px #00B5B540" },
  cellSelected: { borderColor: "#00B5B5", background: "#00B5B510" },
  cellDay: { fontSize: 13, fontWeight: 700, color: "#ccc" },
  cellDow: { fontSize: 9, color: "#444", marginBottom: 3 },
  cellMembers: { display: "flex", flexWrap: "wrap", gap: 2 },
  chip: { fontSize: 9, padding: "1px 5px", borderRadius: 8, fontWeight: 600, cursor: "pointer" },
  leaveHint: { position: "absolute", top: 4, right: 4, fontSize: 9, color: "#E05C5C", fontWeight: 700 },
  panel: {
    marginTop: 12, background: "#111", border: "1px solid #00B5B530",
    borderRadius: 12, padding: 16,
  },
  panelTitle: { fontWeight: 800, fontSize: 15, color: "#00B5B5", marginBottom: 12 },
  panelSection: { marginBottom: 12 },
  panelLabel: { fontSize: 12, color: "#555", marginBottom: 8, fontWeight: 600 },
  memberRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  memberToggle: {
    padding: "6px 12px", borderRadius: 20, border: "1px solid #2a2a2a",
    background: "#1a1a1a", color: "#888", cursor: "pointer", fontSize: 12, fontWeight: 600,
    transition: "all 0.15s",
  },
  memberOnLeave: { opacity: 0.3, cursor: "not-allowed" },
  leaveNote: { fontSize: 12, color: "#555", padding: "8px 4px 4px", fontStyle: "italic" },
  statsGrid: { paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 },
  statCard: {
    background: "#111", borderRadius: 8, padding: "10px 14px",
    position: "relative", overflow: "hidden", display: "flex", alignItems: "center", gap: 10,
  },
  statBar: { position: "absolute", left: 0, top: 0, bottom: 0, opacity: 0.12, transition: "width 0.5s" },
  statName: { fontWeight: 700, fontSize: 14, flex: 1, position: "relative" },
  statCount: { fontWeight: 800, fontSize: 16, position: "relative" },
  statsNote: { textAlign: "center", fontSize: 12, color: "#444", marginTop: 16 },
  modal: {
    position: "fixed", inset: 0, background: "#000a", zIndex: 100,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  modalBox: { background: "#141414", borderRadius: 16, padding: 24, border: "1px solid #2a2a2a", minWidth: 280 },
  modalTitle: { fontWeight: 800, fontSize: 16, marginBottom: 16, color: "#00B5B5" },
  modalGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  memberPickBtn: {
    padding: "8px 14px", borderRadius: 10, background: "#1a1a1a",
    color: "#ccc", border: "1px solid #333", cursor: "pointer", fontSize: 13, fontWeight: 600,
    display: "flex", alignItems: "center", gap: 6,
  },
};