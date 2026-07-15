/**
 * main.gs
 * Webアプリのエントリポイントと、クライアント(google.script.run)から呼ばれる公開関数群
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('シフト作成システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** index.html から <?!= include('Stylesheet') ?> のように呼ぶためのヘルパー */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ---------- 初期化 ---------- */

function initializeSpreadsheetStructure() {
  Object.keys(SHEET_NAMES).forEach(key => getOrCreateSheet_(SHEET_NAMES[key]));
  getOrCreateStaffingConfigSheet_(); // 必要人数設定に既定値(資格保有者/非保有者)を投入
  return { success: true };
}

/* ---------- 従業員 ---------- */

function apiGetEmployees() {
  return getActiveEmployees_();
}

/* ---------- Step1: 制約表 ---------- */

function apiSubmitShiftRequest(payload) {
  return submitShiftRequest(payload);
}

function apiGetConstraintTable(weekStartStr) {
  return getWeekConstraintTable(weekStartStr);
}

function apiGetEmployeeRequestsForWeek(employeeId, weekStartStr) {
  return getEmployeeRequestsForWeek(employeeId, weekStartStr);
}

/* ---------- Step2: シフト生成 ---------- */

// 必要人数設定(曜日×シフト区分ごとの資格保有者/資格非保有者人数)は
// StaffingConfigService.gs の apiGetStaffingConfig / apiUpdateStaffingConfig を
// google.script.run から直接呼び出す。

function apiGenerateDraftShift(weekStartStr) {
  return generateDraftShift(weekStartStr);
}

function apiGetShiftResult(weekStartStr) {
  return getShiftResult(weekStartStr);
}

function apiConfirmShift(weekStartStr) {
  return confirmShift(weekStartStr);
}

/* ---------- Step3: 違反チェック ---------- */

function apiRunValidation(weekStartStr) {
  return runValidation(weekStartStr);
}
