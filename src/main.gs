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

/* ---------- Step2: シフト生成 ---------- */

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
