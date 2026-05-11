# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start local dev server (Vite HMR)
npm run build      # production build → dist/
npm run preview    # preview production build locally
npx eslint src/    # lint
```

Deployment is via Vercel (auto-deploys on push to `main`). The `npm run deploy` script in package.json targets gh-pages and is no longer used.

## Environment Variables

Requires a `.env` file at the repo root (gitignored):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Vercel has these set in its dashboard. The Supabase project ID is `qrkichzuegngsxnvwhgx`.

## Architecture

The entire application lives in **`src/App.jsx`** (~2500 lines). There are no sub-components in separate files — everything is one module.

### Supabase Tables

| Table | Purpose |
|---|---|
| `members` | Staff roster: `name`, `role`, `color`, `phone`, `is_admin`, `sort_order`, `email` |
| `schedules` | Per-day assignments: `year`, `month`, `day`, `member_id`, `manually_set` |
| `leaves` | Leave requests: `year`, `month`, `day`, `member_id` |
| `holidays` | National holidays: `year`, `month`, `day`, `name` |
| `schedule_rules` | Single-row config (id=1): staffing quotas per day type |
| `member_pairs` | Preferred pairing: `member_id_1`, `member_id_2` |

### Auto-Scheduling Logic (`autoGenerate`)

The core algorithm runs in two passes:

1. **Pre-pass** — iterates Saturdays only, picks the shared non-doctor weekend team using a dedicated `wkndCnt` counter so successive weekends rotate to different staff. Result stored in `weekendNonDocTeam[satDay]`.
2. **Pre-seed** — adds expected weekend shift counts into `cnt` so weekday selection deprioritises staff already doing weekends.
3. **Main loop** — day by day:
   - **Locked days** (`lockedDays` Set): keeps `manualSchedule[d]` members, auto-fills remaining non-doctor slots.
   - **Holidays**: preserves existing schedule, no generation.
   - **Weekends**: uses `weekendNonDocTeam` for non-doctors (same team Sat+Sun). Doctors are NOT auto-assigned.
   - **Fridays**: uses next Saturday's team + 1 extra rad/nurse.
   - **Mon–Thu**: picks rad/nurse pool up to `weekday_rad_nurse` quota.

**Doctors are never auto-assigned** — they are managed exclusively via the "👨‍⚕️ 填醫師班" quick-fill modal.

### Scoring (`sortByScore`)

Picks lowest-shift-count members first. Soft balance cap: if a member's count ≥ `floor(poolAvg) + 1`, they get a +2000 penalty. Preferred pairs get −500. `useRandom=true` adds 0–0.9 noise for "regenerate different schedule" behaviour.

### `manually_set` / Locked Days

When a member is toggled via `toggleAssign`, the DB row is inserted with `manually_set=true`. Days that have any `manually_set=true` row are added to the `lockedDays` Set and tracked in `manualSchedule` state. `saveFullSchedule` only deletes `manually_set=false` rows, preserving manual assignments.

### Auth & Roles

Supabase email/password auth. After login, `currentUser` is looked up from the `members` table by email. `isAdmin = currentUser?.is_admin`. Non-admins can only view the schedule and submit leave requests. Admin-only actions: auto-generate, manual edit, doctor fill, manage members/holidays/rules/pairs.

### Views

`view` state: `"calendar"` | `"leave"` | `"admin"` (admin-only).  
Admin sub-tabs (`adminTab`): `"members"` | `"holidays"` | `"rules"` | `"pairs"`.

### Display Sort Order

`ROLE_ORDER = { doctor: 0, radiologist: 1, nurse: 2, other: 3 }` — applied when rendering member chips in calendar cells.
