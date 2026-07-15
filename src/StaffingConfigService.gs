/**
 * StaffingConfigService.gs
 * 「必要人数設定」シートの読み書き。
 * 曜日×シフト区分ごとに「資格保有者人数」「資格非保有者人数」を管理する。
 */

/**
 * シートを取得。存在しない/空の場合は既定値を投入する。
 */
function getOrCreateStaffingConfigSheet_() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.STAFFING_CONFIG);
  if (sheet.getLastRow() < 2) {
    appendObjectRows_(SHEET_NAMES.STAFFING_CONFIG, getDefaultStaffingConfig_());
  }
  return sheet;
}

/**
 * 必要人数設定を { "曜日_シフト区分": {manager, nonManager, total} } の形で返す
 */
function getStaffingRequirements() {
  getOrCreateStaffingConfigSheet_();
  const rows = sheetToObjects_(SHEET_NAMES.STAFFING_CONFIG);
  const map = {};
  rows.forEach(r => {
    const key = r['曜日'] + '_' + r['シフト区分'];
    map[key] = {
      manager: Number(r['資格保有者人数']) || 0,
      nonManager: Number(r['資格非保有者人数']) || 0,
      total: (Number(r['資格保有者人数']) || 0) + (Number(r['資格非保有者人数']) || 0)
    };
  });
  return map;
}

/**
 * フロント表示用: 一覧（曜日・シフト区分順）で返す
 */
function apiGetStaffingConfig() {
  getOrCreateStaffingConfigSheet_();
  const rows = sheetToObjects_(SHEET_NAMES.STAFFING_CONFIG);
  const order = {};
  WEEKDAY_JP.forEach((d, i) => { order[d] = i; });
  rows.sort((a, b) => {
    const dayDiff = order[a['曜日']] - order[b['曜日']];
    if (dayDiff !== 0) return dayDiff;
    return ALL_SHIFT_TYPES.indexOf(a['シフト区分']) - ALL_SHIFT_TYPES.indexOf(b['シフト区分']);
  });
  return rows;
}

/**
 * 管理者が編集した必要人数設定を保存する（全行洗い替え）
 * payload: [{ day, shiftType, manager, nonManager }, ...]
 */
function apiUpdateStaffingConfig(payload) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.STAFFING_CONFIG);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  const rows = payload.map(p => {
    const manager = Math.max(0, Number(p.manager) || 0);
    const nonManager = Math.max(0, Number(p.nonManager) || 0);
    return {
      '曜日': p.day,
      'シフト区分': p.shiftType,
      '資格保有者人数': manager,
      '資格非保有者人数': nonManager,
      '合計人数': manager + nonManager
    };
  });
  appendObjectRows_(SHEET_NAMES.STAFFING_CONFIG, rows);
  return { success: true, count: rows.length };
}
