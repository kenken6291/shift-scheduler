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

  // 単発で手動追加されたシフト（「シフトの手動追加」機能）を取得し、
  // 自動生成では「既に確定している割当」として扱う（上書き・重複割当をしない）
  ensureResultRegistrationMethodColumn_();
  const manualRows = sheetToObjects_(SHEET_NAMES.RESULT).filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr && r['登録方法'] === '手動';
  });
  const manualByDate = {};
  dayList.forEach(d => { manualByDate[d.date] = { '早番': [], '遅番': [], '1日': [] }; });
  manualRows.forEach(r => {
    const dateStr = r['日付'] instanceof Date ? formatDate_(r['日付']) : String(r['日付']);
    if (manualByDate[dateStr] && manualByDate[dateStr][r['シフト区分']]) {
      manualByDate[dateStr][r['シフト区分']].push(r['EmployeeID']);
    }
  });

  let best = null;
  for (let trial = 0; trial < RULES.GENERATION_TRIALS; trial++) {
    const result = runOneTrial_(employees, dayList, requestByEmpAndDate, carryOver, staffingRequirements, manualByDate, trial);
    if (best === null || result.score > best.score) {
      best = result;
    }
  }

  // 完成シフトシートへ書き込み（自動生成行のみ洗い替え。手動追加行は保持）
  clearGeneratedRowsForWeek_(weekStartStr);
  const empMap = {};
  employees.forEach(e => empMap[e['EmployeeID']] = e);

  const autoResultRows = [];
  dayList.forEach(d => {
    ALL_SHIFT_TYPES.forEach(shiftType => {
      const manualIds = manualByDate[d.date][shiftType] || [];
      const assigned = best.assignments[d.date][shiftType] || [];
      const autoAssignedIds = assigned.filter(empId => manualIds.indexOf(empId) === -1);
      autoAssignedIds.forEach(empId => {
        const emp = empMap[empId];
        autoResultRows.push({
          '週開始日': weekStartStr,
          '日付': d.date,
          '曜日': d.label,
          'シフト区分': shiftType,
          'EmployeeID': empId,
          '氏名': emp ? emp['氏名'] : empId,
          '責任者フラグ': emp && isManager_(emp) ? '○' : '',
          'ステータス': '初稿',
          '登録方法': '自動'
        });
      });
    });
  });
  appendObjectRows_(SHEET_NAMES.RESULT, autoResultRows);

  // 画面表示用には、保持した手動追加行＋今回の自動生成行の両方を合わせて渡す
  const allRowsForDisplay = manualRows.concat(autoResultRows);

  return {
    weekStart: weekStartStr,
    shortfalls: best.shortfalls,
    grid: buildGridFromRows_(dayList, allRowsForDisplay, staffingRequirements),
    employeeSummary: buildEmployeeSummary_(employees, allRowsForDisplay)
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

// シフト種別の処理順序：1日(ハード)→1日(ソフト)→早番→遅番。
// 「1日」は専用の必要人数を持たず、割り当てられると早番・遅番双方の
// 残り必要人数を1名分ずつ自動的に満たす（資格保有者/資格非保有者は区別して減算）。
const GENERATION_ORDER = [SHIFT_TYPES.FULL_DAY, SHIFT_TYPES.EARLY, SHIFT_TYPES.LATE];

function runOneTrial_(employees, dayList, requestByEmpAndDate, carryOverInit, staffingRequirements, manualByDate, trialSeed) {
  const weeklyCount = {};
  const weeklyLimit = {};
  const streak = {};
  const lastWorkedDate = {};
  const lastShiftType = {};
  const empById = {};
  employees.forEach(e => {
    empById[e['EmployeeID']] = e;
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

    const earlyNeed = staffingRequirements[d.label + '_' + SHIFT_TYPES.EARLY] || { manager: 0, nonManager: 0 };
    const lateNeed = staffingRequirements[d.label + '_' + SHIFT_TYPES.LATE] || { manager: 0, nonManager: 0 };
    // 早番・遅番それぞれの「残り必要人数」。手動追加・1日勤務で満たされるたびに減算していく。
    let remEarlyMgr = earlyNeed.manager;
    let remEarlyNonMgr = earlyNeed.nonManager;
    let remLateMgr = lateNeed.manager;
    let remLateNonMgr = lateNeed.nonManager;

    const alreadyAssignedToday = () => ALL_SHIFT_TYPES.reduce((acc, t) => acc.concat(assignments[d.date][t]), []);

    const isEligible = (e, shiftType) => {
      const empId = e['EmployeeID'];
      const weight = getShiftWeight_(shiftType);
      if (alreadyAssignedToday().indexOf(empId) !== -1) return false; // 同日二重割当禁止（1日勤務との重複も含む）
      if (weeklyCount[empId] + weight > weeklyLimit[empId]) return false; // 「1日」は2回分として判定
      if (streak[empId] >= RULES.MAX_CONSECUTIVE_DAYS) return false; // 既に上限連勤

      const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
      if (reqType === REQUEST_TYPE.DAY_OFF) return false;
      if (reqType === REQUEST_TYPE.EARLY_ONLY && shiftType !== SHIFT_TYPES.EARLY) return false;
      if (reqType === REQUEST_TYPE.LATE_ONLY && shiftType !== SHIFT_TYPES.LATE) return false;
      if (reqType === REQUEST_TYPE.FULLDAY_ONLY && shiftType !== SHIFT_TYPES.FULL_DAY) return false;

      // 前日が遅番、または「1日」(通し勤務＝遅番相当で終業)の場合は早番を配置しない
      if (shiftType === SHIFT_TYPES.EARLY) {
        const yesterday = formatDate_(addDays_(d.dateObj, -1));
        if (lastWorkedDate[empId] === yesterday &&
            (lastShiftType[empId] === SHIFT_TYPES.LATE || lastShiftType[empId] === SHIFT_TYPES.FULL_DAY)) {
          return false;
        }
      }
      return true;
    };

    const scoreOf = (e, shiftType) => {
      const empId = e['EmployeeID'];
      const reqType = requestByEmpAndDate[empId + '_' + d.date] || REQUEST_TYPE.NONE;
      let pref = 0;
      if (shiftType === SHIFT_TYPES.EARLY && reqType === REQUEST_TYPE.PREFER_EARLY) pref = 2;
      if (shiftType === SHIFT_TYPES.LATE && reqType === REQUEST_TYPE.PREFER_LATE) pref = 2;
      if (shiftType === SHIFT_TYPES.FULL_DAY && reqType === REQUEST_TYPE.PREFER_FULLDAY) pref = 5; // 1日希望
      if (shiftType === SHIFT_TYPES.FULL_DAY && reqType === REQUEST_TYPE.FULLDAY_ONLY) pref = 10; // 1日のみ可を最優先
      const fairness = -weeklyCount[empId]; // 割当が少ないほど高スコア
      const jitter = pseudoRandom_(trialSeed, empId, d.date, shiftType);
      return pref * 10 + fairness + jitter;
    };
    const sortByScore = (list, shiftType) => list
      .map(e => ({ emp: e, sortScore: scoreOf(e, shiftType) }))
      .sort((a, b) => b.sortScore - a.sortScore)
      .map(x => x.emp);

    const finalizeAssignment = (e, shiftType) => {
      const empId = e['EmployeeID'];
      assignments[d.date][shiftType].push(empId);
      const weight = getShiftWeight_(shiftType);
      weeklyCount[empId] += weight;
      const yesterday = formatDate_(addDays_(d.dateObj, -1));
      streak[empId] = (lastWorkedDate[empId] === yesterday) ? streak[empId] + 1 : 1;
      lastWorkedDate[empId] = d.date;
      lastShiftType[empId] = shiftType;
      score += weight;
    };

    // ---- 手動追加分の反映（1日は早番・遅番双方の残り必要人数から1ずつ差し引く） ----
    GENERATION_ORDER.forEach(shiftType => {
      const manualIds = (manualByDate[d.date] && manualByDate[d.date][shiftType]) || [];
      manualIds.forEach(empId => {
        if (assignments[d.date][shiftType].indexOf(empId) !== -1) return; // 念のため重複防止
        const emp = empById[empId];
        assignments[d.date][shiftType].push(empId);
        const weight = getShiftWeight_(shiftType);
        weeklyCount[empId] = (weeklyCount[empId] || 0) + weight;
        const yesterday = formatDate_(addDays_(d.dateObj, -1));
        streak[empId] = (lastWorkedDate[empId] === yesterday) ? (streak[empId] || 0) + 1 : 1;
        lastWorkedDate[empId] = d.date;
        lastShiftType[empId] = shiftType;

        const mgr = emp && isManager_(emp);
        if (shiftType === SHIFT_TYPES.FULL_DAY) {
          if (mgr) { remEarlyMgr = Math.max(0, remEarlyMgr - 1); remLateMgr = Math.max(0, remLateMgr - 1); }
          else { remEarlyNonMgr = Math.max(0, remEarlyNonMgr - 1); remLateNonMgr = Math.max(0, remLateNonMgr - 1); }
        } else if (shiftType === SHIFT_TYPES.EARLY) {
          if (mgr) remEarlyMgr = Math.max(0, remEarlyMgr - 1); else remEarlyNonMgr = Math.max(0, remEarlyNonMgr - 1);
        } else {
          if (mgr) remLateMgr = Math.max(0, remLateMgr - 1); else remLateNonMgr = Math.max(0, remLateNonMgr - 1);
        }
      });
    });

    // ---- Step A: 「1日のみ可」(ハード)を最優先で確定。早番・遅番双方の残り必要人数から1ずつ差し引く ----
    const fulldayHardCandidates = sortByScore(
      employees.filter(e => isEligible(e, SHIFT_TYPES.FULL_DAY) &&
        requestByEmpAndDate[e['EmployeeID'] + '_' + d.date] === REQUEST_TYPE.FULLDAY_ONLY),
      SHIFT_TYPES.FULL_DAY
    );
    fulldayHardCandidates.forEach(e => {
      finalizeAssignment(e, SHIFT_TYPES.FULL_DAY);
      if (isManager_(e)) { remEarlyMgr = Math.max(0, remEarlyMgr - 1); remLateMgr = Math.max(0, remLateMgr - 1); }
      else { remEarlyNonMgr = Math.max(0, remEarlyNonMgr - 1); remLateNonMgr = Math.max(0, remLateNonMgr - 1); }
    });

    // ---- Step B: 「1日希望」(ソフト)を、早番・遅番双方にまだ残り必要人数がある範囲でのみ採用 ----
    const fulldaySoftCandidates = sortByScore(
      employees.filter(e => isEligible(e, SHIFT_TYPES.FULL_DAY) &&
        requestByEmpAndDate[e['EmployeeID'] + '_' + d.date] === REQUEST_TYPE.PREFER_FULLDAY),
      SHIFT_TYPES.FULL_DAY
    );
    fulldaySoftCandidates.forEach(e => {
      const mgr = isManager_(e);
      if (mgr && remEarlyMgr > 0 && remLateMgr > 0) {
        finalizeAssignment(e, SHIFT_TYPES.FULL_DAY);
        remEarlyMgr -= 1; remLateMgr -= 1;
      } else if (!mgr && remEarlyNonMgr > 0 && remLateNonMgr > 0) {
        finalizeAssignment(e, SHIFT_TYPES.FULL_DAY);
        remEarlyNonMgr -= 1; remLateNonMgr -= 1;
      }
      // 早番・遅番どちらかの残り必要人数が0の場合は、1日ではなく通常のシフト希望として扱われる
    });

    // ---- Step C・D: 早番／遅番それぞれの残り必要人数を通常通り埋める ----
    const fillNormalShift = (shiftType, needMgr, needNonMgr, originalNeed) => {
      const candidates = employees.filter(e => isEligible(e, shiftType));
      const managerPool = sortByScore(candidates.filter(isManager_), shiftType);
      const nonManagerPool = sortByScore(candidates.filter(e => !isManager_(e)), shiftType);

      const chosenManagers = managerPool.slice(0, needMgr);
      const chosenNonManagers = nonManagerPool.slice(0, needNonMgr);

      // 資格非保有者が不足する場合は、資格保有者(枠取り分を除いた余り)で代替可能とする
      let coveredByManager = [];
      const nonManagerGap = needNonMgr - chosenNonManagers.length;
      if (nonManagerGap > 0) {
        const spareManagers = managerPool.slice(needMgr);
        coveredByManager = spareManagers.slice(0, nonManagerGap);
      }

      // 手動追加・1日勤務で既にカバー済みの人数も含めて、元の必要人数と比較する
      const alreadyCoveredManager = originalNeed.manager - needMgr;
      const alreadyCoveredNonManager = originalNeed.nonManager - needNonMgr;

      const totalManagerCount = alreadyCoveredManager + chosenManagers.length;
      if (totalManagerCount < originalNeed.manager) {
        shortfalls.push({
          date: d.date, shiftType: shiftType, category: '資格保有者',
          need: originalNeed.manager, actual: totalManagerCount
        });
        score -= (originalNeed.manager - totalManagerCount) * 100;
      }

      const actualTotal = alreadyCoveredManager + alreadyCoveredNonManager + chosenManagers.length + chosenNonManagers.length + coveredByManager.length;
      const needTotal = originalNeed.manager + originalNeed.nonManager;
      if (actualTotal < needTotal) {
        shortfalls.push({
          date: d.date, shiftType: shiftType, category: '合計人数',
          need: needTotal, actual: actualTotal
        });
        score -= (needTotal - actualTotal) * 100;
      } else if (coveredByManager.length > 0) {
        score -= coveredByManager.length * 1;
      }

      chosenManagers.concat(chosenNonManagers).concat(coveredByManager).forEach(e => finalizeAssignment(e, shiftType));
    };

    fillNormalShift(SHIFT_TYPES.EARLY, remEarlyMgr, remEarlyNonMgr, earlyNeed);
    fillNormalShift(SHIFT_TYPES.LATE, remLateMgr, remLateNonMgr, lateNeed);
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
      // 「1日」自体は専用の必要人数を持たない
      const req = STAFFING_SHIFT_TYPES.indexOf(shiftType) !== -1
        ? (requirements[d.label + '_' + shiftType] || { manager: 0, nonManager: 0, total: 0 })
        : { manager: 0, nonManager: 0, total: 0 };
      grid[d.date][shiftType] = { people: [], required: req };
    });
  });
  rows.forEach(r => {
    if (!grid[r['日付']]) return;
    const shiftType = r['シフト区分'];
    const personObj = {
      employeeId: r['EmployeeID'],
      name: r['氏名'],
      isManager: r['責任者フラグ'] === '○',
      isFullDay: shiftType === SHIFT_TYPES.FULL_DAY
    };
    if (shiftType === SHIFT_TYPES.FULL_DAY) {
      // 「1日」は早番・遅番双方の必要人数を満たすため、両方のセルにも表示する
      grid[r['日付']][SHIFT_TYPES.EARLY].people.push(personObj);
      grid[r['日付']][SHIFT_TYPES.LATE].people.push(personObj);
      grid[r['日付']][SHIFT_TYPES.FULL_DAY].people.push(personObj);
    } else {
      grid[r['日付']][shiftType].people.push(personObj);
    }
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

/**
 * シフトを1件だけ手動で「完成シフト」に追加する（単発の1日勤務などを想定）。
 * 同一従業員・同一日付の既存行があれば削除してから追加する（重複防止・上書き）。
 * payload: { date: 'YYYY-MM-DD', employeeId, shiftType }
 */
function addManualShiftEntry(payload) {
  if (ALL_SHIFT_TYPES.indexOf(payload.shiftType) === -1) {
    return { success: false, message: 'シフト区分が不正です' };
  }

  const dateObj = new Date(payload.date);
  if (isNaN(dateObj.getTime())) {
    return { success: false, message: '日付が不正です' };
  }
  const dayIndex = (dateObj.getDay() + 6) % 7; // 月曜=0
  const weekStartDate = addDays_(dateObj, -dayIndex);
  const weekStartStr = formatDate_(weekStartDate);
  const dayLabel = WEEKDAY_JP[dayIndex];

  const employees = getActiveEmployees_();
  const emp = employees.find(e => String(e['EmployeeID']) === String(payload.employeeId));
  if (!emp) return { success: false, message: '従業員が見つかりません' };

  ensureResultRegistrationMethodColumn_();
  const sheet = getOrCreateSheet_(SHEET_NAMES.RESULT);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dateCol = headers.indexOf('日付');
    const empCol = headers.indexOf('EmployeeID');
    const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      const rowDate = values[i][dateCol] instanceof Date ? formatDate_(values[i][dateCol]) : String(values[i][dateCol]);
      if (rowDate === payload.date && String(values[i][empCol]) === String(payload.employeeId)) {
        sheet.deleteRow(i + 2); // 同一従業員・同一日付は上書き（同日の別シフトへの変更にも対応）
      }
    }
  }

  appendObjectRow_(SHEET_NAMES.RESULT, {
    '週開始日': weekStartStr,
    '日付': payload.date,
    '曜日': dayLabel,
    'シフト区分': payload.shiftType,
    'EmployeeID': emp['EmployeeID'],
    '氏名': emp['氏名'],
    '責任者フラグ': isManager_(emp) ? '○' : '',
    'ステータス': '初稿',
    '登録方法': '手動'
  });

  return { success: true, weekStart: weekStartStr, date: payload.date, dayLabel: dayLabel };
}

/**
 * 指定週の「手動追加」されたシフト一覧を返す（一覧表示・編集・削除用）
 */
function getManualShiftEntries(weekStartStr) {
  ensureResultRegistrationMethodColumn_();
  const rows = sheetToObjects_(SHEET_NAMES.RESULT).filter(r => {
    const w = r['週開始日'] instanceof Date ? formatDate_(r['週開始日']) : String(r['週開始日']);
    return w === weekStartStr && r['登録方法'] === '手動';
  });
  return rows.map(r => ({
    date: r['日付'] instanceof Date ? formatDate_(r['日付']) : String(r['日付']),
    dayLabel: r['曜日'],
    employeeId: r['EmployeeID'],
    name: r['氏名'],
    shiftType: r['シフト区分'],
    isManager: r['責任者フラグ'] === '○'
  })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 手動追加されたシフトを1件削除する。
 * payload: { date: 'YYYY-MM-DD', employeeId }
 */
function deleteManualShiftEntry(payload) {
  ensureResultRegistrationMethodColumn_();
  const sheet = getOrCreateSheet_(SHEET_NAMES.RESULT);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: '対象データがありません' };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const dateCol = headers.indexOf('日付');
  const empCol = headers.indexOf('EmployeeID');
  const methodCol = headers.indexOf('登録方法');
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  let deleted = false;
  for (let i = values.length - 1; i >= 0; i--) {
    const rowDate = values[i][dateCol] instanceof Date ? formatDate_(values[i][dateCol]) : String(values[i][dateCol]);
    const isManualRow = methodCol !== -1 && values[i][methodCol] === '手動';
    if (rowDate === payload.date && String(values[i][empCol]) === String(payload.employeeId) && isManualRow) {
      sheet.deleteRow(i + 2);
      deleted = true;
    }
  }
  return { success: deleted, message: deleted ? '' : '該当する手動追加データが見つかりません' };
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
