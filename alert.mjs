/**
 * alert.mjs - 预警模块
 * 负责：触发条件判断、去重、Windows 通知、历史记录
 */

// 内存中保存最近 200 条预警
const alertHistory = [];
// 去重：key = `${code}:${type}`, value = 上次触发时间戳
const lastFired = new Map();
const DEFAULT_DEDUP_MS = 8 * 60 * 1000; // 默认同一条件 8 分钟内不重复
const DEDUP_BY_TYPE = new Map([
  ["涨停", 60 * 60 * 1000],
  ["炸板", 10 * 60 * 1000],
  ["回封观察", 10 * 60 * 1000],
  ["临近涨停", 8 * 60 * 1000],
  ["弱转强", 20 * 60 * 1000],
  ["分歧承接", 15 * 60 * 1000],
  ["破5日线", 30 * 60 * 1000],
  ["破10日线", 60 * 60 * 1000],
]);

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function isAfternoonStrong(s) {
  return s && Number.isFinite(s.lateRet) && s.lateRet >= 1.2;
}

function isLateSession() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return hhmm >= "14:20" && hhmm <= "15:10";
}

export function getAlertHistory() {
  return [...alertHistory].reverse(); // 最新在前
}

function fire(code, name, type, message) {
  const key = `${code}:${type}`;
  const now = Date.now();
  const dedupMs = DEDUP_BY_TYPE.get(type) || DEFAULT_DEDUP_MS;
  if (lastFired.has(key) && now - lastFired.get(key) < dedupMs) return null;
  lastFired.set(key, now);

  const entry = {
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    code,
    name: name || code,
    type,
    message,
  };
  alertHistory.unshift(entry);
  if (alertHistory.length > 200) alertHistory.pop();

  // 只保留网页预警历史，不再弹 Windows 通知，避免阻塞行情接口。

  return entry;
}

/**
 * 对每个 row 检查预警条件，触发时调用 fire()
 * row 结构与 dashboard_server.mjs 中 collectSnapshot 返回的 rows[i] 一致
 */
export function checkAlerts(rows) {
  const fired = [];
  for (const row of rows) {
    const code = row.item?.code;
    const name = row.item?.name || row.quote?.displayName || code;
    const q = row.quote;
    const s = row.stats;
    const d = row.daily;
    if (!q || !code) continue;

    const pctText = fmtPct(q.pct);
    const pullbackText = fmtPct(s?.pullbackFromHigh);
    const lateRetText = fmtPct(s?.lateRet);
    const ma5Text = fmtPrice(d?.ma5);
    const ma10Text = fmtPrice(d?.ma10);
    const yesterdayText = row.yesterday?.text || "昨日状态未知";
    const add = (entry) => {
      if (entry) fired.push(entry);
    };

    // 涨停
    if (q.isLimitUp) {
      add(fire(code, name, "涨停", `${name} 涨停，涨幅 ${pctText}；${yesterdayText}`));
    }

    // 炸板（曾触及涨停但当前未封）
    if (q.boardText === "炸板") {
      add(fire(code, name, "炸板", `${name} 炸板，当前 ${pctText}，高点回撤 ${pullbackText}`));
    }

    // 临近涨停：短线打板/回封观察
    if (!q.isLimitUp && Number.isFinite(q.limitUp) && Number.isFinite(q.last) && q.last >= q.limitUp * 0.985) {
      add(fire(code, name, "临近涨停", `${name} 距涨停价 ${fmtPrice(q.limitUp)} 很近，当前 ${fmtPrice(q.last)} / ${pctText}`));
    }

    // 弱转强：昨日有强势/分歧痕迹，今日盘中转强且回撤不大
    if (
      s &&
      Number.isFinite(q.pct) &&
      q.pct >= 3 &&
      s.bounceFromLow >= 3 &&
      s.pullbackFromHigh > -2.5 &&
      /涨停|炸板|冲高回落|大阳/.test(yesterdayText)
    ) {
      add(fire(code, name, "弱转强", `${name} ${yesterdayText} 后今日转强：${pctText}，低点修复 ${fmtPct(s.bounceFromLow)}，回撤 ${pullbackText}`));
    }

    // 分歧承接：高位没有明显掉队，低点能拉回
    if (s && q.pct >= 2 && s.bounceFromLow >= 4 && s.pullbackFromHigh > -3) {
      add(fire(code, name, "分歧承接", `${name} 分歧后有承接：低点反弹 ${fmtPct(s.bounceFromLow)}，高点回撤 ${pullbackText}，当前 ${pctText}`));
    }

    // 高点回撤 > 5%
    if (s && s.pullbackFromHigh <= -5) {
      add(fire(code, name, "高回撤", `${name} 高点回撤 ${pullbackText}，注意退潮/承接不足`));
    }

    // 破5日线
    if (d && Number.isFinite(d.ma5) && q.last < d.ma5) {
      add(fire(code, name, "破5日线", `${name} 现价 ${fmtPrice(q.last)} 跌破5日均线 ${ma5Text}，进入调整`));
    }

    // 破10日线
    if (d && Number.isFinite(d.ma10) && q.last < d.ma10) {
      add(fire(code, name, "破10日线", `${name} 现价 ${fmtPrice(q.last)} 跌破10日均线 ${ma10Text}，短线风控优先`));
    }

    // 尾盘走强（14:20后更有意义；非尾盘时作为盘中增强信号）
    if (isAfternoonStrong(s) && (isLateSession() || s.lateRet >= 1.8)) {
      add(fire(code, name, "尾盘走强", `${name} 14:30附近走强 ${lateRetText}，关注次日竞价是否超预期`));
    }

    // 大跌预警
    if (Number.isFinite(q.pct) && q.pct <= -7) {
      add(fire(code, name, "大跌", `${name} 跌幅 ${pctText}，注意止损/减仓`));
    }
  }
  return fired;
}
