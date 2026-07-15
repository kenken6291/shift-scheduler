/**
 * ShiftGenerator.gs
 * Step2: 制約表(希望) を満たすように早番/遅番の初稿シフトを自動割当する。
 *
 * アプローチ: GAS内アルゴリズム（貪欲法 + 複数試行のベスト選択）
 *   - 20名×7日×2区分程度の規模であればLLM APIより決定的アルゴリズムの方が
 *     「必要人数」「責任者必須」「連勤上限」等のハード制約を確実に守れるため、
 *     こちらを採用。GENERATION_TRIALS回ランダム性を変えて試行し、
 *     欠員・希望違反が最も少ない結果を採用する。
 *   - 生成後のコメント文（従業員への案内メッセージ等）だけLLM APIに投げる、
 *     という併用は可能（後述コメント参照）。
 */

function generateDraftShift(weekStartStr) {
  const employees = getActiveEmployees_();
  const weekStartDate = new Date(weekStartStr);
  const dayList = WEEKDAY_JP.map((wd, i) => ({
    label: wd,
    date: formatDate_(addDays_(weekStartDate, i)),
    dateObj: addDays_(weekStartDate, i)
  }));

  const constraintTable = getWeekConstraintTable(weekStartStr).rows;
  const requestByEmpAndDate = {};
  constraintTable.forEach(row => {
    dayList.forEach(d => {
      requestByEmpAndDate[row['EmployeeID'] + '_' + d.date] = row[d.label] || REQUEST_TYPE.NONE;
    });
  });

  const carryOver = getCarryOverState_(weekStartDate, employees);

  let best = null;
  for (let trial = 0; trial < RULES.GENERATION_TRIALS; trial++) {
    const result = runOneTrial_(employees, dayList, requestByEmpAndDate, carryOver, trial);
    if (best === null || result.score > best.score) {
      best = result;
    }
  }

  // 完成シフトシートへ書き込み（当該週の既存データは洗い替え）
  clearRowsForWeek_(SHEET_NAMES.RESULT, weekStartStr);
  const empMap = {};
  employees.forEach(e => empMap[e['EmployeeID']] = e);

  const resultRows = [];
  dayList.forEach(d => {
    [SHIFT_TYPES.EARLY, SHIFT_TYPES.LATE].forEach(shiftType => {
      const assigned = best.assignments[d.date][shiftType] || [];
      assigned.forEach(empId => {
        const emp = empMap[empId];
        resultRows.push({
          '週開始日': weekStartStr,
          '日付': d.date,
          '曜日': d.label,
          'シフト区分': shiftType,
          'EmployeeID': empId,
          '氏名': emp ? emp['氏名'] : empId,
          '責任者フラグ': emp && isManager_(emp) ? '○' : '',
          'ステータス': '初稿'
        });
      });
    });
  });
  appendObjectRows_(SHEET_NAMES.RESULT, resultRows);

  return {
    weekStart: weekStartStr,
    shortfalls: best.shortfalls,
    grid: buildGridFromRows_(dayList, resultRows)
  };
}

/**
 * 前週末（週開始日の前日から遡って最大5日）の勤務実績から、
 * 「連続勤務日数の持ち越し」「週初日の遅番→早番禁止チェック」用の状態を作る
 */
function getCarryOverState_(weekStartDate, employees) {
  const prevResults = sheetToObjects_(SHEET_NAMES.RESULT);
  const state = {}; // empId -> { streak, lastShiftType, lastWorkedDate }
  employees.forEach(e => { state[e['EmployeeID']] = { streak: 0, lastShiftType: null, lastWorkedDate: null }; });

  const windowStart = addDays_(weekStartDate, -7);
  const windowEnd = addDays_(weekStartDate, -1);

  const relevant = prevResults.filter(r => {
    const d = r['日付'] instanceof Date ? r['日付'] : new Date(r['日付']);
    return d >= windowStart && d <= windowEnd;
  }).sort((a, b) => {
    const da = a['日付'] instanceof Date ? a['日付'] : new Date(a['日付']);
    const db = b['日付'] instanceof Date ? b['日付'] : new Date(b['日付']);
    return da - db;
  });

  relevant.forEach(r => {
    const empId = r['EmployeeID'];
    if (!state[empId]) return;
    const dateStr = r['日付'] instanceof Date ? formatDate_(r['日付']) : String(r['日付']);
    const prevWorked = state[empId].lastWorkedDate;
    const expectedPrevDay = formatDate_(addDays_(new Date(dateStr), -1));
    if (prevWorked === expectedPrevDay) {
      state[empId].streak += 1;
    } else {
      state[empId].streak = 1;
    }
    state[empId].lastWorkedDate = dateStr;
    state[empId].lastShiftType = r['シフト区分'];
  });

  return state;
}

function runOneTrial_(employees, dayList, requestByEmpAndDate, carryOverInit, trialSeed) {
  const weeklyCount = {};
  const streak = {};
  const lastWorkedDate = {};
  const lastShiftType = {};
  employees.forEach(e => {
    weeklyCount[e['EmployeeID']] = 0;
    const c = carryOverInit[e['EmployeeID']] || { streak: 0, lastShiftType: null, lastWorkedDate: null };
    streak[e['EmployeeID']] = c.streak;
    lastWorkedDate[e['EmployeeID']] = c.lastWorkedDate;
    lastShiftType[e['EmployeeID']] = c.lastShiftType;
  });

  const assignments = {};
  const shortfalls = [];
  let score = 0;

  dayList.forEach(d => {
    assignments[d.date] = { '早番': [], '遅番': [] };
    const weekend = isWeekend_(d.dateObj);
    const need = weekend ? REQUIRED_STAFF.weekend : REQUIRED_STAFF.weekday;

    // 早番を先に確定させる（遅番翌日早番禁止のルールに必要な順序）
    [SHIFT_TYPES.EARLY, SHIFT_TYPES.LATE].forEach(shiftType => {
      const requiredCount = need[shiftType];
      const alreadyAssignedToday = assignments[d.date][SHIFT_TYPES.EARLY].concat(assignments[d.date][SHIFT_TYPES.LATE]);

      let candidates = employees.filter(e => {
        const empId = e['EmployeeID'];
        if (alreadyAssignedToday.indexOf(empId) !== -1) return false; // 同日二重割当禁止
        if (weeklyCount[empId] >= RULES.MAX_WORK_DAYS_PER_WEEK) return false;
        if (streak[empId] >= RULES.MAX_CONSECUTIVE_DAYS) return false; // 既に上限連勤

        const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
        if (reqType === REQUEST_TYPE.DAY_OFF) return false;
        if (reqType === REQUEST_TYPE.EARLY_ONLY && shiftType !== SHIFT_TYPES.EARLY) return false;
        if (reqType === REQUEST_TYPE.LATE_ONLY && shiftType !== SHIFT_TYPES.LATE) return false;

        // 遅番の翌日に早番を配置しない
        if (shiftType === SHIFT_TYPES.EARLY) {
          const yesterday = formatDate_(addDays_(d.dateObj, -1));
          if (lastWorkedDate[empId] === yesterday && lastShiftType[empId] === SHIFT_TYPES.LATE) return false;
        }
        return true;
      });

      // スコアリング: 希望一致 > 割当回数少ない人優先(公平性) > ランダム性(試行多様化)
      candidates = candidates.map(e => {
        const empId = e['EmployeeID'];
        const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
        let pref = 0;
        if (shiftType === SHIFT_TYPES.EARLY && reqType === REQUEST_TYPE.PREFER_EARLY) pref = 2;
        if (shiftType === SHIFT_TYPES.LATE && reqType === REQUEST_TYPE.PREFER_LATE) pref = 2;
        const fairness = -weeklyCount[empId]; // 割当が少ないほど高スコア
        const jitter = pseudoRandom_(trialSeed, empId, d.date, shiftType);
        return { emp: e, sortScore: pref * 10 + fairness + jitter };
      }).sort((a, b) => b.sortScore - a.sortScore).map(x => x.emp);

      // 責任者を最低1名確保
      const managerCandidates = candidates.filter(isManager_);
      const chosen = [];
      if (managerCandidates.length > 0) {
        chosen.push(managerCandidates[0]);
      } else {
        score -= 50; // 責任者不在ペナルティ（後でValidationでも検出される）
      }
      candidates.forEach(e => {
        if (chosen.length >= requiredCount) return;
        if (chosen.indexOf(e) !== -1) return;
        chosen.push(e);
      });

      if (chosen.length < requiredCount) {
        shortfalls.push({ date: d.date, shiftType: shiftType, need: requiredCount, actual: chosen.length });
        score -= (requiredCount - chosen.length) * 100;
      }

      chosen.forEach(e => {
        const empId = e['EmployeeID'];
        assignments[d.date][shiftType].push(empId);
        weeklyCount[empId] += 1;
        const yesterday = formatDate_(addDays_(d.dateObj, -1));
        streak[empId] = (lastWorkedDate[empId] === yesterday) ? streak[empId] + 1 : 1;
        lastWorkedDate[empId] = d.date;
        lastShiftType[empId] = shiftType;
        score += 1; // 割当成功ボーナス
      });
    });
  });

  return { assignments, shortfalls, score };
}

// 試行ごとに結果を変えるための簡易疑似乱数（Math.randomより再現性の議論がしやすい）
function pseudoRandom_(seed, empId, dateStr, shiftType) {
  const str = seed + '_' + empId + '_' + dateStr + '_' + shiftType;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 1000;
  }
  return (hash % 100) / 100; // 0〜1未満のジッター
}

function buildGridFromRows_(dayList, rows) {
  const grid = {};
  dayList.forEach(d => {
    grid[d.date] = { label: d.label, '早番': [], '遅番': [] };
  });
  rows.forEach(r => {
    if (!grid[r['日付']]) return;
    grid[r['日付']][r['シフト区分']].push({
      employeeId: r['EmployeeID'],
      name: r['氏名'],
      isManager: r['責任者フラグ'] === '○'
    });
  });
  return grid;
}

function getShiftResult(weekStartStr) {
  const weekStartDate = new Date(weekStartStr);
  const dayList = WEEKDAY_JP.map((wd, i) => ({ label: wd, date: formatDate_(addDays_(weekStartDate, i)) }));
  const rows = sheetToObjects_(SHEET_NAMES.RESULT).filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr;
  });
  return { weekStart: weekStartStr, grid: buildGridFromRows_(dayList, rows), rowCount: rows.length };
}

function confirmShift(weekStartStr) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.RESULT);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: '対象週のシフトがありません' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const weekCol = headers.indexOf('週開始日') + 1;
  const statusCol = headers.indexOf('ステータス') + 1;
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  values.forEach((row, i) => {
    const w = row[weekCol - 1] instanceof Date ? formatDate_(row[weekCol - 1]) : String(row[weekCol - 1]);
    if (w === weekStartStr) {
      sheet.getRange(i + 2, statusCol).setValue('確定');
    }
  });
  return { success: true };
}
