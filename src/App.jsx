import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://qrkichzuegngsxnvwhgx.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFya2ljaHp1ZWduZ3N4bnZ3aGd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0OTU4NjAsImV4cCI6MjA5NDA3MTg2MH0.5V61Looj6JHVtMEaFArUIBNOnmXCblF-Xc8o32i_NIc"
);

// ─── Scheduling constants ──────────────────────────────────
const WEEKDAY_SLOTS = 2;
const WEEKEND_SLOTS = 3;
const MAX_CONSEC = 2;

// ─── Date helpers ──────────────────────────────────────────
function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getDow(y, m, d) { return new Date(y, m, d).getDay(); }
function isWeekend(dow) { return dow === 0 || dow === 6; }
function isFriday(dow) { return dow === 5; }

function getStreak(sched, day, memberId, year, month) {
  let s = 0;
  for (let d = day - 1; d >= 1; d--) {
    const dow = getDow(year, month, d);
    if (isWeekend(dow) || isFriday(dow)) break;
    if ((sched[d] || []).includes(memberId)) s++;
    else break;
  }
  return s;
}

// ─── Auto-generate schedule ────────────────────────────────
// Rules:
//   Sat/Sun  → 3 people (any role)
//   Fri      → 1 放射師 + 1 護理師 + 1 anyone (role-based guarantee)
//   Mon-Thu  → 2 people, max consecutive days = MAX_CONSEC
function autoGenerate(year, month, members, leave) {
  const days = getDaysInMonth(year, month);
  const sched = {};
  const cnt = Object.fromEntries(members.map(mbr => [mbr.id, 0]));

  for (let d = 1; d <= days; d++) {
    const dow = getDow(year, month, d);
    const lv = leave[d] || [];
    const avail = members.filter(mbr => !lv.includes(mbr.id));

    if (isWeekend(dow)) {
      const pool = avail.slice().sort((a, b) => cnt[a.id] - cnt[b.id]);
      sched[d] = pool.slice(0, WEEKEND_SLOTS).map(mbr => mbr.id);
    } else if (isFriday(dow)) {
      const result = [];
      const used = new Set();
      const rads = avail
        .filter(mbr => mbr.role === "radiologist")
        .sort((a, b) => cnt[a.id] - cnt[b.id]);
      const nurses = avail
        .filter(mbr => mbr.role === "nurse")
        .sort((a, b) => cnt[a.id] - cnt[b.id]);
      if (rads.length > 0) { result.push(rads[0].id); used.add(rads[0].id); }
      if (nurses.length > 0) { result.push(nurses[0].id); used.add(nurses[0].id); }
      const extra = avail
        .filter(mbr => !used.has(mbr.id))
        .sort((a, b) => cnt[a.id] - cnt[b.id]);
      if (extra.length > 0) result.push(extra[0].id);
      sched[d] = result;
    } else {
      let pool = avail.filter(mbr => getStreak(sched, d, mbr.id, year, month) < MAX_CONSEC);
      if (pool.length < WEEKDAY_SLOTS) pool = avail;
      pool = pool.slice().sort((a, b) => cnt[a.id] - cnt[b.id]);
      sched[d] = pool.slice(0, WEEKDAY_SLOTS).map(mbr => mbr.id);
    }
    sched[d].forEach(id => { if (cnt[id] !== undefined) cnt[id]++; });
  }
  return sched;
}

// ─── Supabase data layer ───────────────────────────────────
async function dbFetchMembers() {
  const { data, error } = await supabase.from("members").select("*").order("sort_order");
  if (error) throw error;
  return data;
}

async function dbFetchSchedule(year, month) {
  const { data, error } = await supabase
    .from("schedules").select("day, member_id")
    .eq("year", year).eq("month", month);
  if (error) throw error;
  const result = {};
  for (const row of data) {
    if (!result[row.day]) result[row.day] = [];
    result[row.day].push(row.member_id);
  }
  return result;
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

// ─── UI constants ──────────────────────────────────────────
const DOW_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
const ROLE_LABELS = { radiologist: "放射師", nurse: "護理師", other: "其他" };
const ROLE_COLORS = { radiologist: "#0891b2", nurse: "#7c3aed", other: "#64748b" };

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
  const [editMode, setEditMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [showUserPicker, setShowUserPicker] = useState(false);

  const notify = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [mData, sData, lData] = await Promise.all([
        dbFetchMembers(),
        dbFetchSchedule(year, month),
        dbFetchLeave(year, month),
      ]);
      setMembers(mData);
      setSchedule(sData);
      setLeaveMap(lData);
    } catch (e) {
      notify("⚠️ 載入失敗：" + e.message, "err");
    }
    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Save entire month schedule (used after auto-generate) ──
  async function saveFullSchedule(newSched) {
    setSaving(true);
    try {
      await supabase.from("schedules").delete().eq("year", year).eq("month", month);
      const rows = [];
      for (const [day, ids] of Object.entries(newSched)) {
        for (const member_id of ids) {
          rows.push({ year, month, day: parseInt(day), member_id });
        }
      }
      if (rows.length > 0) {
        const { error } = await supabase.from("schedules").insert(rows);
        if (error) throw error;
      }
      setSchedule(newSched);
      notify("✅ 班表已儲存");
    } catch (e) {
      notify("❌ 儲存失敗：" + e.message, "err");
    }
    setSaving(false);
  }

  // ── Toggle single member on a day (manual edit) ──
  async function toggleAssign(day, memberId) {
    if (saving) return;
    const arr = schedule[day] ? [...schedule[day]] : [];
    const isOn = arr.includes(memberId);
    setSaving(true);
    try {
      if (isOn) {
        const { error } = await supabase.from("schedules").delete()
          .eq("year", year).eq("month", month).eq("day", day).eq("member_id", memberId);
        if (error) throw error;
        setSchedule(prev => ({ ...prev, [day]: arr.filter(x => x !== memberId) }));
      } else {
        const { error } = await supabase.from("schedules").insert({ year, month, day, member_id: memberId });
        if (error) throw error;
        setSchedule(prev => ({ ...prev, [day]: [...arr, memberId] }));
      }
    } catch (e) {
      notify("❌ 操作失敗：" + e.message, "err");
    }
    setSaving(false);
  }

  // ── Toggle leave ──
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
        // Auto-remove from schedule if on leave
        if (schedule[day]?.includes(memberId)) {
          await supabase.from("schedules").delete()
            .eq("year", year).eq("month", month).eq("day", day).eq("member_id", memberId);
          setSchedule(prev => ({ ...prev, [day]: (prev[day] || []).filter(x => x !== memberId) }));
        }
      }
      notify("📅 預假已更新");
    } catch (e) {
      notify("❌ 操作失敗：" + e.message, "err");
    }
    setSaving(false);
  }

  function handleAutoGenerate() {
    const gen = autoGenerate(year, month, members, leaveMap);
    saveFullSchedule(gen);
  }

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
  const isToday = (d) =>
    d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  const callCount = {};
  members.forEach(m => { callCount[m.id] = 0; });
  Object.values(schedule).forEach(ids =>
    ids.forEach(id => { if (callCount[id] !== undefined) callCount[id]++; })
  );

  // ─────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {/* Toast */}
      {toast && (
        <div style={{ ...S.toast, background: toast.type === "err" ? "#dc2626" : "#0891b2" }}>
          {toast.msg}
        </div>
      )}

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
          <button style={S.userBtn} onClick={() => setShowUserPicker(true)}>
            {currentUser ? (
              <><span style={{ ...S.dot, background: currentUser.color }} />{currentUser.name}</>
            ) : "選擇身份"}
          </button>
        </div>
      </header>

      {/* User Picker Modal */}
      {showUserPicker && (
        <div style={S.modalOverlay} onClick={() => setShowUserPicker(false)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>你是誰？</div>
            <div style={S.modalGrid}>
              {members.map(m => (
                <button key={m.id}
                  style={{ ...S.memberPickBtn, borderColor: m.color + "80" }}
                  onClick={() => { setCurrentUser(m); setShowUserPicker(false); }}>
                  <span style={{ ...S.dot, background: m.color }} />
                  <span style={S.pickName}>{m.name}</span>
                  <span style={{ ...S.roleTag, background: ROLE_COLORS[m.role] + "18", color: ROLE_COLORS[m.role] }}>
                    {ROLE_LABELS[m.role]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav style={S.nav}>
        {[["calendar","📅 班表"],["leave","🙋 預假"],["stats","📊 統計"]].map(([v, l]) => (
          <button key={v}
            style={{ ...S.navBtn, ...(view === v ? S.navActive : {}) }}
            onClick={() => { setView(v); setSelectedDay(null); setEditMode(false); }}>
            {l}
          </button>
        ))}
      </nav>

      {/* Month Navigator */}
      <div style={S.monthNav}>
        <button style={S.arrowBtn} onClick={() => {
          setSelectedDay(null);
          setEditMode(false);
          if (month === 0) { setYear(y => y - 1); setMonth(11); }
          else setMonth(m => m - 1);
        }}>‹</button>
        <span style={S.monthLabel}>{year} 年 {MONTH_NAMES[month]}</span>
        <button style={S.arrowBtn} onClick={() => {
          setSelectedDay(null);
          setEditMode(false);
          if (month === 11) { setYear(y => y + 1); setMonth(0); }
          else setMonth(m => m + 1);
        }}>›</button>
        {view === "calendar" && (
          <>
            <button style={S.genBtn} onClick={handleAutoGenerate} disabled={saving || loading}>
              ⚡ 自動排班
            </button>
            <button
              style={{ ...S.editToggleBtn, ...(editMode ? S.editToggleBtnActive : {}) }}
              onClick={() => { setEditMode(e => !e); setSelectedDay(null); }}>
              ✏️ {editMode ? "完成編輯" : "手動調整"}
            </button>
          </>
        )}
        <button style={S.reloadBtn} onClick={loadAll} disabled={loading}>↺</button>
      </div>

      {loading && <div style={S.loadingBar}><div style={S.loadingFill} /></div>}

      {/* Edit mode banner */}
      {editMode && view === "calendar" && (
        <div style={S.editBanner}>
          ✏️ 手動調整模式：點擊日期格子中的人員姓名來加入 / 移除
        </div>
      )}

      {/* ── Calendar View ── */}
      {view === "calendar" && (
        <div style={S.content}>
          {/* DOW headers */}
          <div style={S.calGrid}>
            {DOW_LABELS.map((d, i) => (
              <div key={d} style={{ ...S.dowHeader, color: i === 0 ? "#dc2626" : i === 6 ? "#2563eb" : "#64748b" }}>
                {d}
              </div>
            ))}
          </div>

          {/* Calendar cells */}
          <div style={S.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={S.emptyCell} />;
              const dow = getDow(year, month, d);
              const assigned = schedule[d] || [];
              const leaves = leaveMap[d] || [];
              const wg = isWeekend(dow);
              const fri = isFriday(dow);
              const isSelected = selectedDay === d;

              return (
                <div key={d}
                  style={{
                    ...S.cell,
                    ...(wg ? S.cellWG : {}),
                    ...(fri ? S.cellFri : {}),
                    ...(isToday(d) ? S.cellToday : {}),
                    ...(isSelected && !editMode ? S.cellSelected : {}),
                    ...(editMode ? S.cellEditMode : {}),
                  }}
                  onClick={() => {
                    if (!editMode) setSelectedDay(isSelected ? null : d);
                  }}>
                  <div style={{ ...S.cellDay, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>
                    {d}
                  </div>
                  <div style={S.cellDow}>
                    {DOW_LABELS[dow]}{wg ? " 🌙" : fri ? " ★" : ""}
                  </div>
                  <div style={S.cellMembers}>
                    {assigned.map(id => {
                      const mbr = getMember(id);
                      if (!mbr) return null;
                      return (
                        <span key={id}
                          style={{
                            ...S.chip,
                            background: mbr.color + "22",
                            color: mbr.color,
                            border: `1.5px solid ${mbr.color}55`,
                            ...(editMode ? S.chipEditable : {}),
                          }}
                          onClick={editMode ? (e) => { e.stopPropagation(); toggleAssign(d, id); } : undefined}
                          title={editMode ? "點擊移除" : undefined}>
                          {editMode && <span style={S.chipRemove}>✕ </span>}
                          {mbr.name}
                        </span>
                      );
                    })}
                    {/* Add button in edit mode */}
                    {editMode && (
                      <span style={S.chipAdd}
                        onClick={(e) => { e.stopPropagation(); setSelectedDay(d === selectedDay ? null : d); }}>
                        + 加入
                      </span>
                    )}
                  </div>
                  {leaves.length > 0 && (
                    <div style={S.leaveHint}>休 {leaves.length}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Detail / Edit panel */}
          {selectedDay && !editMode && (
            <div style={S.panel}>
              <div style={S.panelHeader}>
                <div style={S.panelTitle}>
                  {month + 1}/{selectedDay}（{DOW_LABELS[getDow(year, month, selectedDay)]}）
                  {isWeekend(getDow(year, month, selectedDay)) && <span style={S.panelBadgeWG}>🌙 週末</span>}
                  {isFriday(getDow(year, month, selectedDay)) && <span style={S.panelBadgeFri}>★ 週五特排</span>}
                </div>
                <button style={S.panelClose} onClick={() => setSelectedDay(null)}>✕</button>
              </div>
              <div style={S.panelLabel}>📋 On-Call 人員</div>
              <div style={S.memberRow}>
                {members.map(mbr => {
                  const on = (schedule[selectedDay] || []).includes(mbr.id);
                  const lv = (leaveMap[selectedDay] || []).includes(mbr.id);
                  return (
                    <button key={mbr.id}
                      disabled={lv || saving}
                      title={lv ? "請假中" : on ? "點擊移除" : "點擊加入"}
                      style={{
                        ...S.memberToggle,
                        ...(on ? { background: mbr.color, color: "#fff", borderColor: mbr.color, boxShadow: `0 2px 8px ${mbr.color}50` } : {}),
                        ...(lv ? S.memberOnLeave : {}),
                      }}
                      onClick={() => !lv && !saving && toggleAssign(selectedDay, mbr.id)}>
                      <span>{lv ? "🚫" : on ? "✓ " : "+ "}</span>
                      <span>{mbr.name}</span>
                      <span style={{ ...S.roleTag, background: on ? "#fff3" : ROLE_COLORS[mbr.role] + "18", color: on ? "#fff" : ROLE_COLORS[mbr.role] }}>
                        {ROLE_LABELS[mbr.role]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Edit mode add-member panel */}
          {selectedDay && editMode && (
            <div style={{ ...S.panel, borderColor: "#f59e0b60" }}>
              <div style={S.panelHeader}>
                <div style={{ ...S.panelTitle, color: "#b45309" }}>
                  ✏️ {month + 1}/{selectedDay} — 新增人員
                </div>
                <button style={S.panelClose} onClick={() => setSelectedDay(null)}>✕</button>
              </div>
              <div style={S.memberRow}>
                {members.map(mbr => {
                  const on = (schedule[selectedDay] || []).includes(mbr.id);
                  const lv = (leaveMap[selectedDay] || []).includes(mbr.id);
                  if (on || lv) return null;
                  return (
                    <button key={mbr.id}
                      disabled={saving}
                      style={S.memberToggle}
                      onClick={() => { toggleAssign(selectedDay, mbr.id); setSelectedDay(null); }}>
                      + {mbr.name}
                      <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>
                        {ROLE_LABELS[mbr.role]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Leave View ── */}
      {view === "leave" && (
        <div style={S.content}>
          <div style={S.leaveNote}>
            {currentUser
              ? `身份：${currentUser.name}　點擊自己的名字來預假 / 取消`
              : "⬆ 請先點右上角選擇身份，再操作預假"}
          </div>
          <div style={S.calGrid}>
            {DOW_LABELS.map((d, i) => (
              <div key={d} style={{ ...S.dowHeader, color: i === 0 ? "#dc2626" : i === 6 ? "#2563eb" : "#64748b" }}>
                {d}
              </div>
            ))}
          </div>
          <div style={S.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <div key={i} style={S.emptyCell} />;
              const dow = getDow(year, month, d);
              const leaves = leaveMap[d] || [];
              return (
                <div key={d} style={{ ...S.cell, ...(isToday(d) ? S.cellToday : {}), minHeight: 88 }}>
                  <div style={{ ...S.cellDay, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#0f172a" }}>
                    {d}
                  </div>
                  <div style={S.cellDow}>{DOW_LABELS[dow]}</div>
                  <div style={S.cellMembers}>
                    {members.map(mbr => {
                      const onLeave = leaves.includes(mbr.id);
                      const isMe = currentUser?.id === mbr.id;
                      return (
                        <span key={mbr.id}
                          onClick={() => isMe && toggleLeave(d, mbr.id)}
                          title={isMe ? "點擊預假/取消" : "只能操作自己的假"}
                          style={{
                            ...S.chip,
                            background: onLeave ? "#fee2e2" : "#f1f5f9",
                            color: onLeave ? "#dc2626" : isMe ? "#334155" : "#94a3b8",
                            border: `1.5px solid ${onLeave ? "#fca5a5" : isMe ? "#cbd5e1" : "#e2e8f0"}`,
                            cursor: isMe ? "pointer" : "default",
                            opacity: isMe || !currentUser ? 1 : 0.45,
                            fontWeight: isMe ? 700 : 400,
                          }}>
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

      {/* ── Stats View ── */}
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
                    <span style={{ ...S.roleTag, background: ROLE_COLORS[mbr.role] + "18", color: ROLE_COLORS[mbr.role] }}>
                      {ROLE_LABELS[mbr.role]}
                    </span>
                  </div>
                  <div style={{ ...S.statCount, color: mbr.color }}>{cnt} 次</div>
                </div>
              );
            })}
          </div>
          <div style={S.statsNote}>
            本月平均：{members.length > 0
              ? (Object.values(callCount).reduce((a, b) => a + b, 0) / members.length).toFixed(1)
              : 0} 次／人
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  Styles — light theme, larger fonts
// ═══════════════════════════════════════════════════════════
const S = {
  root: {
    minHeight: "100vh",
    background: "#f1f5f9",
    color: "#0f172a",
    fontFamily: "'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
  },
  toast: {
    position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
    padding: "10px 24px", borderRadius: 24, color: "#fff", fontWeight: 700,
    fontSize: 15, zIndex: 999, boxShadow: "0 4px 20px #0003", whiteSpace: "nowrap",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 20px", background: "#fff",
    borderBottom: "2px solid #e2e8f0", boxShadow: "0 1px 4px #0001",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 34, lineHeight: 1 },
  title: { fontSize: 20, fontWeight: 800, color: "#0891b2" },
  subtitle: { fontSize: 12, color: "#94a3b8", letterSpacing: 2, textTransform: "uppercase" },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  savingTxt: { fontSize: 13, color: "#0891b2", fontWeight: 600 },
  userBtn: {
    display: "flex", alignItems: "center", gap: 6,
    background: "#f0f9ff", border: "1.5px solid #bae6fd", color: "#0369a1",
    padding: "7px 16px", borderRadius: 20, fontSize: 14, cursor: "pointer", fontWeight: 600,
  },
  dot: { borderRadius: "50%", display: "inline-block", flexShrink: 0, width: 10, height: 10 },
  nav: {
    display: "flex", gap: 4, padding: "10px 16px",
    background: "#fff", borderBottom: "1px solid #e2e8f0",
  },
  navBtn: {
    padding: "8px 18px", borderRadius: 20, border: "1.5px solid transparent",
    background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 14, fontWeight: 600,
  },
  navActive: { background: "#e0f2fe", color: "#0891b2", borderColor: "#bae6fd" },
  monthNav: {
    display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
    background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap",
  },
  arrowBtn: {
    width: 34, height: 34, borderRadius: "50%", border: "1.5px solid #e2e8f0",
    background: "#f8fafc", color: "#475569", cursor: "pointer", fontSize: 20,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  monthLabel: { fontWeight: 800, fontSize: 17, color: "#1e293b", minWidth: 130, textAlign: "center" },
  genBtn: {
    marginLeft: "auto", padding: "8px 16px", background: "#0891b2", color: "#fff",
    border: "none", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 14,
    boxShadow: "0 2px 8px #0891b230",
  },
  editToggleBtn: {
    padding: "8px 16px", background: "#fff", color: "#92400e",
    border: "1.5px solid #fcd34d", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 14,
  },
  editToggleBtnActive: {
    background: "#fef3c7", color: "#92400e", borderColor: "#f59e0b",
    boxShadow: "0 2px 8px #f59e0b30",
  },
  reloadBtn: {
    width: 34, height: 34, borderRadius: "50%", border: "1.5px solid #e2e8f0",
    background: "#f8fafc", color: "#94a3b8", cursor: "pointer", fontSize: 17,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  loadingBar: { height: 3, background: "#e0f2fe", overflow: "hidden" },
  loadingFill: { height: "100%", width: "60%", background: "#0891b2" },
  editBanner: {
    background: "#fffbeb", borderBottom: "1px solid #fcd34d",
    padding: "8px 16px", fontSize: 13, color: "#92400e", fontWeight: 600,
  },
  content: { padding: "8px 10px 48px" },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 3 },
  dowHeader: { textAlign: "center", fontSize: 13, padding: "6px 0", fontWeight: 700 },
  emptyCell: { minHeight: 80 },
  cell: {
    background: "#fff", borderRadius: 8, padding: "7px 6px", minHeight: 80,
    cursor: "pointer", border: "1.5px solid #e2e8f0",
    transition: "border-color 0.15s, box-shadow 0.15s",
    position: "relative", overflow: "hidden",
    boxShadow: "0 1px 2px #0001",
  },
  cellWG: { background: "#eff6ff", borderColor: "#bfdbfe" },
  cellFri: { background: "#fffbeb", borderColor: "#fde68a" },
  cellToday: { borderColor: "#0891b2", boxShadow: "0 0 0 2px #0891b230" },
  cellSelected: { borderColor: "#0891b2", background: "#e0f2fe" },
  cellEditMode: { cursor: "default", borderColor: "#fcd34d" },
  cellDay: { fontSize: 15, fontWeight: 800, lineHeight: 1.2 },
  cellDow: { fontSize: 10, color: "#94a3b8", marginBottom: 4 },
  cellMembers: { display: "flex", flexWrap: "wrap", gap: 3 },
  chip: {
    fontSize: 11, padding: "2px 7px", borderRadius: 8, fontWeight: 600,
    lineHeight: 1.5, display: "inline-flex", alignItems: "center", gap: 2,
  },
  chipEditable: { cursor: "pointer", outline: "none" },
  chipRemove: { fontSize: 9, opacity: 0.7 },
  chipAdd: {
    fontSize: 10, padding: "2px 6px", borderRadius: 8, fontWeight: 600,
    background: "#f0fdf4", color: "#16a34a", border: "1.5px dashed #86efac",
    cursor: "pointer", lineHeight: 1.5,
  },
  leaveHint: { position: "absolute", top: 4, right: 4, fontSize: 10, color: "#dc2626", fontWeight: 700 },
  panel: {
    marginTop: 10, background: "#fff", border: "1.5px solid #bae6fd",
    borderRadius: 12, padding: "14px 16px", boxShadow: "0 2px 12px #0891b210",
  },
  panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  panelTitle: { fontWeight: 800, fontSize: 16, color: "#0891b2", display: "flex", alignItems: "center", gap: 8 },
  panelBadgeWG: { fontSize: 12, background: "#eff6ff", color: "#2563eb", padding: "2px 8px", borderRadius: 10, fontWeight: 600 },
  panelBadgeFri: { fontSize: 12, background: "#fffbeb", color: "#b45309", padding: "2px 8px", borderRadius: 10, fontWeight: 600 },
  panelClose: {
    width: 28, height: 28, borderRadius: "50%", border: "1.5px solid #e2e8f0",
    background: "#f8fafc", color: "#94a3b8", cursor: "pointer", fontSize: 14,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  panelLabel: { fontSize: 13, color: "#64748b", marginBottom: 10, fontWeight: 600 },
  memberRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  memberToggle: {
    padding: "8px 14px", borderRadius: 20, border: "1.5px solid #e2e8f0",
    background: "#f8fafc", color: "#334155", cursor: "pointer", fontSize: 13, fontWeight: 600,
    transition: "all 0.15s", display: "flex", alignItems: "center", gap: 5,
  },
  memberOnLeave: { opacity: 0.3, cursor: "not-allowed" },
  leaveNote: {
    fontSize: 14, color: "#475569", padding: "10px 4px 6px", fontWeight: 500,
  },
  statsGrid: { paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 },
  statCard: {
    background: "#fff", borderRadius: 10, padding: "14px 18px",
    position: "relative", overflow: "hidden", display: "flex", alignItems: "center",
    border: "1.5px solid #e2e8f0", boxShadow: "0 1px 3px #0001",
  },
  statBar: { position: "absolute", left: 0, top: 0, bottom: 0, transition: "width 0.5s" },
  statInfo: { display: "flex", alignItems: "center", gap: 8, flex: 1, position: "relative" },
  statName: { fontWeight: 700, fontSize: 15, color: "#0f172a" },
  statCount: { fontWeight: 800, fontSize: 18, position: "relative" },
  statsNote: { textAlign: "center", fontSize: 13, color: "#94a3b8", marginTop: 16 },
  roleTag: {
    fontSize: 11, padding: "2px 7px", borderRadius: 6, fontWeight: 600,
    display: "inline-block",
  },
  modalOverlay: {
    position: "fixed", inset: 0, background: "#00000066", zIndex: 100,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  modalBox: {
    background: "#fff", borderRadius: 16, padding: 24, border: "1px solid #e2e8f0",
    minWidth: 300, maxWidth: "90vw", boxShadow: "0 8px 32px #0002",
  },
  modalTitle: { fontWeight: 800, fontSize: 18, marginBottom: 16, color: "#0891b2" },
  modalGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  memberPickBtn: {
    padding: "10px 12px", borderRadius: 10, background: "#f8fafc",
    color: "#1e293b", border: "1.5px solid #e2e8f0", cursor: "pointer",
    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    transition: "background 0.15s",
  },
  pickName: { fontWeight: 700, fontSize: 14, flex: 1 },
};
