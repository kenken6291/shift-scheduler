/**
 * ConstraintService.gs
 * Step1: 従業員マスタ + 希望シフト(生データ) -> 制約表(週×従業員のマトリクス) を生成する
 */

/**
 * 従業員一覧（有効な人のみ）を取得
 */
function getActiveEmployees_() {
  return sheetToObjects_(SHEET_NAMES.EMPLOYEE).filter(e => e['有効'] === true || e['有効'] === 'TRUE' || e['有効'] === 1);
}

function isManager_(employee) {
  const v = employee['資格'];
  return v === true || v === 'TRUE' || v === '責任者' || v === 1;
}

/**
 * 従業員から新しい希望シフトを登録する（Webフォームからの入力を受ける）
 * 同一従業員・同一日付の既存データがあれば上書きする。
 */
function submitShiftRequest(payload) {
  // payload: { employeeId, weekStart, entries: [{date, type, note}] }
  const sheet = getOrCreateSheet_(SHEET_NAMES.REQUEST);
  const existing = sheetToObjects_(SHEET_NAMES.REQUEST);
  const lastRow = sheet.getLastRow();

  // 同一 従業員×日付 の既存行を削除（下から）
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      const row = values[i];
      const empId = row[1];
      const dateStr = row[3] instanceof Date ? formatDate_(row[3]) : String(row[3]);
      const targetDates = payload.entries.map(e => e.date);
      if (String(empId) === String(payload.employeeId) && targetDates.indexOf(dateStr) !== -1) {
        sheet.deleteRow(i + 2);
      }
    }
  }

  const newRows = payload.entries.map(entry => ({
    '希望ID': Utilities.getUuid(),
    'EmployeeID': payload.employeeId,
    '週開始日': payload.weekStart,
    '日付': entry.date,
    '希望区分': entry.type,
    '備考': entry.note || '',
    '提出日時': new Date()
  }));
  appendObjectRows_(SHEET_NAMES.REQUEST, newRows);

  // 提出のたびに制約表を最新化しておく
  buildConstraintTable(payload.weekStart);
  return { success: true, count: newRows.length };
}

/**
 * 指定従業員・指定週の提出済み希望を { "日付": "希望区分" } の形で返す。
 * Webフォームで既存の提出内容をプリフィルするために使用する。
 */
function getEmployeeRequestsForWeek(employeeId, weekStartStr) {
  const allRequests = sheetToObjects_(SHEET_NAMES.REQUEST);
  const map = {};
  allRequests.forEach(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    if (w !== weekStartStr) return;
    if (String(r['EmployeeID']) !== String(employeeId)) return;
    const dateStr = r['日付'] instanceof Date ? formatDate_(r['日付']) : String(r['日付']);
    map[dateStr] = r['希望区分'];
  });
  return map;
}

/**
 * 指定週の希望シフト生データを 従業員×曜日 のマトリクスに変換し、
 * 「制約表」シートへ書き出す。フロントの画面表示にもそのまま使う。
 */
function buildConstraintTable(weekStartStr) {
  const employees = getActiveEmployees_();
  const allRequests = sheetToObjects_(SHEET_NAMES.REQUEST);
  const weekStartDate = new Date(weekStartStr);

  const dayDates = WEEKDAY_JP.map((_, i) => formatDate_(addDays_(weekStartDate, i)));

  const requestsThisWeek = allRequests.filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr;
  });

  const rows = employees.map(emp => {
    const row = {
      '週開始日': weekStartStr,
      'EmployeeID': emp['EmployeeID'],
      '氏名': emp['氏名']
    };
    WEEKDAY_JP.forEach((wd, i) => {
      const dateStr = dayDates[i];
      const req = requestsThisWeek.find(r => {
        const rDate = r['日付'] instanceof Date ? formatDate_(r['日付']) : String(r['日付']);
        return String(r['EmployeeID']) === String(emp['EmployeeID']) && rDate === dateStr;
      });
      row[wd] = req ? req['希望区分'] : REQUEST_TYPE.NONE;
    });
    return row;
  });

  clearRowsForWeek_(SHEET_NAMES.CONSTRAINT, weekStartStr);
  appendObjectRows_(SHEET_NAMES.CONSTRAINT, rows);

  return {
    weekStart: weekStartStr,
    days: WEEKDAY_JP.map((wd, i) => ({ label: wd, date: dayDates[i] })),
    rows: rows
  };
}

/**
 * フロント表示用: 既存の制約表があればそれを、無ければ生成して返す
 */
function getWeekConstraintTable(weekStartStr) {
  const existing = sheetToObjects_(SHEET_NAMES.CONSTRAINT).filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr;
  });
  if (existing.length > 0) {
    const weekStartDate = new Date(weekStartStr);
    const days = WEEKDAY_JP.map((wd, i) => ({ label: wd, date: formatDate_(addDays_(weekStartDate, i)) }));
    return { weekStart: weekStartStr, days: days, rows: existing };
  }
  return buildConstraintTable(weekStartStr);
}
