(() => {
  "use strict";

  const HPL_CONTRACT = "0xbd6dab50f03a305a80037294fa8d1a9dc0cac91b";
  const SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000078";
  const CORE_API = "https://api.hypurrscan.io";
  const EVM_API = "https://trace.hypurrscan.io/api/v1";
  const HL_API = "https://api.hyperliquid.xyz/info";
  const FULL_REFRESH_MS = 5 * 60 * 1000;      // 榜单、期间流向、买卖均价：每 5 分钟后台静默刷新
  const BALANCE_REFRESH_MS = 60 * 1000;       // 前十与项目合约的实时余额：每 60 秒
  const BOOK_POLL_MS = 5 * 1000;              // 实时推送断开时，盘口改为每 5 秒轮询
  const TRADES_POLL_MS = 15 * 1000;           // 实时推送断开时，最新成交每 15 秒轮询
  const AGG_BOOK_REFRESH_MS = 10 * 1000;      // 5% / 10% 合并档位盘口：每 10 秒
  const MARKET_REFRESH_MS = 10 * 60 * 1000;   // 7 / 30 天成交额与柱状图：每 10 分钟（24 小时数据走实时推送）
  const LIVE_RENDER_MS = 250;                 // 实时数据最快每 0.25 秒重绘一次
  const ROWS_PRICE_RENDER_MS = 30 * 1000;     // 价格变化引起的榜单重绘（浮动盈亏等）最多每 30 秒一次
  const WS_URL = "wss://api.hyperliquid.xyz/ws";
  const ARCHIVE_RPC = "https://rpc.hyperlend.finance"; // HyperLend 公共节点，支持按历史区块读取余额
  // 读取当前链上数据的公共节点：一个限流就换下一个
  const LIVE_RPCS = ["https://rpc.hyperliquid.xyz/evm", "https://rpc.hypurrscan.io", "https://rpc.hyperlend.finance"];
  const POOL_SIZE = 14;                       // 前十之外多核对 4 个候选，用实时余额重新排名
  const BIG_FLOW_HPL = 1000000;
  const BIG_FLOW_RATIO = 0.1;
  const TAPE_MAX = 60;
  const RETRY_REFRESH_MS = 2 * 60 * 1000;
  const HISTORY_PAGE_SIZE = 2000;
  const EVM_PAGE_SIZE = 1000;
  const EVM_MAX_PAGES = 20;
  const EVM_RPC = "https://rpc.hyperliquid.xyz/evm";
  const SNAPSHOT_TOLERANCE_MS = 30 * 60 * 1000;
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
  // 已核实身份的普通账户（EOA）：只加标签，仍按个人地址参与排名，不归入合约区
  const ACCOUNT_LABELS = {
    "0xf2f1d8dfcbfbbcc30fd5671a2dbd37a12e9a8d86": {
      name: "项目金库出资做市",
      short: "项目金库拨入 1,000 万 HPL + 5 万 USDC，程序化双边挂单做市",
      note: "HyperLend 项目金库多签（0xCBF4…3d7b）于 2026-07-23/24 拨入 1,000 万 HPL 与 5 万 USDC；程序化双边挂单做市，约占 Hyperliquid 上 HPL/USDC 七成以上成交"
    }
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
    excludeContracts: true, // 前十只列个人地址；项目合约另列在下方
    candles: new Map(),
    chart: null,
    chartSeries: null,
    chartKey: "",
    silent: false,
    bookRaw: null,
    aggBook: null,
    aggFetchedAt: 0,
    aggLoading: false,
    tradesFetchedAt: 0,
    balancesLoading: false,
    statusError: null,
    statusLoading: null,
    archiveRetrying: false,
    historyQuiet: null,
    historyUserCleared: false,
    rowsRetryTimer: null,
    rowsPointerDown: false,
    marketError: null,
    live: {
      ws: null, connected: false, retry: 0, pingTimer: null, reconnectTimer: null, renderTimer: null,
      lastMsg: 0, lastRender: 0, lastRowsRender: 0, startedAt: 0, lastBadge: null,
      bookDirty: false, tradesDirty: false, ctxDirty: false, priceChanged: false
    }
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
    return LABELS[wallet] || (ACCOUNT_LABELS[wallet] && ACCOUNT_LABELS[wallet].name) || (state.aliases && state.aliases.get(wallet)) || "";
  }
  function usd(value) {
    if (!Number.isFinite(value)) return "—";
    if (value >= 1e8) return "$" + fmt(value / 1e8) + " 亿";
    if (value >= 1e4) return "$" + fmt(value / 1e4) + " 万";
    return "$" + fmt(value);
  }
  // 状态栏优先级：错误 > 进行中 > 已同步。后台静默刷新时不显示“进行中”
  function renderSyncStatus() {
    const text = state.statusError || state.statusLoading || syncedText();
    const el = $("sync-status");
    if (el.textContent !== text) el.textContent = text;
  }
  function setLoading(text) {
    if (state.silent) return;
    state.statusLoading = text;
    renderSyncStatus();
  }
  function setError(text) {
    state.statusError = text;
    state.statusLoading = null;
    renderSyncStatus();
  }
  function clearStatus() {
    state.statusError = null;
    state.statusLoading = null;
    renderSyncStatus();
  }
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  }
  function syncedText() {
    const view = state.current;
    if (!view) return "准备读取数据";
    const pd = state.periodData;
    let text = view.balancesAt ? "已同步 · " + clockText(view.balancesAt) : "实时余额读取失败，正在重试";
    if (view.balancesAt && view.balancesOk === false) text += " · 最近一次余额刷新失败，显示 " + clockText(view.balancesAt) + " 的数据";
    if (pd && view.rows.some(row => { const detail = pd.details.get(row.address); return !detail || !detail.flowComplete; })) text += " · 部分流向暂不可用";
    if (pd && pd.fallback) text += " · 部分流向为估算，正在重试";
    if (!view.verified) text += " · 榜单范围需进一步核对";
    return text;
  }
  // 只在内容真的变化时写入，避免每秒重写打断选中文字
  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  function isAbort(error) {
    return error && error.name === "AbortError";
  }
  // 每次请求都带超时：调用方取消时立即停止；超时按普通失败处理（可重试、可换节点）
  function timeoutSignal(signal, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), ms);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    };
  }
  async function fetchJson(url, options = {}, retries = 3, timeoutMs = 20000) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const timed = timeoutSignal(options.signal, timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: timed.signal });
        if (!response.ok) throw new Error("HTTP " + response.status);
        return await response.json();
      } catch (error) {
        // 调用方已取消或整轮已超时：不再重试
        if (isAbort(error) || attempt === retries || (options.signal && options.signal.aborted)) throw error;
        const limited = /HTTP 429/.test(String(error && error.message));
        await new Promise(resolve => setTimeout(resolve, (limited ? 2500 : 450) * (attempt + 1)));
      } finally {
        timed.done();
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
    $("book-status").textContent = liveOk()
      ? "实时推送 · 北京时间 " + fullTimeText(book.at) + " · 有变化即更新"
      : "盘口快照 · 北京时间 " + fullTimeText(book.at) + " · 每 5 秒更新（实时推送连接中）";
    const hasIncompleteRange = book.ranges.slice(0, 2).some(range => !range.bid.complete || !range.ask.complete);
    $("book-note").textContent = hasIncompleteRange
      ? "1%/2% 深度仅含官方接口可见的前 20 档；“至少”表示该区间超出可见档位。5%/10% 为合并档位后的约值。挂单可撤销，不等于已成交量。"
      : "官方接口每侧最多显示 20 档；1% 和 2% 区间均在可见范围内，5%/10% 为合并档位后的约值。挂单可撤销，不等于已成交量。";
    // 盘口提示：用“多少钱就能把价格推动 1%”的说法；只在数据完整、方向不矛盾时给结论
    const warns = [];
    const one = book.ranges[0];
    const two = book.ranges[1];
    const thinBid = one.bid.complete && one.bid.usdc < 500;
    const thinAsk = one.ask.complete && one.ask.usdc < 500;
    if (thinBid) {
      warns.push(one.bid.usdc < 1
        ? "现价下方 1% 内没有买单，任何市价卖出都会让价格跌 1% 以上"
        : "现价下方 1% 内的买单只有约 " + fmt(one.bid.usdc) + " USDC，市价卖出超过这个金额，价格就会跌 1% 以上");
    }
    if (thinAsk) {
      warns.push(one.ask.usdc < 1
        ? "现价上方 1% 内没有卖单，任何市价买入都会让价格涨 1% 以上"
        : "现价上方 1% 内的卖单只有约 " + fmt(one.ask.usdc) + " USDC，市价买入超过这个金额，价格就会涨 1% 以上");
    }
    // 买卖力量对比：2% 区间两侧都完整且都有挂单时才算，并且结论不能和上面的方向相反
    if (two.bid.complete && two.ask.complete && two.bid.usdc > 0 && two.ask.usdc > 0 && !(thinBid && thinAsk)) {
      const ratio = two.bid.usdc / two.ask.usdc;
      const dir = ratio >= 5 ? "up" : ratio <= 0.2 ? "down" : null;
      const thinDir = thinBid ? "down" : thinAsk ? "up" : null;
      if (dir && (!thinDir || thinDir === dir)) {
        warns.push(dir === "up"
          ? "2% 内买单约是卖单的 " + fmt(Math.round(ratio)) + " 倍，价格更容易被买上去"
          : "2% 内卖单约是买单的 " + fmt(Math.round(1 / ratio)) + " 倍，价格更容易被卖下来");
      }
    }
    const spread = (book.ask.px - book.bid.px) / book.mid;
    if (spread > 0.01) warns.push("买一和卖一相差 " + (spread * 100).toFixed(2) + "%，直接市价成交损耗较大");
    $("book-warn").hidden = !warns.length;
    setText("book-warn", warns.length ? (thinBid || thinAsk ? "⚠ 盘口偏薄：" : "盘口提示：") + warns.join("；") + "。" : "");
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

  // ---------- 盘口与成交：REST 读取（首屏、手动刷新、实时推送断开时使用） ----------
  async function refreshBook(force = false) {
    if (document.hidden && !force) return;
    if (state.bookLoading) return;
    if (!state.pairs?.usdc) {
      $("book-status").textContent = "等待 HPL / USDC 交易对信息";
      return;
    }
    state.bookLoading = true;
    $("book-reload").disabled = true;
    if (!state.book) $("book-status").textContent = "正在读取盘口…";
    const now = Date.now();
    const wantAgg = force || now - state.aggFetchedAt >= AGG_BOOK_REFRESH_MS;
    const wantTrades = force || now - state.tradesFetchedAt >= TRADES_POLL_MS;
    try {
      const [raw, rawAgg, trades] = await Promise.all([
        info({ type: "l2Book", coin: state.pairs.usdc }),
        wantAgg ? info({ type: "l2Book", coin: state.pairs.usdc, nSigFigs: 3 }).catch(() => null) : Promise.resolve(null),
        wantTrades ? info({ type: "recentTrades", coin: state.pairs.usdc }).catch(() => null) : Promise.resolve(null)
      ]);
      if (rawAgg) {
        state.aggBook = rawAgg;
        state.aggFetchedAt = Date.now();
      }
      if (trades) {
        mergeTrades(trades);
        state.tradesFetchedAt = Date.now();
        renderTrades();
      }
      // 实时推送正常时，推送来的盘口更快，不用 REST 结果覆盖
      if (!liveOk() || !state.bookRaw) state.bookRaw = raw;
      state.book = parseBook(state.bookRaw, state.aggBook);
      renderBook();
    } catch (_) {
      $("book-status").textContent = state.book
        ? "盘口刷新失败 · 上次快照：北京时间 " + fullTimeText(state.book.at)
        : "盘口暂不可用，请稍后重试";
    } finally {
      state.bookLoading = false;
      $("book-reload").disabled = false;
    }
  }
  async function refreshAggBook() {
    if (!state.pairs?.usdc || state.aggLoading) return;
    state.aggLoading = true;
    try {
      state.aggBook = await info({ type: "l2Book", coin: state.pairs.usdc, nSigFigs: 3 });
      state.aggFetchedAt = Date.now();
      if (state.bookRaw) {
        state.live.bookDirty = true;
        queueLiveRender();
      }
    } catch (_) { /* 下次再试 */ } finally {
      state.aggLoading = false;
    }
  }

  // ---------- 实时推送（Hyperliquid WebSocket）：盘口、成交、价格与 24 小时数据 ----------
  function liveOk() {
    return state.live.connected && Date.now() - state.live.lastMsg < 20000;
  }
  // 左上角状态看的是“最近是否真的收到推送”；模式变化时同步刷新盘口与市场状态文字
  function updateLiveBadge() {
    const live = state.live;
    const ok = liveOk();
    $("live-dot").classList.toggle("off", !ok);
    setText("live-state", ok
      ? "实时 · 盘口 / 成交 / 价格秒级推送"
      : live.ws ? "实时推送连接中 · 暂用轮询"
      : live.reconnectTimer ? "实时推送重连中 · 暂用轮询"
      : "连接实时行情…");
    if (live.lastBadge !== ok) {
      live.lastBadge = ok;
      if (state.book) renderBook();
      renderMarketStats();
    }
  }
  // 正常情况下推送约每秒一条；超过 30 秒没有任何消息就视为断线，丢弃旧连接并重连
  function liveWatchdog() {
    const live = state.live;
    if (live.ws) {
      const since = live.connected ? live.lastMsg : live.startedAt;
      if (Date.now() - since > 30000) {
        const dead = live.ws;
        live.ws = null;
        live.connected = false;
        clearInterval(live.pingTimer);
        try { dead.close(); } catch (_) { /* 已关闭 */ }
        scheduleLiveReconnect();
      }
    }
    updateLiveBadge();
  }
  function connectLive() {
    const live = state.live;
    if (live.ws || live.reconnectTimer || !state.pairs || !state.pairs.usdc || typeof WebSocket !== "function") return;
    const coin = state.pairs.usdc;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (_) {
      scheduleLiveReconnect();
      return;
    }
    live.ws = ws;
    live.startedAt = Date.now();
    ws.onopen = () => {
      if (live.ws !== ws) return;
      live.connected = true;
      live.lastMsg = Date.now();
      for (const subscription of [{ type: "l2Book", coin }, { type: "trades", coin }, { type: "activeAssetCtx", coin }]) {
        ws.send(JSON.stringify({ method: "subscribe", subscription }));
      }
      clearInterval(live.pingTimer);
      live.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" }));
      }, 30000);
      updateLiveBadge();
    };
    ws.onmessage = event => {
      if (live.ws !== ws) return;
      live.lastMsg = Date.now();
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (!message) return;
      const data = message.data;
      // 真正收到行情数据后才把重连退避清零（防止“连上就断”时每秒重连）
      if (live.retry && message.channel !== "subscriptionResponse" && message.channel !== "pong") live.retry = 0;
      if (message.channel === "l2Book" && data && data.coin === coin) {
        state.bookRaw = data;
        live.bookDirty = true;
        queueLiveRender();
      } else if (message.channel === "trades" && Array.isArray(data)) {
        mergeTrades(data.filter(trade => trade.coin === coin));
        live.tradesDirty = true;
        queueLiveRender();
      } else if ((message.channel === "activeSpotAssetCtx" || message.channel === "activeAssetCtx") && data && data.coin === coin && data.ctx) {
        applyLiveCtx(data.ctx);
        queueLiveRender();
      }
    };
    ws.onclose = () => {
      if (live.ws !== ws) return;
      live.ws = null;
      live.connected = false;
      clearInterval(live.pingTimer);
      updateLiveBadge();
      scheduleLiveReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) { /* 已关闭 */ }
    };
  }
  function scheduleLiveReconnect() {
    const live = state.live;
    if (live.reconnectTimer) return;
    const base = Math.min(30000, 1000 * 2 ** Math.min(live.retry, 5));
    const delay = Math.round(base * (0.5 + Math.random())); // 随机抖动，避免大家同时重连
    live.retry += 1;
    live.reconnectTimer = setTimeout(() => {
      live.reconnectTimer = null;
      connectLive();
    }, delay);
  }
  function applyLiveCtx(ctx) {
    if (!state.market) state.market = { ctx: null, ctxH: null, bars: null, sums: null, at: 0 };
    state.market.ctx = ctx;
    state.market.ctxAt = Date.now();
    const mid = Number(ctx.midPx) || Number(ctx.markPx);
    if (Number.isFinite(mid) && mid > 0 && mid !== state.price) {
      state.price = mid;
      state.live.priceChanged = true;
    }
    state.live.ctxDirty = true;
  }
  function queueLiveRender() {
    const live = state.live;
    if (live.renderTimer) return;
    const wait = Math.max(0, LIVE_RENDER_MS - (Date.now() - live.lastRender));
    live.renderTimer = setTimeout(flushLiveRender, wait);
  }
  function flushLiveRender() {
    const live = state.live;
    if (live.renderTimer) {
      clearTimeout(live.renderTimer);
      live.renderTimer = null;
    }
    if (document.hidden) return; // 页面在后台时只收数据，回到前台再一次性重绘
    live.lastRender = Date.now();
    if (live.bookDirty && state.bookRaw) {
      live.bookDirty = false;
      try {
        state.book = parseBook(state.bookRaw, state.aggBook);
        renderBook();
      } catch (_) { /* 盘口暂时不完整，等下一次推送 */ }
    }
    if (live.tradesDirty) {
      live.tradesDirty = false;
      renderTrades();
    }
    if (live.ctxDirty) {
      live.ctxDirty = false;
      renderMarketStats();
      renderPrice();
    }
    if (live.priceChanged && state.current && Date.now() - live.lastRowsRender >= ROWS_PRICE_RENDER_MS) {
      live.priceChanged = false;
      live.lastRowsRender = Date.now();
      renderRowsSoon();
    }
  }
  function renderPrice() {
    const el = $("market-price");
    const html = state.price ? priceText(state.price) + "<small>USDC</small>" : "—";
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  // ---------- 成交额与市场概况 ----------
  const candleNotional = c => c.v * (c.o + c.h + c.l + c.c) / 4;
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
      const bars = (Array.isArray(candles) ? candles : [])
        .map(c => ({ t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }))
        .filter(c => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite));
      const sumSince = ms => bars.filter(c => c.t >= end - ms).reduce((acc, c) => ({ usd: acc.usd + candleNotional(c), hpl: acc.hpl + c.v }), { usd: 0, hpl: 0 });
      const prev = state.market;
      // 实时推送来的 24 小时数据比这里的快照新，保留推送值
      const liveCtx = prev && prev.ctx && prev.ctxAt && Date.now() - prev.ctxAt < 60000 ? prev.ctx : null;
      state.market = {
        ctx: liveCtx || ctx,
        ctxAt: liveCtx ? prev.ctxAt : end,
        ctxH,
        bars,
        sums: { d1: sumSince(DAY_MS), d7: sumSince(7 * DAY_MS), d30: sumSince(30 * DAY_MS) },
        at: end
      };
      state.marketError = null;
      renderMarket();
    } catch (error) {
      state.marketError = (state.market && state.market.sums ? "7/30 天数据刷新失败，显示上次数据" : "7/30 天数据读取失败") + "（" + historyErrorText(error) + "）";
      if (state.market) renderMarketStats();
      else setText("market-status", "成交数据暂不可用：" + historyErrorText(error));
    }
  }
  function renderMarket() {
    renderMarketStats();
    if (state.market && state.market.bars) renderVolumeChart(state.market.bars, candleNotional);
  }
  function renderMarketStats() {
    const m = state.market;
    if (!m) return;
    const ctx = m.ctx;
    const sums = m.sums;
    const dayNtl = ctx ? Number(ctx.dayNtlVlm) : sums ? sums.d1.usd : NaN;
    const dayBase = ctx ? Number(ctx.dayBaseVlm) : sums ? sums.d1.hpl : NaN;
    setText("vol-24h", usd(dayNtl));
    let sub24 = Number.isFinite(dayBase) ? fmt(dayBase) + " HPL" : "—";
    if (m.ctxH && Number(m.ctxH.dayNtlVlm) > 0) sub24 += " · USDH 对另有 " + usd(Number(m.ctxH.dayNtlVlm));
    setText("vol-24h-sub", sub24);
    const mid = ctx ? Number(ctx.midPx) || Number(ctx.markPx) : NaN;
    const prev = ctx ? Number(ctx.prevDayPx) : NaN;
    if (Number.isFinite(mid) && Number.isFinite(prev) && prev > 0) {
      const chg = (mid - prev) / prev * 100;
      setText("chg-24h", (chg > 0 ? "+" : chg < 0 ? "−" : "") + Math.abs(chg).toFixed(2) + "%");
      const cls = chg > 0 ? "positive" : chg < 0 ? "negative" : "";
      if ($("chg-24h").className !== cls) $("chg-24h").className = cls;
      setText("chg-24h-sub", priceText(prev) + " → " + priceText(mid));
    }
    if (sums) {
      setText("vol-7d", "≈ " + usd(sums.d7.usd));
      setText("vol-7d-sub", compact(sums.d7.hpl) + " HPL · 日均 " + usd(sums.d7.usd / 7));
      setText("vol-30d", "≈ " + usd(sums.d30.usd));
      setText("vol-30d-sub", compact(sums.d30.hpl) + " HPL · 日均 " + usd(sums.d30.usd / 30));
    }
    const circ = ctx ? Number(ctx.circulatingSupply) : NaN;
    if (Number.isFinite(circ) && Number.isFinite(mid)) {
      setText("mcap", usd(circ * mid));
      const turnover = circ > 0 && Number.isFinite(dayBase) ? dayBase / circ * 100 : 0;
      setText("mcap-sub", "流通 " + compact(circ) + " HPL · 24h 换手 " + turnover.toFixed(2) + "%");
    }
    setText("market-status", (liveOk()
      ? "24 小时数据实时推送 · 更新于 " + clockText(m.ctxAt || Date.now())
      : "24 小时为官方统计 · 更新于 " + clockText(m.ctxAt || m.at || Date.now())) +
      " · 7/30 天由 K 线估算，每 10 分钟更新" + (state.marketError ? " · " + state.marketError : ""));
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

  // 用 HyperEVM 的 eth_getCode 判断地址是否为合约（一次批量请求，节点限流时自动换节点）；
  // 结果缓存，所有节点都失败时视为未知（按个人地址处理）。
  async function ensureCodes(wallets, signal) {
    const missing = wallets.filter(wallet => !state.codes.has(wallet));
    if (!missing.length) return;
    const body = missing.map((wallet, k) => ({ jsonrpc: "2.0", id: k, method: "eth_getCode", params: [wallet, "latest"] }));
    try {
      const res = await rpcAny(LIVE_RPCS, body, signal, r => Array.isArray(r) && r.every(item => item && typeof item.result === "string"));
      for (const item of res) {
        const wallet = missing[item.id];
        if (wallet) state.codes.set(wallet, item.result !== "0x" && item.result !== "0x0");
      }
    } catch (error) {
      if (isAbort(error)) throw error;
    }
  }
  function isContract(wallet) {
    return Boolean(LABELS[wallet]) || state.codes.get(wallet) === true;
  }

  async function buildView(base, signal) {
    const exclude = state.excludeContracts;
    const picked = [];
    let scanned = 0;
    while (scanned < base.all.length && picked.length < POOL_SIZE) {
      const chunk = base.all.slice(scanned, scanned + 12);
      await ensureCodes(chunk.map(row => row.address), signal);
      for (const row of chunk) {
        if (!exclude || !isContract(row.address)) picked.push(row);
      }
      scanned += chunk.length;
    }
    if (picked.length < 10) throw new Error("符合条件的持有人不足 10 个");
    // 多取几个候选（POOL_SIZE），读完实时余额后再定前十，避免索引延迟导致排名错位
    const pool = picked.slice(0, POOL_SIZE).map(row => ({ ...row, contract: isContract(row.address) }));
    const rows = pool.slice(0, 10);
    // 榜单校验：第 10 名必须高于榜外任何候选地址可能达到的最大余额
    const top = new Set(pool.map(row => row.address));
    const cutoff = rows[9].total;
    let outsideUpperBound = base.coreThreshold + base.evmThreshold;
    base.all.forEach((row, index) => {
      if (top.has(row.address)) return;
      if (exclude && index < scanned && isContract(row.address)) return;
      const possible = row.total + (base.core.has(row.address) ? 0 : base.coreThreshold) + (base.evm.has(row.address) ? 0 : base.evmThreshold);
      outsideUpperBound = Math.max(outsideUpperBound, possible);
    });
    // 持仓超过第 10 名个人地址的合约，单独列出
    const contracts = exclude
      ? base.all.slice(0, scanned).filter(row => isContract(row.address) && row.total >= cutoff).map(row => ({ ...row, contract: true }))
      : [];
    return {
      pool,
      rows,
      contracts,
      core: base.core,
      evm: base.evm,
      verified: cutoff > outsideUpperBound,
      outsideUpperBound,
      coreAt: base.coreAt,
      coreHolders: base.coreHolders,
      evmHolders: base.evmHolders
    };
  }

  async function fetchCoreBalance(wallet, signal) {
    // 余额每分钟都会再读一次，这里只重试 1 次，失败就等下一轮
    const data = await fetchJson(HL_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "spotClearinghouseState", user: wallet }), signal }, 1);
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

  // JSON-RPC：节点限流（HTTP 429，或返回 -32005 / “rate limit”）时立即换节点，并让该节点冷却 60 秒
  const rpcCooldown = new Map();
  function rpcRateLimited(res) {
    const items = Array.isArray(res) ? res : [res];
    return items.some(item => item && item.error && (item.error.code === -32005 || /rate/i.test(String(item.error.message || ""))));
  }
  async function rpcCall(url, body, signal) {
    const timed = timeoutSignal(signal, 10000);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: timed.signal });
      const res = await response.json().catch(() => null);
      if (response.status === 429 || rpcRateLimited(res)) {
        rpcCooldown.set(url, Date.now() + 60000);
        throw new Error("HTTP 429");
      }
      if (!response.ok || !res) throw new Error("HTTP " + response.status);
      return res;
    } finally {
      timed.done();
    }
  }
  // 依次尝试多个节点（冷却中的排在后面），直到拿到满足 accept 的结果
  async function rpcAny(urls, body, signal, accept = () => true) {
    const now = Date.now();
    const cooling = url => (rpcCooldown.get(url) || 0) > now;
    const ordered = [...urls.filter(url => !cooling(url)), ...urls.filter(cooling)];
    let lastError = new Error("RPC 请求失败");
    for (const url of ordered) {
      try {
        const res = await rpcCall(url, body, signal);
        if (accept(res)) return res;
        lastError = new Error("节点返回不完整");
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  // HyperEVM 余额直接读链上 balanceOf（可指定历史区块），不依赖可能延迟的第三方索引
  async function fetchEvmBalancesAt(wallets, blockTag, urls, signal) {
    const out = new Map();
    for (let i = 0; i < wallets.length; i += 20) {
      const chunk = wallets.slice(i, i + 20);
      const body = chunk.map((wallet, k) => ({
        jsonrpc: "2.0", id: k, method: "eth_call",
        params: [{ to: HPL_CONTRACT, data: "0x70a08231" + wallet.slice(2).toLowerCase().padStart(64, "0") }, blockTag]
      }));
      const valid = item => item && typeof item.result === "string" && /^0x[0-9a-fA-F]*$/.test(item.result);
      const res = await rpcAny(urls, body, signal, r => Array.isArray(r) && r.filter(valid).length === chunk.length);
      for (const item of res) {
        const wallet = valid(item) ? chunk[item.id] : null;
        if (wallet) out.set(wallet, item.result === "0x" ? 0 : Number(BigInt(item.result)) / 1e18);
      }
    }
    return out;
  }
  async function fetchCoreBalancesLive(wallets, signal) {
    const out = new Map();
    await mapLimit(wallets, 4, async wallet => {
      try {
        out.set(wallet, await fetchCoreBalance(wallet, signal));
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    });
    return out;
  }
  // 读取实时余额：只有真正读到的数值才更新，并记下读取时间（coreLiveAt / evmLiveAt）。
  // rerank=true（每 5 分钟的完整刷新）时在候选池里重新排出前十；否则只更新数值并在前十内重新排序。
  async function refreshBalances(view, signal, rerank) {
    const list = [...(rerank ? view.pool : view.rows), ...view.contracts];
    const wallets = [...new Set(list.map(row => row.address))];
    const [core, evm] = await Promise.all([
      fetchCoreBalancesLive(wallets, signal),
      fetchEvmBalancesAt(wallets, "latest", LIVE_RPCS, signal).catch(error => {
        if (isAbort(error)) throw error;
        return new Map();
      })
    ]);
    const now = Date.now();
    for (const row of list) {
      row.prevCore = row.core;
      const liveCore = core.get(row.address);
      const liveEvm = evm.get(row.address);
      if (liveCore !== undefined) {
        row.core = liveCore;
        row.coreLiveAt = now;
      }
      if (liveEvm !== undefined) {
        row.evm = liveEvm;
        row.evmLiveAt = now;
      }
      row.total = row.core + row.evm;
    }
    if (rerank) {
      view.pool.sort((a, b) => b.total - a.total);
      view.rows = view.pool.slice(0, 10);
      // 用实时余额重新做榜单校验
      if (Number.isFinite(view.outsideUpperBound) && view.rows.length >= 10) view.verified = view.rows[9].total > view.outsideUpperBound;
    } else {
      view.rows.sort((a, b) => b.total - a.total);
    }
    view.contracts.sort((a, b) => b.total - a.total);
    const ok = wallets.every(wallet => core.has(wallet) && evm.has(wallet));
    view.balancesOk = ok;
    if (ok) view.balancesAt = now;
    return ok;
  }
  // 完整刷新会新建榜单对象：先沿用上一轮读到的实时余额，读取失败时也不会退回到有延迟的索引数据
  function seedLiveValues(view, prev) {
    if (!prev) return;
    const old = new Map();
    for (const row of [...(prev.pool || prev.rows), ...prev.contracts]) old.set(row.address, row);
    for (const row of [...view.pool, ...view.contracts]) {
      const was = old.get(row.address);
      if (!was) continue;
      if (was.coreLiveAt) {
        row.core = was.core;
        row.coreLiveAt = was.coreLiveAt;
      }
      if (was.evmLiveAt) {
        row.evm = was.evm;
        row.evmLiveAt = was.evmLiveAt;
      }
      row.total = row.core + row.evm;
    }
    view.balancesAt = prev.balancesAt;
  }
  async function refreshLiveBalances() {
    const view = state.current;
    if (!view || state.refreshing || state.balancesLoading || document.hidden) return;
    state.balancesLoading = true;
    const timed = timeoutSignal(undefined, 30000);
    try {
      const order = view.rows.map(row => row.address).join();
      await refreshBalances(view, timed.signal, false);
      if (state.current !== view) return;
      await extendTrades(view, timed.signal);
      if (state.current !== view) return;
      recomputeFlows();
      renderCurrent();
      renderRowsSoon();
      renderSyncStatus();
      if (view.rows.map(row => row.address).join() !== order) {
        populateHistoryWallets(true);
        renderTrades();
      }
      void retryArchiveStart();
      void loadCosts(1);
    } catch (_) { /* 下一分钟再试 */ } finally {
      timed.done();
      state.balancesLoading = false;
    }
  }

  function updateSnapshotLabel() {
    const view = state.current;
    if (!view) return;
    const pd = state.periodData;
    const liveAt = view.balancesAt ? "实时余额 " + clockText(view.balancesAt) : "余额读取中";
    $("snapshot-label").textContent = pd && pd.historyAt
      ? "比较北京时间 " + timeText(pd.historyAt) + " → 现在（" + liveAt + "）· 跨度 " + spanText(Date.now() - pd.historyAt)
      : liveAt;
  }
  function renderCurrent() {
    if (!state.current) return;
    const total = state.current.rows.reduce((sum, row) => sum + row.total, 0);
    $("total-holdings").textContent = fmt(total) + " HPL";
    $("holder-count").textContent = "Core " + fmt(state.current.coreHolders) + " 个地址 · EVM " + fmt(state.current.evmHolders) + " 个地址";
    updateSnapshotLabel();
    renderPrice();
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
      const acct = ACCOUNT_LABELS[row.address];
      const label = (acct
        ? '<span class="address-label account" title="' + esc(acct.note) + '">' + esc(acct.name) + '</span>'
        : name ? '<span class="address-label">' + esc(name) + '</span>' : "") +
        (row.contract && !LABELS[row.address] ? '<span class="address-label contract">合约</span>' : "");
      const liveAt = Math.min(row.coreLiveAt || 0, row.evmLiveAt || 0);
      const balanceNote = !row.coreLiveAt || !row.evmLiveAt
        ? ' · <span class="caution">部分余额来自索引，可能有延迟</span>'
        : Date.now() - liveAt > 3 * BALANCE_REFRESH_MS ? ' · <span class="caution">余额为 ' + clockText(liveAt) + ' 读取</span>' : '';
      const split = 'Core ' + compact(row.core) + ' · EVM ' + compact(row.evm) + balanceNote;
      let flow = '<span class="pending">读取中…</span>';
      if (detail && detail.flowComplete) {
        const cls = detail.flow > 0 ? "positive" : detail.flow < 0 ? "negative" : "neutral";
        const bar = Math.abs(detail.flow) > 0 ? '<span class="flow-bar ' + (detail.flow < 0 ? "negative" : "") + '" style="width:' + Math.max(4, Math.round(Math.abs(detail.flow) / maxAbs * 60)) + 'px"></span>' : "";
        const big = isBigFlow(row, detail.flow) && !detail.indexerFallback ? '<span class="big-tag">大额</span>' : "";
        flow = '<span class="flow ' + cls + '">' + signed(detail.flow) + '</span>' + big + bar + splitHtml(detail);
      } else if (detail && (detail.flowError || detail.balanceMissing)) {
        flow = '<span class="muted-cell">' + (detail.balanceMissing ? "余额读取失败" : "读取失败") + '</span>';
      }
      return '<tr>' +
        '<td><span class="rank">' + String(index + 1).padStart(2, "0") + '</span>' +
        '<a class="addr" href="https://hypurrscan.io/address/' + row.address + '" target="_blank" rel="noopener noreferrer" title="' + row.address + '">' + short(row.address) + ' ↗</a>' +
        label + '<button class="history-link" type="button" data-history-wallet="' + row.address + '">查看历史点位</button>' +
        (acct ? '<span class="sub acct-note">' + esc(acct.short) + '</span>' : '') +
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

  // 后台更新引起的重绘：用户正在用键盘操作、选中文字或按住鼠标时稍后再画，避免打断
  function rowsBusy() {
    const box = document.querySelector(".tablebox");
    if (!box) return false;
    const active = document.activeElement;
    if (active && active !== document.body && box.contains(active) && active.matches(":focus-visible")) return true;
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.anchorNode && box.contains(selection.anchorNode)) return true;
    return Boolean(state.rowsPointerDown);
  }
  function renderRowsSoon() {
    if (state.rowsRetryTimer) return;
    if (!rowsBusy()) {
      renderRows();
      return;
    }
    state.rowsRetryTimer = setTimeout(() => {
      state.rowsRetryTimer = null;
      renderRowsSoon();
    }, 1500);
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
    const lag = detail && detail.indexerFallback ? '<span class="sub caution">HyperEVM 部分来自索引，可能有延迟</span>' : "";
    const net = tradeNet(detail);
    if (net === null || !detail.flowComplete) return '<span class="sub">HPL</span>' + lag;
    const transfer = detail.flow - net;
    const part = (label, value) => '<span class="' + (Math.abs(value) < 0.5 ? "muted-cell" : value > 0 ? "positive" : "negative") + '">' + label + " " + signed(Math.round(value)) + "</span>";
    if (Math.abs(net) < 0.5 && Math.abs(transfer) < 0.5) return '<span class="sub">HPL</span>' + lag;
    return '<span class="sub split-line">' + part("交易", net) + " · " + part("转账", transfer) + "</span>" + lag;
  }
  function isBigFlow(row, flow) {
    const before = Math.max(row.total - flow, 0);
    return Math.abs(flow) >= BIG_FLOW_HPL || (before > 0 && Math.abs(flow) / before >= BIG_FLOW_RATIO && Math.abs(flow) >= BIG_FLOW_HPL / 10);
  }
  function renderAlerts() {
    const box = $("flow-alerts");
    const details = state.periodData && state.periodData.details;
    if (!details || !state.current) { box.hidden = true; return; }
    const items = [
      ...state.current.rows.map((row, index) => ({ row, index, detail: details.get(row.address) })),
      ...(state.current.contracts || []).map(row => ({ row, index: -1, detail: details.get(row.address) }))
    ]
      .filter(item => item.detail && item.detail.flowComplete && !item.detail.indexerFallback && isBigFlow(item.row, item.detail.flow))
      .sort((x, y) => Math.abs(y.detail.flow) - Math.abs(x.detail.flow));
    if (!items.length) { box.hidden = true; return; }
    const usdNote = state.price ? flow => " ≈ " + usd(Math.abs(flow) * state.price) : () => "";
    box.innerHTML = '<strong>本期大额变动 · ' + PERIODS[state.period].label + '</strong>' + items.map(item => {
      const name = labelFor(item.row.address);
      const before = Math.max(item.row.total - item.detail.flow, 0);
      const pct = before > 0 ? " · " + (item.detail.flow > 0 ? "+" : "−") + (Math.abs(item.detail.flow) / before * 100).toFixed(1) + "%" : "";
      return '<span class="alert-item">' + (item.index >= 0 ? "#" + (item.index + 1) : "合约") + ' ' + short(item.row.address) + (name ? "（" + esc(name) + "）" : "") +
        ' <span class="' + (item.detail.flow > 0 ? "positive" : "negative") + '">' + signed(item.detail.flow) + ' HPL</span>' + usdNote(item.detail.flow) + pct + '</span>';
    }).join("");
    box.hidden = false;
  }
  function renderContracts() {
    const box = $("contractbox");
    const list = (state.current && state.current.contracts) || [];
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    const details = state.periodData && state.periodData.details;
    let total = 0, net = 0, known = 0;
    $("contract-rows").innerHTML = list.map(row => {
      total += row.total;
      const detail = details && details.get(row.address);
      let flow = '<span class="pending">读取中…</span>';
      if (detail && detail.flowComplete) {
        known += 1;
        net += detail.flow;
        const cls = detail.flow > 0 ? "positive" : detail.flow < 0 ? "negative" : "neutral";
        const big = isBigFlow(row, detail.flow) && !detail.indexerFallback ? '<span class="big-tag">大额</span>' : "";
        const before = Math.max(row.total - detail.flow, 0);
        const pct = detail.flow && before > 0 ? '<span class="sub">' + (detail.flow > 0 ? "+" : "−") + (Math.abs(detail.flow) / before * 100).toFixed(1) + "% · 转账/分发/质押</span>" : '<span class="sub">HPL</span>';
        flow = '<span class="flow ' + cls + '">' + signed(detail.flow) + '</span>' + big + pct;
      } else if (detail && (detail.flowError || detail.balanceMissing)) {
        flow = '<span class="muted-cell">' + (detail.balanceMissing ? "余额读取失败" : "读取失败") + '</span>';
      }
      const name = labelFor(row.address) || "未标注合约";
      return '<tr><td data-label=""><a class="addr" href="https://hypurrscan.io/address/' + row.address + '" target="_blank" rel="noopener noreferrer" title="' + row.address + '">' + short(row.address) + ' ↗</a>' +
        '<span class="address-label' + (LABELS[row.address] ? "" : " contract") + '">' + esc(name) + '</span>' +
        '<span class="sub">Core ' + compact(row.core) + ' · EVM ' + compact(row.evm) + '</span></td>' +
        '<td data-label="当前仓位"><span class="holdings">' + fmt(row.total) + '</span><span class="sub">HPL</span></td>' +
        '<td data-label="期间净流向">' + flow + '</td></tr>';
    }).join("");
    $("contract-summary").textContent = list.length + " 个 · 合计 " + compact(total) + " HPL" +
      (known === list.length ? " · " + PERIODS[state.period].label + "净流向 " + signed(Math.round(net)) : "");
  }
  function renderSummary() {
    renderAlerts();
    renderContracts();
    const pd = state.periodData;
    updateSnapshotLabel();
    const actual = pd && pd.historyAt ? Date.now() - pd.historyAt : null;
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
      ? "交易 " + signed(Math.round(tradeSum)) + " · 转账 " + signed(Math.round(transferSum)) + " HPL" + (splitCount < flows.length ? "（" + splitCount + " 个地址）" : "") + (state.periodData && state.periodData.fallback ? " · 部分为估算" : "")
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

  function addFills(groups, fills) {
    for (const fill of fills) {
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
  }
  function aggregateFills(data) {
    const groups = { buy: {}, sell: {} };
    addFills(groups, data.fills);
    return { groups, complete: data.complete };
  }
  // 把某个地址的期间成交补到 until（只取上次之后的部分），让“交易 / 转账”拆分和实时流向用同一时间段
  async function topUpTrades(wallet, detail, until, signal) {
    const result = await pageFills(wallet, detail.tradesTo + 1, until, false, signal);
    addFills(detail.trades.groups, result.fills);
    if (!result.complete) detail.trades.complete = false;
    detail.tradesTo = until;
  }
  // 每分钟：HyperCore 余额有变化（或超过 5 分钟没补）的地址，补上新成交
  async function extendTrades(view, signal) {
    const pd = state.periodData;
    if (!pd || !state.pairs) return;
    const targets = view.rows.filter(row => {
      if (row.contract) return false;
      const detail = pd.details.get(row.address);
      if (!detail || !detail.trades || detail.trades.error || typeof detail.tradesTo !== "number") return false;
      return row.core !== row.prevCore || Date.now() - detail.tradesTo > FULL_REFRESH_MS;
    });
    await mapLimit(targets, 2, async row => {
      try {
        await topUpTrades(row.address, pd.details.get(row.address), Date.now(), signal);
      } catch (error) {
        if (isAbort(error)) throw error; // 其他失败保留原样，下一分钟再补
      }
    });
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
  // limit：一次最多算几个（后台每分钟只补 1 个，避免和其他请求挤在一起触发限流）；force：中断正在进行的计算重新开始
  async function loadCosts(limit = Infinity, force = false) {
    if (!state.current || !state.pairs) return;
    if (state.costController) {
      if (!force) return;
      state.costController.abort();
    }
    const controller = new AbortController();
    state.costController = controller;
    const view = state.current;
    const now = Date.now();
    const missing = row => !state.costs.get(row.address);
    const stale = row => {
      const cost = state.costs.get(row.address);
      if (!cost) return true;
      if (cost.retryAt && now < cost.retryAt) return false;
      if (cost.error) return true;
      return Boolean(cost.at) && now - cost.at > COST_TTL_MS;
    };
    const targets = view.rows.filter(row => !row.contract && stale(row)).sort((a, b) => missing(b) - missing(a)).slice(0, limit);
    try {
      await mapLimit(targets, 1, async row => {
        if (controller.signal.aborted) return;
        try {
          state.costs.set(row.address, await computeCost(row.address, controller.signal));
        } catch (error) {
          if (isAbort(error)) return;
          const prev = state.costs.get(row.address);
          if (prev && !prev.error) prev.retryAt = Date.now() + 5 * 60 * 1000; // 保留上次的结果，5 分钟后再试
          else state.costs.set(row.address, { error: historyErrorText(error), at: Date.now(), retryAt: Date.now() + 2 * 60 * 1000 });
        }
        if (state.current === view && !controller.signal.aborted) renderRowsSoon();
      });
    } finally {
      if (state.costController === controller) state.costController = null;
    }
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

  function abortHistoryLoads() {
    if (state.historyController) state.historyController.abort();
    if (state.historyQuiet) {
      state.historyQuiet.abort();
      state.historyQuiet = null;
    }
  }
  // keepCurrent=true（后台刷新）时，已选的地址即使掉出前十也继续保留，不自动切换
  function populateHistoryWallets(keepCurrent = false) {
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
    const inTop = Boolean(state.historyWallet) && state.current.rows.some(row => row.address === state.historyWallet);
    if (state.historyWallet && !inTop && keepCurrent) {
      const option = document.createElement("option");
      option.value = state.historyWallet;
      option.textContent = short(state.historyWallet) + "（已不在前十）";
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    if (state.historyWallet && (inTop || keepCurrent)) {
      select.value = state.historyWallet;
    } else {
      abortHistoryLoads();
      state.historyWallet = null;
      state.historyData = null;
      state.historyLoading = false;
      renderHistory();
    }
  }
  // 后台静默更新当前选中地址的历史成交：成功后才替换，失败保留旧数据
  async function refreshHistoryQuietly() {
    const wallet = state.historyWallet;
    const range = state.historyRange;
    const data = state.historyData;
    if (!wallet || state.historyLoading || state.historyQuiet || !data || data.error) return;
    if (Date.now() - (data.asOf || 0) < FULL_REFRESH_MS - 30 * 1000) return;
    const controller = new AbortController();
    state.historyQuiet = controller;
    try {
      const fresh = await fetchHistory(wallet, range, controller.signal, () => {});
      if (controller.signal.aborted || state.historyWallet !== wallet || state.historyRange !== range || state.historyLoading) return;
      state.historyCache.set(wallet + ":" + range, fresh);
      state.historyData = fresh;
      renderHistory();
    } catch (_) { /* 保留旧数据，下次再试 */ } finally {
      if (state.historyQuiet === controller) state.historyQuiet = null;
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
    const data = state.historyWallet ? state.historyData : null;
    if (data && !data.error && data.asOf && !state.historyLoading) {
      $("history-status").textContent += " 数据截至北京时间 " + clockText(data.asOf) + "，每 5 分钟后台更新。";
    }
    void renderChart(data);
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
    abortHistoryLoads();
    const valid = Boolean(state.current && wallet && (state.current.rows.some(row => row.address === wallet) || wallet === state.historyWallet));
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
    const cachedHistory = state.historyCache.get(cacheKey);
    if (cachedHistory && Date.now() - (cachedHistory.asOf || 0) < FULL_REFRESH_MS) {
      state.historyData = cachedHistory;
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

  // 找到时间点 ms 之前（含）最近的 HyperEVM 区块号（插值查找，通常 4–8 次请求）
  // 期初时间点只随历史快照变化（约每 6 小时一次），找到的区块记在浏览器里，刷新页面不必重新查找
  const BLOCK_CACHE_KEY = "hpl-tracker:blocks";
  const blockCache = (() => {
    try { return new Map(JSON.parse(localStorage.getItem(BLOCK_CACHE_KEY) || "[]")); } catch (_) { return new Map(); }
  })();
  function rememberBlock(key, number) {
    blockCache.set(key, number);
    try {
      localStorage.setItem(BLOCK_CACHE_KEY, JSON.stringify(Array.from(blockCache.entries()).slice(-50)));
    } catch (_) { /* 存储不可用时忽略 */ }
  }
  async function getBlock(tag, signal) {
    const res = await rpcAny(LIVE_RPCS, { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }, signal, r => r && r.result && r.result.number);
    return { number: parseInt(res.result.number, 16), ts: parseInt(res.result.timestamp, 16) * 1000 };
  }
  async function findBlockAt(ms, signal) {
    const key = Math.floor(ms / 1000);
    if (blockCache.has(key)) return blockCache.get(key);
    let hi = await getBlock("latest", signal);
    if (ms >= hi.ts) return hi.number;
    let guessNumber = Math.max(1, hi.number - Math.ceil((hi.ts - ms) / 1000 * 1.1));
    let lo = await getBlock("0x" + guessNumber.toString(16), signal);
    for (let i = 0; i < 6 && lo.ts > ms && lo.number > 1; i++) {
      hi = lo;
      guessNumber = Math.max(1, lo.number - Math.ceil((lo.ts - ms) / 1000 * 2));
      lo = await getBlock("0x" + guessNumber.toString(16), signal);
    }
    if (lo.ts > ms) throw new Error("找不到对应区块");
    for (let i = 0; i < 14 && hi.number - lo.number > 1 && ms - lo.ts > 2000; i++) {
      const rate = (hi.number - lo.number) / Math.max(1, hi.ts - lo.ts);
      const guess = Math.min(hi.number - 1, Math.max(lo.number + 1, Math.round(lo.number + (ms - lo.ts) * rate)));
      const block = await getBlock("0x" + guess.toString(16), signal);
      if (block.ts <= ms) lo = block;
      else hi = block;
    }
    rememberBlock(key, lo.number);
    return lo.number;
  }
  // 期初 HyperEVM 余额（历史区块）不会再变：按“区块:地址”缓存在浏览器里，只读缺的
  const ARCHIVE_CACHE_KEY = "hpl-tracker:evm-start";
  const archiveCache = (() => {
    try { return new Map(JSON.parse(localStorage.getItem(ARCHIVE_CACHE_KEY) || "[]")); } catch (_) { return new Map(); }
  })();
  function rememberArchive(block, balances) {
    for (const [wallet, value] of balances) archiveCache.set(block + ":" + wallet, value);
    try {
      localStorage.setItem(ARCHIVE_CACHE_KEY, JSON.stringify(Array.from(archiveCache.entries()).slice(-400)));
    } catch (_) { /* 存储不可用时忽略 */ }
  }
  // patient=true：首次读取时多等两次（历史节点常有短暂限流），仍失败才退回索引；只返回读到的部分
  async function fetchStartBalances(wallets, block, signal, patient) {
    const out = new Map();
    const missing = [];
    for (const wallet of wallets) {
      const key = block + ":" + wallet;
      if (archiveCache.has(key)) out.set(wallet, archiveCache.get(key));
      else missing.push(wallet);
    }
    if (!missing.length) return out;
    for (const delay of patient ? [0, 3000, 10000] : [0]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const got = await fetchEvmBalancesAt(missing, "0x" + block.toString(16), [ARCHIVE_RPC], signal);
        rememberArchive(block, got);
        for (const [wallet, value] of got) out.set(wallet, value);
        return out;
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    }
    return out;
  }
  // 期间净流向 = 当前实时余额 − 期初余额（HyperCore 期初取历史快照，HyperEVM 期初取历史区块余额）。
  // 某一侧从没读到过实时余额时不计算，避免把有延迟的索引数据当成实时数据。
  function computeFlow(row, detail) {
    if (!detail) return;
    detail.balanceMissing = !row.coreLiveAt || !row.evmLiveAt;
    if (detail.balanceMissing || detail.flowError) {
      detail.flowComplete = false;
      return;
    }
    let evmDelta = null;
    if (typeof detail.startEvm === "number") evmDelta = row.evm - detail.startEvm;
    else if (typeof detail.evmDelta === "number") evmDelta = detail.evmDelta;
    if (evmDelta === null) return;
    detail.flow = (row.core - detail.startCore) + evmDelta;
    detail.flowComplete = true;
  }
  function recomputeFlows() {
    const pd = state.periodData;
    const view = state.current;
    if (!pd || !view) return;
    for (const row of [...view.rows, ...view.contracts]) computeFlow(row, pd.details.get(row.address));
  }
  // 历史节点读取失败时，只重试“期初余额”这一步（指数退避），不重新下载成交和转账记录
  async function retryArchiveStart() {
    const pd = state.periodData;
    if (!pd || !pd.fallback || pd.view !== state.current || state.archiveRetrying || Date.now() < (pd.nextRetryAt || 0)) return;
    state.archiveRetrying = true;
    try {
      if (!pd.block) pd.block = await findBlockAt(pd.historyAt);
      const missing = Array.from(pd.details.entries()).filter(([, detail]) => detail.startEvm === null).map(([wallet]) => wallet);
      const got = await fetchStartBalances(missing, pd.block, undefined, false);
      for (const [wallet, value] of got) {
        const detail = pd.details.get(wallet);
        if (!detail) continue;
        detail.startEvm = value;
        detail.indexerFallback = false;
        detail.flowError = false;
      }
      pd.fallback = Array.from(pd.details.values()).some(detail => detail.startEvm === null);
      if (state.periodData === pd) {
        recomputeFlows();
        renderRowsSoon();
        renderSyncStatus();
      }
    } catch (_) { /* 退避后再试 */ } finally {
      if (pd.fallback) {
        pd.retryDelay = Math.min(FULL_REFRESH_MS, (pd.retryDelay || 30000) * 2);
        pd.nextRetryAt = Date.now() + pd.retryDelay;
      }
      state.archiveRetrying = false;
    }
  }

  // options.background：后台更新（不显示过程、算完前保留旧数据）；options.force：忽略缓存
  async function loadPeriod(options = {}) {
    const view = state.current;
    if (!view) return null;
    if (state.periodController) state.periodController.abort();
    const controller = new AbortController();
    state.periodController = controller;
    const generation = ++state.generation;
    const period = state.period;
    const quiet = Boolean(options.background);
    const finish = () => { if (state.periodController === controller) state.periodController = null; };
    const alive = () => !controller.signal.aborted && generation === state.generation && state.current === view;
    const cached = state.periodCache[period];
    if (!options.force && cached && cached.view === view) {
      state.periodData = cached;
      recomputeFlows();
      renderRows();
      finish();
      clearStatus();
      return cached;
    }
    // 同一时间窗口的上一份结果（当前显示的或缓存的）：期初余额和已有成交可以直接沿用
    const shown = state.periodData && state.periodData.period === period ? state.periodData : null;
    const prevPd = shown || cached || null;
    const keepOld = quiet && Boolean(shown);
    if (!keepOld) {
      state.periodData = null;
      renderRows();
    }
    if (!quiet) setLoading("计算" + PERIODS[period].label + "流向…");
    const nowMs = Date.now();
    let history;
    try {
      history = await fetchNearestSnapshot(nowMs - PERIODS[period].ms, nowMs, controller.signal);
    } catch (error) {
      if (isAbort(error) || !alive()) return null;
      finish();
      if (!quiet) {
        setError("历史快照暂不可用，请稍后刷新");
        $("coverage-note").textContent = "历史持仓快照读取失败，请刷新重试";
      }
      return null;
    }
    if (!alive()) return null;
    const startMs = Number(history.lastUpdate) * 1000;
    const past = history.holders;
    const sameWindow = Boolean(prevPd && prevPd.historyAt === startMs);
    const tracked = [...view.rows, ...view.contracts];
    // 期初 HyperEVM 余额：找到期初时间对应的区块，读该区块的历史余额（有缓存）
    let block = sameWindow && prevPd.block ? prevPd.block : null;
    let evmStart = new Map();
    try {
      if (!block) block = await findBlockAt(startMs, controller.signal);
      evmStart = await fetchStartBalances(tracked.map(row => row.address), block, controller.signal, true);
    } catch (error) {
      if (isAbort(error) || !alive()) return null;
    }
    if (!alive()) return null;
    const details = new Map();
    for (const row of tracked) {
      const old = sameWindow ? prevPd.details.get(row.address) : null;
      let startEvm = evmStart.has(row.address) ? evmStart.get(row.address) : null;
      if (startEvm === null && old && typeof old.startEvm === "number") startEvm = old.startEvm;
      const reuseTrades = !row.contract && old && old.trades && !old.trades.error && typeof old.tradesTo === "number";
      details.set(row.address, {
        startCore: Number(past[row.address] || 0),
        startEvm,
        evmDelta: null,
        indexerFallback: startEvm === null,
        flow: null,
        flowComplete: false,
        flowError: false,
        balanceMissing: false,
        trades: row.contract ? { groups: { buy: {}, sell: {} }, complete: true } : reuseTrades ? old.trades : null, // 合约不做买卖统计
        tradesTo: reuseTrades ? old.tradesTo : null
      });
    }
    const pd = { period, view, historyAt: startMs, block, details, loadedAt: Date.now(), retryDelay: 30000, nextRetryAt: Date.now() + 60000 };
    pd.fallback = tracked.some(row => details.get(row.address).startEvm === null);
    if (!keepOld) {
      state.periodData = pd;
      for (const row of tracked) computeFlow(row, details.get(row.address));
      renderRows();
    }
    await mapLimit(tracked, 3, async row => {
      if (!alive()) return;
      const detail = details.get(row.address);
      const tasks = [];
      if (detail.startEvm === null) {
        // 历史节点暂时读不到时，先用 Transfer 事件索引估算（可能有延迟：页面会标注、不触发大额提醒，并在后台重试）
        tasks.push(fetchEvmDelta(row.address, startMs, Date.now(), controller.signal)
          .then(result => {
            if (result.complete) detail.evmDelta = result.delta;
            else detail.flowError = true;
          })
          .catch(error => { if (!isAbort(error)) detail.flowError = true; }));
      }
      if (!row.contract) {
        if (!detail.trades) {
          const until = Date.now();
          tasks.push(state.pairs
            ? fetchFills(row.address, startMs, until, controller.signal)
              .then(result => {
                detail.trades = aggregateFills(result);
                detail.tradesTo = until;
              })
              .catch(error => { if (!isAbort(error)) detail.trades = { error: true }; })
            : Promise.resolve().then(() => { detail.trades = { error: true }; }));
        } else if (Date.now() - detail.tradesTo > 2 * 60 * 1000) {
          // 沿用的成交已经过了一会儿：只补上之后的部分
          tasks.push(topUpTrades(row.address, detail, Date.now(), controller.signal).catch(error => { if (isAbort(error)) throw error; }));
        }
      }
      await Promise.all(tasks);
      computeFlow(row, detail);
      if (!keepOld && alive()) renderRows();
    }).catch(error => { if (!isAbort(error)) throw error; });
    if (!alive()) return null;
    // 后台更新时，个别地址这次没读到的，沿用上一次（同一时间窗口）的结果，不把好数据换成“读取失败”
    if (keepOld && sameWindow) {
      for (const row of tracked) {
        const detail = details.get(row.address);
        const old = prevPd.details.get(row.address);
        if (!old) continue;
        if (detail.trades && detail.trades.error && old.trades && !old.trades.error) {
          detail.trades = old.trades;
          detail.tradesTo = old.tradesTo;
        }
        if (detail.flowError && !old.flowError) {
          detail.flowError = false;
          detail.evmDelta = old.evmDelta;
          if (typeof old.startEvm === "number") detail.startEvm = old.startEvm;
          detail.indexerFallback = detail.startEvm === null;
        }
      }
      pd.fallback = tracked.some(row => details.get(row.address).startEvm === null);
    }
    state.periodData = pd;
    for (const row of tracked) computeFlow(row, details.get(row.address));
    const allFlows = view.rows.every(row => details.get(row.address).flowComplete);
    const allTrades = view.rows.every(row => details.get(row.address).trades && !details.get(row.address).trades.error);
    if (allFlows && allTrades) state.periodCache[period] = pd;
    finish();
    clearStatus();
    renderRows();
    return pd;
  }

  async function refresh(manual = false) {
    if (state.currentController) state.currentController.abort();
    state.lastAttemptAt = Date.now();
    state.refreshing = true;
    state.silent = Boolean(state.current) && !manual; // 已有数据时的自动刷新在后台静默进行
    const controller = new AbortController();
    state.currentController = controller;
    if (!state.silent) $("refresh").disabled = true;
    setLoading("同步两端持仓…");
    if (!state.current) $("rows").innerHTML = '<tr><td colspan="6" class="loading">正在读取 HyperCore 与 HyperEVM 持仓…</td></tr>';
    // 交易对信息只依赖 Hyperliquid：单独读取，实时行情不受第三方持仓接口影响
    const metaTask = info({ type: "spotMeta" }, controller.signal).then(meta => {
      const pairs = meta ? derivePairs(meta) : null;
      if (pairs) state.pairs = pairs;
      if (!state.pairs || controller.signal.aborted) return;
      connectLive();
      if (!state.book || manual) void refreshBook(true);
      if (!state.market || !state.market.sums || manual) void refreshMarket();
    }).catch(() => { /* 下次刷新再试 */ });
    const midsTask = info({ type: "allMids" }, controller.signal).catch(() => null);
    try {
      const [coreData, evmData] = await Promise.all([
        fetchJson(CORE_API + "/holdersWithLimit/HPL/100", { signal: controller.signal }),
        post(EVM_API + "/indexed/token-holders", { token_address: HPL_CONTRACT, limit: 100, offset: 0 }, controller.signal)
      ]);
      await metaTask;
      const midsResult = await midsTask;
      if (controller.signal.aborted) return;
      if (!liveOk()) {
        const mid = state.pairs && midsResult ? Number(midsResult[state.pairs.usdc]) : NaN;
        if (Number.isFinite(mid) && mid > 0) state.price = mid;
      }
      state.base = buildBase(coreData, evmData);
      if (!state.silent) {
        state.costs.clear();
        state.historyCache.clear();
        state.periodCache = {};
      }
      await applyView(controller, manual);
      if (!controller.signal.aborted) state.lastRefreshAt = Date.now();
    } catch (error) {
      if (isAbort(error)) return;
      if (state.current) {
        setError((manual ? "刷新失败" : "后台刷新失败") + "，显示上次数据 · " + clockText(Date.now()));
      } else {
        setError("数据读取失败，稍后自动重试");
        $("rows").innerHTML = '<tr><td colspan="6" class="loading">暂时无法读取两端持仓，请稍后刷新。</td></tr>';
        $("history-status").textContent = "榜单读取失败，刷新后再查看历史成交。";
      }
    } finally {
      if (state.currentController === controller) {
        $("refresh").disabled = false;
        state.refreshing = false;
        state.silent = false;
      }
    }
  }

  async function applyView(controller, forceHistory) {
    setLoading("识别合约地址…");
    const view = await buildView(state.base, controller.signal);
    if (controller.signal.aborted) return;
    seedLiveValues(view, state.current);
    setLoading("读取实时余额…");
    await refreshBalances(view, controller.signal, true);
    if (controller.signal.aborted) return;
    state.current = view;
    if (!state.silent) state.periodData = null;
    recomputeFlows();
    $("contract-scope").textContent = "仅个人地址 · 项目合约见下方";
    renderCurrent();
    renderRows();
    populateHistoryWallets(state.silent);
    if (!state.historyWallet && !state.historyUserCleared) {
      const wallet = (view.rows.find(row => !row.contract) || view.rows[0] || {}).address;
      if (wallet) void selectHistoryWallet(wallet, false, forceHistory);
    } else if (state.historyWallet && forceHistory) {
      void selectHistoryWallet(state.historyWallet, false, true);
    } else if (state.silent) {
      void refreshHistoryQuietly();
    }
    await loadPeriod({ background: state.silent });
    if (!controller.signal.aborted) void loadCosts(state.silent ? 2 : Infinity, !state.silent);
  }

  function refreshIfStale() {
    if (document.hidden || state.refreshing) return;
    const due = Math.max(state.lastRefreshAt + FULL_REFRESH_MS, state.lastAttemptAt + RETRY_REFRESH_MS);
    if (Date.now() >= due) void refresh(false);
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
    if (button) {
      state.historyUserCleared = false;
      void selectHistoryWallet(button.dataset.historyWallet, true);
    }
  });
  $("history-wallet").addEventListener("change", event => {
    state.historyUserCleared = !event.target.value; // 用户主动清空时，后台刷新不再自动选地址
    void selectHistoryWallet(event.target.value);
  });
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
  $("refresh").addEventListener("click", () => { void refresh(true); });
  $("book-reload").addEventListener("click", () => { void refreshBook(true); });
  // 自动刷新全部在后台静默进行：
  // 盘口 / 成交 / 价格 / 24 小时数据走实时推送；余额每 60 秒；榜单与流向每 5 分钟；7/30 天成交额每 10 分钟
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    flushLiveRender();
    refreshIfStale();
    if (state.current && Date.now() - (state.current.balancesAt || 0) >= BALANCE_REFRESH_MS) void refreshLiveBalances();
    if (!liveOk()) void refreshBook(true);
  });
  window.addEventListener("focus", refreshIfStale);
  setInterval(refreshIfStale, 30 * 1000);
  setInterval(liveWatchdog, 5 * 1000);
  $("rows").addEventListener("pointerdown", () => { state.rowsPointerDown = true; });
  document.addEventListener("pointerup", () => { state.rowsPointerDown = false; });
  document.addEventListener("pointercancel", () => { state.rowsPointerDown = false; });
  setInterval(() => { void refreshLiveBalances(); }, BALANCE_REFRESH_MS);
  setInterval(() => { if (!document.hidden && liveOk()) void refreshAggBook(); }, AGG_BOOK_REFRESH_MS);
  setInterval(() => { if (!document.hidden && !liveOk()) void refreshBook(); }, BOOK_POLL_MS);
  setInterval(() => { if (!document.hidden) void refreshMarket(); }, MARKET_REFRESH_MS);
  setInterval(() => { if (!document.hidden && state.current) updateSnapshotLabel(); }, 30 * 1000);
  // TradingView 高级图表（官方免费嵌入组件）
  function mountTradingView(symbol) {
    const container = $("tv-container");
    container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.text = JSON.stringify({
      autosize: true,
      symbol,
      interval: "60",
      timezone: "Asia/Shanghai",
      theme: "dark",
      style: "1",
      locale: "zh_CN",
      backgroundColor: "#0f1c22",
      gridColor: "rgba(34, 52, 58, 0.6)",
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      details: true,
      hotlist: false,
      calendar: false,
      studies: ["STD;Volume"],
      support_host: "https://www.tradingview.com"
    });
    container.appendChild(script);
  }
  document.querySelectorAll("[data-tv-symbol]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-tv-symbol]").forEach(other => {
        const active = other === button;
        other.classList.toggle("active", active);
        other.setAttribute("aria-pressed", String(active));
      });
      mountTradingView(button.dataset.tvSymbol);
    });
  });
  $("tv-fullscreen").addEventListener("click", () => {
    const box = $("tvbox");
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (box.requestFullscreen) box.requestFullscreen().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    $("tv-fullscreen").textContent = document.fullscreenElement ? "✕ 退出全屏" : "⛶ 全屏";
  });
  mountTradingView("HYPERLIQUID:HPLUSDC");

  registerWebMcp();
  fetchJson(CORE_API + "/globalAliases").then(data => {
    if (!data || typeof data !== "object") return;
    state.aliases = new Map(Object.entries(data).filter(([wallet, name]) => validAddress(wallet) && typeof name === "string").map(([wallet, name]) => [address(wallet), name.slice(0, 40)]));
    if (state.current) { renderRows(); populateHistoryWallets(); }
  }).catch(() => { /* 别名为可选信息 */ });
  void refresh();
})();
