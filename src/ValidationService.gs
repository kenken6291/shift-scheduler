/**
 * ValidationService.gs
 * Step3: 完成シフトに対してビジネスルール違反を検出し、違反ログへ書き出す。
 */

function runValidation(weekStartStr) {
  const weekStartDate = new Date(weekStartStr);
  const dayList = WEEKDAY_JP.map((wd, i) => ({
    label: wd,
    date: formatDate_(addDays_(weekStartDate, i)),
    dateObj: addDays_(weekStartDate, i)
  }));

  const employees = getActiveEmployees_();
  const empMap = {};
  employees.forEach(e => empMap[e['EmployeeID']] = e);

  const rows = sheetToObjects_(SHEET_NAMES.RESULT).filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr;
  });

  const violations = [];

  // 1) 必要人数チェック（曜日×シフトごと）
  //    資格非保有者の枠は資格保有者で代替してよいため、
  //    「資格保有者不足」＝資格保有者の必要数そのものが満たせていない場合のみ厳格にチェックし、
  //    資格非保有者の不足は「合計人数」が代替後もなお満たせていない場合のみ違反として扱う。
  const staffingRequirements = getStaffingRequirements();
  dayList.forEach(d => {
    ALL_SHIFT_TYPES.forEach(shiftType => {
      const need = staffingRequirements[d.label + '_' + shiftType] || { manager: 0, nonManager: 0 };
      const needTotal = need.manager + need.nonManager;
      const slotRows = rows.filter(r => r['日付'] === d.date && r['シフト区分'] === shiftType);
      const managerCount = slotRows.filter(r => r['責任者フラグ'] === '○').length;
      const totalCount = slotRows.length;

      if (managerCount < need.manager) {
        violations.push(mkViolation_(weekStartStr, '資格保有者不足', d.date, shiftType, '', '',
          `${d.label}(${d.date}) ${shiftType}: 資格保有者が必要${need.manager}名に対し${managerCount}名`, 'エラー'));
      }
      if (totalCount < needTotal) {
        violations.push(mkViolation_(weekStartStr, '合計人数不足', d.date, shiftType, '', '',
          `${d.label}(${d.date}) ${shiftType}: 必要合計${needTotal}名（資格保有者による代替を含む）に対し${totalCount}名`, 'エラー'));
      }
    });
  });

  // 2) 週の勤務回数 > 担当者ごとの上限 チェック（「1日」は2回分としてカウント）
  const countByEmp = {};
  rows.forEach(r => {
    const weight = getShiftWeight_(r['シフト区分']);
    countByEmp[r['EmployeeID']] = (countByEmp[r['EmployeeID']] || 0) + weight;
  });
  Object.keys(countByEmp).forEach(empId => {
    const emp = empMap[empId];
    const limit = emp ? getEmployeeWeeklyLimit_(emp) : RULES.MAX_WORK_DAYS_PER_WEEK;
    if (countByEmp[empId] > limit) {
      violations.push(mkViolation_(weekStartStr, '週出勤回数超過', '', '', empId, emp ? emp['氏名'] : '',
        `週${countByEmp[empId]}回勤務（「1日」は2回分カウント／上限${limit}回）`, 'エラー'));
    }
  });

  // 3) 連続勤務 > 5日 チェック（前週末からの持ち越しも考慮）
  const carryOver = getCarryOverState_(weekStartDate, employees);
  employees.forEach(emp => {
    const empId = emp['EmployeeID'];
    let streak = carryOver[empId] ? carryOver[empId].streak : 0;
    let lastWorkedDate = carryOver[empId] ? carryOver[empId].lastWorkedDate : null;

    dayList.forEach(d => {
      const todayRows = rows.filter(r => r['日付'] === d.date && r['EmployeeID'] === empId);
      if (todayRows.length === 0) {
        return;
      }
      const shiftType = todayRows[0]['シフト区分'];
      const yesterday = formatDate_(addDays_(d.dateObj, -1));

      streak = (lastWorkedDate === yesterday) ? streak + 1 : 1;
      if (streak > RULES.MAX_CONSECUTIVE_DAYS) {
        violations.push(mkViolation_(weekStartStr, '連続勤務超過', d.date, shiftType, empId, emp['氏名'],
          `${d.label}(${d.date})時点で${streak}連勤（上限${RULES.MAX_CONSECUTIVE_DAYS}日）`, 'エラー'));
      }
      lastWorkedDate = d.date;
    });
  });

  // 4) 希望休なのに勤務になっているケース（警告）
  const constraintRows = getWeekConstraintTable(weekStartStr).rows;
  dayList.forEach(d => {
    constraintRows.forEach(cRow => {
      const reqType = cRow[d.label];
      if (reqType !== REQUEST_TYPE.DAY_OFF) return;
      const empId = cRow['EmployeeID'];
      const assigned = rows.find(r => r['日付'] === d.date && r['EmployeeID'] === empId);
      if (assigned) {
        violations.push(mkViolation_(weekStartStr, '希望休違反', d.date, assigned['シフト区分'], empId, cRow['氏名'],
          `${d.label}(${d.date})は休み希望でしたが${assigned['シフト区分']}に配置されています`, '警告'));
      }
    });
  });

  clearRowsForWeek_(SHEET_NAMES.VIOLATION, weekStartStr);
  appendObjectRows_(SHEET_NAMES.VIOLATION, violations);

  return {
    weekStart: weekStartStr,
    total: violations.length,
    errorCount: violations.filter(v => v['深刻度'] === 'エラー').length,
    warningCount: violations.filter(v => v['深刻度'] === '警告').length,
    violations: violations
  };
}

function mkViolation_(weekStart, type, date, shiftType, empId, empName, detail, severity) {
  return {
    '週開始日': weekStart,
    'チェック日時': new Date(),
    '違反種別': type,
    '対象日': date,
    '対象シフト': shiftType,
    'EmployeeID': empId,
    '氏名': empName,
    '詳細': detail,
    '深刻度': severity
  };
}
