import { DEFAULT_RULES } from "./constants.js";

export function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
export function getDow(y, m, d) { return new Date(y, m, d).getDay(); }
export function isWeekend(dow) { return dow === 0 || dow === 6; }
export function isFriday(dow) { return dow === 5; }

// Returns the day-of-month of the Monday of the Mon–Sun calendar week containing day d.
// May be ≤0 for the first partial week; used only as a map key.
function getWeekKey(y, m, d) {
  const dow = getDow(y, m, d);
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  return d - daysSinceMon;
}

// Consecutive streak — all days (including weekends and holidays) count
function getStreak(sched, day, memberId) {
  let s = 0;
  for (let d = day - 1; d >= 1; d--) {
    if ((sched[d] || []).includes(memberId)) s++;
    else break;
  }
  return s;
}

// Sort pool: balance (soft cap at floor(avg)+1) > pair bonus > fewer calls
// useRandom: add small noise so equal-score members get shuffled differently each run
function sortByScore(pool, cnt, selectedIds, pairsMap, avoidMap, useRandom, personalCap = null, weekCntMap = null) {
  const poolAvg = pool.length > 0 ? pool.reduce((s, m) => s + (cnt[m.id] || 0), 0) / pool.length : 0;
  const scores = new Map(pool.map(m => {
    const cap = personalCap ? (personalCap.get(m.id) ?? Math.floor(poolAvg) + 1) : Math.floor(poolAvg) + 1;
    const paired = (pairsMap[m.id] || []).some(pid => selectedIds && selectedIds.has(pid));
    const avoided = ((avoidMap && avoidMap[m.id]) || []).some(pid => selectedIds && selectedIds.has(pid));
    const overCap = (cnt[m.id] || 0) >= cap ? 100000 : 0;
    const noise = useRandom ? Math.random() * 0.9 : 0;
    const weekPenalty = weekCntMap ? (weekCntMap[m.id] || 0) * 10 : 0;
    return [m.id, (cnt[m.id] || 0) - (paired ? 500 : 0) + (avoided ? 2000 : 0) + overCap + weekPenalty + noise];
  }));
  return pool.slice().sort((a, b) => scores.get(a.id) - scores.get(b.id));
}

function pick(pool, cnt, n, fallback, selectedIds, pairsMap, avoidMap, useRandom, personalCap = null, weekCntMap = null) {
  const sorted = sortByScore(pool, cnt, selectedIds, pairsMap, avoidMap, useRandom, personalCap, weekCntMap);
  return sorted.length >= n
    ? sorted.slice(0, n)
    : sortByScore(fallback, cnt, selectedIds, pairsMap, avoidMap, useRandom, personalCap, weekCntMap).slice(0, n);
}

export function autoGenerate(year, month, members, leave, existingSched, lockedDays, holidayDays, rules, pairs, manualSchedule, useRandom) {
  const r = rules || DEFAULT_RULES;
  const days = getDaysInMonth(year, month);
  const sched = {};
  const cnt = Object.fromEntries(members.map(m => [m.id, 0]));
  const getMember = id => members.find(m => m.id === id);

  // Build pairs lookups: prefer → -500 score, avoid → +2000 score
  const pairsMap = {};
  const avoidMap = {};
  for (const p of (pairs || [])) {
    if (p.type === 'avoid') {
      (avoidMap[p.member_id_1] = avoidMap[p.member_id_1] || []).push(p.member_id_2);
      (avoidMap[p.member_id_2] = avoidMap[p.member_id_2] || []).push(p.member_id_1);
    } else {
      (pairsMap[p.member_id_1] = pairsMap[p.member_id_1] || []).push(p.member_id_2);
      (pairsMap[p.member_id_2] = pairsMap[p.member_id_2] || []).push(p.member_id_1);
    }
  }

  // Pre-pass: for each Saturday in month, compute the shared non-doctor weekend team.
  // Use a dedicated counter so successive weekends rotate to different staff.
  const weekendNonDocTeam = {}; // satDay → [memberId, ...]
  const wkndCnt = Object.fromEntries(members.map(m => [m.id, 0]));

  // Strict radiologist cap: each rad gets at most ceil(numSaturdays / numRads) weekends.
  // With 4 rads & 4 weekends → cap=1 (no rad doubles); with 4 rads & 5 weekends → cap=2.
  const allRads = members.filter(m => m.role === "radiologist");
  let numSats = 0;
  for (let d = 1; d <= days; d++) if (getDow(year, month, d) === 6) numSats++;
  const wkndRadCapVal = allRads.length > 0 ? Math.ceil(numSats / allRads.length) : 1;
  const wkndRadCap = new Map(allRads.map(m => [m.id, wkndRadCapVal]));

  for (let d = 1; d <= days; d++) {
    if (getDow(year, month, d) !== 6) continue; // only Saturdays
    const sat = d, sun = d + 1;
    const satLv = leave[sat] || [];
    const sunLv = sun <= days ? (leave[sun] || []) : [];
    // Pick members available on BOTH Sat and Sun (or just Sat if Sun is next month)
    const availBoth = members.filter(m =>
      (m.role === "radiologist" || m.role === "nurse") &&
      !satLv.includes(m.id) &&
      (sun > days || !sunLv.includes(m.id))
    );
    const sel = new Set(), used = new Set(), team = [];
    const rads = pick(availBoth.filter(m => m.role === "radiologist"), wkndCnt, r.weekend_radiologist,
      availBoth.filter(m => m.role === "radiologist"), sel, pairsMap, avoidMap, useRandom, wkndRadCap);
    rads.forEach(m => { team.push(m.id); used.add(m.id); sel.add(m.id); });
    const nurses = pick(availBoth.filter(m => m.role === "nurse" && !used.has(m.id)), wkndCnt, r.weekend_nurse,
      availBoth.filter(m => m.role === "nurse"), sel, pairsMap, avoidMap, useRandom);
    nurses.forEach(m => { team.push(m.id); });
    // Update wkndCnt so next weekend favours different staff
    team.forEach(id => { if (wkndCnt[id] !== undefined) wkndCnt[id]++; });
    weekendNonDocTeam[sat] = team;
  }

  // Pre-seed cnt with weekend shifts so weekday selection deprioritises
  // staff who already have weekend duties this month.
  // Skip locked weekends — those use manualSchedule, not weekendNonDocTeam.
  // Also include the preceding Friday if it's a normal working day — the Friday
  // logic uses the same weekend team, so their total "block" is Fri+Sat+Sun.
  for (let d = 1; d <= days; d++) {
    if (getDow(year, month, d) !== 6) continue;
    if (lockedDays && lockedDays.has(d)) continue;
    const team = weekendNonDocTeam[d] || [];
    const sun = d + 1;
    let daysWorked = sun <= days ? 2 : 1; // Sat + Sun (or just Sat at month-end)
    // Count the preceding Friday if it's a normal non-holiday, non-locked weekday
    const fri = d - 1;
    if (fri >= 1 && !isWeekend(getDow(year, month, fri)) &&
        !(lockedDays && lockedDays.has(fri)) &&
        !(holidayDays && holidayDays.has(fri))) {
      daysWorked += 1;
    }
    team.forEach(id => { if (cnt[id] !== undefined) cnt[id] += daysWorked; });
  }

  // Pre-seed weekCnt with the same Fri+Sat+Sun blocks so within-week weekday
  // selection deprioritises staff who already have weekend duties that week.
  const weekCnt = {};
  for (let d = 1; d <= days; d++) {
    if (getDow(year, month, d) !== 6) continue;
    if (lockedDays && lockedDays.has(d)) continue;
    const team = weekendNonDocTeam[d] || [];
    const sat = d, sun = d + 1, fri = d - 1;
    const satKey = getWeekKey(year, month, sat); // Fri/Sat/Sun share the same Mon–Sun week key
    if (!weekCnt[satKey]) weekCnt[satKey] = {};
    let preSeededCount = 1; // Saturday
    if (sun <= days) preSeededCount++;
    if (fri >= 1 && !isWeekend(getDow(year, month, fri)) &&
        !(lockedDays && lockedDays.has(fri)) &&
        !(holidayDays && holidayDays.has(fri))) preSeededCount++;
    team.forEach(id => { weekCnt[satKey][id] = (weekCnt[satKey][id] || 0) + preSeededCount; });
  }

  // Pre-seed cnt with all locked-day manual assignments so that auto-assigned
  // days (which may come before the locked day in the loop) correctly
  // deprioritise staff who already have manual shifts later in the month.
  if (lockedDays) {
    for (let d = 1; d <= days; d++) {
      if (!lockedDays.has(d)) continue;
      const ids = (manualSchedule && manualSchedule[d]) ? manualSchedule[d] : (existingSched[d] || []);
      ids.forEach(id => { if (cnt[id] !== undefined) cnt[id]++; });
    }
  }

  // Compute per-person shift caps weighted by availability (leave-aware).
  // Members with more leave days get proportionally lower caps, preventing
  // always-available members from absorbing all overflow shifts.
  let totalNonDoctorShifts = 0;
  for (let d = 1; d <= days; d++) {
    const dow = getDow(year, month, d);
    if (holidayDays && holidayDays.has(d)) {
      const ids = (manualSchedule && manualSchedule[d]) ? [...manualSchedule[d]] : (existingSched[d] || []);
      totalNonDoctorShifts += ids.filter(id => members.find(m => m.id === id)?.role !== "doctor").length;
    } else if (isWeekend(dow)) {
      totalNonDoctorShifts += r.weekend_radiologist + r.weekend_nurse;
    } else {
      totalNonDoctorShifts += r.weekday_rad_nurse;
    }
  }
  const nonDoctors = members.filter(m => m.role !== "doctor");
  let personalCap = null;
  if (nonDoctors.length > 0) {
    // Count leave days per non-doctor member
    const leaveCount = {};
    nonDoctors.forEach(m => { leaveCount[m.id] = 0; });
    for (let d = 1; d <= days; d++) {
      (leave[d] || []).forEach(id => { if (leaveCount[id] !== undefined) leaveCount[id]++; });
    }
    // Available days per member (at least 1 to avoid division by zero)
    const availDays = new Map(nonDoctors.map(m => [m.id, Math.max(1, days - leaveCount[m.id])]));
    const totalAvailDays = nonDoctors.reduce((s, m) => s + availDays.get(m.id), 0);
    // Each member's cap is proportional to their available days
    personalCap = new Map(nonDoctors.map(m => [
      m.id,
      Math.ceil(totalNonDoctorShifts * availDays.get(m.id) / totalAvailDays)
    ]));
  }

  for (let d = 1; d <= days; d++) {
    if (lockedDays && lockedDays.has(d)) {
      const manualIds = (manualSchedule && manualSchedule[d]) ? [...manualSchedule[d]] : (existingSched[d] || []);
      // On holidays, keep only the manual assignments — no auto-fill
      if (holidayDays && holidayDays.has(d)) {
        sched[d] = manualIds;
        // manual members already pre-seeded; no cnt increment needed
        continue;
      }
      // Keep manually-assigned members; auto-fill the remaining slots
      const usedIds = new Set(manualIds);
      const result = [...manualIds];
      const sel = new Set(manualIds);
      const lv = leave[d] || [];
      const avail = members.filter(m => !lv.includes(m.id) && !usedIds.has(m.id));
      const maxC = r.max_consecutive;
      const eligible = m => getStreak(sched, d, m.id) < maxC;
      const numRad   = manualIds.filter(id => getMember(id)?.role === "radiologist").length;
      const numNurse = manualIds.filter(id => getMember(id)?.role === "nurse").length;

      if (isWeekend(getDow(year, month, d))) {
        // Respect manual assignments; only fill up to quota
        const needRad   = Math.max(0, r.weekend_radiologist - numRad);
        const needNurse = Math.max(0, r.weekend_nurse - numNurse);
        if (needRad > 0) {
          const pool = avail.filter(m => m.role === "radiologist" && !usedIds.has(m.id));
          pick(pool, cnt, needRad, pool, sel, pairsMap, avoidMap, useRandom, personalCap).forEach(m => { result.push(m.id); usedIds.add(m.id); sel.add(m.id); });
        }
        if (needNurse > 0) {
          const pool = avail.filter(m => m.role === "nurse" && !usedIds.has(m.id));
          pick(pool, cnt, needNurse, pool, sel, pairsMap, avoidMap, useRandom, personalCap).forEach(m => { result.push(m.id); usedIds.add(m.id); sel.add(m.id); });
        }
      } else {
        // Weekday (Mon–Fri): fill to weekday quotas
        if (numRad === 0) {
          const pool = avail.filter(m => m.role === "radiologist" && !usedIds.has(m.id));
          pick(pool.filter(eligible), cnt, 1, pool, sel, pairsMap, avoidMap, useRandom, personalCap).forEach(m => { result.push(m.id); usedIds.add(m.id); sel.add(m.id); });
        }
        if (numNurse === 0) {
          const pool = avail.filter(m => m.role === "nurse" && !usedIds.has(m.id));
          pick(pool.filter(eligible), cnt, 1, pool, sel, pairsMap, avoidMap, useRandom, personalCap).forEach(m => { result.push(m.id); usedIds.add(m.id); sel.add(m.id); });
        }
        const currentRN = result.filter(id => { const role = getMember(id)?.role; return role === "radiologist" || role === "nurse"; }).length;
        const needMore = r.weekday_rad_nurse - currentRN;
        if (needMore > 0) {
          const pool = avail.filter(m => (m.role === "radiologist" || m.role === "nurse") && !usedIds.has(m.id));
          pick(pool.filter(eligible), cnt, needMore, pool, sel, pairsMap, avoidMap, useRandom, personalCap).forEach(m => { result.push(m.id); usedIds.add(m.id); sel.add(m.id); });
        }
      }
      sched[d] = result;
      // Don't double-count manually locked day members (already pre-seeded)
      continue;
    }

    const dow = getDow(year, month, d);
    // Holidays: preserve existing schedule unchanged
    if (holidayDays && holidayDays.has(d)) {
      sched[d] = existingSched[d] ? [...existingSched[d]] : [];
      continue;
    }

    const lv = leave[d] || [];
    const maxC = r.max_consecutive;
    const eligible = m => getStreak(sched, d, m.id) < maxC;

    if (isWeekend(dow)) {
      // Weekend: use pre-computed team (same Sat+Sun)
      const satDay = dow === 6 ? d : d - 1;
      const team = weekendNonDocTeam[satDay] || [];
      // Fallback: generate independently (e.g. sat was a holiday)
      if (team.length === 0) {
        const avail = members.filter(m => (m.role === "radiologist" || m.role === "nurse") && !lv.includes(m.id));
        const sel = new Set();
        const result = [];
        pick(avail.filter(m => m.role === "radiologist"), cnt, r.weekend_radiologist, avail.filter(m => m.role === "radiologist"), sel, pairsMap, avoidMap, useRandom, personalCap)
          .forEach(m => { result.push(m.id); sel.add(m.id); });
        pick(avail.filter(m => m.role === "nurse" && !sel.has(m.id)), cnt, r.weekend_nurse, avail.filter(m => m.role === "nurse"), sel, pairsMap, avoidMap, useRandom, personalCap)
          .forEach(m => { result.push(m.id); });
        sched[d] = result;
      } else {
        sched[d] = team.filter(id => !lv.includes(id));
      }
    } else if (isFriday(dow)) {
      // Friday: use next Saturday's team + extra rad/nurse if needed
      const satDay = d + 1;
      const team = satDay <= days ? (weekendNonDocTeam[satDay] || []) : [];
      const avail = members.filter(m => (m.role === "radiologist" || m.role === "nurse") && !lv.includes(m.id));
      const base = team.filter(id => !lv.includes(id));
      const used = new Set(base);
      const sel = new Set(base);
      const result = [...base];
      const filled = result.filter(id => { const role = getMember(id)?.role; return role === "radiologist" || role === "nurse"; }).length;
      const remaining = r.weekday_rad_nurse - filled;
      if (remaining > 0) {
        const currentWeekCnt = weekCnt[getWeekKey(year, month, d)] || {};
        const rnPool = avail.filter(m => (m.role === "radiologist" || m.role === "nurse") && !used.has(m.id));
        pick(rnPool.filter(eligible), cnt, remaining, rnPool, sel, pairsMap, avoidMap, useRandom, personalCap, currentWeekCnt)
          .forEach(m => { result.push(m.id); used.add(m.id); sel.add(m.id); });
      }
      sched[d] = result;
    } else {
      // Mon–Thu
      const avail = members.filter(m => !lv.includes(m.id));
      const sel = new Set();
      const result = [];
      const used = new Set();
      const currentWeekCnt = weekCnt[getWeekKey(year, month, d)] || {};

      // Ensure at least 1 rad and 1 nurse before filling to quota
      pick(avail.filter(m => m.role === "radiologist").filter(eligible), cnt, 1,
        avail.filter(m => m.role === "radiologist"), sel, pairsMap, avoidMap, useRandom, personalCap, currentWeekCnt)
        .forEach(m => { result.push(m.id); used.add(m.id); sel.add(m.id); });
      pick(avail.filter(m => m.role === "nurse" && !used.has(m.id)).filter(eligible), cnt, 1,
        avail.filter(m => m.role === "nurse"), sel, pairsMap, avoidMap, useRandom, personalCap, currentWeekCnt)
        .forEach(m => { result.push(m.id); used.add(m.id); sel.add(m.id); });
      const filled = result.filter(id => { const role = getMember(id)?.role; return role === "radiologist" || role === "nurse"; }).length;
      const remaining = r.weekday_rad_nurse - filled;
      if (remaining > 0) {
        const rnPool = avail.filter(m => (m.role === "radiologist" || m.role === "nurse") && !used.has(m.id));
        pick(rnPool.filter(eligible), cnt, remaining, rnPool, sel, pairsMap, avoidMap, useRandom, personalCap, currentWeekCnt)
          .forEach(m => { result.push(m.id); used.add(m.id); sel.add(m.id); });
      }
      sched[d] = result;
    }

    const result = sched[d];
    const wkKey = getWeekKey(year, month, d);
    if (!weekCnt[wkKey]) weekCnt[wkKey] = {};
    if (isWeekend(dow)) {
      // Weekend team was pre-seeded (Fri+Sat+Sun block); don't double-count.
      const satDay = dow === 6 ? d : d - 1;
      const preSeededSet = new Set(weekendNonDocTeam[satDay] || []);
      result.forEach(id => {
        if (!preSeededSet.has(id) && cnt[id] !== undefined) cnt[id]++;
        if (!preSeededSet.has(id)) weekCnt[wkKey][id] = (weekCnt[wkKey][id] || 0) + 1;
      });
    } else if (isFriday(dow)) {
      // Friday uses next weekend's team; only skip increment if that Sat was pre-seeded
      // (i.e. it's not locked — locked weekends aren't in weekendNonDocTeam pre-seed).
      const satDay = d + 1;
      const nextSatPreseeded = satDay <= days && !(lockedDays && lockedDays.has(satDay));
      const preSeededFriSet = nextSatPreseeded ? new Set(weekendNonDocTeam[satDay] || []) : new Set();
      result.forEach(id => {
        if (!preSeededFriSet.has(id) && cnt[id] !== undefined) cnt[id]++;
        if (!preSeededFriSet.has(id)) weekCnt[wkKey][id] = (weekCnt[wkKey][id] || 0) + 1;
      });
    } else {
      result.forEach(id => {
        if (cnt[id] !== undefined) cnt[id]++;
        weekCnt[wkKey][id] = (weekCnt[wkKey][id] || 0) + 1;
      });
    }
  }
  return sched;
}
