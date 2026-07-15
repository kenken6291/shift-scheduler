/**
 * Config.gs
 * シート名・シフト区分・営業ルールなどの定数定義
 */

const SHEET_NAMES = {
  EMPLOYEE: '従業員マスタ',
  REQUEST: '希望シフト',
  CONSTRAINT: '制約表',
  RESULT: '完成シフト',
  VIOLATION: '違反ログ',
  STAFFING_CONFIG: '必要人数設定'
};

const SHEET_HEADERS = {
  EMPLOYEE: ['EmployeeID', '氏名', '資格', 'メールアドレス', '有効', '上限回数'],
  REQUEST: ['希望ID', 'EmployeeID', '週開始日', '日付', '希望区分', '備考', '提出日時'],
  CONSTRAINT: ['週開始日', 'EmployeeID', '氏名', '月', '火', '水', '木', '金', '土', '日'],
  RESULT: ['週開始日', '日付', '曜日', 'シフト区分', 'EmployeeID', '氏名', '責任者フラグ', 'ステータス'],
  VIOLATION: ['週開始日', 'チェック日時', '違反種別', '対象日', '対象シフト', 'EmployeeID', '氏名', '詳細', '深刻度'],
  STAFFING_CONFIG: ['曜日', 'シフト区分', '資格保有者人数', '資格非保有者人数', '合計人数']
};

const SHIFT_TYPES = {
  EARLY: '早番',
  LATE: '遅番',
  FULL_DAY: '1日'
};

const ALL_SHIFT_TYPES = [SHIFT_TYPES.EARLY, SHIFT_TYPES.LATE, SHIFT_TYPES.FULL_DAY];

const SHIFT_TIME_LABEL = {
  '早番': '9:00〜17:00',
  '遅番': '13:00〜21:00',
  '1日': '9:00〜21:00（早番+遅番の通し勤務）'
};

/**
 * シフト1回あたりの「出勤回数」への重み。
 * 「1日」は早番+遅番の通し勤務のため2回分としてカウントする。
 */
function getShiftWeight_(shiftType) {
  return shiftType === SHIFT_TYPES.FULL_DAY ? 2 : 1;
}

const WEEKDAY_JP = ['月', '火', '水', '木', '金', '土', '日'];

/**
 * 「必要人数設定」シートの既定値（初回のみ自動投入）。
 * 曜日×シフト区分ごとに 資格保有者人数 / 資格非保有者人数 を個別指定する。
 * 従来の「平日3名(責任者1+一般2)・土日4名(責任者1+一般3)」を初期値として踏襲。
 */
function getDefaultStaffingConfig_() {
  const rows = [];
  WEEKDAY_JP.forEach(day => {
    const weekend = (day === '土' || day === '日');
    ALL_SHIFT_TYPES.forEach(shiftType => {
      let manager = 1;
      let nonManager = weekend ? 3 : 2;
      if (shiftType === SHIFT_TYPES.FULL_DAY) {
        // 「1日」は通常運用では任意（必要な週だけ管理者が人数を設定する想定）のため既定0名
        manager = 0;
        nonManager = 0;
      }
      rows.push({
        '曜日': day,
        'シフト区分': shiftType,
        '資格保有者人数': manager,
        '資格非保有者人数': nonManager,
        '合計人数': manager + nonManager
      });
    });
  });
  return rows;
}

// 希望区分の意味
const REQUEST_TYPE = {
  DAY_OFF: '休み希望',         // ハード：その日は入れない
  EARLY_ONLY: '早番のみ可',    // ハード：入れるなら早番のみ
  LATE_ONLY: '遅番のみ可',     // ハード：入れるなら遅番のみ
  FULLDAY_ONLY: '1日のみ可',   // ハード：入れるなら1日(通し)のみ
  PREFER_EARLY: '早番希望',    // ソフト：早番を優先
  PREFER_LATE: '遅番希望',     // ソフト：遅番を優先
  PREFER_FULLDAY: '1日希望',   // ソフト：1日(通し)を優先
  NONE: '指定なし'
};

const RULES = {
  MAX_WORK_DAYS_PER_WEEK: 10, // 「上限回数」列が未設定の従業員に適用する既定値（「1日」は2回分カウントのため引き上げ）
  MAX_CONSECUTIVE_DAYS: 5,
  GENERATION_TRIALS: 20 // 複数試行してベストなシフトを採用する
};

/**
 * 従業員ごとの週の出勤回数上限を返す。
 * 「従業員マスタ」の「上限回数」列が空/0の場合は RULES.MAX_WORK_DAYS_PER_WEEK を既定値として使う。
 */
function getEmployeeWeeklyLimit_(emp) {
  const raw = Number(emp && emp['上限回数']);
  return (raw && raw > 0) ? raw : RULES.MAX_WORK_DAYS_PER_WEEK;
}

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
