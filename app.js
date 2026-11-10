(() => {
  "use strict";

  const HPL_CONTRACT = "0xbd6dab50f03a305a80037294fa8d1a9dc0cac91b";
  const SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000078";
  const CORE_API = "https://api.hypurrscan.io";
  const EVM_API = "https://trace.hypurrscan.io/api/v1";
  const HL_API = "https://api.hyperliquid.xyz/info";
  const DAILY_REFRESH_MS = 60 * 60 * 1000; // 榜单与流向每小时自动刷新
  const BOOK_REFRESH_MS = 15 * 1000;       // 盘口与最新成交每 15 秒
  const MARKET_REFRESH_MS = 5 * 60 * 1000; // 成交额每 5 分钟
  const BIG_FLOW_HPL = 1000000;
  const BIG_FLOW_RATIO = 0.1;
  const TAPE_MAX = 60;
  const RETRY_REFRESH_MS = 15 * 60 * 1000;
  const HISTORY_PAGE_SIZE = 2000;
  const EVM_PAGE_SIZE = 1000;
  const EVM_MAX_PAGES = 20;
  const EVM_RPC = "https://rpc.hyperliquid.xyz/evm";
  const SNAPSHOT_TOLERANCE_MS = 30 * 60 * 1000;
  const PREF_KEY = "hpl-tracker:exclude-contracts";
  const HISTORY_MAX_RANGE_REQUESTS = 5;
  const HISTORY_BATCH_SIZE = 50;
  const HISTORY_RANGES = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  };
  const HISTORY_RANGE_LABELS = {
    recent: "最近最多 2,000 笔全部品种成交",
    day: "近 24 小时",
    week: "近 7 天",
    month: "近 30 天",
    year: "近 365 天"
  };
  const PERIODS = {
    day: { ms: 24 * 60 * 60 * 1000, label: "24 小时" },
    week: { ms: 7 * 24 * 60 * 60 * 1000, label: "7 天" },
    month: { ms: 30 * 24 * 60 * 60 * 1000, label: "30 天" }
  };
  const LABELS = {
    "0x09b2236327d76fcd9e4b72db70a6608c21a94292": "sHPL 质押合约",
    "0xcbf400610dbf462fe316d8a7db6ba78d57e43d7b": "项目资金库多签",
    "0x50ff828e66612a4d1f7141936f2b4078c7356329": "锁仓流合约",
    "0x3aa0a4f916f6c3c9c9054e52cd5aafeb8a09cf39": "空投分发合约",
    "0x5369e34c92eacc1cceaffe1be01f057c68ca1b19": "锁仓合约",
    "0x9450b54a3d9586e117a9b00197cd8a938f9b75e2": "空投领取合约"
  };
  const $ = id => document.getElementById(id);
  const state = {
    period: "day",
    current: null,
    periodData: null,
    periodCache: {},
    pairs: null,
    price: null,
    book: null,
    bookLoading: false,
    generation: 0,
    periodController: null,
    currentController: null,
    lastRefreshAt: 0,
    lastAttemptAt: 0,
    refreshing: false,
    historyWallet: null,
    historyRange: "recent",
    historySide: "all",
    historyData: null,
    historyController: null,
    historyLoading: false,
    historyShown: HISTORY_BATCH_SIZE,
    historyCache: new Map(),
    aliases: null,
    costs: new Map(),
    costController: null,
    market: null,
    trades: new Map(),
    volumeChart: null,
    volumeSeries: null,
    base: null,
    codes: new Map(),
    excludeContracts: false,
    candles: new Map(),
    chart: null,
    chartSeries: null,
    chartKey: ""
  };
  const nf = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

  function validAddress(value) {
    return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
  }
  function address(value) {
    return String(value).toLowerCase();
  }
  function amount(value, decimals = 18) {
    const n = Number(value);
    return Number.isFinite(n) ? n / 10 ** decimals : 0;
  }
  function fmt(value) {
    return nf.format(value);
  }
  function compact(value) {
    if (value >= 1e8) return fmt(value / 1e8) + " 亿";
    if (value >= 1e4) return fmt(value / 1e4) + " 万";
    return fmt(value);
  }
  function signed(value) {
    return (value > 0 ? "+" : value < 0 ? "−" : "") + fmt(Math.abs(value));
  }
  function timeText(ms) {
    return new Date(ms).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }
  function fullTimeText(ms) {
    return new Date(ms).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }
  function priceText(value) {
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value.toFixed(value < 0.01 ? 7 : 6);
  }
  function short(value) {
    return value.slice(0, 6) + "…" + value.slice(-4);
  }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function labelFor(wallet) {
    return LABELS[wallet] || (state.aliases && state.aliases.get(wallet)) || "";
  }
  function usd(value) {
    if (!Number.isFinite(value)) return "—";
    if (value >= 1e8) return "$" + fmt(value / 1e8) + " 亿";
    if (value >= 1e4) return "$" + fmt(value / 1e4) + " 万";
    return "$" + fmt(value);
  }
  function setStatus(text) {
    $("sync-status").textContent = text;
  }
  function isAbort(error) {
    return error && error.name === "AbortError";
  }
  async function fetchJson(url, options = {}, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error("HTTP " + response.status);
        return await response.json();
      } catch (error) {
        if (isAbort(error) || attempt === retries) throw error;
        const limited = /HTTP 429/.test(String(error && error.message));
        await new Promise(resolve => setTimeout(resolve, (limited ? 2500 : 450) * (attempt + 1)));
      }
    }
  }
  function post(url, body, signal) {
    return fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  }
  function info(body, signal) {
    return post(HL_API, body, signal);
  }
  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  function derivePairs(meta) {
    const tokens = Array.isArray(meta.tokens) ? meta.tokens : [];
    const markets = Array.isArray(meta.universe) ? meta.universe : [];
    const hpl = tokens.find(item => item.name === "HPL" && address(item.evmContract && item.evmContract.address) === HPL_CONTRACT);
    const usdc = tokens.find(item => item.name === "USDC");
    const usdh = tokens.find(item => item.name === "USDH");
    if (!hpl || !usdc) return null;
    const pairFor = quote => {
      if (!quote) return null;
      const item = markets.find(market => Array.isArray(market.tokens) && market.tokens[0] === hpl.index && market.tokens[1] === quote.index);
      return item ? "@" + item.index : null;
    };
    const usdcPair = pairFor(usdc);
    const usdhPair = pairFor(usdh);
    if (!usdcPair) return null;
    return { usdc: usdcPair, usdh: usdhPair, tokenIndex: hpl.index };
  }

  function parseSide(side) {
    return (Array.isArray(side) ? side : []).map(level => ({
      px: Number(level.px), sz: Number(level.sz), n: Number(level.n) || 0
    })).filter(level => Number.isFinite(level.px) && level.px > 0 && Number.isFinite(level.sz) && level.sz > 0);
  }
  function depthWithin(side, mid, percent, isBid) {
    const threshold = mid * (1 + (isBid ? -percent : percent));
    const included = side.filter(level => isBid ? level.px >= threshold : level.px <= threshold);
    return {
      hpl: included.reduce((sum, level) => sum + level.sz, 0),
      usdc: included.reduce((sum, level) => sum + level.px * level.sz, 0),
      complete: side.length < 20 || (isBid ? side[side.length - 1].px < threshold : side[side.length - 1].px > threshold)
    };
  }
  function parseBook(raw, rawAgg) {
    if (!raw || !Array.isArray(raw.levels) || raw.levels.length < 2) throw new Error("盘口数据格式无法识别");
    const bids = parseSide(raw.levels[0]).sort((x, y) => y.px - x.px);
    const asks = parseSide(raw.levels[1]).sort((x, y) => x.px - y.px);
    if (!bids.length || !asks.length || bids[0].px >= asks[0].px) throw new Error("盘口买卖档位暂不可用");
    const mid = (bids[0].px + asks[0].px) / 2;
    const ranges = [0.01, 0.02].map(percent => ({ bid: depthWithin(bids, mid, percent, true), ask: depthWithin(asks, mid, percent, false) }));
    // 5% / 10% 用按 3 位有效数字合并档位的盘口估算
    if (rawAgg && Array.isArray(rawAgg.levels) && rawAgg.levels.length >= 2) {
      const aggBids = parseSide(rawAgg.levels[0]).sort((x, y) => y.px - x.px);
      const aggAsks = parseSide(rawAgg.levels[1]).sort((x, y) => x.px - y.px);
      for (const percent of [0.05, 0.1]) {
        ranges.push({ bid: depthWithin(aggBids, mid, percent, true), ask: depthWithin(aggAsks, mid, percent, false) });
      }
    }
    const apiTime = Number(raw.time);
    return {
      bid: bids[0], ask: asks[0], mid, bids, asks, ranges,
      at: Number.isFinite(apiTime) && apiTime > 0 ? apiTime : Date.now(),
      fetchedAt: Date.now()
    };
  }

  function renderLadder(book) {
    const build = (side, isBid) => {
      let cum = 0;
      const rows = side.map(level => { cum += level.sz; return { ...level, cum }; });
      return { rows, total: cum };
    };
    const bidData = build(book.bids, true);
    const askData = build(book.asks, false);
    const maxCum = Math.max(bidData.total, askData.total, 1);
    const pct = (level, isBid) => (isBid ? "−" : "+") + (Math.abs(level.px - book.mid) / book.mid * 100).toFixed(2) + "%";
    $("ladder-bids").innerHTML = bidData.rows.map(level =>
      '<div class="ladder-row" title="距中间价 ' + pct(level, true) + (level.n ? " · " + level.n + " 笔挂单" : "") + '">' +
      '<i class="ladder-bar" style="width:' + (level.cum / maxCum * 100).toFixed(1) + '%"></i>' +
      '<span class="muted">' + compact(level.cum) + '</span><span>' + compact(level.sz) + '</span>' +
      '<span class="ladder-px bid">' + priceText(level.px) + '</span></div>').join("");
    $("ladder-asks").innerHTML = askData.rows.map(level =>
      '<div class="ladder-row" title="距中间价 ' + pct(level, false) + (level.n ? " · " + level.n + " 笔挂单" : "") + '">' +
      '<i class="ladder-bar" style="width:' + (level.cum / maxCum * 100).toFixed(1) + '%"></i>' +
      '<span class="ladder-px ask">' + priceText(level.px) + '</span><span>' + compact(level.sz) + '</span>' +
      '<span class="muted">' + compact(level.cum) + '</span></div>').join("");
  }

  function renderBook() {
    const book = state.book;
    if (!book) return;
    $("book-bid").textContent = priceText(book.bid.px);
    $("book-ask").textContent = priceText(book.ask.px);
    $("book-bid-size").textContent = fmt(book.bid.sz) + " HPL 挂单";
    $("book-ask-size").textContent = fmt(book.ask.sz) + " HPL 挂单";
    $("book-spread").textContent = ((book.ask.px - book.bid.px) / book.mid * 100).toFixed(3) + "%";
    const depthHtml = value => value
      ? '<span class="book-depth-value">' + (value.complete ? "" : "至少 ") + compact(value.hpl) + ' HPL</span><span class="book-depth-sub">≈ ' + fmt(value.usdc) + ' USDC</span>'
      : "—";
    ["1", "2", "5", "10"].forEach((key, index) => {
      const range = book.ranges[index];
      $("book-bid-" + key).innerHTML = depthHtml(range && range.bid);
      $("book-ask-" + key).innerHTML = depthHtml(range && range.ask);
    });
    $("book-status").textContent = "盘口快照 · 北京时间 " + fullTimeText(book.at) + " · 每 15 秒更新";
    const hasIncompleteRange = book.ranges.slice(0, 2).some(range => !range.bid.complete || !range.ask.complete);
    $("book-note").textContent = hasIncompleteRange
      ? "1%/2% 深度仅含官方接口可见的前 20 档；“至少”表示该区间超出可见档位。5%/10% 为合并档位后的约值。挂单可撤销，不等于已成交量。"
      : "官方接口每侧最多显示 20 档；1% 和 2% 区间均在可见范围内，5%/10% 为合并档位后的约值。挂单可撤销，不等于已成交量。";
    // 盘口偏薄提示
    const warns = [];
    const one = book.ranges[0];
    const thin = (value, name) => { if (value.usdc < 500) warns.push(name + " 1% 内仅 ≈ " + fmt(value.usdc) + " USDC"); };
    thin(one.bid, "买盘");
    thin(one.ask, "卖盘");
    const ratio = one.ask.usdc > 0 ? one.bid.usdc / one.ask.usdc : Infinity;
    if (ratio >= 5) warns.push("1% 内买盘约为卖盘的 " + (Number.isFinite(ratio) ? fmt(Math.round(ratio)) : "∞") + " 倍，向上更容易被推动");
    else if (ratio > 0 && ratio <= 0.2) warns.push("1% 内卖盘约为买盘的 " + fmt(Math.round(1 / ratio)) + " 倍，向下更容易被推动");
    const spread = (book.ask.px - book.bid.px) / book.mid;
    if (spread > 0.01) warns.push("买卖价差 " + (spread * 100).toFixed(2) + "%，偏宽");
    $("book-warn").hidden = !warns.length;
    $("book-warn").textContent = warns.length ? "⚠ 盘口偏薄：" + warns.join("；") + "。" : "";
    renderLadder(book);
  }

  function mergeTrades(list) {
    if (!Array.isArray(list)) return;
    for (const trade of list) {
      const key = String(trade.tid ?? "") + ":" + String(trade.hash ?? "") + ":" + String(trade.time ?? "");
      if (state.trades.has(key)) continue;
      const px = Number(trade.px);
      const sz = Number(trade.sz);
      const time = Number(trade.time);
      if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(time)) continue;
      const users = Array.isArray(trade.users) ? trade.users.map(address) : [];
      state.trades.set(key, { key, px, sz, time, side: trade.side === "B" ? "buy" : "sell", users, fresh: state.trades.size > 0 });
    }
    const sorted = Array.from(state.trades.values()).sort((x, y) => y.time - x.time);
    state.trades = new Map(sorted.slice(0, TAPE_MAX).map(trade => [trade.key, trade]));
  }
  function renderTrades() {
    const trades = Array.from(state.trades.values());
    if (!trades.length) {
      $("tape-rows").innerHTML = '<tr><td colspan="6" class="loading">暂无成交</td></tr>';
      return;
    }
    const top = new Map((state.current ? state.current.rows : []).map((row, index) => [row.address, index + 1]));
    $("tape-rows").innerHTML = trades.map(trade => {
      const cls = trade.side === "buy" ? "positive" : "negative";
      const hit = trade.users.map(user => top.get(user)).filter(Boolean);
      const tag = hit.length ? '<span class="tape-tag" title="买方或卖方是前十地址">前十 #' + hit.join("/#") + '</span>' : "";
      const html = '<tr class="' + (trade.fresh ? "fresh" : "") + '"><td class="history-time">' +
        new Date(trade.time).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + '</td>' +
        '<td class="' + cls + '">' + (trade.side === "buy" ? "买入" : "卖出") + tag + '</td>' +
        '<td class="' + cls + '">' + priceText(trade.px) + '</td><td>' + fmt(trade.sz) + '</td><td>' + fmt(trade.px * trade.sz) + '</td></tr>';
      trade.fresh = false;
      return html;
    }).join("");
    const span = trades.length > 1 ? trades[0].time - trades[trades.length - 1].time : 0;
    const vol = trades.reduce((sum, trade) => sum + trade.px * trade.sz, 0);
    $("tape-caption").textContent = "最近 " + trades.length + " 笔" + (span ? " · 覆盖 " + spanText(span) : "") + " · 合计 ≈ " + fmt(vol) + " USDC";
  }

  async function refreshBook(force = false) {
    if (document.hidden && !force) return;
    if (state.bookLoading) return;
    if (!force && state.book && Date.now() - state.book.fetchedAt < BOOK_REFRESH_MS - 500) return;
    if (!state.pairs?.usdc) {
      $("book-status").textContent = "等待 HPL / USDC 交易对信息";
      return;
    }
    state.bookLoading = true;
    $("book-reload").disabled = true;
    if (!state.book) $("book-status").textContent = "正在读取盘口…";
    try {
      const [raw, rawAgg, trades] = await Promise.all([
        info({ type: "l2Book", coin: state.pairs.usdc }),
        info({ type: "l2Book", coin: state.pairs.usdc, nSigFigs: 3 }).catch(() => null),
        info({ type: "recentTrades", coin: state.pairs.usdc }).catch(() => null)
      ]);
      state.book = parseBook(raw, rawAgg);
      renderBook();
      mergeTrades(trades);
      renderTrades();
    } catch (_) {
      $("book-status").textContent = state.book
        ? "盘口刷新失败 · 上次快照：北京时间 " + fullTimeText(state.book.at)
        : "盘口暂不可用，请稍后重试";
    } finally {
      state.bookLoading = false;
      $("book-reload").disabled = false;
    }
  }

  // ---------- 成交额与市场概况 ----------
  async function refreshMarket() {
    if (!state.pairs?.usdc) return;
    const end = Date.now();
    try {
      const [ctxs, candles] = await Promise.all([
        info({ type: "spotMetaAndAssetCtxs" }),
        info({ type: "candleSnapshot", req: { coin: state.pairs.usdc, interval: "1h", startTime: end - 31 * DAY_MS, endTime: end } })
      ]);
      const list = Array.isArray(ctxs) && Array.isArray(ctxs[1]) ? ctxs[1] : [];
      const ctx = list.find(item => item.coin === state.pairs.usdc) || null;
      const ctxH = state.pairs.usdh ? list.find(item => item.coin === state.pairs.usdh) || null : null;
      state.market = { ctx, ctxH, candles: Array.isArray(candles) ? candles : [], at: end };
      renderMarket();
    } catch (error) {
      $("market-status").textContent = state.market ? "成交数据刷新失败，显示上次数据" : "成交数据暂不可用：" + historyErrorText(error);
    }
  }
  function renderMarket() {
    const m = state.market;
    if (!m) return;
    const now = m.at;
    const bars = m.candles.map(c => ({ t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }))
      .filter(c => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite));
    const notional = c => c.v * (c.o + c.h + c.l + c.c) / 4;
    const sumSince = ms => bars.filter(c => c.t >= now - ms).reduce((acc, c) => ({ usd: acc.usd + notional(c), hpl: acc.hpl + c.v }), { usd: 0, hpl: 0 });
    const d1 = sumSince(DAY_MS);
    const d7 = sumSince(7 * DAY_MS);
    const d30 = sumSince(30 * DAY_MS);
    const ctx = m.ctx;
    const dayNtl = ctx ? Number(ctx.dayNtlVlm) : d1.usd;
    const dayBase = ctx ? Number(ctx.dayBaseVlm) : d1.hpl;
    $("vol-24h").textContent = usd(dayNtl);
    let sub24 = fmt(dayBase) + " HPL";
    if (m.ctxH && Number(m.ctxH.dayNtlVlm) > 0) sub24 += " · USDH 对另有 " + usd(Number(m.ctxH.dayNtlVlm));
    $("vol-24h-sub").textContent = sub24;
    const mid = ctx ? Number(ctx.midPx) || Number(ctx.markPx) : NaN;
    const prev = ctx ? Number(ctx.prevDayPx) : NaN;
    if (Number.isFinite(mid) && Number.isFinite(prev) && prev > 0) {
      const chg = (mid - prev) / prev * 100;
      $("chg-24h").textContent = (chg > 0 ? "+" : chg < 0 ? "−" : "") + Math.abs(chg).toFixed(2) + "%";
      $("chg-24h").className = chg > 0 ? "positive" : chg < 0 ? "negative" : "";
      $("chg-24h-sub").textContent = priceText(prev) + " → " + priceText(mid);
    }
    $("vol-7d").textContent = "≈ " + usd(d7.usd);
    $("vol-7d-sub").textContent = compact(d7.hpl) + " HPL · 日均 " + usd(d7.usd / 7);
    $("vol-30d").textContent = "≈ " + usd(d30.usd);
    $("vol-30d-sub").textContent = compact(d30.hpl) + " HPL · 日均 " + usd(d30.usd / 30);
    const circ = ctx ? Number(ctx.circulatingSupply) : NaN;
    if (Number.isFinite(circ) && Number.isFinite(mid)) {
      $("mcap").textContent = usd(circ * mid);
      const turnover = circ > 0 ? dayBase / circ * 100 : 0;
      $("mcap-sub").textContent = "流通 " + compact(circ) + " HPL · 24h 换手 " + turnover.toFixed(2) + "%";
    }
    $("market-status").textContent = "北京时间 " + fullTimeText(now) + " · 每 5 分钟更新 · 24 小时为官方统计，7/30 天由 K 线估算";
    renderVolumeChart(bars, notional);
  }
  function renderVolumeChart(bars, notional) {
    if (!window.LightweightCharts) return;
    if (!state.volumeChart) {
      state.volumeChart = window.LightweightCharts.createChart($("volume-chart"), {
        autoSize: true,
        layout: { background: { type: "solid", color: "#0f1c22" }, textColor: "#8fa6a9", fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: "#16262c" } },
        rightPriceScale: { borderColor: "#22343a" },
        timeScale: { borderColor: "#22343a" },
        handleScroll: false,
        handleScale: false
      });
      state.volumeSeries = state.volumeChart.addHistogramSeries({ priceFormat: { type: "custom", formatter: value => usd(value) } });
    }
    const days = new Map();
    for (const c of bars) {
      const day = Math.floor((c.t + CHART_OFFSET_S * 1000) / DAY_MS) * DAY_MS / 1000;
      const item = days.get(day) || { time: day, value: 0, open: c.o, close: c.c };
      item.value += notional(c);
      item.close = c.c;
      days.set(day, item);
    }
    const data = Array.from(days.values()).sort((x, y) => x.time - y.time).slice(-30).map(item => ({
      time: item.time, value: item.value, color: item.close >= item.open ? "rgba(70,223,176,.75)" : "rgba(242,142,141,.75)"
    }));
    state.volumeSeries.setData(data);
    state.volumeChart.timeScale().fitContent();
  }

  function buildBase(coreData, evmData) {
    if (!coreData || !coreData.holders || !evmData || !Array.isArray(evmData.holders)) {
      throw new Error("持有人数据格式无法识别");
    }
    const core = new Map();
    const evm = new Map();
    for (const [wallet, raw] of Object.entries(coreData.holders)) {
      if (validAddress(wallet) && Number.isFinite(Number(raw))) core.set(address(wallet), Number(raw));
    }
    for (const holder of evmData.holders) {
      const wallet = holder.holder_address;
      if (validAddress(wallet)) evm.set(address(wallet), amount(holder.balance, Number(holder.token_decimals || 18)));
    }
    core.delete(SYSTEM_ADDRESS);
    evm.delete(SYSTEM_ADDRESS);
    const all = Array.from(new Set([...core.keys(), ...evm.keys()]), wallet => ({
      address: wallet,
      core: core.get(wallet) || 0,
      evm: evm.get(wallet) || 0
    }));
    all.forEach(row => { row.total = row.core + row.evm; });
    all.sort((a, b) => b.total - a.total);
    if (all.length < 10) throw new Error("持有人不足 10 个");
    return {
      all,
      core,
      evm,
      coreThreshold: core.size >= 99 ? Math.min(...core.values()) : 0,
      evmThreshold: evm.size >= 99 ? Math.min(...evm.values()) : 0,
      coreAt: Number(coreData.lastUpdate) * 1000,
      coreHolders: Number(coreData.holdersCount || 0),
      evmHolders: Number(evmData.total_holders || 0)
    };
  }

  // 用 HyperEVM 的 eth_getCode 判断地址是否为合约；结果缓存，查询失败视为未知（按个人地址处理）。
  async function ensureCodes(wallets, signal) {
    const missing = wallets.filter(wallet => !state.codes.has(wallet));
    await mapLimit(missing, 5, async wallet => {
      try {
        const data = await post(EVM_RPC, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [wallet, "latest"] }, signal);
        if (typeof data.result === "string") state.codes.set(wallet, data.result !== "0x" && data.result !== "0x0");
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    });
  }
  function isContract(wallet) {
    return Boolean(LABELS[wallet]) || state.codes.get(wallet) === true;
  }

  async function buildView(base, signal) {
    const exclude = state.excludeContracts;
    const picked = [];
    let scanned = 0;
    while (scanned < base.all.length && picked.length < 10) {
      const chunk = base.all.slice(scanned, scanned + 12);
      await ensureCodes(chunk.map(row => row.address), signal);
      for (const row of chunk) {
        if (!exclude || !isContract(row.address)) picked.push(row);
      }
      scanned += chunk.length;
    }
    if (picked.length < 10) throw new Error("符合条件的持有人不足 10 个");
    const rows = picked.slice(0, 10).map(row => ({ ...row, contract: isContract(row.address) }));
    // 榜单校验：第 10 名必须高于榜外任何候选地址可能达到的最大余额
    const top = new Set(rows.map(row => row.address));
    const cutoff = rows[9].total;
    let outsideUpperBound = base.coreThreshold + base.evmThreshold;
    base.all.forEach((row, index) => {
      if (top.has(row.address)) return;
      if (exclude && index < scanned && isContract(row.address)) return;
      const possible = row.total + (base.core.has(row.address) ? 0 : base.coreThreshold) + (base.evm.has(row.address) ? 0 : base.evmThreshold);
      outsideUpperBound = Math.max(outsideUpperBound, possible);
    });
    return {
      rows,
      core: base.core,
      evm: base.evm,
      verified: cutoff > outsideUpperBound,
      coreAt: base.coreAt,
      coreHolders: base.coreHolders,
      evmHolders: base.evmHolders
    };
  }

  async function fetchCoreBalance(wallet, signal) {
    const data = await info({ type: "spotClearinghouseState", user: wallet }, signal);
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const match = balances.find(item => item.token === state.pairs?.tokenIndex || item.coin === "HPL");
    return match ? Number(match.total) || 0 : 0;
  }
  async function fetchEvmBalance(wallet, signal) {
    const data = await post(EVM_API + "/address/tokens/indexed", { address: wallet }, signal);
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const match = balances.find(item => address(item.token) === HPL_CONTRACT);
    return match ? amount(match.balance, Number(match.decimals || 18)) : 0;
  }

  async function refineCandidates(snapshot, signal) {
    await mapLimit(snapshot.rows, 4, async row => {
      const tasks = [];
      if (!snapshot.core.has(row.address)) {
        tasks.push(fetchCoreBalance(row.address, signal).then(value => { row.core = value; }).catch(error => { if (!isAbort(error)) row.estimated = true; }));
      }
      if (!snapshot.evm.has(row.address)) {
        tasks.push(fetchEvmBalance(row.address, signal).then(value => { row.evm = value; }).catch(error => { if (!isAbort(error)) row.estimated = true; }));
      }
      await Promise.all(tasks);
      row.total = row.core + row.evm;
    });
    snapshot.rows.sort((a, b) => b.total - a.total);
  }

  function staleNote() {
    if (!state.current) return "";
    const lag = Date.now() - state.current.coreAt;
    return lag > 20 * 60 * 1000 ? " · 快照后 " + spanText(lag) + " 内的变动未计入" : "";
  }
  function renderCurrent() {
    if (!state.current) return;
    const total = state.current.rows.reduce((sum, row) => sum + row.total, 0);
    $("total-holdings").textContent = fmt(total) + " HPL";
    $("holder-count").textContent = "Core " + fmt(state.current.coreHolders) + " 个地址 · EVM " + fmt(state.current.evmHolders) + " 个地址";
    $("snapshot-label").textContent = "Core 持仓快照：北京时间 " + timeText(state.current.coreAt);
    if (state.price) {
      $("market-price").innerHTML = priceText(state.price) + "<small>USDC</small>";
    } else {
      $("market-price").textContent = "—";
    }
  }

  function renderTradeCell(detail, side) {
    if (!detail || detail.trades === null) return '<span class="pending">读取中…</span>';
    if (detail.trades.error) return '<span class="muted-cell">读取失败</span>';
    const groups = detail.trades.groups[side];
    const labels = ["USDC", "USDH"];
    const content = labels.filter(label => groups[label] && groups[label].qty > 0).map(label => {
      const group = groups[label];
      return '<span class="quote-line">' + priceText(group.notional / group.qty) + ' <small>' + label + '</small></span>' +
        '<span class="sub">' + compact(group.qty) + ' HPL · ' + fmt(group.count) + ' 笔</span>';
    }).join("");
    if (!content) return '<span class="muted-cell">—</span><span class="sub">该期无成交</span>';
    return content + (detail.trades.complete ? "" : '<span class="sub caution">成交记录可能不全</span>');
  }

  function renderRows() {
    if (!state.current) return;
    const details = state.periodData && state.periodData.details;
    const maxAbs = Math.max(1, ...state.current.rows.map(row => {
      const item = details && details.get(row.address);
      return item && item.flowComplete ? Math.abs(item.flow) : 0;
    }));
    $("rows").innerHTML = state.current.rows.map((row, index) => {
      const detail = details && details.get(row.address);
      const name = labelFor(row.address);
      const label = (name ? '<span class="address-label">' + esc(name) + '</span>' : "") +
        (row.contract && !LABELS[row.address] ? '<span class="address-label contract">合约</span>' : "");
      const split = 'Core ' + compact(row.core) + ' · EVM ' + compact(row.evm);
      let flow = '<span class="pending">读取中…</span>';
      if (detail && detail.flowComplete) {
        const cls = detail.flow > 0 ? "positive" : detail.flow < 0 ? "negative" : "neutral";
        const bar = Math.abs(detail.flow) > 0 ? '<span class="flow-bar ' + (detail.flow < 0 ? "negative" : "") + '" style="width:' + Math.max(4, Math.round(Math.abs(detail.flow) / maxAbs * 60)) + 'px"></span>' : "";
        const big = isBigFlow(row, detail.flow) ? '<span class="big-tag">大额</span>' : "";
        flow = '<span class="flow ' + cls + '">' + signed(detail.flow) + '</span>' + big + bar + splitHtml(detail);
      } else if (detail && detail.flowError) {
        flow = '<span class="muted-cell">读取失败</span>';
      }
      return '<tr>' +
        '<td><span class="rank">' + String(index + 1).padStart(2, "0") + '</span>' +
        '<a class="addr" href="https://hypurrscan.io/address/' + row.address + '" target="_blank" rel="noopener noreferrer" title="' + row.address + '">' + short(row.address) + ' ↗</a>' +
        label + '<button class="history-link" type="button" data-history-wallet="' + row.address + '">查看历史点位</button>' +
        '<span class="sub split">' + split + '</span></td>' +
        '<td data-label="当前仓位"><span class="holdings">' + fmt(row.total) + '</span><span class="sub">HPL</span></td>' +
        '<td data-label="期间净流向">' + flow + '</td>' +
        '<td data-label="买入均价">' + renderTradeCell(detail, "buy") + '</td>' +
        '<td data-label="卖出均价">' + renderTradeCell(detail, "sell") + '</td>' +
        '<td data-label="持仓成本 / 浮动盈亏">' + renderCostCell(row) + '</td>' +
        '</tr>';
    }).join("");
    renderSummary();
  }

  function spanText(ms) {
    const hours = ms / 3600000;
    return hours < 48 ? fmt(Math.round(hours * 10) / 10) + " 小时" : fmt(Math.round(hours / 24 * 10) / 10) + " 天";
  }
  // 期间 HyperCore 现货买卖带来的 HPL 净变动（买入量 − 卖出量，未扣手续费）
  function tradeNet(detail) {
    if (!detail || !detail.trades || detail.trades.error) return null;
    let net = 0;
    for (const label of ["USDC", "USDH"]) {
      net += (detail.trades.groups.buy[label] ? detail.trades.groups.buy[label].qty : 0);
      net -= (detail.trades.groups.sell[label] ? detail.trades.groups.sell[label].qty : 0);
    }
    return net;
  }
  function splitHtml(detail) {
    const net = tradeNet(detail);
    if (net === null || !detail.flowComplete) return '<span class="sub">HPL</span>';
    const transfer = detail.flow - net;
    const part = (label, value) => '<span class="' + (Math.abs(value) < 0.5 ? "muted-cell" : value > 0 ? "positive" : "negative") + '">' + label + " " + signed(Math.round(value)) + "</span>";
    if (Math.abs(net) < 0.5 && Math.abs(transfer) < 0.5) return '<span class="sub">HPL</span>';
    return '<span class="sub split-line">' + part("交易", net) + " · " + part("转账", transfer) + "</span>";
  }
  function isBigFlow(row, flow) {
    const before = Math.max(row.total - flow, 0);
    return Math.abs(flow) >= BIG_FLOW_HPL || (before > 0 && Math.abs(flow) / before >= BIG_FLOW_RATIO && Math.abs(flow) >= BIG_FLOW_HPL / 10);
  }
  function renderAlerts() {
    const box = $("flow-alerts");
    const details = state.periodData && state.periodData.details;
    if (!details || !state.current) { box.hidden = true; return; }
    const items = state.current.rows.map((row, index) => ({ row, index, detail: details.get(row.address) }))
      .filter(item => item.detail && item.detail.flowComplete && isBigFlow(item.row, item.detail.flow))
      .sort((x, y) => Math.abs(y.detail.flow) - Math.abs(x.detail.flow));
    if (!items.length) { box.hidden = true; return; }
    const usdNote = state.price ? flow => " ≈ " + usd(Math.abs(flow) * state.price) : () => "";
    box.innerHTML = '<strong>本期大额变动 · ' + PERIODS[state.period].label + '</strong>' + items.map(item => {
      const name = labelFor(item.row.address);
      const before = Math.max(item.row.total - item.detail.flow, 0);
      const pct = before > 0 ? " · " + (item.detail.flow > 0 ? "+" : "−") + (Math.abs(item.detail.flow) / before * 100).toFixed(1) + "%" : "";
      return '<span class="alert-item">#' + (item.index + 1) + ' ' + short(item.row.address) + (name ? "（" + esc(name) + "）" : "") +
        ' <span class="' + (item.detail.flow > 0 ? "positive" : "negative") + '">' + signed(item.detail.flow) + ' HPL</span>' + usdNote(item.detail.flow) + pct + '</span>';
    }).join("");
    box.hidden = false;
  }
  function renderSummary() {
    renderAlerts();
    const pd = state.periodData;
    const actual = pd && pd.historyAt ? pd.coreAt - pd.historyAt : null;
    const nominal = PERIODS[state.period].ms;
    $("period-caption").textContent = "· " + PERIODS[state.period].label +
      (actual && Math.abs(actual - nominal) > nominal * 0.05 ? "（实际 " + spanText(actual) + "）" : "");
    const details = state.periodData && state.periodData.details;
    if (!details) {
      for (const id of ["net-flow", "inflow", "outflow"]) $(id).textContent = "—";
      $("net-split").textContent = "持仓快照差额 · HPL";
      return;
    }
    const flows = state.current.rows.map(row => details.get(row.address)).filter(item => item && item.flowComplete).map(item => item.flow);
    if (!flows.length) {
      for (const id of ["net-flow", "inflow", "outflow"]) $(id).textContent = "—";
      return;
    }
    const incoming = flows.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
    const outgoing = -flows.filter(value => value < 0).reduce((sum, value) => sum + value, 0);
    const net = incoming - outgoing;
    $("net-flow").textContent = signed(net);
    $("net-flow").className = "card-value " + (net > 0 ? "positive" : net < 0 ? "negative" : "neutral");
    $("inflow").textContent = "+" + fmt(incoming);
    $("outflow").textContent = "−" + fmt(outgoing);
    let tradeSum = 0;
    let transferSum = 0;
    let splitCount = 0;
    for (const row of state.current.rows) {
      const item = details.get(row.address);
      const net = tradeNet(item);
      if (!item || !item.flowComplete || net === null) continue;
      tradeSum += net;
      transferSum += item.flow - net;
      splitCount += 1;
    }
    $("net-split").textContent = splitCount
      ? "交易 " + signed(Math.round(tradeSum)) + " · 转账 " + signed(Math.round(transferSum)) + " HPL" + (splitCount < flows.length ? "（" + splitCount + " 个地址）" : "")
      : "持仓快照差额 · HPL";
    const flowCoverage = flows.length;
    const limited = state.current.rows.filter(row => {
      const item = details.get(row.address);
      return item && item.trades && !item.trades.error && !item.trades.complete;
    }).length;
    $("coverage-note").textContent = flowCoverage < 10
      ? "净流向仅覆盖已读取的 " + flowCoverage + "/10 个地址；其余数据暂不可用"
      : limited
        ? limited + " 个地址的成交记录可能不完整；资金流向已覆盖 10/10 地址"
        : "净流向覆盖 10/10 地址 · 买卖均价仅统计 HyperCore 现货成交";
  }

  async function fetchEvmDelta(wallet, startMs, endMs, signal) {
    let offset = 0;
    let delta = 0;
    for (let page = 0; page < EVM_MAX_PAGES; page += 1) {
      const data = await post(EVM_API + "/indexed/erc20-transfers", {
        address: wallet,
        token_address: HPL_CONTRACT,
        limit: EVM_PAGE_SIZE,
        offset,
        order: "desc"
      }, signal);
      if (!data || !Array.isArray(data.transfers)) throw new Error("转账数据格式无法识别");
      const transfers = data.transfers;
      if (!transfers.length) return { delta, complete: true };
      let oldest = Infinity;
      for (const transfer of transfers) {
        const timestamp = Date.parse(transfer.timestamp);
        if (!Number.isFinite(timestamp)) throw new Error("转账时间格式无法识别");
        oldest = Math.min(oldest, timestamp);
        if (timestamp <= startMs || timestamp > endMs) continue;
        const value = amount(transfer.value, Number(transfer.token_decimals || 18));
        if (address(transfer.to_address) === wallet) delta += value;
        if (address(transfer.from_address) === wallet) delta -= value;
      }
      if (oldest <= startMs || transfers.length < EVM_PAGE_SIZE) return { delta, complete: true };
      offset += transfers.length;
    }
    return { delta, complete: false };
  }

  // userFillsByTime 按时间正序每次最多返回 2,000 笔；以最后一笔时间为游标向后翻页。
  // 官方只保留每个地址最近约 1 万笔成交，接近该数量时标记为可能不完整。
  async function pageFills(wallet, startMs, endMs, aggregate, signal, maxPages = 6) {
    const seen = new Map();
    let cursor = Math.floor(startMs);
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await info({ type: "userFillsByTime", user: wallet, startTime: cursor, endTime: Math.floor(endMs), aggregateByTime: aggregate }, signal);
      if (!Array.isArray(batch)) throw new Error("成交数据格式无法识别");
      let last = cursor;
      for (const fill of batch) {
        const time = Number(fill.time);
        seen.set(String(fill.tid ?? "") + ":" + String(fill.hash ?? "") + ":" + String(time), fill);
        if (Number.isFinite(time)) last = Math.max(last, time);
      }
      if (batch.length < HISTORY_PAGE_SIZE) return { fills: Array.from(seen.values()), complete: seen.size < 9500 };
      if (last <= cursor) break;
      cursor = last;
    }
    return { fills: Array.from(seen.values()), complete: false };
  }
  function fetchFills(wallet, startMs, endMs, signal) {
    return pageFills(wallet, startMs, endMs, false, signal);
  }

  function aggregateFills(data) {
    const groups = { buy: {}, sell: {} };
    for (const fill of data.fills) {
      const label = fill.coin === state.pairs.usdc ? "USDC" : fill.coin === state.pairs.usdh ? "USDH" : null;
      const side = fill.side === "B" ? "buy" : fill.side === "A" ? "sell" : null;
      const qty = Number(fill.sz);
      const price = Number(fill.px);
      if (!label || !side || !Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) continue;
      const group = groups[side][label] || { qty: 0, notional: 0, count: 0 };
      group.qty += qty;
      group.notional += qty * price;
      group.count += 1;
      groups[side][label] = group;
    }
    return { groups, complete: data.complete };
  }

  const COST_TTL_MS = 30 * 60 * 1000;
  const COST_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;
  function fetchFillsAgg(wallet, startMs, endMs, signal) {
    return pageFills(wallet, startMs, endMs, true, signal);
  }
  // 按移动加权平均法，从可查到的 HPL 现货成交推算交易部分的持仓成本与盈亏。
  // 买入手续费以 HPL 扣除，卖出手续费以 USDC/USDH 扣除；USDH 按 1:1 视同 USDC。
  async function computeCost(wallet, signal) {
    const cacheKey = "hpl-cost:" + wallet;
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.at < COST_TTL_MS) return cached;
    } catch (_) { /* 缓存不可用时直接计算 */ }
    const end = Date.now();
    const data = await fetchFillsAgg(wallet, end - COST_LOOKBACK_MS, end, signal);
    const pairs = state.pairs;
    const fills = data.fills
      .filter(fill => fill.coin === pairs.usdc || (pairs.usdh && fill.coin === pairs.usdh))
      .map(fill => ({ time: Number(fill.time), tid: Number(fill.tid) || 0, side: fill.side, px: Number(fill.px), sz: Number(fill.sz), fee: Number(fill.fee) || 0, feeHpl: fill.feeToken === "HPL" }))
      .filter(fill => Number.isFinite(fill.px) && fill.px > 0 && Number.isFinite(fill.sz) && fill.sz > 0)
      .sort((x, y) => x.time - y.time || x.tid - y.tid);
    let pos = 0, cost = 0, realized = 0, unmatched = 0, bought = 0, sold = 0;
    for (const fill of fills) {
      if (fill.side === "B") {
        pos += fill.sz - (fill.feeHpl ? fill.fee : 0);
        cost += fill.sz * fill.px + (fill.feeHpl ? 0 : fill.fee);
        bought += fill.sz;
      } else if (fill.side === "A") {
        const qty = fill.sz + (fill.feeHpl ? fill.fee : 0);
        const proceeds = fill.sz * fill.px - (fill.feeHpl ? 0 : fill.fee);
        const matched = Math.min(qty, Math.max(pos, 0));
        const avg = pos > 0 ? cost / pos : 0;
        realized += proceeds * (matched / qty) - matched * avg;
        cost -= matched * avg;
        pos -= matched;
        unmatched += qty - matched;
        sold += fill.sz;
      }
    }
    const result = {
      at: Date.now(),
      fills: fills.length,
      pos: pos > 1e-6 ? pos : 0,
      avg: pos > 1e-6 ? cost / pos : null,
      realized,
      unmatched,
      bought,
      sold,
      firstTime: fills.length ? fills[0].time : null,
      complete: data.complete
    };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(result)); } catch (_) { /* 忽略 */ }
    return result;
  }
  async function loadCosts() {
    if (!state.current || !state.pairs) return;
    if (state.costController) state.costController.abort();
    const controller = new AbortController();
    state.costController = controller;
    const view = state.current;
    const targets = view.rows.filter(row => !row.contract && !state.costs.has(row.address));
    await mapLimit(targets, 1, async row => {
      if (controller.signal.aborted) return;
      try {
        state.costs.set(row.address, await computeCost(row.address, controller.signal));
      } catch (error) {
        if (isAbort(error)) return;
        state.costs.set(row.address, { error: historyErrorText(error) });
      }
      if (state.current === view && !controller.signal.aborted) renderRows();
    });
  }
  function renderCostCell(row) {
    if (row.contract) return '<span class="muted-cell">—</span><span class="sub">合约 · 不适用</span>';
    const cost = state.costs.get(row.address);
    if (!cost) return '<span class="pending">计算中…</span>';
    if (cost.error) return '<span class="muted-cell">读取失败</span><span class="sub">' + esc(cost.error) + '</span>';
    if (!cost.fills) return '<span class="muted-cell">—</span><span class="sub">无可查成交 · 持仓来自转入</span>';
    const price = state.price;
    const realized = '<span class="' + (cost.realized >= 0 ? "positive" : "negative") + '">' + (cost.realized >= 0 ? "+" : "−") + usd(Math.abs(cost.realized)) + '</span>';
    const caution = cost.complete ? "" : '<span class="sub caution">仅基于可查到的最近成交</span>';
    if (!cost.pos || cost.avg === null) {
      return '<span class="muted-cell">已卖完买入部分</span><span class="sub">已实现 ' + realized + '</span>' + caution;
    }
    const coverage = row.total > 0 ? Math.min(cost.pos / row.total, 1) : 0;
    let pnl = "";
    if (price) {
      const unreal = cost.pos * (price - cost.avg);
      const pct = (price - cost.avg) / cost.avg * 100;
      const cls = unreal >= 0 ? "positive" : "negative";
      pnl = '<span class="pnl ' + cls + '">浮' + (unreal >= 0 ? "盈 +" : "亏 −") + usd(Math.abs(unreal)) + ' (' + (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1) + '%)</span>';
    }
    return '<span class="quote-line">' + priceText(cost.avg) + ' <small>成本</small></span>' + pnl +
      '<span class="sub">覆盖 ' + (coverage * 100).toFixed(coverage < 0.1 ? 1 : 0) + '% 持仓 · 已实现 ' + realized + '</span>' + caution;
  }

  function populateHistoryWallets() {
    const select = $("history-wallet");
    const fragment = document.createDocumentFragment();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择前十地址";
    fragment.appendChild(placeholder);
    for (const [index, row] of state.current.rows.entries()) {
      const option = document.createElement("option");
      option.value = row.address;
      option.textContent = "#" + (index + 1) + " " + short(row.address) + (labelFor(row.address) ? " · " + labelFor(row.address) : row.contract ? " · 合约" : "");
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    if (state.historyWallet && state.current.rows.some(row => row.address === state.historyWallet)) {
      select.value = state.historyWallet;
    } else {
      if (state.historyController) state.historyController.abort();
      state.historyWallet = null;
      state.historyData = null;
      state.historyLoading = false;
      renderHistory();
    }
  }

  function historyErrorText(error) {
    const message = String(error && error.message || "");
    if (message.includes("HTTP 429")) return "请求过于频繁，请稍后重试";
    const status = message.match(/HTTP (\d{3})/);
    return status ? "数据接口暂不可用（HTTP " + status[1] + "）" : "数据接口暂不可用";
  }

  async function fetchHistory(wallet, range, signal, onProgress) {
    const pairs = state.pairs;
    if (!pairs) throw new Error("HPL 交易对暂不可用");
    const endTime = Date.now();
    const startTime = range === "recent" ? null : endTime - HISTORY_RANGES[range];
    const fills = new Map();
    let requests = 0;
    let rangeRequests = 0;
    const merge = batch => {
      if (!Array.isArray(batch)) throw new Error("成交数据格式无法识别");
      for (const fill of batch) {
        const time = Number(fill.time);
        if (!Number.isFinite(time) || time > endTime || (startTime !== null && time < startTime)) continue;
        const key = String(fill.tid ?? "") + ":" + String(fill.hash ?? "") + ":" + String(time);
        fills.set(key, fill);
      }
    };
    const snapshot = (complete, progress = false, partialError = "") => {
      const points = [];
      let firstTime = null;
      let lastTime = null;
      for (const fill of fills.values()) {
        const time = Number(fill.time);
        firstTime = firstTime === null ? time : Math.min(firstTime, time);
        lastTime = lastTime === null ? time : Math.max(lastTime, time);
        const quote = fill.coin === pairs.usdc ? "USDC" : fill.coin === pairs.usdh ? "USDH" : null;
        const side = fill.side === "B" ? "buy" : fill.side === "A" ? "sell" : null;
        const price = Number(fill.px);
        const qty = Number(fill.sz);
        if (!quote || !side || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
        points.push({ quote, side, price, qty, time, priceRaw: String(fill.px), qtyRaw: String(fill.sz) });
      }
      points.sort((a, b) => b.time - a.time);
      return { points, allCount: fills.size, firstTime, lastTime, requests, complete,
        range, startTime, asOf: endTime, progress, partialError };
    };

    let recentError = null;
    try {
      merge(await info({ type: "userFills", user: wallet, aggregateByTime: false }, signal));
      requests += 1;
      onProgress(snapshot(range === "recent", range !== "recent"));
    } catch (error) {
      if (isAbort(error)) throw error;
      recentError = error;
      if (range === "recent") throw error;
    }
    if (range === "recent") return snapshot(true);

    const windows = [{ start: startTime, end: endTime }];
    let partialError = "";
    while (windows.length && rangeRequests < HISTORY_MAX_RANGE_REQUESTS) {
      const window = windows.pop();
      let batch;
      try {
        batch = await info({ type: "userFillsByTime", user: wallet,
          startTime: window.start, endTime: window.end, aggregateByTime: false }, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        partialError = historyErrorText(error);
        break;
      }
      requests += 1;
      rangeRequests += 1;
      merge(batch);
      onProgress(snapshot(false, true));
      if (batch.length >= HISTORY_PAGE_SIZE) {
        if (window.end <= window.start) {
          partialError = "同一时间内成交过多，无法取全";
          continue;
        }
        const midpoint = Math.floor((window.start + window.end) / 2);
        windows.push({ start: window.start, end: midpoint });
        windows.push({ start: midpoint + 1, end: window.end });
      }
    }
    if (recentError && !rangeRequests) throw recentError;
    if (windows.length && !partialError) partialError = "查询量达到上限，可选择更短时间范围继续核对";
    return snapshot(!windows.length && !partialError, false, partialError);
  }

  function renderHistory() {
    renderHistoryBody();
    void renderChart(state.historyWallet ? state.historyData : null);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const CHART_OFFSET_S = 8 * 3600; // 图表时间轴按北京时间显示
  function pickInterval(spanMs) {
    if (spanMs <= 2 * DAY_MS) return { name: "15m", ms: 15 * 60 * 1000 };
    if (spanMs <= 10 * DAY_MS) return { name: "1h", ms: 60 * 60 * 1000 };
    if (spanMs <= 60 * DAY_MS) return { name: "4h", ms: 4 * 60 * 60 * 1000 };
    return { name: "1d", ms: DAY_MS };
  }
  function chartWindow(data) {
    const end = data.asOf || Date.now();
    if (data.range !== "recent" && data.startTime) return { start: data.startTime, end };
    let oldest = end - 7 * DAY_MS;
    for (const point of data.points || []) oldest = Math.min(oldest, point.time);
    const start = Math.max(oldest - (end - oldest) * 0.04, end - 365 * DAY_MS);
    return { start, end };
  }
  function loadCandles(interval, start, end) {
    const startTime = Math.floor(start / interval.ms) * interval.ms;
    const endTime = Math.ceil(end / (5 * 60 * 1000)) * 5 * 60 * 1000;
    const key = state.pairs.usdc + ":" + interval.name + ":" + startTime + ":" + endTime;
    if (!state.candles.has(key)) {
      const request = info({ type: "candleSnapshot", req: { coin: state.pairs.usdc, interval: interval.name, startTime, endTime } })
        .catch(error => { state.candles.delete(key); throw error; });
      state.candles.set(key, request);
    }
    return { key, request: state.candles.get(key) };
  }
  function ensureChart() {
    if (state.chart) return true;
    if (!window.LightweightCharts) return false;
    const chart = window.LightweightCharts.createChart($("history-chart"), {
      autoSize: true,
      layout: { background: { type: "solid", color: "#0f1c22" }, textColor: "#8fa6a9", fontSize: 12 },
      grid: { vertLines: { color: "#16262c" }, horzLines: { color: "#16262c" } },
      rightPriceScale: { borderColor: "#22343a" },
      timeScale: { borderColor: "#22343a", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });
    state.chartSeries = chart.addCandlestickSeries({
      upColor: "#46dfb0", downColor: "#f28e8d", borderUpColor: "#46dfb0", borderDownColor: "#f28e8d",
      wickUpColor: "#46dfb0", wickDownColor: "#f28e8d",
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 }
    });
    state.chart = chart;
    return true;
  }
  async function renderChart(data) {
    const box = $("history-chart-box");
    if (!data || data.error || !state.pairs || !state.pairs.usdc) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (!ensureChart()) {
      $("chart-status").textContent = "图表库加载失败，无法显示价格图。";
      return;
    }
    const token = {};
    state.chartToken = token;
    const { start, end } = chartWindow(data);
    const interval = pickInterval(end - start);
    const { key, request } = loadCandles(interval, start, end);
    if (state.chartKey !== key) $("chart-status").textContent = "正在读取 " + interval.name + " K 线…";
    let candles;
    try {
      candles = await request;
    } catch (error) {
      if (state.chartToken === token) $("chart-status").textContent = "K 线读取失败：" + historyErrorText(error);
      return;
    }
    if (state.chartToken !== token) return;
    const bars = [];
    const seen = new Set();
    for (const candle of Array.isArray(candles) ? candles : []) {
      const bar = { time: Math.floor(Number(candle.t) / 1000) + CHART_OFFSET_S, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) };
      if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) || seen.has(bar.time)) continue;
      seen.add(bar.time);
      bars.push(bar);
    }
    bars.sort((a, b) => a.time - b.time);
    if (state.chartKey !== key) {
      state.chartSeries.setData(bars);
      state.chart.timeScale().fitContent();
      state.chartKey = key;
    }
    // 同一根 K 线内、同方向的成交合并为一个标记
    const points = state.historySide === "all" ? data.points : data.points.filter(point => point.side === state.historySide);
    const groups = new Map();
    let usdh = 0;
    let outside = 0;
    for (const point of points) {
      if (point.quote === "USDH") usdh += 1;
      const time = Math.floor(Math.floor(point.time / interval.ms) * interval.ms / 1000) + CHART_OFFSET_S;
      if (!seen.has(time)) { outside += 1; continue; }
      const groupKey = time + ":" + point.side;
      const group = groups.get(groupKey) || { time, side: point.side, qty: 0, count: 0 };
      group.qty += point.qty;
      group.count += 1;
      groups.set(groupKey, group);
    }
    const withText = groups.size <= 60;
    const markers = Array.from(groups.values()).sort((a, b) => a.time - b.time || (a.side === "buy" ? -1 : 1)).map(group => ({
      time: group.time,
      position: group.side === "buy" ? "belowBar" : "aboveBar",
      color: group.side === "buy" ? "#46dfb0" : "#f28e8d",
      shape: group.side === "buy" ? "arrowUp" : "arrowDown",
      text: withText ? (group.side === "buy" ? "买 " : "卖 ") + compact(group.qty) : ""
    }));
    state.chartSeries.setMarkers(markers);
    const notes = [interval.name + " K 线 · " + fmt(bars.length) + " 根"];
    notes.push(points.length ? fmt(points.length) + " 笔成交合并为 " + fmt(groups.size) + " 个标记（同一根 K 线内同方向合并）" : "该范围内没有可标记的 HPL 成交");
    if (!withText && groups.size) notes.push("标记较多，已隐藏数量文字");
    if (usdh) notes.push(fmt(usdh) + " 笔 HPL/USDH 成交按时间叠加在 USDC 价格图上");
    if (outside) notes.push(fmt(outside) + " 笔成交超出 K 线可查范围未标记");
    $("chart-status").textContent = notes.join(" · ");
  }

  function renderHistoryBody() {
    const summary = $("history-summary");
    const scroller = $("history-scroller");
    const more = $("history-more");
    summary.hidden = true;
    scroller.hidden = true;
    more.hidden = true;
    $("history-reload").disabled = !state.historyWallet || state.historyLoading;
    $("history-export").disabled = !state.historyData || !state.historyData.points || !state.historyData.points.length;
    if (!state.historyWallet) {
      $("history-status").textContent = "选择地址后读取历史成交。";
      return;
    }
    const data = state.historyData;
    if (!data) {
      $("history-status").textContent = state.historyLoading
        ? "正在读取最近成交，请稍候…"
        : "选择地址后读取历史成交。";
      return;
    }
    if (data.error) {
      $("history-status").textContent = "成交记录读取失败：" + data.error + "。请点击「重新读取」重试。";
      return;
    }
    const range = data.firstTime ? " · 已取得全部品种记录 " + fullTimeText(data.firstTime) + " 至 " + fullTimeText(data.lastTime) : "";
    const scope = data.range === "recent"
      ? HISTORY_RANGE_LABELS.recent + "中"
      : HISTORY_RANGE_LABELS[data.range] + "的接口可查记录中";
    const progress = state.historyLoading
      ? " · 正在继续补查，请稍候"
      : data.partialError
        ? " · 部分结果：" + data.partialError
        : data.range === "recent"
          ? " · 更早成交请切换时间范围"
          : " · 所选时间范围的接口可查记录已查完";
    $("history-status").textContent = "已取得该地址" + scope + " " + fmt(data.allCount) + " 笔成交，其中 HPL 买卖 " + fmt(data.points.length) + " 笔" + range + progress + "。";
    if (!data.points.length) {
      if (state.historyLoading) return;
      $("history-status").textContent += isContract(state.historyWallet)
        ? " 已取得的记录没有该合约或资金库地址的 HPL 成交；不能由持仓推算买入成本。"
        : " 已取得的记录没有该地址的 HPL 成交；持仓可能来自转入或其他场所，不能由余额推算买入成本。";
      return;
    }

    const groups = new Map();
    for (const point of data.points) {
      const key = point.side + ":" + point.quote;
      const group = groups.get(key) || { side: point.side, quote: point.quote, count: 0, qty: 0, notional: 0, min: point, max: point, latest: point, latestMin: point, latestMax: point };
      group.count += 1;
      group.qty += point.qty;
      group.notional += point.qty * point.price;
      if (point.price < group.min.price) group.min = point;
      if (point.price > group.max.price) group.max = point;
      if (point.time === group.latest.time) {
        if (point.price < group.latestMin.price) group.latestMin = point;
        if (point.price > group.latestMax.price) group.latestMax = point;
      }
      groups.set(key, group);
    }
    summary.innerHTML = ["buy:USDC", "sell:USDC", "buy:USDH", "sell:USDH"].filter(key => groups.has(key)).map(key => {
      const group = groups.get(key);
      const label = group.side === "buy" ? "买入" : "卖出";
      const cls = group.side === "buy" ? "positive" : "negative";
      const latestPrice = esc(group.latestMin.price === group.latestMax.price
        ? group.latest.priceRaw
        : group.latestMin.priceRaw + " — " + group.latestMax.priceRaw);
      return '<div class="history-stat"><div class="stat-label">' + label + ' · HPL/' + group.quote + ' · 最近点位</div>' +
        '<div class="stat-value ' + cls + '">' + latestPrice + '</div>' +
        '<div class="stat-detail">北京时间 ' + fullTimeText(group.latest.time) + '<br>' +
        fmt(group.count) + ' 笔 · 成交量加权均价 ' + priceText(group.notional / group.qty) +
        '<br>价格范围 ' + esc(group.min.priceRaw) + ' — ' + esc(group.max.priceRaw) + '</div></div>';
    }).join("");
    summary.hidden = false;

    const points = state.historySide === "all" ? data.points : data.points.filter(point => point.side === state.historySide);
    if (!points.length) {
      $("history-status").textContent += " 当前筛选方向没有可查成交。";
      return;
    }
    $("history-rows").innerHTML = points.slice(0, state.historyShown).map(point => {
      const label = point.side === "buy" ? "买入" : "卖出";
      const cls = point.side === "buy" ? "positive" : "negative";
      return '<tr><td class="history-time">' + fullTimeText(point.time) + '</td>' +
        '<td class="history-side ' + cls + '">' + label + '</td>' +
        '<td>' + esc(point.priceRaw) + ' ' + point.quote + '</td>' +
        '<td>' + esc(point.qtyRaw) + '</td>' +
        '<td>' + fmt(point.price * point.qty) + ' ' + point.quote + '</td>' +
        '<td>HPL/' + point.quote + '</td></tr>';
    }).join("");
    scroller.hidden = false;
    if (points.length > state.historyShown) {
      more.textContent = "显示更多 · 还剩 " + fmt(points.length - state.historyShown) + " 笔";
      more.hidden = false;
    }
  }

  async function selectHistoryWallet(wallet, scrollToPanel = false, force = false) {
    if (state.historyController) state.historyController.abort();
    const valid = state.current && state.current.rows.some(row => row.address === wallet);
    state.historyWallet = valid ? wallet : null;
    const range = state.historyRange;
    const cacheKey = wallet + ":" + range;
    state.historyShown = HISTORY_BATCH_SIZE;
    state.historyData = null;
    $("history-wallet").value = state.historyWallet || "";
    $("history-range").value = range;
    if (scrollToPanel) $("history").scrollIntoView({ behavior: "smooth", block: "start" });
    if (!state.historyWallet) {
      state.historyLoading = false;
      renderHistory();
      return;
    }
    if (force) state.historyCache.delete(cacheKey);
    if (state.historyCache.has(cacheKey)) {
      state.historyData = state.historyCache.get(cacheKey);
      state.historyLoading = false;
      renderHistory();
      return;
    }
    const controller = new AbortController();
    state.historyController = controller;
    state.historyLoading = true;
    renderHistory();
    try {
      const data = await fetchHistory(wallet, range, controller.signal, partial => {
        if (controller.signal.aborted || state.historyWallet !== wallet || state.historyRange !== range) return;
        state.historyData = partial;
        renderHistory();
      });
      if (controller.signal.aborted || state.historyWallet !== wallet || state.historyRange !== range) return;
      state.historyCache.set(cacheKey, data);
      state.historyData = data;
    } catch (error) {
      if (isAbort(error) || state.historyWallet !== wallet || state.historyRange !== range) return;
      if (state.historyData && !state.historyData.error) {
        state.historyData = { ...state.historyData, partialError: historyErrorText(error) };
      } else {
        state.historyData = { error: historyErrorText(error) };
      }
    } finally {
      if (state.historyController === controller) {
        state.historyController = null;
        state.historyLoading = false;
        renderHistory();
      }
    }
  }

  function validSnapshot(data) {
    return data && data.holders && Number.isFinite(Number(data.lastUpdate)) && Number(data.lastUpdate) > 0;
  }
  // holdersAtTime 返回目标时间之前最近的一份快照（约每 6 小时一份）。
  // 若偏差较大，再探测目标时间之后的一份，取离目标更近的那份。
  async function fetchNearestSnapshot(targetMs, endMs, signal) {
    const get = ms => fetchJson(CORE_API + "/holdersAtTime/HPL/" + Math.floor(ms / 1000), { signal });
    const before = await get(targetMs);
    if (!validSnapshot(before)) throw new Error("历史快照格式无法识别");
    const beforeMs = Number(before.lastUpdate) * 1000;
    const gap = targetMs - beforeMs;
    if (gap <= SNAPSHOT_TOLERANCE_MS) return before;
    const probe = Math.min(targetMs + gap, endMs - 60 * 1000);
    if (probe <= targetMs) return before;
    try {
      const after = await get(probe);
      const afterMs = validSnapshot(after) ? Number(after.lastUpdate) * 1000 : NaN;
      if (afterMs > beforeMs && afterMs < endMs && Math.abs(afterMs - targetMs) < gap) return after;
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    return before;
  }

  async function loadPeriod() {
    if (!state.current) return null;
    if (state.periodController) state.periodController.abort();
    const controller = new AbortController();
    state.periodController = controller;
    const generation = ++state.generation;
    const period = state.period;
    const cached = state.periodCache[period];
    if (cached && cached.coreAt === state.current.coreAt) {
      state.periodData = cached;
      renderRows();
      setStatus("已同步 · " + timeText(Date.now()) + (state.current.verified ? "" : " · 榜单范围需进一步核对"));
      return cached;
    }
    state.periodData = null;
    renderRows();
    setStatus("计算" + PERIODS[period].label + "流向…");
    const targetMs = state.current.coreAt - PERIODS[period].ms;
    let history;
    try {
      history = await fetchNearestSnapshot(targetMs, state.current.coreAt, controller.signal);
    } catch (error) {
      if (isAbort(error) || generation !== state.generation) return null;
      setStatus("历史快照暂不可用");
      $("coverage-note").textContent = "历史持仓快照读取失败，请刷新重试";
      return null;
    }
    if (generation !== state.generation) return null;
    const startMs = Number(history.lastUpdate) * 1000;
    const endMs = state.current.coreAt;
    const past = history.holders;
    const details = new Map();
    for (const row of state.current.rows) {
      const historicalCore = Number(past[row.address] || 0);
      details.set(row.address, {
        coreDelta: row.core - historicalCore,
        evmDelta: null,
        flow: null,
        flowComplete: false,
        flowError: false,
        trades: null
      });
    }
    state.periodData = { coreAt: state.current.coreAt, historyAt: startMs, details };
    $("snapshot-label").textContent = "比较北京时间 " + timeText(startMs) + " → " + timeText(state.current.coreAt) + " 的 Core 快照 · 实际跨度 " + spanText(state.current.coreAt - startMs) + staleNote();
    renderRows();
    await mapLimit(state.current.rows, 3, async row => {
      if (controller.signal.aborted || generation !== state.generation) return;
      const detail = details.get(row.address);
      const tasks = [
        fetchEvmDelta(row.address, startMs, endMs, controller.signal)
          .then(result => {
            if (result.complete) {
              detail.evmDelta = result.delta;
              detail.flow = detail.coreDelta + detail.evmDelta;
              detail.flowComplete = true;
            } else {
              detail.flowError = true;
            }
          })
          .catch(error => { if (!isAbort(error)) detail.flowError = true; }),
        state.pairs
          ? fetchFills(row.address, startMs, endMs, controller.signal)
            .then(result => { detail.trades = aggregateFills(result); })
            .catch(error => { if (!isAbort(error)) detail.trades = { error: true }; })
          : Promise.resolve().then(() => { detail.trades = { error: true }; })
      ];
      await Promise.all(tasks);
      if (!controller.signal.aborted && generation === state.generation) renderRows();
    });
    if (controller.signal.aborted || generation !== state.generation) return null;
    const allFlows = state.current.rows.every(row => details.get(row.address).flowComplete);
    const allTrades = state.current.rows.every(row => details.get(row.address).trades && !details.get(row.address).trades.error);
    if (allFlows && allTrades) state.periodCache[period] = state.periodData;
    setStatus((allFlows ? "已同步 · " + timeText(Date.now()) : "部分流向暂不可用") + (state.current.verified ? "" : " · 榜单范围需进一步核对"));
    renderRows();
    return state.periodData;
  }

  async function refresh() {
    if (state.currentController) state.currentController.abort();
    if (state.periodController) state.periodController.abort();
    state.generation += 1;
    state.lastAttemptAt = Date.now();
    state.refreshing = true;
    const controller = new AbortController();
    state.currentController = controller;
    $("refresh").disabled = true;
    $("exclude-contracts").disabled = true;
    setStatus("同步两端持仓…");
    if (!state.current) $("rows").innerHTML = '<tr><td colspan="6" class="loading">正在读取 HyperCore 与 HyperEVM 持仓…</td></tr>';
    try {
      const [coreData, evmData, metaResult, midsResult] = await Promise.all([
        fetchJson(CORE_API + "/holdersWithLimit/HPL/100", { signal: controller.signal }),
        post(EVM_API + "/indexed/token-holders", { token_address: HPL_CONTRACT, limit: 100, offset: 0 }, controller.signal),
        info({ type: "spotMeta" }, controller.signal).catch(() => null),
        info({ type: "allMids" }, controller.signal).catch(() => null)
      ]);
      if (controller.signal.aborted) return;
      state.pairs = metaResult ? derivePairs(metaResult) : null;
      void refreshBook(true);
      void refreshMarket();
      state.price = state.pairs && midsResult ? Number(midsResult[state.pairs.usdc]) || null : null;
      state.base = buildBase(coreData, evmData);
      state.costs.clear();
      state.historyCache.clear();
      await applyView(controller, true);
      if (!controller.signal.aborted) state.lastRefreshAt = Date.now();
    } catch (error) {
      if (isAbort(error)) return;
      setStatus(state.current ? "刷新失败，显示上次数据" : "数据读取失败");
      if (!state.current) {
        $("rows").innerHTML = '<tr><td colspan="6" class="loading">暂时无法读取两端持仓，请稍后刷新。</td></tr>';
        $("history-status").textContent = "榜单读取失败，刷新后再查看历史成交。";
      }
    } finally {
      if (state.currentController === controller) {
        $("refresh").disabled = false;
        $("exclude-contracts").disabled = false;
        state.refreshing = false;
      }
    }
  }

  async function applyView(controller, forceHistory) {
    setStatus("识别合约地址…");
    const view = await buildView(state.base, controller.signal);
    if (controller.signal.aborted) return;
    state.current = view;
    state.periodCache = {};
    state.periodData = null;
    $("contract-scope").textContent = state.excludeContracts ? "已排除合约与项目地址" : "榜单包含合约";
    renderCurrent();
    renderRows();
    setStatus("核对跨层余额…");
    await refineCandidates(state.current, controller.signal);
    if (controller.signal.aborted) return;
    renderCurrent();
    renderRows();
    populateHistoryWallets();
    const historyWallet = state.historyWallet ||
      (state.current.rows.find(row => !row.contract) || state.current.rows[0] || {}).address;
    if (historyWallet) void selectHistoryWallet(historyWallet, false, forceHistory);
    await loadPeriod();
    if (!controller.signal.aborted) void loadCosts();
  }

  async function toggleContracts(checked) {
    state.excludeContracts = checked;
    try { localStorage.setItem(PREF_KEY, checked ? "1" : "0"); } catch (_) { /* 存储不可用时忽略 */ }
    if (!state.base || state.refreshing) return;
    if (state.periodController) state.periodController.abort();
    state.generation += 1;
    const controller = new AbortController();
    state.currentController = controller;
    state.refreshing = true;
    $("refresh").disabled = true;
    $("exclude-contracts").disabled = true;
    try {
      await applyView(controller, false);
      if (!controller.signal.aborted) state.lastRefreshAt = Date.now();
    } catch (error) {
      if (!isAbort(error)) setStatus("切换失败：" + (error.message || "数据暂不可用"));
    } finally {
      if (state.currentController === controller) {
        state.refreshing = false;
        $("refresh").disabled = false;
        $("exclude-contracts").disabled = false;
      }
    }
  }

  function refreshIfStale() {
    if (document.hidden || state.refreshing) return;
    const now = Date.now();
    if (state.lastRefreshAt && now - state.lastRefreshAt < DAILY_REFRESH_MS) return;
    if (now - state.lastAttemptAt < RETRY_REFRESH_MS) return;
    void refresh();
  }

  async function selectPeriod(period) {
    if (!Object.prototype.hasOwnProperty.call(PERIODS, period)) throw new Error("请选择 day、week 或 month");
    state.period = period;
    document.querySelectorAll(".period").forEach(button => {
      const active = button.dataset.period === period;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("period-caption").textContent = "· " + PERIODS[period].label;
    return loadPeriod();
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context || typeof context.registerTool !== "function") return;
    try {
      Promise.resolve(context.registerTool({
        name: "select_hpl_period",
        title: "切换 HPL 统计周期",
        description: "把 HPL 地址仓位追踪器切换到日、周或月，更新页面上的净流向与成交均价。",
        inputSchema: {
          type: "object",
          properties: { period: { type: "string", enum: ["day", "week", "month"] } },
          required: ["period"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          if (!input || !Object.prototype.hasOwnProperty.call(PERIODS, input.period)) throw new Error("无效统计周期");
          await selectPeriod(input.period);
          return {
            period: input.period,
            netFlowHpl: $("net-flow").textContent,
            inflowHpl: $("inflow").textContent,
            outflowHpl: $("outflow").textContent
          };
        }
      })).catch(() => {});
    } catch (_) { /* WebMCP is optional in unsupported browsers. */ }
  }

  document.querySelectorAll(".period").forEach(button => {
    button.addEventListener("click", () => { void selectPeriod(button.dataset.period); });
  });
  $("rows").addEventListener("click", event => {
    const button = event.target.closest("[data-history-wallet]");
    if (button) void selectHistoryWallet(button.dataset.historyWallet, true);
  });
  $("history-wallet").addEventListener("change", event => { void selectHistoryWallet(event.target.value); });
  if (Object.prototype.hasOwnProperty.call(HISTORY_RANGE_LABELS, $("history-range").value)) {
    state.historyRange = $("history-range").value;
  }
  $("history-range").addEventListener("change", event => {
    state.historyRange = event.target.value;
    if (state.historyWallet) void selectHistoryWallet(state.historyWallet);
  });
  $("history-side").addEventListener("change", event => {
    state.historySide = event.target.value;
    state.historyShown = HISTORY_BATCH_SIZE;
    renderHistory();
  });
  $("history-more").addEventListener("click", () => {
    state.historyShown += HISTORY_BATCH_SIZE;
    renderHistory();
  });
  $("history-export").addEventListener("click", () => {
    const data = state.historyData;
    if (!data || !data.points || !data.points.length) return;
    const points = state.historySide === "all" ? data.points : data.points.filter(point => point.side === state.historySide);
    const lines = [["成交时间(北京)", "方向", "交易对", "成交价", "数量HPL", "成交额"].join(",")];
    for (const point of points) {
      lines.push([fullTimeText(point.time), point.side === "buy" ? "买入" : "卖出", "HPL/" + point.quote, point.priceRaw, point.qtyRaw, (point.price * point.qty).toFixed(6)]
        .map(value => '"' + String(value).replace(/"/g, '""') + '"').join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "hpl-trades-" + state.historyWallet.slice(0, 8) + "-" + data.range + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  $("history-reload").addEventListener("click", () => {
    if (state.historyWallet) void selectHistoryWallet(state.historyWallet, false, true);
  });
  $("refresh").addEventListener("click", () => { void refresh(); });
  try { state.excludeContracts = localStorage.getItem(PREF_KEY) === "1"; } catch (_) { /* 存储不可用时使用默认值 */ }
  $("exclude-contracts").checked = state.excludeContracts;
  $("exclude-contracts").addEventListener("change", event => { void toggleContracts(event.target.checked); });
  $("book-reload").addEventListener("click", () => { void refreshBook(true); });
  document.addEventListener("visibilitychange", () => { refreshIfStale(); void refreshBook(); });
  window.addEventListener("focus", () => { refreshIfStale(); void refreshBook(); });
  setInterval(refreshIfStale, 10 * 60 * 1000);
  setInterval(() => { if (!document.hidden) void refreshMarket(); }, MARKET_REFRESH_MS);
  setInterval(() => { void refreshBook(); }, BOOK_REFRESH_MS);
  registerWebMcp();
  fetchJson(CORE_API + "/globalAliases").then(data => {
    if (!data || typeof data !== "object") return;
    state.aliases = new Map(Object.entries(data).filter(([wallet, name]) => validAddress(wallet) && typeof name === "string").map(([wallet, name]) => [address(wallet), name.slice(0, 40)]));
    if (state.current) { renderRows(); populateHistoryWallets(); }
  }).catch(() => { /* 别名为可选信息 */ });
  void refresh();
})();
