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
  const staffingRequirements = getStaffingRequirements(); // { "曜日_シフト区分": {manager, nonManager, total} }

  let best = null;
  for (let trial = 0; trial < RULES.GENERATION_TRIALS; trial++) {
    const result = runOneTrial_(employees, dayList, requestByEmpAndDate, carryOver, staffingRequirements, trial);
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
    ALL_SHIFT_TYPES.forEach(shiftType => {
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
    grid: buildGridFromRows_(dayList, resultRows, staffingRequirements),
    employeeSummary: buildEmployeeSummary_(employees, resultRows)
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

function runOneTrial_(employees, dayList, requestByEmpAndDate, carryOverInit, staffingRequirements, trialSeed) {
  const weeklyCount = {};
  const weeklyLimit = {};
  const streak = {};
  const lastWorkedDate = {};
  const lastShiftType = {};
  employees.forEach(e => {
    weeklyCount[e['EmployeeID']] = 0;
    weeklyLimit[e['EmployeeID']] = getEmployeeWeeklyLimit_(e);
    const c = carryOverInit[e['EmployeeID']] || { streak: 0, lastShiftType: null, lastWorkedDate: null };
    streak[e['EmployeeID']] = c.streak;
    lastWorkedDate[e['EmployeeID']] = c.lastWorkedDate;
    lastShiftType[e['EmployeeID']] = c.lastShiftType;
  });

  const assignments = {};
  const shortfalls = [];
  let score = 0;

  dayList.forEach(d => {
    assignments[d.date] = { '早番': [], '遅番': [], '1日': [] };

    // 早番→遅番→1日の順で確定させる（遅番/1日の翌日早番禁止ルールに必要な順序）
    ALL_SHIFT_TYPES.forEach(shiftType => {
      const need = staffingRequirements[d.label + '_' + shiftType] || { manager: 0, nonManager: 0 };
      const shiftWeight = getShiftWeight_(shiftType);
      const alreadyAssignedToday = ALL_SHIFT_TYPES.reduce((acc, t) => acc.concat(assignments[d.date][t]), []);

      const baseCandidates = employees.filter(e => {
        const empId = e['EmployeeID'];
        if (alreadyAssignedToday.indexOf(empId) !== -1) return false; // 同日二重割当禁止（1日勤務との重複も含む）
        if (weeklyCount[empId] + shiftWeight > weeklyLimit[empId]) return false; // 「1日」は2回分として判定
        if (streak[empId] >= RULES.MAX_CONSECUTIVE_DAYS) return false; // 既に上限連勤

        const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
        if (reqType === REQUEST_TYPE.DAY_OFF) return false;
        if (reqType === REQUEST_TYPE.EARLY_ONLY && shiftType !== SHIFT_TYPES.EARLY) return false;
        if (reqType === REQUEST_TYPE.LATE_ONLY && shiftType !== SHIFT_TYPES.LATE) return false;

        // 前日が遅番、または「1日」(通し勤務＝遅番相当で終業)の場合は早番を配置しない
        if (shiftType === SHIFT_TYPES.EARLY) {
          const yesterday = formatDate_(addDays_(d.dateObj, -1));
          if (lastWorkedDate[empId] === yesterday &&
              (lastShiftType[empId] === SHIFT_TYPES.LATE || lastShiftType[empId] === SHIFT_TYPES.FULL_DAY)) {
            return false;
          }
        }
        return true;
      });

      const scored = e => {
        const empId = e['EmployeeID'];
        const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
        let pref = 0;
        if (shiftType === SHIFT_TYPES.EARLY && reqType === REQUEST_TYPE.PREFER_EARLY) pref = 2;
        if (shiftType === SHIFT_TYPES.LATE && reqType === REQUEST_TYPE.PREFER_LATE) pref = 2;
        const fairness = -weeklyCount[empId]; // 割当が少ないほど高スコア
        const jitter = pseudoRandom_(trialSeed, empId, d.date, shiftType);
        return pref * 10 + fairness + jitter;
      };
      const sortByScore = list => list
        .map(e => ({ emp: e, sortScore: scored(e) }))
        .sort((a, b) => b.sortScore - a.sortScore)
        .map(x => x.emp);

      // 資格保有者枠・資格非保有者枠を別々に埋める
      const managerPool = sortByScore(baseCandidates.filter(isManager_));
      const nonManagerPool = sortByScore(baseCandidates.filter(e => !isManager_(e)));

      const chosenManagers = managerPool.slice(0, need.manager);
      const chosenNonManagers = nonManagerPool.slice(0, need.nonManager);

      // 資格非保有者が不足する場合は、資格保有者(枠取り分を除いた余り)で代替可能とする
      // ※ 逆(資格保有者の必要人数を資格非保有者で埋める)は不可
      let coveredByManager = [];
      const nonManagerGap = need.nonManager - chosenNonManagers.length;
      if (nonManagerGap > 0) {
        const spareManagers = managerPool.slice(need.manager); // 資格保有者枠に使われなかった残り
        coveredByManager = spareManagers.slice(0, nonManagerGap);
      }

      if (chosenManagers.length < need.manager) {
        // 資格保有者の必要人数そのものは資格非保有者で代替できないため、これは実質的な不足
        shortfalls.push({
          date: d.date, shiftType: shiftType, category: '資格保有者',
          need: need.manager, actual: chosenManagers.length
        });
        score -= (need.manager - chosenManagers.length) * 100;
      }

      const actualTotal = chosenManagers.length + chosenNonManagers.length + coveredByManager.length;
      const needTotal = need.manager + need.nonManager;
      if (actualTotal < needTotal) {
        // 資格保有者での代替を試みてもなお埋まらない、純粋な人数不足
        shortfalls.push({
          date: d.date, shiftType: shiftType, category: '合計人数',
          need: needTotal, actual: actualTotal
        });
        score -= (needTotal - actualTotal) * 100;
      } else if (coveredByManager.length > 0) {
        // 代替が発生したこと自体は違反ではないが、わずかに減点して
        // 「本来の資格非保有者が確保できる場合はそちらを優先」する試行を後押しする
        score -= coveredByManager.length * 1;
      }

      chosenManagers.concat(chosenNonManagers).concat(coveredByManager).forEach(e => {
        const empId = e['EmployeeID'];
        assignments[d.date][shiftType].push(empId);
        weeklyCount[empId] += shiftWeight; // 「1日」は2回分としてカウント
        const yesterday = formatDate_(addDays_(d.dateObj, -1));
        streak[empId] = (lastWorkedDate[empId] === yesterday) ? streak[empId] + 1 : 1;
        lastWorkedDate[empId] = d.date;
        lastShiftType[empId] = shiftType;
        score += shiftWeight; // 割当成功ボーナス
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

/**
 * 従業員ごとの早番/遅番/1日/合計 回数を集計する。
 * 「1日」は2回分として合計にカウントする。
 * 0回のシフトの従業員も一覧に含める（割当が偏っていないか確認しやすくするため）。
 */
function buildEmployeeSummary_(employees, rows) {
  const countMap = {};
  employees.forEach(e => {
    const limit = getEmployeeWeeklyLimit_(e);
    countMap[e['EmployeeID']] = {
      employeeId: e['EmployeeID'],
      name: e['氏名'],
      isManager: isManager_(e),
      early: 0,
      late: 0,
      fullDay: 0,
      total: 0,
      limit: limit
    };
  });
  rows.forEach(r => {
    const entry = countMap[r['EmployeeID']];
    if (!entry) return; // 無効化された従業員などは除外
    const shiftType = r['シフト区分'];
    if (shiftType === SHIFT_TYPES.EARLY) entry.early += 1;
    if (shiftType === SHIFT_TYPES.LATE) entry.late += 1;
    if (shiftType === SHIFT_TYPES.FULL_DAY) entry.fullDay += 1;
    entry.total += getShiftWeight_(shiftType);
  });
  return Object.keys(countMap)
    .map(id => {
      const entry = countMap[id];
      entry.overLimit = entry.total > entry.limit;
      return entry;
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ja'));
}

function buildGridFromRows_(dayList, rows, staffingRequirements) {
  const requirements = staffingRequirements || getStaffingRequirements();
  const grid = {};
  dayList.forEach(d => {
    grid[d.date] = { label: d.label };
    ALL_SHIFT_TYPES.forEach(shiftType => {
      grid[d.date][shiftType] = {
        people: [],
        required: requirements[d.label + '_' + shiftType] || { manager: 0, nonManager: 0, total: 0 }
      };
    });
  });
  rows.forEach(r => {
    if (!grid[r['日付']]) return;
    grid[r['日付']][r['シフト区分']].people.push({
      employeeId: r['EmployeeID'],
      name: r['氏名'],
      isManager: r['責任者フラグ'] === '○'
    });
  });
  // 実際の人数集計（資格保有者/資格非保有者/合計）を付与
  Object.keys(grid).forEach(date => {
    ALL_SHIFT_TYPES.forEach(shiftType => {
      const cell = grid[date][shiftType];
      const managerCount = cell.people.filter(p => p.isManager).length;
      const nonManagerCount = cell.people.length - managerCount;
      cell.actual = { manager: managerCount, nonManager: nonManagerCount, total: cell.people.length };
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
  const staffingRequirements = getStaffingRequirements();
  const employees = getActiveEmployees_();
  return {
    weekStart: weekStartStr,
    grid: buildGridFromRows_(dayList, rows, staffingRequirements),
    employeeSummary: buildEmployeeSummary_(employees, rows),
    rowCount: rows.length
  };
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
