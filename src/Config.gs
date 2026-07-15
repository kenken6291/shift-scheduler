/**
 * Config.gs
 * シート名・シフト区分・営業ルールなどの定数定義
 */

const SHEET_NAMES = {
  EMPLOYEE: '従業員マスタ',
  REQUEST: '希望シフト',
  CONSTRAINT: '制約表',
  RESULT: '完成シフト',
  VIOLATION: '違反ログ'
};

const SHEET_HEADERS = {
  EMPLOYEE: ['EmployeeID', '氏名', '資格', 'メールアドレス', '有効'],
  REQUEST: ['希望ID', 'EmployeeID', '週開始日', '日付', '希望区分', '備考', '提出日時'],
  CONSTRAINT: ['週開始日', 'EmployeeID', '氏名', '月', '火', '水', '木', '金', '土', '日'],
  RESULT: ['週開始日', '日付', '曜日', 'シフト区分', 'EmployeeID', '氏名', '責任者フラグ', 'ステータス'],
  VIOLATION: ['週開始日', 'チェック日時', '違反種別', '対象日', '対象シフト', 'EmployeeID', '氏名', '詳細', '深刻度']
};

const SHIFT_TYPES = {
  EARLY: '早番',
  LATE: '遅番'
};

const SHIFT_TIME_LABEL = {
  '早番': '9:00〜17:00',
  '遅番': '13:00〜21:00'
};

const WEEKDAY_JP = ['月', '火', '水', '木', '金', '土', '日'];

// 平日/週末ごとの必要人数
const REQUIRED_STAFF = {
  weekday: { '早番': 3, '遅番': 3 },
  weekend: { '早番': 4, '遅番': 4 }
};

// 希望区分の意味
const REQUEST_TYPE = {
  DAY_OFF: '休み希望',        // ハード：その日は入れない
  EARLY_ONLY: '早番のみ可',   // ハード：入れるなら早番のみ
  LATE_ONLY: '遅番のみ可',    // ハード：入れるなら遅番のみ
  PREFER_EARLY: '早番希望',   // ソフト：早番を優先
  PREFER_LATE: '遅番希望',    // ソフト：遅番を優先
  NONE: '指定なし'
};

const RULES = {
  MAX_WORK_DAYS_PER_WEEK: 5,
  MAX_CONSECUTIVE_DAYS: 5,
  GENERATION_TRIALS: 20 // 複数試行してベストなシフトを採用する
};

/**
 * 対象スプレッドシートを返す。
 * スクリプトプロパティに SPREADSHEET_ID を設定していればそれを優先し、
 * 未設定ならスタンドアロンScriptにバインドされたシートを使う想定。
 */
function getSpreadsheet() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (ssId) return SpreadsheetApp.openById(ssId);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function isWeekend_(dateObj) {
  const day = dateObj.getDay(); // 0:日, 6:土
  return day === 0 || day === 6;
}

function formatDate_(dateObj) {
  return Utilities.formatDate(dateObj, Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
}

function addDays_(dateObj, days) {
  const d = new Date(dateObj.getTime());
  d.setDate(d.getDate() + days);
  return d;
}
