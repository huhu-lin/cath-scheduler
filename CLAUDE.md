# CLAUDE.md

此檔案提供 Claude Code (claude.ai/code) 在此專案中工作所需的指引。

## 常用指令

```bash
npm run dev        # 啟動本地開發伺服器（Vite HMR）
npm run build      # 產生正式版本 → dist/
npm run preview    # 本地預覽正式版本
npx eslint src/    # 執行 lint 檢查
```

部署透過 Vercel（push 到 `main` 自動觸發）。package.json 中的 `npm run deploy` 是舊的 gh-pages 腳本，已不再使用。

## 環境變數

需在專案根目錄建立 `.env` 檔案（已加入 .gitignore）：

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Vercel 儀表板已設定這兩個變數。Supabase 專案 ID 為 `qrkichzuegngsxnvwhgx`。

## 架構說明

整個應用程式集中在 **`src/App.jsx`** 一個檔案（約 2500 行），沒有拆分子元件。

### Supabase 資料表

| 資料表 | 用途 |
|---|---|
| `members` | 人員名單：`name`、`role`、`color`、`phone`、`is_admin`、`sort_order`、`email` |
| `schedules` | 每日排班：`year`、`month`、`day`、`member_id`、`manually_set` |
| `leaves` | 預假申請：`year`、`month`、`day`、`member_id` |
| `holidays` | 國定假日：`year`、`month`、`day`、`name` |
| `schedule_rules` | 單列設定（id=1）：各日型別的人力配額 |
| `member_pairs` | 偏好配對：`member_id_1`、`member_id_2` |

### 自動排班邏輯（`autoGenerate`）

核心演算法分兩段執行：

1. **預先計算（Pre-pass）** — 僅迭代每個週六，使用獨立的 `wkndCnt` 計數器挑選非醫師的週末班組，確保連續週末輪到不同人員。結果存入 `weekendNonDocTeam[satDay]`。
2. **預填計數（Pre-seed）** — 將週末班次數預先加入 `cnt`，使主迴圈排平日時自動降低已有週末班人員的優先度。
3. **主迴圈** — 逐日處理：
   - **已鎖定日**（`lockedDays` Set）：保留 `manualSchedule[d]` 的人員，再自動補滿其餘非醫師空缺。
   - **國定假日**：保留現有排班，不重新生成。
   - **週六日**：非醫師使用 `weekendNonDocTeam` 的預計算班組（週六日同一組）。**醫師不自動排班。**
   - **週五**：使用下週六班組 + 額外 1 位放射師或護理師。
   - **週一至週四**：從放射師／護理師名單中選人，達到 `weekday_rad_nurse` 配額。

**醫師永遠不自動排班** — 僅透過「👨‍⚕️ 填醫師班」快速填班視窗手動管理。

### 計分邏輯（`sortByScore`）

優先選取班次最少的人員。軟性平衡上限：若某人班次 ≥ `floor(poolAvg) + 1`，額外加 +2000 分懲罰。偏好配對減 −500 分。`useRandom=true` 時加入 0–0.9 的隨機噪音，使「重新排班」每次產生不同結果。

### `manually_set` / 鎖定日

透過 `toggleAssign` 手動指派時，DB 記錄以 `manually_set=true` 寫入。有任何 `manually_set=true` 記錄的日期會加入 `lockedDays` Set，並在 `manualSchedule` state 中追蹤。`saveFullSchedule` 只刪除 `manually_set=false` 的記錄，手動排班不受影響。

### 登入與權限

使用 Supabase email/password 驗證。登入後從 `members` 表依 email 查出 `currentUser`。`isAdmin = currentUser?.is_admin`。一般成員只能查看班表和申請預假；管理員才能執行自動排班、手動編輯、填醫師班、管理人員／假日／規則／配對。

### 頁面結構

`view` state：`"calendar"` | `"leave"` | `"admin"`（僅管理員可見）。  
管理頁子分頁（`adminTab`）：`"members"` | `"holidays"` | `"rules"` | `"pairs"`。

### 顯示排序

`ROLE_ORDER = { doctor: 0, radiologist: 1, nurse: 2, other: 3 }` — 用於日曆格內人員標籤的顯示順序（醫師→放射師→護理師）。
