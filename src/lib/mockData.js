// 本機測試用假資料（無 Supabase 連線時自動使用）
export const MOCK_MEMBERS = [
  { id: 'doc1', name: '張育晟', role: 'doctor',       color: '#15803d', phone: '381978', is_admin: true,  sort_order: 1, email: 'admin@test.com' },
  { id: 'doc2', name: '陳彥旭', role: 'doctor',       color: '#166534', phone: '381080', is_admin: false, sort_order: 2, email: '' },
  { id: 'doc3', name: '朱永謙', role: 'doctor',       color: '#14532d', phone: '381273', is_admin: false, sort_order: 3, email: '' },
  { id: 'rad1', name: '施榮彰', role: 'radiologist',  color: '#1d4ed8', phone: '381016', is_admin: false, sort_order: 4, email: '' },
  { id: 'rad2', name: '潘泓智', role: 'radiologist',  color: '#1e40af', phone: '381081', is_admin: false, sort_order: 5, email: '' },
  { id: 'rad3', name: '許楹奇', role: 'radiologist',  color: '#1e3a8a', phone: '381978', is_admin: false, sort_order: 6, email: '' },
  { id: 'rad4', name: '林佩瑜', role: 'radiologist',  color: '#2563eb', phone: '0919805726', is_admin: false, sort_order: 7, email: '' },
  { id: 'nur1', name: '游雅雯', role: 'nurse',        color: '#dc2626', phone: '0963110765', is_admin: false, sort_order: 8, email: '' },
  { id: 'nur2', name: '廖宜澤', role: 'nurse',        color: '#b91c1c', phone: '0900765562', is_admin: false, sort_order: 9, email: '' },
  { id: 'nur3', name: '張花萍', role: 'nurse',        color: '#991b1b', phone: '0976822705', is_admin: false, sort_order: 10, email: '' },
];

export const MOCK_RULES = {
  weekday_rad_nurse: 3,
  weekend_radiologist: 1,
  weekend_nurse: 1,
  max_consecutive: 2,
};

export const MOCK_HOLIDAYS = [
  { id: 1, year: 2026, month: 5, day: 1, name: '勞動節' },
];

export const MOCK_PAIRS = [];
