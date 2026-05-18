#!/usr/bin/env node

import http from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const CONFIG_FILE = new URL("./watchlist.json", import.meta.url);
const SIGNALS_FILE = new URL("./buy_signals.json", import.meta.url);
const SNAPSHOT_CACHE_TTL_MS = Number(process.env.SNAPSHOT_CACHE_TTL_MS || 5000);
let snapshotCache = { data: null, expiresAt: 0 };

const DEFAULT_SIGNALS = {
  _help: "改这里的数字即可生效，保存后刷新浏览器。enabled=false 可关闭该信号。",
  strong_yesterday_keywords: ["涨停", "炸板"],
  huifeng: { name: "回封确认", enabled: true, require_limit_up: true, require_bid1_volume: true, require_yesterday_strong: true, desc: "现价涨停 + 买一有挂单 + 昨日强势（涨停/炸板）" },
  linban: { name: "临板预警", enabled: true, require_yesterday_strong: true, min_open_pct: 5, min_pct: 7, max_pullback: -2, desc: "昨日强势 + 未涨停 + 开盘涨幅 ≥ 5% + 涨幅 ≥ 7% + 高点回撤 > -2%" },
  fenqi: { name: "分歧承接", enabled: true, require_yesterday_strong: true, min_pct: 4, min_bounce: 4, max_pullback: -2.5, min_open_pct: 2, require_above_ma5: true, require_above_ma10: true, desc: "昨日强势 + 开盘涨幅 ≥ 2% + 涨幅 ≥ 4% + 低点反弹 ≥ 4% + 高点回撤 > -2.5% + 站上 MA5/MA10" },
  ruozhuanqiang: { name: "弱转强确认", enabled: true, require_yesterday_strong: true, min_pct: 3, min_bounce: 3, max_pullback: -2.5, min_open_pct: -3, max_open_pct: 3, require_above_ma5: true, desc: "昨日强势 + 开盘涨幅 -3%~3% + 涨幅 ≥ 3% + 低点反弹 ≥ 3% + 高点回撤 > -2.5% + 站上 MA5" },
};

async function loadSignals() {
  try {
    if (!existsSync(SIGNALS_FILE)) {
      await writeFile(SIGNALS_FILE, JSON.stringify(DEFAULT_SIGNALS, null, 2), "utf8");
      return DEFAULT_SIGNALS;
    }
    const raw = JSON.parse(await readFile(SIGNALS_FILE, "utf8"));
    return { ...DEFAULT_SIGNALS, ...raw };
  } catch {
    return DEFAULT_SIGNALS;
  }
}


const DEFAULT_CONFIG = {
  refreshSeconds: 10,
  watchlist: [
    { code: "002580", name: "圣阳股份", note: "监管预期牌" },
    { code: "001896", name: "豫能控股", note: "核心逻辑牌" },
    { code: "600396", name: "华电辽能", note: "中继/负反馈观察" },
    { code: "600821", name: "金开新能", note: "电力强票" },
    { code: "603629", name: "利通电子", note: "算力侧强股" },
    { code: "688256", name: "寒武纪", note: "高位科技锚" },
  ],
};

function normalizeCode(code) {
  const clean = String(code || "").trim().replace(/^(sh|sz)/i, "");
  return /^\d{6}$/.test(clean) ? clean : "";
}

function marketCode(code) {
  const clean = normalizeCode(code);
  if (!clean) return "";
  return clean.startsWith("6") ? `sh${clean}` : `sz${clean}`;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtMoney(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)}万`;
  return value.toFixed(0);
}

function fmtShares(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿股`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)}万股`;
  return `${value.toFixed(0)}股`;
}

function timeOf(day) {
  return day.slice(11, 16);
}

function isTradingSession(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return (hhmm >= "09:25" && hhmm <= "11:35") || (hhmm >= "12:55" && hhmm <= "15:10");
}

function effectiveRefreshSeconds(configSeconds) {
  const requested = Number(configSeconds || 10);
  if (isTradingSession()) return Math.max(5, requested);
  return Math.max(30, requested);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://finance.sina.com.cn",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  const encoding = url.includes("sina") ? "gb18030" : "utf-8";
  return new TextDecoder(encoding).decode(buffer);
}

async function ensureConfig() {
  if (!existsSync(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }
}

async function loadConfig() {
  await ensureConfig();
  const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  const watchlist = Array.isArray(raw.watchlist) ? raw.watchlist : [];
  return {
    refreshSeconds: Number(raw.refreshSeconds || 10),
    watchlist: watchlist
      .map((item) => ({
        code: normalizeCode(item.code),
        name: String(item.name || "").trim(),
        note: String(item.note || "").trim(),
      }))
      .filter((item) => item.code),
  };
}

async function saveConfig(config) {
  const clean = {
    refreshSeconds: Number(config.refreshSeconds || 10),
    watchlist: config.watchlist.map((item) => ({
      code: normalizeCode(item.code),
      name: String(item.name || "").trim(),
      note: String(item.note || "").trim(),
    })),
  };
  await writeFile(CONFIG_FILE, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

async function fetchQuotes(items) {
  if (!items.length) return new Map();
  const list = items.map((item) => marketCode(item.code)).join(",");
  const text = await fetchText(`https://hq.sinajs.cn/list=${list}`);
  const quotes = new Map();

  for (const line of text.split(";")) {
    const match = line.match(/hq_str_(s[hz]\d+)="([^"]*)"/);
    if (!match) continue;
    const [, symbol, payload] = match;
    const f = payload.split(",");
    if (f.length < 32 || !f[0]) continue;
    const code = symbol.slice(2);
    const previousClose = Number(f[2]);
    const last = Number(f[3]);
    const limitPct = code.startsWith("688") || code.startsWith("300") || code.startsWith("301") ? 1.2 : 1.1;
    const limitUp = previousClose ? Number((previousClose * limitPct).toFixed(2)) : NaN;
    const high = Number(f[4]);
    const isLimitUp = Number.isFinite(limitUp) && last >= limitUp - 0.01;
    quotes.set(code, {
      code,
      displayName: f[0],
      open: Number(f[1]),
      previousClose,
      last,
      high,
      low: Number(f[5]),
      volumeShares: Number(f[8]),
      amount: Number(f[9]),
      bid1Volume: Number(f[10]),
      bid1: Number(f[11]),
      ask1Volume: Number(f[20]),
      ask1: Number(f[21]),
      pct: previousClose ? ((last / previousClose) - 1) * 100 : NaN,
      limitUp,
      isLimitUp,
      boardText: isLimitUp ? "涨停" : (Number.isFinite(limitUp) && high >= limitUp - 0.01 ? "炸板" : ""),
      time: `${f[30]} ${f[31]}`,
    });
  }
  return quotes;
}

async function fetchMinute(code, datalen = 260) {
  const symbol = marketCode(code);
  const url =
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_m=/CN_MarketData.getKLineData` +
    `?symbol=${symbol}&scale=1&ma=no&datalen=${datalen}`;
  const text = await fetchText(url);
  const cleaned = text
    .replace(/^\/\*<script>location\.href='\/\/sina\.com';<\/script>\*\//, "")
    .replace(/^.*?\(\[/s, "[")
    .replace(/\);?\s*$/s, "");
  const rows = JSON.parse(cleaned);
  const latestDay = rows.length ? rows.at(-1).day.slice(0, 10) : "";
  return rows
    .filter((row) => row.day.startsWith(latestDay))
    .map((row) => ({
      day: row.day,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      amount: Number(row.amount),
    }));
}

async function fetchDaily(code, datalen = 20) {
  const symbol = marketCode(code);
  const url =
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_m=/CN_MarketData.getKLineData` +
    `?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`;
  const text = await fetchText(url);
  const cleaned = text
    .replace(/^\/\*<script>location\.href='\/\/sina\.com';<\/script>\*\//, "")
    .replace(/^.*?\(\[/s, "[")
    .replace(/\);?\s*$/s, "");
  const rows = JSON.parse(cleaned);
  return rows.map((row) => ({
    day: row.day,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
}

function dailyMetrics(dailyRows, liveClose = NaN, currentTradeDate = "") {
  if (!Array.isArray(dailyRows) || !dailyRows.length) {
    return {
      ma5: NaN,
      ma10: NaN,
      ret5: NaN,
      ret10: NaN,
      ret30: NaN,
      maxVol100: NaN,
      maDiffNow: NaN,
      maDiffPrev: NaN,
    };
  }

  const liveRows = dailyRows.map((row) => ({ ...row }));
  const hasCurrentDaily = currentTradeDate && liveRows.at(-1)?.day === currentTradeDate;
  if (Number.isFinite(liveClose)) {
    if (hasCurrentDaily) liveRows[liveRows.length - 1].close = liveClose;
    else liveRows.push({ day: currentTradeDate || "live", open: liveClose, high: liveClose, low: liveClose, close: liveClose, volume: 0 });
  }
  const prevRows = hasCurrentDaily ? dailyRows.slice(0, -1) : dailyRows;

  const avgClose = (rowsSource, count) => {
    if (rowsSource.length < count) return NaN;
    const rows = rowsSource.slice(-count);
    return rows.reduce((sum, row) => sum + row.close, 0) / count;
  };
  const rangeRet = (count) => {
    if (liveRows.length < count + 1) return NaN;
    const last = liveRows.at(-1).close;
    const base = liveRows.at(-count - 1).close;
    return base ? ((last / base) - 1) * 100 : NaN;
  };
  const maxVolume = (count) => {
    if (dailyRows.length < count) return NaN;
    return dailyRows.slice(-count).reduce((max, row) => Math.max(max, row.volume), 0);
  };
  const ma5 = avgClose(liveRows, 5);
  const ma10 = avgClose(liveRows, 10);
  const prevMa5 = avgClose(prevRows, 5);
  const prevMa10 = avgClose(prevRows, 10);

  return {
    ma5,
    ma10,
    ret5: rangeRet(5),
    ret10: rangeRet(10),
    ret30: rangeRet(30),
    maxVol100: maxVolume(100),
    maDiffNow: Number.isFinite(ma5) && Number.isFinite(ma10) ? ma5 - ma10 : NaN,
    maDiffPrev: Number.isFinite(prevMa5) && Number.isFinite(prevMa10) ? prevMa5 - prevMa10 : NaN,
  };
}

async function fetchMinuteByDay(code, day, datalen = 260) {
  const rows = await fetchMinute(code, datalen);
  if (rows.length && rows[0].day.startsWith(day)) return rows;

  // Sina minute endpoint usually returns the latest trading day only.
  // Keep this function explicit so yesterday-state code can degrade cleanly.
  return [];
}

function minuteStats(minutes, quote = null) {
  if (!minutes.length) return null;
  const first = minutes[0];
  const last = minutes.at(-1);
  const isLimitUp = quote?.isLimitUp && Number.isFinite(quote.limitUp);
  const highRow = isLimitUp
    ? (() => {
        const tolerance = 0.02;
        let index = minutes.length - 1;
        while (index > 0 && minutes[index - 1].close >= quote.limitUp - tolerance) index -= 1;
        return minutes[index] ||
          minutes.find((row) => row.high >= quote.limitUp - tolerance || row.close >= quote.limitUp - tolerance) ||
          minutes.reduce((best, row) => (row.high > best.high ? row : best), first);
      })()
    : quote?.boardText === "炸板" && Number.isFinite(quote.limitUp)
      ? (minutes.filter((row) => row.high >= quote.limitUp - 0.02 || row.close >= quote.limitUp - 0.02).at(-1) ||
        minutes.reduce((best, row) => (row.high > best.high ? row : best), first))
      : minutes.reduce((best, row) => (row.high >= best.high ? row : best), first);
  const lowRow = minutes.reduce((best, row) => (row.low <= best.low ? row : best), first);
  const row1430 = minutes.filter((row) => timeOf(row.day) <= "14:30").at(-1);
  const totalVolume = minutes.reduce((sum, row) => sum + row.volume, 0);
  const lateVolume = minutes
    .filter((row) => timeOf(row.day) >= "14:30")
    .reduce((sum, row) => sum + row.volume, 0);

  return {
    date: last.day.slice(0, 10),
    high: highRow.high,
    highTime: timeOf(highRow.day),
    low: lowRow.low,
    lowTime: timeOf(lowRow.day),
    close: last.close,
    closeTime: timeOf(last.day),
    pullbackFromHigh: highRow.high ? ((last.close / highRow.high) - 1) * 100 : NaN,
    bounceFromLow: lowRow.low ? ((last.close / lowRow.low) - 1) * 100 : NaN,
    amplitude: lowRow.low ? ((highRow.high / lowRow.low) - 1) * 100 : NaN,
    lateRet: row1430 ? ((last.close / row1430.close) - 1) * 100 : NaN,
    lateVolumeShare: totalVolume ? (lateVolume / totalVolume) * 100 : NaN,
  };
}

function yesterdayState(dailyRows, yesterdayMinutes, currentTradeDate) {
  if (!dailyRows || dailyRows.length < 2) {
    return { text: "昨日数据不足", labels: [], high: null, finalLimitTime: "" };
  }
  const lastDaily = dailyRows.at(-1);
  const hasCurrentDaily = currentTradeDate && lastDaily?.day === currentTradeDate;
  const prev = hasCurrentDaily ? dailyRows.at(-2) : dailyRows.at(-1);
  const prevIndex = hasCurrentDaily ? dailyRows.length - 2 : dailyRows.length - 1;
  const prev2 = dailyRows[prevIndex - 1];
  if (!prev2) return { text: "昨日数据不足", labels: [], high: prev.high, finalLimitTime: "" };

  const limitUp = Number((prev2.close * 1.1).toFixed(2));
  const closeLimit = prev.close >= limitUp - 0.01;
  const touchedLimit = prev.high >= limitUp - 0.01;
  const pullbackFromHigh = prev.high ? ((prev.close / prev.high) - 1) * 100 : NaN;

  let finalLimitTime = "";
  let highTime = "";
  let lowTime = "";
  if (yesterdayMinutes?.length && touchedLimit) {
    const limitRows = yesterdayMinutes.filter((row) => row.close >= limitUp - 0.01 || row.high >= limitUp - 0.01);
    if (limitRows.length) finalLimitTime = timeOf(limitRows.at(-1).day);
  }
  if (yesterdayMinutes?.length) {
    const highRow = yesterdayMinutes.reduce((best, row) => (row.high >= best.high ? row : best), yesterdayMinutes[0]);
    const lowRow = yesterdayMinutes.reduce((best, row) => (row.low <= best.low ? row : best), yesterdayMinutes[0]);
    highTime = timeOf(highRow.day);
    lowTime = timeOf(lowRow.day);
  }

  const labels = [];
  if (closeLimit) labels.push("昨日涨停");
  if (touchedLimit && !closeLimit) labels.push("昨日炸板");
  if (!closeLimit && pullbackFromHigh <= -3) labels.push("昨日冲高回落");
  if (prev.close > prev.open && ((prev.close / prev.open) - 1) * 100 >= 5) labels.push("昨日大阳");
  if (prev.close < prev.open && ((prev.close / prev.open) - 1) * 100 <= -5) labels.push("昨日大阴");

  let text = "昨日普通";
  if (closeLimit) text = finalLimitTime ? `昨日涨停 ${finalLimitTime}` : "昨日涨停";
  else if (touchedLimit) text = finalLimitTime ? `昨日${finalLimitTime}涨停后炸板` : "昨日炸板";
  else if (pullbackFromHigh <= -3) text = "昨日冲高回落";
  else if (labels.length) text = labels.join("/");

  return {
    text,
    labels,
    date: prev.day,
    high: prev.high,
    highTime,
    low: prev.low,
    lowTime,
    close: prev.close,
    amount: prev.volume && prev.close ? prev.volume * prev.close : NaN,
    volume: prev.volume,
    pct: prev2.close ? ((prev.close / prev2.close) - 1) * 100 : NaN,
    limitUp,
    finalLimitTime,
    pullbackFromHigh,
    pullbackFromHighText: fmtPct(pullbackFromHigh),
  };
}

function buyPointHints(row) {
  const q = row.quote;
  const s = row.stats;
  const d = row.dragon;
  const daily = row.daily;
  if (!q || !s || !daily) return ["无数据"];

  const hints = [];
  if (Number.isFinite(daily.ma10) && q.last < daily.ma10) {
    return ["破10日线：短线卖出"];
  } else if (Number.isFinite(daily.ma5) && q.last < daily.ma5) {
    return ["破5日线：进入调整，谨慎买入"];
  }

  if (q.isLimitUp && q.ask1 === 0) {
    hints.push("一致封板：持仓，不追");
  } else if (q.isLimitUp) {
    hints.push("分歧回封确认");
  } else if (q.pct >= 7 && s.pullbackFromHigh > -1.5 && s.lateRet >= 0) {
    hints.push("强势临板：只看封板确认");
  } else if (q.pct >= 4 && s.bounceFromLow >= 4 && s.pullbackFromHigh > -2.5) {
    hints.push("分歧承接：小仓观察");
  } else if (q.pct >= 2 && s.lateRet >= 1 && s.pullbackFromHigh > -2) {
    hints.push("弱转强预备");
  }

  if (s.pullbackFromHigh <= -5) {
    hints.push("高点回撤大，等止跌");
  } else if (s.pullbackFromHigh <= -3) {
    hints.push("冲高回落，等承接");
  }

  if (d?.risk === "高") hints.push("风险高");
  return [...new Set(hints)].slice(0, 3);
}

function confirmedBuySignals(row, cfg = DEFAULT_SIGNALS) {
  const q = row.quote;
  const s = row.stats;
  const d = row.daily;
  const y = row.yesterday;
  if (!q || !s || !d) return [];

  const signals = [];
  const openPct = q.open && q.previousClose ? (q.open / q.previousClose - 1) * 100 : NaN;
  const aboveMa5 = !Number.isFinite(d.ma5) || q.last >= d.ma5;
  const aboveMa10 = !Number.isFinite(d.ma10) || q.last >= d.ma10;
  const kw = Array.isArray(cfg.strong_yesterday_keywords) && cfg.strong_yesterday_keywords.length
    ? cfg.strong_yesterday_keywords
    : ["涨停", "炸板"];
  const yStrong = kw.some((k) => (y?.text || "").includes(k));

  const hf = cfg.huifeng || {};
  if (hf.enabled !== false) {
    const ok = (!hf.require_limit_up || q.isLimitUp)
      && (!hf.require_bid1_volume || q.bid1Volume > 0)
      && (!hf.require_yesterday_strong || yStrong);
    if (ok && q.isLimitUp) signals.push(hf.name || "回封确认");
  }

  const lb = cfg.linban || {};
  if (lb.enabled !== false) {
    const minPct = Number.isFinite(lb.min_pct) ? lb.min_pct : 7;
    const minOpen = Number.isFinite(lb.min_open_pct) ? lb.min_open_pct : 5;
    const maxPull = Number.isFinite(lb.max_pullback) ? lb.max_pullback : -2;
    const needY = lb.require_yesterday_strong !== false;
    if ((!needY || yStrong) && !q.isLimitUp && Number.isFinite(openPct) && openPct >= minOpen && q.pct >= minPct && s.pullbackFromHigh > maxPull) {
      signals.push(lb.name || "临板确认");
    }
  }

  const fq = cfg.fenqi || {};
  if (fq.enabled !== false) {
    const minPct = Number.isFinite(fq.min_pct) ? fq.min_pct : 4;
    const minBounce = Number.isFinite(fq.min_bounce) ? fq.min_bounce : 4;
    const maxPull = Number.isFinite(fq.max_pullback) ? fq.max_pullback : -2.5;
    const needY = fq.require_yesterday_strong === true;
    const needMa5 = fq.require_above_ma5 !== false;
    const needMa10 = fq.require_above_ma10 !== false;
    const fqMinOpen = Number.isFinite(fq.min_open_pct) ? fq.min_open_pct : null;
    if ((!needY || yStrong) && q.pct >= minPct && s.bounceFromLow >= minBounce && s.pullbackFromHigh > maxPull && (!needMa5 || aboveMa5) && (!needMa10 || aboveMa10) && (fqMinOpen === null || !Number.isFinite(openPct) || openPct >= fqMinOpen)) {
      signals.push(fq.name || "分歧承接");
    }
  }

  const rz = cfg.ruozhuanqiang || {};
  if (rz.enabled !== false) {
    const minPct = Number.isFinite(rz.min_pct) ? rz.min_pct : 3;
    const minBounce = Number.isFinite(rz.min_bounce) ? rz.min_bounce : 3;
    const maxPull = Number.isFinite(rz.max_pullback) ? rz.max_pullback : -2.5;
    const needY = rz.require_yesterday_strong !== false;
    const needMa5 = rz.require_above_ma5 !== false;
    const rzMinOpen = Number.isFinite(rz.min_open_pct) ? rz.min_open_pct : null;
    const rzMaxOpen = Number.isFinite(rz.max_open_pct) ? rz.max_open_pct : null;
    if ((!needY || yStrong) && q.pct >= minPct && s.bounceFromLow >= minBounce && s.pullbackFromHigh > maxPull && (!needMa5 || aboveMa5) && (rzMinOpen === null || !Number.isFinite(openPct) || openPct >= rzMinOpen) && (rzMaxOpen === null || !Number.isFinite(openPct) || openPct <= rzMaxOpen)) {
      signals.push(rz.name || "弱转强确认");
    }
  }

  return [...new Set(signals)];
}

function calcMinTriggerPrices(row, cfg = DEFAULT_SIGNALS) {
  const q = row.quote;
  const s = row.stats;
  const d = row.daily;
  const y = row.yesterday;
  if (!q || !s || !d) return [];

  const openPct = q.open && q.previousClose ? (q.open / q.previousClose - 1) * 100 : NaN;
  const kw = Array.isArray(cfg.strong_yesterday_keywords) && cfg.strong_yesterday_keywords.length
    ? cfg.strong_yesterday_keywords : ["涨停", "炸板"];
  const yStrong = kw.some((k) => (y?.text || "").includes(k));
  const result = [];

  // 回封确认: 需要涨停价
  const hf = cfg.huifeng || {};
  if (hf.enabled !== false && (!hf.require_yesterday_strong || yStrong) && Number.isFinite(q.limitUp)) {
    result.push({ key: "huifeng", name: hf.name || "回封确认", price: q.limitUp });
  }

  // 临板预警: 昨日强势 + 开盘>=minOpen + 涨幅>=minPct + 回撤>maxPull
  const lb = cfg.linban || {};
  if (lb.enabled !== false) {
    const needY = lb.require_yesterday_strong !== false;
    const minOpen = Number.isFinite(lb.min_open_pct) ? lb.min_open_pct : 5;
    const minPct = Number.isFinite(lb.min_pct) ? lb.min_pct : 7;
    const maxPull = Number.isFinite(lb.max_pullback) ? lb.max_pullback : -2;
    const openOk = Number.isFinite(openPct) && openPct >= minOpen;
    if ((!needY || yStrong) && openOk && Number.isFinite(q.previousClose) && Number.isFinite(s.high)) {
      const price = Math.max(
        q.previousClose * (1 + minPct / 100),
        s.high * (1 + maxPull / 100)
      );
      result.push({ key: "linban", name: lb.name || "临板预警", price });
    }
  }

  // 分歧承接: 昨日强势 + 开盘>=minOpen + 涨幅>=4% + 低点反弹>=4% + 回撤>-2.5% + MA5 + MA10
  const fq = cfg.fenqi || {};
  if (fq.enabled !== false) {
    const needY = fq.require_yesterday_strong === true;
    const minOpen = Number.isFinite(fq.min_open_pct) ? fq.min_open_pct : null;
    const minPct = Number.isFinite(fq.min_pct) ? fq.min_pct : 4;
    const minBounce = Number.isFinite(fq.min_bounce) ? fq.min_bounce : 4;
    const maxPull = Number.isFinite(fq.max_pullback) ? fq.max_pullback : -2.5;
    const needMa5 = fq.require_above_ma5 !== false;
    const needMa10 = fq.require_above_ma10 !== false;
    const openOk = minOpen === null || !Number.isFinite(openPct) || openPct >= minOpen;
    if ((!needY || yStrong) && openOk && Number.isFinite(q.previousClose) && Number.isFinite(s.high) && Number.isFinite(s.low)) {
      const candidates = [
        q.previousClose * (1 + minPct / 100),
        s.low * (1 + minBounce / 100),
        s.high * (1 + maxPull / 100),
      ];
      if (needMa5 && Number.isFinite(d.ma5)) candidates.push(d.ma5);
      if (needMa10 && Number.isFinite(d.ma10)) candidates.push(d.ma10);
      result.push({ key: "fenqi", name: fq.name || "分歧承接", price: Math.max(...candidates) });
    }
  }

  // 弱转强确认: 昨日强势 + 开盘-3%~3% + 涨幅>=3% + 低点反弹>=3% + 回撤>-2.5% + MA5
  const rz = cfg.ruozhuanqiang || {};
  if (rz.enabled !== false) {
    const needY = rz.require_yesterday_strong !== false;
    const minOpen = Number.isFinite(rz.min_open_pct) ? rz.min_open_pct : null;
    const maxOpen = Number.isFinite(rz.max_open_pct) ? rz.max_open_pct : null;
    const minPct = Number.isFinite(rz.min_pct) ? rz.min_pct : 3;
    const minBounce = Number.isFinite(rz.min_bounce) ? rz.min_bounce : 3;
    const maxPull = Number.isFinite(rz.max_pullback) ? rz.max_pullback : -2.5;
    const needMa5 = rz.require_above_ma5 !== false;
    const openOk = (minOpen === null || !Number.isFinite(openPct) || openPct >= minOpen) &&
                   (maxOpen === null || !Number.isFinite(openPct) || openPct <= maxOpen);
    if ((!needY || yStrong) && openOk && Number.isFinite(q.previousClose) && Number.isFinite(s.high) && Number.isFinite(s.low)) {
      const candidates = [
        q.previousClose * (1 + minPct / 100),
        s.low * (1 + minBounce / 100),
        s.high * (1 + maxPull / 100),
      ];
      if (needMa5 && Number.isFinite(d.ma5)) candidates.push(d.ma5);
      result.push({ key: "ruozhuanqiang", name: rz.name || "弱转强确认", price: Math.max(...candidates) });
    }
  }

  return result;
}

function watchSummary(rows) {
  const activeRows = rows.filter((row) => row.quote && row.stats);
  if (!activeRows.length) {
    return {
      intraday: "暂无行情数据",
      trend: "--",
      risk: "--",
    };
  }

  const limitRows = activeRows
    .filter((row) => row.quote.isLimitUp)
    .sort((a, b) => (a.stats.highTime || "99:99").localeCompare(b.stats.highTime || "99:99"));
  const firstLimit = limitRows[0] || null;
  const topGainer = [...activeRows]
    .filter((row) => Number.isFinite(row.quote?.pct))
    .sort((a, b) => {
      const pctDiff = (b.quote.pct ?? -Infinity) - (a.quote.pct ?? -Infinity);
      if (pctDiff !== 0) return pctDiff;
      return (a.stats?.highTime || "99:99").localeCompare(b.stats?.highTime || "99:99");
    })[0] || null;

  const intradayParts = [];
  if (firstLimit) {
    intradayParts.push(`分时领涨：${firstLimit.item.name || firstLimit.quote.displayName} ${firstLimit.stats.highTime}涨停`);
  } else if (topGainer) {
    intradayParts.push(`分时领涨：${topGainer.item.name || topGainer.quote.displayName} ${fmtPct(topGainer.quote.pct)}`);
  }

  const bestBy = (field) =>
    activeRows
      .filter((row) => Number.isFinite(row.daily?.[field]))
      .sort((a, b) => b.daily[field] - a.daily[field])[0] || null;
  const best5 = bestBy("ret5");
  const best10 = bestBy("ret10");
  const best30 = bestBy("ret30");
  const trendParts = [];
  if (best5) trendParts.push(`5日${best5.item.name || best5.quote.displayName}${fmtPct(best5.daily.ret5)}`);
  if (best10) trendParts.push(`10日${best10.item.name || best10.quote.displayName}${fmtPct(best10.daily.ret10)}`);
  if (best30) trendParts.push(`30日${best30.item.name || best30.quote.displayName}${fmtPct(best30.daily.ret30)}`);
  const trendText = trendParts.length ? trendParts.join(" / ") : "--";

  const volumeRows = activeRows
    .filter((row) => row.yesterday?.volume && row.quote?.volumeShares)
    .map((row) => ({
      row,
      ratio: row.quote.volumeShares / row.yesterday.volume,
      max100Ratio: row.daily?.maxVol100 ? row.quote.volumeShares / row.daily.maxVol100 : NaN,
    }))
    .sort((a, b) => b.ratio - a.ratio);
  const volumeBreaks = volumeRows
    .filter((item) => Number.isFinite(item.max100Ratio) && item.max100Ratio >= 1)
    .slice(0, 3)
    .map((item) => `${item.row.item.name || item.row.quote.displayName}${item.max100Ratio.toFixed(2)}`);
  if (volumeBreaks.length) intradayParts.push(`量能：${volumeBreaks.join(" / ")}`);

  const riskTexts = [];
  for (const row of activeRows) {
    const name = row.item.name || row.quote.displayName || row.item.code;
    const q = row.quote;
    const s = row.stats;
    const d = row.daily;
    if (d?.ma10 && q.last < d.ma10) riskTexts.push(`${name}破10日线`);
    else if (d?.ma5 && q.last < d.ma5) riskTexts.push(`${name}破5日线`);
    else if (d?.ma10 && q.last <= d.ma10 * 1.02) riskTexts.push(`${name}近10日线`);
    else if (d?.ma5 && q.last <= d.ma5 * 1.02) riskTexts.push(`${name}近5日线`);
    if (Number.isFinite(d?.ret5) && d.ret5 <= -8) riskTexts.push(`${name}5日转弱`);
    if (Number.isFinite(d?.ret10) && d.ret10 <= -12) riskTexts.push(`${name}10日转弱`);
    if (Number.isFinite(d?.ret30) && d.ret30 >= 100 && s.pullbackFromHigh <= -3) riskTexts.push(`${name}高位分歧`);
    if (s.pullbackFromHigh <= -5) riskTexts.push(`${name}高回撤`);
  }

  return {
    intraday: intradayParts.length ? intradayParts.join("；") : "--",
    trend: trendText,
    risk: riskTexts.length ? [...new Set(riskTexts)].slice(0, 8).join(" / ") : "--",
  };
}

function evaluateRow(row) {
  const q = row.quote;
  const s = row.stats;
  if (!q || !s) return { score: 0, tags: ["无数据"], warnings: [] };
  const tags = [];
  const warnings = [];
  let score = 0;

  if (q.isLimitUp) {
    score += 35;
    tags.push("涨停");
  } else if (q.pct >= 7) {
    score += 22;
    tags.push("大涨");
  } else if (q.pct >= 3) {
    score += 12;
    tags.push("强于平盘");
  } else if (q.pct <= -5) {
    score -= 22;
    warnings.push("大跌");
  }

  if (s.pullbackFromHigh <= -5) {
    score -= 18;
    warnings.push("高点回撤大");
  } else if (s.pullbackFromHigh <= -2.5) {
    score -= 9;
    warnings.push("冲高回落");
  } else if (s.pullbackFromHigh > -0.8 && q.pct > 0) {
    score += 10;
    tags.push("贴近高点");
  }

  if (s.bounceFromLow >= 3) {
    score += 8;
    tags.push("低点修复");
  }
  if (s.lateRet >= 1) {
    score += 8;
    tags.push("尾盘走强");
  } else if (s.lateRet <= -1) {
    score -= 8;
    warnings.push("尾盘走弱");
  }
  if (q.amount >= 3_000_000_000) tags.push("容量");

  return { score, tags: [...new Set(tags)], warnings: [...new Set(warnings)] };
}

function dragonMetrics(row) {
  const q = row.quote;
  const s = row.stats;
  if (!q || !s) {
    return {
      boardState: "无数据",
      initiative: "无数据",
      acceptance: "无数据",
      risk: "无数据",
      buyType: "无数据",
      quantScore: 0,
      labels: ["无数据"],
    };
  }

  const pullback = s.pullbackFromHigh;
  const bounce = s.bounceFromLow;
  const pct = q.pct;
  const late = s.lateRet;
  const amount = q.amount;
  const nearHigh = pullback > -0.8;
  const strongHigh = pullback > -1.5;
  const heavyVolume = amount >= 3_000_000_000;
  const largeCapVolume = amount >= 10_000_000_000;
  const labels = [];

  let boardState = "未封板";
  if (q.isLimitUp && q.ask1 === 0) boardState = "封死涨停";
  else if (q.isLimitUp) boardState = "涨停价附近";
  else if (q.limitUp && q.last >= q.limitUp * 0.985) boardState = "临近涨停";

  let initiative = "观察";
  if (q.isLimitUp && s.highTime >= "13:00") initiative = "午后主动封板";
  else if (q.isLimitUp) initiative = "早盘/盘中封板";
  else if (pct >= 7 && nearHigh && late >= 0.5) initiative = "主动上攻";
  else if (pct >= 7 && strongHigh) initiative = "强势逼近涨停";
  else if (bounce >= 5 && pct > 3) initiative = "低点修复";
  else if (pullback <= -5) initiative = "被动回落";

  let acceptance = "一般";
  if (q.isLimitUp && q.bid1Volume > 0) acceptance = "封单承接";
  else if (pct >= 7 && pullback > -1.5) acceptance = "高位承接";
  else if (bounce >= 5 && pullback > -2.5) acceptance = "分歧承接";
  else if (pullback <= -5) acceptance = "承接不足";

  let risk = "低";
  if (pullback <= -5 || late <= -1.5) risk = "高";
  else if (pullback <= -2.5 || late <= -0.8) risk = "中";
  if (q.isLimitUp && q.ask1 === 0) risk = "封板风险";

  let buyType = "无明确买点";
  if (q.isLimitUp && q.ask1 === 0) buyType = "持有/排板，不追价";
  else if (q.isLimitUp) buyType = "回封确认";
  else if (pct >= 8 && strongHigh) buyType = "打板观察";
  else if (pct >= 5 && bounce >= 5 && pullback > -2.5) buyType = "分歧承接";
  else if (pullback <= -3) buyType = "等待止跌";

  let quantScore = 0;
  quantScore += Math.max(-30, Math.min(30, pct * 3));
  quantScore += Math.max(-25, Math.min(15, pullback * 4));
  quantScore += Math.max(0, Math.min(15, bounce));
  quantScore += Math.max(-10, Math.min(10, late * 4));
  if (q.isLimitUp) quantScore += 20;
  if (heavyVolume) quantScore += 6;
  if (largeCapVolume) quantScore += 4;
  quantScore = Math.round(quantScore);

  if (q.isLimitUp) labels.push("封板");
  if (pct >= 7) labels.push("高强度");
  if (nearHigh) labels.push("贴近高点");
  if (bounce >= 5) labels.push("低点强修复");
  if (late >= 1) labels.push("尾盘增强");
  if (pullback <= -2.5) labels.push("冲高回落");
  if (pullback <= -5) labels.push("高回撤");
  if (heavyVolume) labels.push("容量");

  return {
    boardState,
    initiative,
    acceptance,
    risk,
    buyType,
    quantScore,
    labels: [...new Set(labels)],
  };
}

function tactic(row) {
  const q = row.quote;
  const s = row.stats;
  const e = row.evaluation;
  if (!q || !s) return "无行情数据";
  const d = row.dragon;

  if (q.isLimitUp && q.ask1 === 0 && s.lateRet >= 0) {
    return "主升/一致：封住看次日溢价，不开板不追；若炸板只看快速回封";
  }
  if (q.isLimitUp) {
    return "分歧转一致：只看回封质量，反复炸板降低预期";
  }
  if (q.pct >= 8 && s.pullbackFromHigh > -1 && s.lateRet >= 0.5) {
    return "打板观察：临近涨停且主动，买点只在封板确认";
  }
  if (q.pct >= 6 && s.bounceFromLow >= 6 && s.pullbackFromHigh > -2.5) {
    return "强分歧承接：可小仓低吸/做T，不能当一致板追";
  }
  if (q.pct >= 4 && s.lateRet >= 1 && s.pullbackFromHigh > -2) {
    return "弱转强预备：尾盘转强，明日看竞价/开盘超预期";
  }
  if (s.pullbackFromHigh <= -5) {
    return "退潮/强分歧：高点回撤大，等止跌或次日弱转强";
  }
  if (q.pct <= -3) {
    return "退潮防守：先看止跌，不做主动买点";
  }
  if (s.bounceFromLow >= 3 && q.pct > -1) {
    return "修复观察：低点反弹，需站回分时均线才有买点";
  }
  return "混沌观察：无确认买点，等主动性或承接信号";
}

export async function collectSnapshot() {
  const config = await loadConfig();
  const signals = await loadSignals();
  const quotes = await fetchQuotes(config.watchlist);
  const rows = [];


  for (const item of config.watchlist) {
    const quote = quotes.get(item.code) || null;
    let stats = null;
    let yState = null;
    let dMetrics = null;
    try {
      stats = minuteStats(await fetchMinute(item.code), quote);
    } catch {
      stats = null;
    }
    try {
      const quoteDate = quote?.time ? String(quote.time).slice(0, 10) : "";
      const daily = await fetchDaily(item.code, 120);
      dMetrics = dailyMetrics(daily, quote?.last, quoteDate);
      const lastDaily = daily.at(-1);
      const hasCurrentDaily = quoteDate && lastDaily?.day === quoteDate;
      const yDay = daily.length >= 2 ? (hasCurrentDaily ? daily.at(-2).day : daily.at(-1).day) : "";
      const yMinutes = yDay ? await fetchMinuteByDay(item.code, yDay) : [];
      yState = yesterdayState(daily, yMinutes, quoteDate);
    } catch {
      yState = { text: "昨日状态失败", labels: [], high: null, finalLimitTime: "" };
      dMetrics = dailyMetrics([]);
    }
    const row = { item, quote, stats };
    row.yesterday = yState;
    row.daily = dMetrics;
    row.evaluation = evaluateRow(row);
    row.dragon = dragonMetrics(row);
    row.tactic = tactic(row);
    row.buyHints = buyPointHints(row);
    row.buySignals = confirmedBuySignals(row, signals);
    row.triggerPrices = calcMinTriggerPrices(row, signals);
    rows.push(row);

  }

  const leader = rows
    .filter((row) => Number.isFinite(row.quote?.pct))
    .sort((a, b) => b.quote.pct - a.quote.pct)[0] || null;
  const risk = rows
    .filter((row) => row.evaluation.warnings.length)
    .sort((a, b) => a.evaluation.score - b.evaluation.score)
    .slice(0, 5);
  const sortedRows = [...rows].sort((a, b) => {
    const at = a.stats?.highTime || "99:99";
    const bt = b.stats?.highTime || "99:99";
    if (at !== bt) return at.localeCompare(bt);
    return (b.quote?.pct ?? -Infinity) - (a.quote?.pct ?? -Infinity);
  });

  return {
    generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    refreshSeconds: effectiveRefreshSeconds(config.refreshSeconds),
    configuredRefreshSeconds: config.refreshSeconds,
    isTradingSession: isTradingSession(),
    stale: false,
    watchSummary: watchSummary(rows),
    signalRules: ["huifeng", "linban", "fenqi", "ruozhuanqiang"]
      .map((k) => signals[k] || DEFAULT_SIGNALS[k])
      .filter((r) => r && r.enabled !== false)
      .map((r) => ({ name: r.name || "", desc: r.desc || "" })),
    leader: leader
      ? {
          code: leader.item.code,
          name: leader.item.name || leader.quote?.displayName,
          pctText: fmtPct(leader.quote?.pct),
        }
      : null,
    risk: risk.map((row) => ({
      code: row.item.code,
      name: row.item.name || row.quote?.displayName,
      warnings: row.evaluation.warnings,
    })),
    rows: sortedRows.map((row) => ({
      item: row.item,
      quote: row.quote
        ? {
            ...row.quote,
            pctText: fmtPct(row.quote.pct),
            openPctText: fmtPct(row.quote.open && row.quote.previousClose ? (row.quote.open / row.quote.previousClose - 1) * 100 : NaN),
            amountText: fmtMoney(row.quote.amount),
            volumeText: fmtShares(row.quote.volumeShares),
            limitUpText: Number.isFinite(row.quote.limitUp) ? row.quote.limitUp.toFixed(2) : "--",
          }
        : null,
      stats: row.stats
        ? {
            ...row.stats,
            pullbackFromHighText: fmtPct(row.stats.pullbackFromHigh),
            bounceFromLowText: fmtPct(row.stats.bounceFromLow),
            amplitudeText: fmtPct(row.stats.amplitude),
            lateRetText: fmtPct(row.stats.lateRet),
          }
        : null,
      evaluation: row.evaluation,
      dragon: row.dragon,
      yesterday: row.yesterday,
      yesterdayText: row.yesterday
        ? {
            highText: Number.isFinite(row.yesterday.high) ? row.yesterday.high.toFixed(2) : "--",
            highTime: row.yesterday.highTime || "",
            lowText: Number.isFinite(row.yesterday.low) ? row.yesterday.low.toFixed(2) : "--",
            lowTime: row.yesterday.lowTime || "",
            pctText: fmtPct(row.yesterday.pct),
            amountText: fmtMoney(row.yesterday.amount),
            volumeText: fmtShares(row.yesterday.volume),
            volumeRatioText:
              row.yesterday.volume && row.quote?.volumeShares
                ? (row.quote.volumeShares / row.yesterday.volume).toFixed(2)
                : "--",
            boardTag: row.yesterday.labels?.some((label) => label.includes("炸板")) || row.yesterday.text.includes("炸板") ? "炸板"
              : row.yesterday.labels?.some((label) => label.includes("涨停")) || row.yesterday.text.includes("涨停") ? "涨停" : "",
          }
        : null,
      buyHints: row.buyHints,
      buySignals: row.buySignals,
      daily: row.daily
        ? {
            ...row.daily,
            ma5Text: Number.isFinite(row.daily.ma5) ? row.daily.ma5.toFixed(2) : "--",
            ma10Text: Number.isFinite(row.daily.ma10) ? row.daily.ma10.toFixed(2) : "--",
            ret5Text: fmtPct(row.daily.ret5),
            ret10Text: fmtPct(row.daily.ret10),
            ret30Text: fmtPct(row.daily.ret30),
            maxVol100Text: fmtShares(row.daily.maxVol100),
            volToMax100Text:
              row.daily.maxVol100 && row.quote?.volumeShares
                ? (row.quote.volumeShares / row.daily.maxVol100).toFixed(2)
                : "--",
            maDiffNowText: Number.isFinite(row.daily.maDiffNow)
              ? `${row.daily.maDiffNow >= 0 ? "+" : ""}${row.daily.maDiffNow.toFixed(2)}`
              : "--",
            maDiffPrevText: Number.isFinite(row.daily.maDiffPrev)
              ? `${row.daily.maDiffPrev >= 0 ? "+" : ""}${row.daily.maDiffPrev.toFixed(2)}`
              : "--",
            maDiffChangeText:
              Number.isFinite(row.daily.maDiffNow) && Number.isFinite(row.daily.maDiffPrev)
                ? `${(row.daily.maDiffNow - row.daily.maDiffPrev) >= 0 ? "+" : ""}${(row.daily.maDiffNow - row.daily.maDiffPrev).toFixed(2)}`
                : "--",
            ma5DistanceText:
              Number.isFinite(row.daily.ma5) && row.quote?.last
                ? fmtPct(((row.daily.ma5 / row.quote.last) - 1) * 100)
                : "--",
            ma10DistanceText:
              Number.isFinite(row.daily.ma10) && row.quote?.last
                ? fmtPct(((row.daily.ma10 / row.quote.last) - 1) * 100)
                : "--",
          }
        : null,
      tactic: row.tactic,
      triggerPrices: (row.triggerPrices || []).map(t => ({
        name: t.name,
        price: Number.isFinite(t.price) ? t.price.toFixed(2) : "--",
      })),
    })),
  };
}

async function getSnapshotCached() {
  const now = Date.now();
  if (snapshotCache.data && now < snapshotCache.expiresAt) {
    return { ...snapshotCache.data, cached: true };
  }

  try {
    const data = await collectSnapshot();
    snapshotCache = {
      data,
      expiresAt: now + SNAPSHOT_CACHE_TTL_MS,
    };
    return data;
  } catch (error) {
    if (snapshotCache.data) {
      return {
        ...snapshotCache.data,
        cached: true,
        stale: true,
        staleReason: error.message || String(error),
      };
    }
    throw error;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>自选股</title>
  <style>
    :root { --bg:#f5f6f8; --panel:#fff; --line:#d9dee7; --text:#141922; --muted:#667085; --red:#c62828; --green:#11834a; --amber:#9a6200; --head:#eef2f7; --input:#fff; --ticker:#111827; --warn5:#ffe45c; --warn10:#ffd7d7; }
    body[data-theme="ths"] { --bg:#000; --panel:#050505; --line:#262626; --text:#e5e7eb; --muted:#9ca3af; --red:#ff3030; --green:#00d26a; --amber:#facc15; --head:#080808; --input:#111; --ticker:#050505; --warn5:#4a3a00; --warn10:#401111; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"Microsoft YaHei","Segoe UI",Arial,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:8px 12px; background:var(--panel); border-bottom:1px solid var(--line); display:flex; justify-content:flex-end; gap:12px; align-items:center; flex-wrap:wrap; position:sticky; top:0; z-index:2; }
    main { padding:8px 12px 18px; }
    .sub,.meta,.muted,.code { color:var(--muted); font-size:12px; }
    .meta { display:flex; align-items:center; gap:12px; flex-wrap:nowrap; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; align-items:stretch; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
    .label { color:var(--muted); font-size:12px; margin-bottom:6px; font-weight:700; }
    .value { font-size:16px; font-weight:700; }
    .hint-lines { display:flex; flex-direction:column; gap:6px; }
    .hint-line { font-size:12px; line-height:1.6; font-weight:400; color:var(--text); }
    .hint-line.risk { white-space:normal; word-break:break-word; }
    .hint-tag { color:var(--muted); margin-right:6px; font-weight:400; }
    .hint-text { color:var(--text); font-weight:400; }
    .rules { font-size:12px; line-height:1.6; }
    .rules { display:flex; flex-direction:column; gap:4px; font-size:12px; line-height:1.6; font-weight:400; color:var(--text); }
    .rules .rule-name { color:var(--muted); font-weight:400; margin-right:6px; }
    .rules .rule-cond { color:var(--text); font-weight:400; }
    .ticker { margin-bottom:8px; background:var(--ticker); color:#fff; border-radius:8px; border:1px solid #1f2937; padding:7px 10px; font-size:12px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ticker-text .risk { color:#4ade80; font-weight:800; }
    .ticker-text .buy { color:#fbbf24; font-weight:800; }
    .ticker-text .sep { color:#d1d5db; display:inline-block; padding:0 24px; }
    .manager { margin-bottom:10px; padding:4px 8px; }
    .manager-body { display:flex; gap:10px; align-items:center; flex-wrap:nowrap; overflow-x:auto; }
    .theme-tools { margin-left:auto; justify-content:flex-end; flex:0 0 auto; }
    .manager-body::before { content:""; flex:1 1 auto; order:98; }
    .theme-tools { order:99; }
    .toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin:0; }
    .toolbar input { width:118px; }
    input,button { height:30px; border-radius:6px; border:1px solid var(--line); padding:0 8px; font:inherit; }
    input { background:var(--input); color:var(--text); }
    button { background:#050505; color:#fff; cursor:pointer; border-color:#333; }
    button.secondary { background:#050505; color:#fff; }
    button.theme-active { border-color:#333; color:#fff; font-weight:800; }
    button.danger { background:#050505; color:#fff; border-color:#333; }
    .error { display:none; margin-bottom:12px; padding:10px 12px; border:1px solid #efb1b1; background:#fff1f1; color:#9d1d22; border-radius:8px; }
    .table-wrap { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    table { width:100%; border-collapse:collapse; table-layout:auto; }
    th,td { border-bottom:1px solid var(--line); padding:5px 4px; text-align:left; vertical-align:top; font-size:11px; word-break:break-all; }
    th { background:var(--head); color:var(--muted); white-space:nowrap; font-size:11px; }
    body[data-theme="ths"] th { border-top:1px solid #8b0000; border-bottom:1px solid #8b0000; }
    body[data-theme="ths"] td { background:#000; }

    tr:last-child td { border-bottom:0; }
    .name { font-weight:700; }
    .name.warn5 { background:#052e16; color:#22c55e; padding:1px 4px; border-radius:4px; display:inline-block; }
    .name.warn10 { background:#3f1111; color:#ff4d4d; padding:1px 4px; border-radius:4px; display:inline-block; }
    .ma-cell.warn5 { background:#052e16; color:#22c55e; padding:1px 4px; border-radius:4px; display:block; }
    .ma-cell.warn10 { background:#3f1111; color:#ff4d4d; padding:1px 4px; border-radius:4px; display:block; }
    .last-price { font-size:11px; font-weight:700; line-height:inherit; }
    .row-index { color:var(--muted); text-align:center; font-weight:700; }
    .pos { color:var(--red); font-weight:700; }
    .neg { color:var(--green); font-weight:700; }
    .chips { display:flex; gap:5px; flex-wrap:wrap; }
    .chip { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:1px 5px; font-size:11px; background:#f8fafc; white-space:nowrap; }
    .chip.good,.board-tag { border:1px solid #333; background:#050505; color:#facc15; border-radius:4px; padding:1px 4px; font-size:11px; font-weight:700; white-space:nowrap; }
    .chip.warn { border-color:#e9c77d; background:#fff8e6; color:var(--amber); }
    .buy-signal { color:#facc15; font-weight:800; }
    .trigger-prices { display:flex; flex-direction:column; gap:2px; margin-top:2px; }
    .trigger-item { font-size:10px; font-weight:600; color:var(--muted); white-space:nowrap; }
    .trigger-item.triggered { color:#facc15; font-weight:800; }
    .row-delete { height:24px; padding:0 7px; font-size:11px; border-radius:5px; }
    @media (max-width:900px){ .grid{grid-template-columns:1fr}form{grid-template-columns:1fr} }
    @media (max-width:640px){ .manager-body{align-items:center}.toolbar input{width:100px}.toolbar button{flex:none}.ticker{white-space:normal} }
  </style>
</head>
<body>
  <main>
    <div id="error" class="error"></div>
    <section class="ticker">
      <div id="tickerText" class="ticker-text">等待信号...</div>
    </section>
    <section class="card manager">
      <div class="manager-body">
        <form id="addForm" class="toolbar">
          <input name="code" placeholder="代码 002580" required />
          <button type="submit">增加</button>
        </form>
        <form id="deleteForm" class="toolbar">
          <input name="code" placeholder="代码 002580" required />
          <button class="danger" type="submit">删除</button>
        </form>
        <div class="meta">
          <div id="updated">等待数据...</div>
          <div id="refreshText">自动刷新</div>
        </div>
        <div class="toolbar">
          <label class="muted">刷新秒数 <input id="refreshSecondsInput" type="number" min="5" step="1" value="5" /></label>
          <button class="secondary" type="button" onclick="saveRefreshSeconds()">保存刷新</button>
        </div>
        <div class="toolbar theme-tools">
          <button id="themeLight" class="secondary" type="button" onclick="setTheme('light')">亮色</button>
          <button id="themeThs" class="secondary" type="button" onclick="setTheme('ths')">黑底</button>
        </div>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <div class="label">自选股提示</div>
        <div id="watchHint" class="hint-lines">
          <div class="hint-line"><span class="hint-tag">分时领涨/量能</span><span class="hint-text">--</span></div>
          <div class="hint-line"><span class="hint-tag">趋势</span><span class="hint-text">--</span></div>
          <div class="hint-line risk"><span class="hint-tag">风险</span><span class="hint-text">--</span></div>
        </div>
      </div>
      <div class="card">
        <div class="label">买点/预警规则（满足任一即显示）</div>
        <div class="rules" id="signalRules">--</div>
      </div>
    </section>
    <div class="table-wrap">

      <table>
        <thead>
          <tr>
            <th>标的</th><th>买点/预警</th><th>昨日涨幅</th><th>昨日高低</th><th>当日最高</th><th>最新/涨幅</th><th>开盘涨幅</th><th>当日最低</th><th>高点回撤</th><th>低点反弹</th><th>昨今成交量</th><th>100日最大量</th><th>量比</th><th>成交额</th><th>5日均价</th><th>10日均价</th><th>5-10差</th><th>5日涨幅</th><th>10日涨幅</th><th>30日涨幅</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </main>
  <script>
    let timer = null;
    function pctClass(text){ return text && text.startsWith("-") ? "neg" : "pos"; }
    function chips(items, cls=""){ return items && items.length ? '<div class="chips">' + items.map(x => '<span class="chip '+cls+'">'+x+'</span>').join('') + '</div>' : '<span class="muted">--</span>'; }
    function escapeHtml(value){
      return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function setTheme(theme){
      const next = theme === 'ths' ? 'ths' : 'light';
      document.body.dataset.theme = next;
      localStorage.setItem('klineTheme', next);
      document.getElementById('themeLight')?.classList.toggle('theme-active', next === 'light');
      document.getElementById('themeThs')?.classList.toggle('theme-active', next === 'ths');
    }
    function initTheme(){
      setTheme(localStorage.getItem('klineTheme') || 'ths');
    }
    function ensureLocalColumns(){
      const head = document.querySelector('thead tr');
      if (head && !head.dataset.localIndexColumn) {
        head.insertAdjacentHTML('afterbegin', '<th>序</th>');
        head.dataset.localIndexColumn = '1';
      }
      if (head && !head.dataset.localDeleteColumn) {
        head.insertAdjacentHTML('beforeend', '<th>删除</th>');
        head.dataset.localDeleteColumn = '1';
      }
    }
    function applyTableHeader(){
      const head = document.querySelector('thead tr');
      if (!head || head.dataset.localColumnsReady) return;
      head.innerHTML = '<th>序</th><th>标的</th><th>买点/预警</th><th>昨日涨幅</th><th>昨日高低</th><th>开盘涨幅</th><th>最新/涨幅</th><th>高点回撤</th><th>低点反弹</th><th>当日最高</th><th>当日最低</th><th>100日最大量</th><th>量比</th><th>成交额</th><th>5日均价</th><th>10日均价</th><th>5-10差</th><th>5日涨幅</th><th>10日涨幅</th><th>30日涨幅</th><th>删除</th>';
      head.dataset.localColumnsReady = '1';
    }
    function collectAlerts(data){
      const alerts = [];
      for (const row of data.rows || []) {
        for (const signal of row.buySignals || []) {
          alerts.push({ key: 'buy:' + row.item.code + ':' + signal, type: 'buy', text: (row.item.name || row.quote?.displayName || row.item.code) + ' ' + signal });
        }
        if (row.daily?.ma10Text !== '--' && row.quote?.last && Number(row.quote.last) < Number(row.daily.ma10Text)) {
          alerts.push({ key: 'risk:' + row.item.code + ':破10日线', type: 'risk', text: (row.item.name || row.quote?.displayName || row.item.code) + ' 破10日线' });
        } else if (row.daily?.ma5Text !== '--' && row.quote?.last && Number(row.quote.last) < Number(row.daily.ma5Text)) {
          alerts.push({ key: 'risk:' + row.item.code + ':破5日线', type: 'risk', text: (row.item.name || row.quote?.displayName || row.item.code) + ' 破5日线' });
        }
      }
      return alerts;
    }
    function renderTicker(data){
      const alerts = collectAlerts(data);
      const ticker = document.getElementById('tickerText');
      const risks = alerts.filter(item => item.type === 'risk').map(item => item.text);
      const buys = alerts.filter(item => item.type === 'buy').map(item => item.text);
      const messages = [];
      if (risks.length) messages.push('<span class="risk">破均线：' + escapeHtml(risks.slice(0, 4).join(' / ')) + '</span>');
      if (buys.length) messages.push('<span class="buy">买点：' + escapeHtml(buys.slice(0, 4).join(' / ')) + '</span>');
      ticker.innerHTML = messages.length ? messages.join('<span class="sep">|</span>') : '等待信号...';
      ticker.className = 'ticker-text';
    }
        async function api(path, options){
      const res = await fetch(path, options);
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      if(!res.ok){
        const msg = text.includes('Worker exceeded resource limits') || text.includes('Error 1102')
          ? '网页版 Worker 超出资源限制，已保留旧数据，请稍后自动重试'
          : (text.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 180) || ('HTTP ' + res.status));
        throw new Error(msg);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('接口返回不是 JSON：' + (type || 'unknown'));
      }
    }
    async function removeStock(code){
      await api('/api/watchlist/' + code, { method:'DELETE' });
      await loadEditor();
      await refresh();
    }
    async function saveRefreshSeconds(){
      const value = Math.max(5, Number(document.getElementById('refreshSecondsInput').value || 5));
      await api('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ refreshSeconds: value }) });
      await loadEditor();
      await refresh();
    }
    async function loadEditor(){
      const config = await api('/api/config?t=' + Date.now());
      document.getElementById('refreshSecondsInput').value = config.refreshSeconds || 5;
    }
    async function refresh(){
      if (document.hidden) {
        if(timer) clearTimeout(timer);
        timer = setTimeout(refresh, 30000);
        return;
      }
      try {
        const data = await api('/api/snapshot?t=' + Date.now());
        document.getElementById('error').style.display = 'none';
        document.getElementById('updated').textContent = '更新：' + data.generatedAt + (data.cached ? '（缓存）' : '') + (data.stale ? '（旧数据）' : '');
        document.getElementById('refreshText').textContent = (data.isTradingSession ? '交易时段' : '非交易时段') + '，每 ' + data.refreshSeconds + ' 秒刷新';
        const summary = data.watchSummary || {};
        document.getElementById('watchHint').innerHTML =
          '<div class="hint-line"><span class="hint-tag">分时领涨/量能</span><span class="hint-text">' + (summary.intraday || '--') + '</span></div>' +
          '<div class="hint-line"><span class="hint-tag">趋势</span><span class="hint-text">' + (summary.trend || '--') + '</span></div>' +
          '<div class="hint-line risk"><span class="hint-tag">风险</span><span class="hint-text">' + (summary.risk || '--') + '</span></div>';
        if (data.signalRules && data.signalRules.length) {
          document.getElementById('signalRules').innerHTML = data.signalRules.map(r =>
            '<div><span class="rule-name">' + r.name + '</span><span class="rule-cond">' + r.desc + '</span></div>'
          ).join('');
        }
        applyTableHeader();
        document.getElementById('rows').innerHTML = data.rows.map((row, index) => {
          const q = row.quote || {}, s = row.stats || {}, yt = row.yesterdayText || {}, dly = row.daily || {};
          const below5 = dly.ma5Text && q.last ? Number(q.last) < Number(dly.ma5Text) : false;
          const below10 = dly.ma10Text && q.last ? Number(q.last) < Number(dly.ma10Text) : false;
          const nameClass = below10 ? 'name warn10' : (below5 ? 'name warn5' : 'name');
          const ma5Class = below5 && !below10 ? 'ma-cell warn5' : 'ma-cell';
          const ma10Class = below10 ? 'ma-cell warn10' : 'ma-cell';
          return '<tr>' +
            '<td class="row-index">' + (index + 1) + '</td>' +
            '<td><div class="' + nameClass + '">' + (row.item.name || q.displayName || '--') + '</div><div class="code">' + row.item.code + '</div></td>' +
            '<td class="buy-signal">' +
              ((row.buySignals && row.buySignals.length) ? '<div>' + row.buySignals.join('<br>') + '</div>' : '') +
              ((row.triggerPrices && row.triggerPrices.length) ?
                (() => {
                  const pending = row.triggerPrices.filter(t => !row.buySignals || !row.buySignals.includes(t.name));
                  return pending.length ? '<div class="trigger-prices">' + pending.map(t => '<span class="trigger-item">' + t.name + '≥' + t.price + '</span>').join('') + '</div>' : '';
                })() : '') +
              ((!row.buySignals || !row.buySignals.length) && (!row.triggerPrices || !row.triggerPrices.length) ? '--' : '') +
            '</td>' +
            '<td class="' + pctClass(yt.pctText) + '">' + (yt.pctText || '--') + (yt.boardTag ? '<div><span class="chip good">' + yt.boardTag + '</span></div>' : '') + '</td>' +
            '<td><div>高 ' + (yt.highText || '--') + '</div><div class="code">低 ' + (yt.lowText || '--') + '</div></td>' +
            '<td class="' + pctClass(q.openPctText) + '">' + (q.openPctText || '--') + '</td>' +
            '<td><div class="last-price ' + pctClass(q.pctText) + '">' + (q.last ? q.last.toFixed(2) : '--') + '</div><div class="' + pctClass(q.pctText) + '">' + (q.pctText || '--') + (q.boardText ? ' <span class="board-tag">' + q.boardText + '</span>' : '') + '</div></td>' +
            '<td class="' + pctClass(s.pullbackFromHighText) + '">' + (s.pullbackFromHighText || '--') + '</td>' +
            '<td class="pos">' + (s.bounceFromLowText || '--') + '</td>' +
            '<td>' + (s.high ? s.high.toFixed(2) + '<div class="code">' + s.highTime + '</div>' : '--') + '</td>' +
            '<td>' + (s.low ? s.low.toFixed(2) + '<div class="code">' + s.lowTime + '</div>' : '--') + '</td>' +
            '<td><div>' + (dly.maxVol100Text || '--') + '</div><div class="code">' + (dly.volToMax100Text || '--') + '</div></td>' +
            '<td>' + (yt.volumeRatioText || '--') + '</td>' +
            '<td>' + (q.amountText || '--') + '</td>' +
            '<td><div class="' + ma5Class + '">' + (dly.ma5Text || '--') + '</div><div class="code ' + pctClass(dly.ma5DistanceText) + '">' + (dly.ma5DistanceText || '--') + '</div></td>' +
            '<td><div class="' + ma10Class + '">' + (dly.ma10Text || '--') + '</div><div class="code ' + pctClass(dly.ma10DistanceText) + '">' + (dly.ma10DistanceText || '--') + '</div></td>' +
            '<td><div class="' + pctClass(dly.maDiffNowText) + '">' + (dly.maDiffNowText || '--') + '</div><div class="code ' + pctClass(dly.maDiffPrevText) + '">' + (dly.maDiffPrevText || '--') + '</div></td>' +
            '<td class="' + pctClass(dly.ret5Text) + '">' + (dly.ret5Text || '--') + '</td>' +
            '<td class="' + pctClass(dly.ret10Text) + '">' + (dly.ret10Text || '--') + '</td>' +
            '<td class="' + pctClass(dly.ret30Text) + '">' + (dly.ret30Text || '--') + '</td>' +
            '<td><button class="danger row-delete" type="button" data-delete-code="' + row.item.code + '">删除</button></td>' +
          '</tr>';
        }).join('');
        renderTicker(data);
        if(timer) clearTimeout(timer);
        timer = setTimeout(refresh, Math.max(5, data.refreshSeconds || 10) * 1000);
      } catch (err) {
        const box = document.getElementById('error');
        box.style.display = 'block';
        box.textContent = '刷新失败：' + err.message;
        if(timer) clearTimeout(timer);
        timer = setTimeout(refresh, 10000);
      }
    }
    document.getElementById('addForm').addEventListener('submit', async e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      await api('/api/watchlist', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: form.get('code') }) });
      e.currentTarget.reset();
      await loadEditor();
      await refresh();
    });
    document.getElementById('deleteForm').addEventListener('submit', async e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      await removeStock(String(form.get('code') || '').trim());
      e.currentTarget.reset();
    });
    document.getElementById('rows').addEventListener('click', async e => {
      const button = e.target.closest('[data-delete-code]');
      if (!button) return;
      await removeStock(button.dataset.deleteCode || '');
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    initTheme();
    loadEditor();
    refresh();
  </script>
</body>
</html>`;

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") return send(res, 200, html, "text/html; charset=utf-8");
    if (url.pathname === "/api/snapshot") return send(res, 200, JSON.stringify(await getSnapshotCached()), "application/json; charset=utf-8");
    if (url.pathname === "/api/config" && req.method === "GET") return send(res, 200, JSON.stringify(await loadConfig()), "application/json; charset=utf-8");
    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readJson(req);
      const config = await loadConfig();
      if (Number.isFinite(Number(body.refreshSeconds))) {
        config.refreshSeconds = Math.max(5, Number(body.refreshSeconds));
      }
      if (Array.isArray(body.watchlist)) {
        config.watchlist = body.watchlist;
      }
      return send(res, 200, JSON.stringify(await saveConfig(config)), "application/json; charset=utf-8");
    }
    if (url.pathname === "/api/watchlist" && req.method === "POST") {
      const body = await readJson(req);
      const code = normalizeCode(body.code);
      if (!code) return send(res, 400, "Invalid code");
      const config = await loadConfig();
      const item = { code, name: String(body.name || "").trim(), note: String(body.note || "").trim() };
      const index = config.watchlist.findIndex((x) => x.code === code);
      if (index >= 0) config.watchlist[index] = item;
      else config.watchlist.push(item);
      return send(res, 200, JSON.stringify(await saveConfig(config)), "application/json; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/watchlist/") && req.method === "DELETE") {
      const code = normalizeCode(decodeURIComponent(url.pathname.split("/").at(-1)));
      const config = await loadConfig();
      config.watchlist = config.watchlist.filter((item) => item.code !== code);
      return send(res, 200, JSON.stringify(await saveConfig(config)), "application/json; charset=utf-8");
    }
    return send(res, 404, "Not found");
  } catch (error) {
    return send(res, 500, error.stack || error.message);
  }
});

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isMain) {
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    console.log(`A股龙头监控已启动：http://${displayHost}:${PORT}`);
    console.log("数据源：新浪行情");
    console.log("停止服务：在这个窗口按 Ctrl + C");
  });
}
