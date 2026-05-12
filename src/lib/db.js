import { createClient } from "@supabase/supabase-js";
import { DEFAULT_RULES } from "./constants.js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export async function dbFetchMembers() {
  const { data, error } = await supabase.from("members").select("*").order("sort_order");
  if (error) throw error;
  return data;
}

export async function dbFetchSchedule(year, month) {
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
  const { data, error } = await supabase
    .from("holidays").select("*").eq("year", year).order("month").order("day");
  if (error) throw error;
  return data;
}

export async function dbFetchRules() {
  const { data, error } = await supabase.from("schedule_rules").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data || DEFAULT_RULES;
}

export async function dbFetchPairs() {
  const { data, error } = await supabase.from("member_pairs").select("*");
  if (error) throw error;
  return data;
}
