import { ROLES, ROLE_LABELS } from "../lib/constants.js";
import { S } from "../styles.js";

export default function MemberForm({ member, onChange, onSave, onCancel, saving }) {
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
