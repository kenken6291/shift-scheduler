/**
 * SheetService.gs
 * スプレッドシート読み書きの共通ユーティリティ。
 * ヘッダー行をキーにしたオブジェクト配列 <-> シート のマッピングを担当する。
 */

/**
 * 指定シートを取得。無ければヘッダー付きで新規作成する。
 */
function getOrCreateSheet_(sheetName) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const headers = SHEET_HEADERS[headerKeyFromSheetName_(sheetName)];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function headerKeyFromSheetName_(sheetName) {
  return Object.keys(SHEET_NAMES).find(k => SHEET_NAMES[k] === sheetName);
}

/**
 * シートの全データをヘッダーキーのオブジェクト配列として取得
 */
function sheetToObjects_(sheetName) {
  const sheet = getOrCreateSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return values
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

/**
 * 「従業員マスタ」シートに「上限回数」列が無い場合、末尾に自動追加する。
 * (機能追加前に作成済みのスプレッドシートとの互換性のため)
 */
function ensureEmployeeLimitColumn_() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EMPLOYEE);
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (headers.indexOf('上限回数') === -1) {
    sheet.getRange(1, lastCol + 1).setValue('上限回数');
  }
}

/**
 * オブジェクトをヘッダー順に整形して1行追加
 */
function appendObjectRow_(sheetName, obj) {
  const sheet = getOrCreateSheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
}

/**
 * 複数オブジェクトをまとめて追記（高速化のためバッチ書き込み）
 */
function appendObjectRows_(sheetName, objects) {
  if (!objects || objects.length === 0) return;
  const sheet = getOrCreateSheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = objects.map(obj => headers.map(h => (obj[h] !== undefined ? obj[h] : '')));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/**
 * 指定シートの「週開始日」列が weekStartStr に一致する行をすべて削除する。
 * (シフト再生成・再チェック時に前回分をクリアするために使用)
 */
function clearRowsForWeek_(sheetName, weekStartStr) {
  const sheet = getOrCreateSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const weekColIndex = headers.indexOf('週開始日');
  if (weekColIndex === -1) return;
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  // 下から削除しないと行番号がズレるため逆順で処理
  for (let i = values.length - 1; i >= 0; i--) {
    const cellVal = values[i][weekColIndex];
    const cellStr = cellVal instanceof Date ? formatDate_(cellVal) : String(cellVal);
    if (cellStr === weekStartStr) {
      sheet.deleteRow(i + 2);
    }
  }
}
