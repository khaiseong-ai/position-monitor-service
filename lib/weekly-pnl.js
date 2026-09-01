import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";

const DEFAULT_ENV_FILE = "C:/Users/User/Documents/Codex/2026-06-12/files-mentioned-by-the-user-codex/outputs/position-monitor-service/.env";

function loadEnv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function hmacHex(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function hmacBase64(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64");
}

function queryString(params) {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)])
  ).toString();
}

async function readJson(response, label) {
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label}: HTTP ${response.status}, non-JSON response`);
  }
  if (!response.ok) {
    const message = json.msg || json.message || json.retMsg || text.slice(0, 200);
    throw new Error(`${label}: HTTP ${response.status}: ${message}`);
  }
  return json;
}

function normalizeTimestamp(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) number = Date.parse(String(value || ""));
  if (!Number.isFinite(number)) return 0;
  if (number > 1e17) number /= 1e6;
  else if (number > 1e14) number /= 1e3;
  return Math.trunc(number);
}

function record({ exchange, symbol, side, pnl, pricePnl, fundingPnl, qty, entryPrice, closePrice, openedAt, closedAt, id }) {
  return {
    exchange,
    symbol: String(symbol || "").replace(/_/g, ""),
    side: String(side || "").toLowerCase(),
    pnl: Number(pnl),
    pricePnl: Number(pricePnl ?? pnl),
    fundingPnl: Number(fundingPnl || 0),
    qty: Math.abs(Number(qty || 0)),
    entryPrice: Number(entryPrice || 0),
    closePrice: Number(closePrice || 0),
    openedAt: normalizeTimestamp(openedAt),
    closedAt: normalizeTimestamp(closedAt),
    id: String(id || "")
  };
}

async function binanceGet(env, endpoint, params) {
  const base = env.BINANCE_REST_BASE || "https://fapi.binance.com";
  const fullParams = { ...params, recvWindow: 10000, timestamp: Date.now() };
  const query = queryString(fullParams);
  const signature = hmacHex(env.BINANCE_API_SECRET, query);
  const response = await fetch(`${base}${endpoint}?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY }
  });
  return readJson(response, `binance ${endpoint}`);
}

async function fetchBinanceTrades(env, startMs, endMs, symbol = "") {
  const trades = [];
  const chunkMs = 6 * 24 * 60 * 60 * 1000;
  for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkMs) {
    const chunkEnd = Math.min(endMs, chunkStart + chunkMs - 1);
    let pageStart = chunkStart;
    for (let page = 0; page < 50 && pageStart <= chunkEnd; page += 1) {
      const rows = await binanceGet(env, "/fapi/v1/userTrades", {
        symbol,
        startTime: pageStart,
        endTime: chunkEnd,
        limit: 1000
      });
      trades.push(...rows);
      if (rows.length < 1000) break;
      const nextStart = Math.max(...rows.map((row) => Number(row.time))) + 1;
      if (!Number.isFinite(nextStart) || nextStart <= pageStart) {
        throw new Error("binance userTrades pagination did not advance");
      }
      pageStart = nextStart;
    }
  }
  return [...new Map(trades.map((row) => [`${row.symbol}:${row.id}`, row])).values()];
}

function isBinanceInvalidSymbolError(error) {
  const message = String(error?.message || error || "");
  return message.includes("binance /fapi/v1/userTrades: HTTP 400: Invalid symbol.");
}

async function fetchBinance(env, startMs, endMs) {
  const realizedIncome = [];
  let incomePageStart = startMs;
  for (let page = 0; page < 20 && incomePageStart <= endMs; page += 1) {
    const rows = await binanceGet(env, "/fapi/v1/income", {
      incomeType: "REALIZED_PNL",
      startTime: incomePageStart,
      endTime: endMs,
      limit: 1000
    });
    realizedIncome.push(...rows);
    if (rows.length < 1000) break;
    const nextStart = Math.max(...rows.map((row) => Number(row.time))) + 1;
    if (!Number.isFinite(nextStart) || nextStart <= incomePageStart) break;
    incomePageStart = nextStart;
  }
  const symbols = [...new Set(realizedIncome.map((row) => row.symbol).filter(Boolean))];
  const historyStart = startMs - 90 * 24 * 60 * 60 * 1000;
  const tradeResults = await Promise.allSettled(
    symbols.map((symbol) => fetchBinanceTrades(env, historyStart, endMs, symbol))
  );
  const trades = [];
  for (const item of tradeResults) {
    if (item.status === "fulfilled") {
      trades.push(...item.value);
      continue;
    }
    if (isBinanceInvalidSymbolError(item.reason)) continue;
    throw item.reason;
  }
  const groups = new Map();
  for (const row of trades) {
    const key = `${row.symbol}:${row.positionSide || "BOTH"}:${row.orderId}`;
    const group = groups.get(key) || {
      symbol: row.symbol,
      positionSide: row.positionSide || "BOTH",
      orderId: row.orderId,
      time: 0,
      startTime: Number.POSITIVE_INFINITY,
      delta: 0,
      pnl: 0,
      fillQty: 0,
      fillNotional: 0,
      commissionPnl: 0
    };
    const quantity = Number(row.qty || 0);
    group.delta += row.buyer ? quantity : -quantity;
    group.pnl += Number(row.realizedPnl || 0);
    group.commissionPnl -= Number(row.commission || 0);
    group.fillQty += quantity;
    group.fillNotional += quantity * Number(row.price || 0);
    group.time = Math.max(group.time, Number(row.time || 0));
    group.startTime = Math.min(group.startTime, Number(row.time || 0));
    groups.set(key, group);
  }

  const result = [];
  const states = new Map();
  const orderedGroups = [...groups.values()].sort((a, b) => a.time - b.time);
  for (const group of orderedGroups) {
    const positionKey = `${group.symbol}:${group.positionSide}`;
    let state = states.get(positionKey) || {
      qty: 0,
      openedAt: 0,
      openQty: 0,
      entryNotional: 0,
      maxQty: 0,
      closedQty: 0,
      pnl: 0,
      reliable: true
    };
    const before = state.qty;
    const after = before + group.delta;
    const avgFillPrice = group.fillQty ? group.fillNotional / group.fillQty : 0;
    const tolerance = 1e-12;
    const opensOrAdds = Math.abs(before) <= tolerance || Math.sign(before) === Math.sign(group.delta);

    if (opensOrAdds) {
      if (Math.abs(before) <= tolerance) {
        state = { qty: 0, openedAt: group.startTime, openQty: 0, entryNotional: 0, maxQty: 0, closedQty: 0, pnl: 0, reliable: Math.abs(group.pnl) <= tolerance };
      }
      state.openQty += Math.abs(group.delta);
      state.entryNotional += Math.abs(group.delta) * avgFillPrice;
      state.qty = after;
      state.maxQty = Math.max(state.maxQty, Math.abs(after));
      state.pnl += group.pnl + group.commissionPnl;
      states.set(positionKey, state);
      continue;
    }

    const closingQty = Math.min(Math.abs(before), Math.abs(group.delta));
    state.closedQty += closingQty;
    state.pnl += group.pnl + group.commissionPnl;
    const fullyClosed = Math.abs(after) <= tolerance || Math.sign(before) !== Math.sign(after);
    if (fullyClosed) {
      if (state.reliable && group.time >= startMs && group.time <= endMs) {
        result.push(record({
          exchange: "binance",
          symbol: group.symbol,
          side: before > 0 ? "long" : "short",
          pnl: state.pnl,
          qty: state.maxQty,
          entryPrice: state.openQty ? state.entryNotional / state.openQty : 0,
          closePrice: avgFillPrice,
          openedAt: state.openedAt,
          closedAt: group.time,
          id: `${group.symbol}:${group.positionSide}:${group.time}`
        }));
      }
      const residual = Math.abs(after);
      state = residual > tolerance ? {
        qty: after,
        openedAt: group.startTime,
        openQty: residual,
        entryNotional: residual * avgFillPrice,
        maxQty: residual,
        closedQty: 0,
        pnl: 0,
        reliable: true
      } : { qty: 0, openedAt: 0, openQty: 0, entryNotional: 0, maxQty: 0, closedQty: 0, pnl: 0, reliable: true };
    } else {
      state.qty = after;
    }
    states.set(positionKey, state);
  }
  if (result.length) {
    const incomeStart = Math.min(...result.map((row) => row.openedAt || startMs));
    const fundingRows = [];
    for (const incomeType of ["FUNDING_FEE"]) {
      let pageStart = incomeStart;
      for (let page = 0; page < 20 && pageStart <= endMs; page += 1) {
        const rows = await binanceGet(env, "/fapi/v1/income", {
          incomeType,
          startTime: pageStart,
          endTime: endMs,
          limit: 1000
        });
        fundingRows.push(...rows);
        if (rows.length < 1000) break;
        const nextStart = Math.max(...rows.map((row) => Number(row.time))) + 1;
        if (!Number.isFinite(nextStart) || nextStart <= pageStart) break;
        pageStart = nextStart;
      }
    }
    for (const funding of fundingRows) {
      const time = Number(funding.time || 0);
      const candidates = result.filter((row) => row.symbol === funding.symbol && row.openedAt <= time && time <= row.closedAt);
      if (candidates.length !== 1) continue;
      const amount = Number(funding.income || 0);
      candidates[0].fundingPnl += amount;
      candidates[0].pnl += amount;
    }
  }
  return result;
}

async function bybitGet(env, endpoint, params) {
  const base = env.BYBIT_REST_BASE || "https://api.bybit.com";
  const query = queryString(params);
  const timestamp = String(Date.now());
  const recvWindow = "10000";
  const signature = hmacHex(env.BYBIT_API_SECRET, `${timestamp}${env.BYBIT_API_KEY}${recvWindow}${query}`);
  const response = await fetch(`${base}${endpoint}?${query}`, {
    headers: {
      "X-BAPI-API-KEY": env.BYBIT_API_KEY,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature
    }
  });
  const json = await readJson(response, `bybit ${endpoint}`);
  if (json.retCode !== 0) throw new Error(`bybit ${endpoint}: ${json.retCode} ${json.retMsg}`);
  return json;
}

async function fetchBybit(env, startMs, endMs) {
  const raw = [];
  const chunkMs = 6 * 24 * 60 * 60 * 1000;
  for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkMs) {
    const chunkEnd = Math.min(endMs, chunkStart + chunkMs - 1);
    let cursor = "";
    for (let page = 0; page < 50; page += 1) {
      const json = await bybitGet(env, "/v5/position/closed-pnl", {
        category: "linear",
        startTime: chunkStart,
        endTime: chunkEnd,
        limit: 100,
        cursor
      });
      const rows = json.result?.list || [];
      for (const row of rows) {
        const exitValue = Number(row.cumExitValue || 0);
        const exitPrice = Number(row.avgExitPrice || 0);
        const requestedQty = Number(row.qty || 0);
        const derivedQty = exitValue > 0 && exitPrice > 0 ? exitValue / exitPrice : requestedQty;
        const executedQty = requestedQty > 0 && Math.abs(derivedQty - requestedQty) / requestedQty <= 0.005
          ? requestedQty
          : Number(derivedQty.toFixed(8));
        raw.push(record({
          exchange: "bybit",
          symbol: row.symbol,
          side: String(row.side).toLowerCase() === "buy" ? "short" : "long",
          pnl: row.closedPnl,
          qty: executedQty,
          entryPrice: row.avgEntryPrice,
          closePrice: row.avgExitPrice,
          openedAt: 0,
          closedAt: row.updatedTime || row.createdTime,
          id: row.orderId
        }));
      }
      cursor = json.result?.nextPageCursor || "";
      if (!cursor || rows.length === 0) break;
    }
  }
  return mergeBybitClosedPositions(raw);
}

function nearlyEqual(left, right, tolerance = 0.0001) {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1e-12);
  return Math.abs(left - right) / scale <= tolerance;
}

export function mergeBybitClosedPositions(rows) {
  const ordered = [...rows].sort((left, right) => left.closedAt - right.closedAt);
  const groups = [];
  const activeBySymbol = new Map();
  for (const row of ordered) {
    const last = activeBySymbol.get(row.symbol);
    const previous = last?.rows.at(-1);
    const continues = previous && previous.side === row.side;
    if (continues) last.rows.push(row);
    else {
      const group = { rows: [row] };
      groups.push(group);
      activeBySymbol.set(row.symbol, group);
    }
  }

  return groups.map(({ rows: members }) => {
    if (members.length === 1) return members[0];
    const first = members[0];
    const last = members.at(-1);
    let exitNotional = 0;
    let exitQty = 0;
    for (let index = 0; index < members.length; index += 1) {
      const current = members[index];
      exitNotional += current.qty * current.closePrice;
      exitQty += current.qty;
    }
    return record({
      exchange: "bybit",
      symbol: first.symbol,
      side: first.side,
      pnl: members.reduce((sum, row) => sum + row.pnl, 0),
      qty: members.reduce((sum, row) => sum + row.qty, 0),
      entryPrice: exitQty
        ? members.reduce((sum, row) => sum + row.entryPrice * row.qty, 0) / exitQty
        : first.entryPrice,
      closePrice: exitQty ? exitNotional / exitQty : last.closePrice,
      openedAt: 0,
      closedAt: last.closedAt,
      id: `position:${members.map((row) => row.id).join("+")}`
    });
  });
}

async function bitgetGet(env, endpoint, params) {
  const base = env.BITGET_REST_BASE || "https://api.bitget.com";
  const query = queryString(params);
  const suffix = query ? `?${query}` : "";
  const timestamp = String(Date.now());
  const signature = hmacBase64(env.BITGET_API_SECRET, `${timestamp}GET${endpoint}${suffix}`);
  const response = await fetch(`${base}${endpoint}${suffix}`, {
    headers: {
      "ACCESS-KEY": env.BITGET_API_KEY,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": env.BITGET_API_PASSPHRASE,
      locale: "en-US"
    }
  });
  const json = await readJson(response, `bitget ${endpoint}`);
  if (json.code !== "00000") throw new Error(`bitget ${endpoint}: ${json.code} ${json.msg}`);
  return json;
}

async function fetchBitget(env, startMs, endMs) {
  const result = [];
  for (const productType of ["USDT-FUTURES", "USDC-FUTURES"]) {
    let idLessThan = "";
    for (let page = 0; page < 50; page += 1) {
      const json = await bitgetGet(env, "/api/v2/mix/position/history-position", {
        productType,
        startTime: startMs,
        endTime: endMs,
        limit: 100,
        idLessThan
      });
      const rows = json.data?.list || [];
      for (const row of rows) {
        result.push(record({
          exchange: "bitget",
          symbol: row.symbol,
          side: row.holdSide,
          pnl: row.netProfit,
          qty: row.closeTotalPos,
          entryPrice: row.openAvgPrice,
          closePrice: row.closeAvgPrice,
          openedAt: row.ctime,
          closedAt: row.utime,
          id: row.positionId
        }));
      }
      idLessThan = json.data?.endId || "";
      if (!idLessThan || rows.length === 0) break;
    }
  }
  return result;
}

async function mexcGet(env, endpoint, params) {
  const base = env.MEXC_REST_BASE || "https://contract.mexc.com";
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  const query = queryString(sorted);
  const requestTime = String(Date.now());
  const signature = hmacHex(env.MEXC_API_SECRET, `${env.MEXC_API_KEY}${requestTime}${query}`);
  const response = await fetch(`${base}${endpoint}?${query}`, {
    headers: {
      ApiKey: env.MEXC_API_KEY,
      "Request-Time": requestTime,
      Signature: signature,
      "Content-Type": "application/json"
    }
  });
  const json = await readJson(response, `mexc ${endpoint}`);
  if (!json.success) throw new Error(`mexc ${endpoint}: ${json.code} ${json.message || "failed"}`);
  return json;
}

async function fetchMexc(env, startMs, endMs) {
  const result = [];
  const base = env.MEXC_REST_BASE || "https://contract.mexc.com";
  const detailResponse = await fetch(`${base}/api/v1/contract/detail`);
  const detailJson = await readJson(detailResponse, "mexc contract detail");
  const contractSizes = new Map(
    (detailJson.data || []).map((item) => [String(item.symbol || ""), Number(item.contractSize || 1)])
  );
  for (let page = 1; page <= 50; page += 1) {
    const json = await mexcGet(env, "/api/v1/private/position/list/history_positions", {
      page_num: page,
      page_size: 100
    });
    const rows = Array.isArray(json.data) ? json.data : (json.data?.list || []);
    for (const row of rows) {
      const closedAt = normalizeTimestamp(row.updateTime);
      if (Number(row.state) === 3 && closedAt >= startMs && closedAt <= endMs) {
        const contracts = Number(row.closeVol || row.vol || row.holdVol || 0);
        result.push(record({
          exchange: "mexc",
          symbol: row.symbol,
          side: Number(row.positionType) === 1 ? "long" : "short",
          pnl: row.realised,
          qty: contracts * (contractSizes.get(String(row.symbol || "")) || 1),
          entryPrice: row.openAvgPrice,
          closePrice: row.closeAvgPrice,
          openedAt: row.createTime,
          closedAt,
          id: row.positionId
        }));
      }
    }
    if (rows.length < 100 || rows.every((row) => normalizeTimestamp(row.updateTime) < startMs)) break;
  }
  return result;
}

async function phemexGet(env, endpoint, params) {
  const base = env.PHEMEX_REST_BASE || "https://api.phemex.com";
  const query = queryString(params);
  const expiry = String(Math.floor(Date.now() / 1000) + 60);
  const signature = hmacHex(env.PHEMEX_API_SECRET, `${endpoint}${query}${expiry}`);
  const response = await fetch(`${base}${endpoint}?${query}`, {
    headers: {
      "x-phemex-access-token": env.PHEMEX_API_KEY,
      "x-phemex-request-expiry": expiry,
      "x-phemex-request-signature": signature
    }
  });
  const json = await readJson(response, `phemex ${endpoint}`);
  if (json.code !== 0) throw new Error(`phemex ${endpoint}: ${json.code} ${json.msg}`);
  return json;
}

async function fetchPhemex(env, startMs, endMs) {
  const result = [];
  const currency = env.PHEMEX_CURRENCY || "USDT";
  for (let offset = 0; offset < 5000; offset += 200) {
    const json = await phemexGet(env, "/api-data/g-futures/closedPosition", {
      currency,
      offset,
      limit: 200,
      withCount: true
    });
    const rows = json.data?.rows || [];
    for (const row of rows) {
      const closedAt = normalizeTimestamp(row.updatedTimeNs || row.updatedAt || row.closedTime);
      if (closedAt >= startMs && closedAt <= endMs) {
        result.push(record({
          exchange: "phemex",
          symbol: row.symbol,
          side: row.side === 1 || row.side === "Buy" ? "long" : "short",
          pnl: row.realizedPnlRv,
          qty: row.closedSizeRq,
          entryPrice: row.openPriceRp || row.openPrice,
          closePrice: row.closePriceRp || row.closePrice,
          openedAt: normalizeTimestamp(row.openedTimeNs || row.createdTimeNs || row.createdAt),
          closedAt,
          id: `${row.symbol}:${row.updatedTimeNs || row.updatedAt}:${row.closedSizeRq}`
        }));
      }
    }
    const total = Number(json.data?.total || 0);
    if (rows.length < 200 || offset + rows.length >= total || rows.every((row) => normalizeTimestamp(row.updatedTimeNs || row.updatedAt || row.closedTime) < startMs)) break;
  }
  return result;
}

async function hyperliquidInfo(env, body) {
  const base = env.HYPERLIQUID_REST_BASE || "https://api.hyperliquid.xyz";
  const response = await fetch(`${base}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson(response, `hyperliquid ${body.type}`);
}

async function fetchHyperliquidFunding(env, wallet, startMs, endMs) {
  const fundingRows = [];
  let pageStart = startMs;
  for (let page = 0; page < 100 && pageStart <= endMs; page += 1) {
    const rows = await hyperliquidInfo(env, {
      type: "userFunding", user: wallet, startTime: pageStart, endTime: endMs
    });
    if (!Array.isArray(rows)) throw new Error("userFunding returned invalid data");
    fundingRows.push(...rows);
    if (rows.length < 500) break;
    const nextStart = Math.max(...rows.map((row) => Number(row.time || 0))) + 1;
    if (!Number.isFinite(nextStart) || nextStart <= pageStart) {
      throw new Error("userFunding pagination did not advance");
    }
    pageStart = nextStart;
  }
  return fundingRows;
}

async function fetchHyperliquid(env, startMs, endMs) {
  const wallet = env.HYPERLIQUID_WALLET;
  if (!wallet) return [];
  const historyStart = startMs - 90 * 24 * 60 * 60 * 1000;
  const fills = [];
  let pageStart = historyStart;
  for (let page = 0; page < 20 && pageStart <= endMs; page += 1) {
    const rows = await hyperliquidInfo(env, {
      type: "userFillsByTime", user: wallet, startTime: pageStart, endTime: endMs, aggregateByTime: true
    });
    fills.push(...rows);
    if (rows.length < 2000) break;
    const nextStart = Math.max(...rows.map((row) => Number(row.time || 0))) + 1;
    if (!Number.isFinite(nextStart) || nextStart <= pageStart) break;
    pageStart = nextStart;
  }

  const states = new Map();
  const result = [];
  for (const fill of fills.sort((left, right) => Number(left.time) - Number(right.time))) {
    if (String(fill.coin || "").startsWith("@")) continue;
    const before = Number(fill.startPosition || 0);
    const size = Math.abs(Number(fill.sz || 0));
    const delta = String(fill.side).toUpperCase() === "B" ? size : -size;
    const after = before + delta;
    const tolerance = 1e-10;
    const coin = String(fill.coin || "");
    let state = states.get(coin);
    if (!state && Math.abs(before) > tolerance) {
      state = { qty: before, openedAt: historyStart, maxQty: Math.abs(before), entryQty: Math.abs(before),
        entryNotional: Math.abs(before) * Number(fill.px || 0), pnl: 0, reliable: false };
      states.set(coin, state);
    }
    if (!state || Math.abs(before) <= tolerance) {
      const openQty = Math.abs(after);
      state = { qty: after, openedAt: Number(fill.time || 0), maxQty: openQty, entryQty: openQty,
        entryNotional: openQty * Number(fill.px || 0), pnl: -Math.abs(Number(fill.fee || 0)), reliable: true };
      states.set(coin, state);
      continue;
    }
    if (Math.sign(before) === Math.sign(delta)) {
      state.entryQty += size;
      state.entryNotional += size * Number(fill.px || 0);
    }
    state.maxQty = Math.max(state.maxQty, Math.abs(after));
    state.pnl += Number(fill.closedPnl || 0) - Math.abs(Number(fill.fee || 0));
    state.qty = after;
    if (Math.abs(after) <= tolerance || Math.sign(before) !== Math.sign(after)) {
      const closedAt = Number(fill.time || 0);
      if (state.reliable && closedAt >= startMs && closedAt <= endMs) {
        result.push(record({ exchange: "hyperliquid", symbol: coin, side: before > 0 ? "long" : "short",
          pnl: state.pnl, qty: state.maxQty, entryPrice: state.entryQty ? state.entryNotional / state.entryQty : 0,
          closePrice: fill.px, openedAt: state.openedAt, closedAt,
          id: `${coin}:${fill.hash || fill.oid}:${closedAt}` }));
      }
      states.delete(coin);
    }
  }

  const fundingRows = await fetchHyperliquidFunding(env, wallet, historyStart, endMs);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const funding of fundingRows) {
    const time = Number(funding.time || 0);
    const coin = String(funding.delta?.coin || funding.coin || "");
    const candidates = result.filter((row) => {
      const openingDayStart = Math.floor(row.openedAt / dayMs) * dayMs;
      return row.symbol === coin && openingDayStart <= time && time <= row.closedAt;
    });
    if (candidates.length !== 1) continue;
    const amount = Number(funding.delta?.usdc ?? funding.usdc ?? 0);
    candidates[0].fundingPnl += amount;
    candidates[0].pnl += amount;
  }
  return result;
}

async function backpackSignedGet(env, endpoint, instruction, params = {}) {
  const base = env.BACKPACK_REST_BASE || "https://api.backpack.exchange";
  const timestamp = String(Date.now());
  const window = "60000";
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const payload = `instruction=${instruction}${query ? `&${query}` : ""}&timestamp=${timestamp}&window=${window}`;
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload), Buffer.from(env.BACKPACK_API_SECRET, "base64"))).toString("base64");
  const response = await fetch(`${base}${endpoint}${query ? `?${query}` : ""}`, { headers: {
    "X-API-Key": env.BACKPACK_API_KEY, "X-Signature": signature, "X-Timestamp": timestamp, "X-Window": window
  } });
  return readJson(response, `backpack ${endpoint}`);
}

function backpackSide(row) {
  const explicit = String(row.side || "").toLowerCase();
  if (["long", "short"].includes(explicit)) return explicit;
  const entry = Number(row.entryPrice || 0);
  const close = Number(row.closingPrice || 0);
  const pricePnl = Number(row.cumulativePnlRealized || 0);
  if (entry !== close && pricePnl !== 0) return Math.sign(close - entry) === Math.sign(pricePnl) ? "long" : "short";
  const volume = Number(row.closedVolume || row.netQuantity || 0);
  return volume < 0 ? "short" : "long";
}

async function fetchBackpack(env, startMs, endMs) {
  if (env.BACKPACK_HISTORY_PROXY_URL && env.WEEKLY_PNL_PROXY_SECRET) {
    const url = new URL(env.BACKPACK_HISTORY_PROXY_URL);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    const response = await fetch(url, { headers: { "x-weekly-pnl-secret": env.WEEKLY_PNL_PROXY_SECRET } });
    const json = await readJson(response, "backpack history proxy");
    if (!json.success || !Array.isArray(json.result)) throw new Error("backpack history proxy returned invalid data");
    return json.result.map((row) => record(row));
  }
  if (!env.BACKPACK_API_KEY || !env.BACKPACK_API_SECRET) return [];
  const positions = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const rows = await backpackSignedGet(env, "/wapi/v1/history/position", "positionHistoryQueryAll", {
      state: "Closed", limit: 1000, offset, sortDirection: "Desc"
    });
    positions.push(...rows);
    if (rows.length < 1000 || rows.every((row) => normalizeTimestamp(row.closedAt) < startMs)) break;
  }
  const selected = positions.filter((row) => {
    const closedAt = normalizeTimestamp(row.closedAt);
    return closedAt >= startMs && closedAt <= endMs;
  });
  if (!selected.length) return [];

  const settlementByPosition = new Map();
  const oldestOpen = Math.min(...selected.map((row) => normalizeTimestamp(row.openedAt) || startMs));
  for (let offset = 0; offset < 20000; offset += 1000) {
    const rows = await backpackSignedGet(env, "/wapi/v1/history/settlement", "settlementHistoryQueryAll", {
      limit: 1000, offset, sortDirection: "Desc"
    });
    for (const row of rows) {
      const positionId = String(row.positionId || "");
      if (!positionId) continue;
      const bucket = settlementByPosition.get(positionId) || [];
      bucket.push(row);
      settlementByPosition.set(positionId, bucket);
    }
    if (rows.length < 1000 || rows.every((row) => normalizeTimestamp(row.timestamp) < oldestOpen)) break;
  }

  return selected.map((row) => {
    const settlements = settlementByPosition.get(String(row.id || row.positionId || "")) || [];
    const netSettlement = settlements.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const fundingPnl = settlements.filter((item) => item.source === "FundingPayment")
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const fallbackPnl = Number(row.cumulativePnlRealized || 0) + Number(row.fundingQuantity || 0) - Math.abs(Number(row.fees || 0));
    return record({ exchange: "backpack", symbol: row.symbol, side: backpackSide(row),
      pnl: settlements.length ? netSettlement : fallbackPnl, pricePnl: row.cumulativePnlRealized, fundingPnl,
      qty: row.closedVolume || row.netExposureQuantity || row.netQuantity, entryPrice: row.entryPrice,
      closePrice: row.closingPrice, openedAt: row.openedAt, closedAt: row.closedAt,
      id: row.id || row.positionId });
  });
}

export function normalizePair(symbol) {
  const pair = String(symbol || "")
    .toUpperCase()
    .replace(/[-_/]?(PERP|IPERP)$/i, "")
    .replace(/(?:[-_/]?)(USDT|USDC|USD)$/i, "")
    .replace(/[-_/]?STOCK$/i, "")
    .replace(/[^A-Z0-9]/g, "");
  if (pair === "DATAIP") return "DATA";
  if (pair === "MONAD") return "MON";
  if (pair === "XTI" || pair === "CL") return "CL";
  if (pair === "PUMPFUN" || pair === "PUMP") return "PUMP";
  if (pair === "TRUMPOFFICIAL" || pair === "TRUMP") return "TRUMP";
  return pair;
}

function isOpposite(left, right) {
  return (left.side === "long" && right.side === "short") ||
    (left.side === "short" && right.side === "long");
}

function withinOneDay(left, right) {
  const dayMs = 24 * 60 * 60 * 1000;
  if (Math.abs(left.closedAt - right.closedAt) > dayMs) return false;
  return true;
}

function summarizeMatched(records) {
  const groups = new Map();
  for (const row of records) {
    const pair = normalizePair(row.symbol);
    if (!pair || !["long", "short"].includes(row.side) || !(row.qty > 0)) continue;
    const bucket = groups.get(pair) || [];
    bucket.push({ ...row, pair });
    groups.set(pair, bucket);
  }

  const clusters = [];
  const unmatched = [];
  for (const [pair, rows] of groups) {
    const adjacent = rows.map(() => []);
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        if (rows[left].exchange === rows[right].exchange) continue;
        if (!isOpposite(rows[left], rows[right]) || !withinOneDay(rows[left], rows[right])) continue;
        adjacent[left].push(right);
        adjacent[right].push(left);
      }
    }

    const seen = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      if (seen.has(index)) continue;
      const stack = [index];
      const indexes = [];
      seen.add(index);
      while (stack.length) {
        const current = stack.pop();
        indexes.push(current);
        for (const next of adjacent[current]) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      const members = indexes.map((memberIndex) => rows[memberIndex]);
      const longQty = members.filter((row) => row.side === "long").reduce((sum, row) => sum + row.qty, 0);
      const shortQty = members.filter((row) => row.side === "short").reduce((sum, row) => sum + row.qty, 0);
      const exchanges = new Set(members.map((row) => row.exchange));
      const mismatch = Math.max(longQty, shortQty) > 0
        ? Math.abs(longQty - shortQty) / Math.max(longQty, shortQty)
        : 1;
      if (members.length >= 2 && exchanges.size >= 2 && longQty > 0 && shortQty > 0 && mismatch <= 0.005) {
        const longNotional = members.filter((row) => row.side === "long")
          .reduce((sum, row) => sum + row.qty * row.entryPrice, 0);
        const shortNotional = members.filter((row) => row.side === "short")
          .reduce((sum, row) => sum + row.qty * row.entryPrice, 0);
        const positiveNotionals = [longNotional, shortNotional].filter((value) => value > 0);
        clusters.push({
          pair,
          records: members,
          longQty,
          shortQty,
          qtyMismatch: mismatch,
          position: positiveNotionals.length ? Math.min(...positiveNotionals) : 0,
          pnl: members.reduce((sum, row) => sum + row.pnl, 0)
        });
      } else {
        unmatched.push(...members.map((row) => ({
          exchange: row.exchange,
          pair,
          side: String(row.side).toLowerCase() === "buy" ? "short" : "long",
          qty: row.qty,
          openedAt: row.openedAt,
          closedAt: row.closedAt,
          reason: adjacent[index].length ? `quantity mismatch ${(mismatch * 100).toFixed(3)}%` : "no opposite leg within time tolerance"
        })));
      }
    }
  }

  const matchedRecords = clusters.flatMap((cluster) => cluster.records);
  const byExchange = {};
  for (const exchange of Object.keys(fetchers)) {
    const rows = matchedRecords.filter((row) => row.exchange === exchange);
    const directions = new Set(rows.map((row) => row.side));
    byExchange[exchange] = {
      count: rows.length,
      pnl: rows.reduce((sum, row) => sum + row.pnl, 0),
      direction: directions.size > 1 ? "long/short" : (rows[0]?.side || "")
    };
  }
  const totalPnl = clusters.reduce((sum, cluster) => sum + cluster.pnl, 0);
  const position = clusters.reduce((sum, cluster) => sum + cluster.position, 0);
  const latestRecord = matchedRecords.reduce((latest, row) => !latest || row.closedAt > latest.closedAt ? row : latest, null);
  return {
    pairs: [...new Set(clusters.map((cluster) => cluster.pair))],
    clusters,
    matchedRecords,
    unmatched,
    byExchange,
    totalPnl,
    position,
    pnlPct: position > 0 ? totalPnl / position : null,
    latestRecord
  };
}

const fetchers = {
  binance: fetchBinance,
  bybit: fetchBybit,
  bitget: fetchBitget,
  mexc: fetchMexc,
  phemex: fetchPhemex,
  backpack: fetchBackpack,
  hyperliquid: fetchHyperliquid
};

export async function fetchWeeklyPnl({ env = process.env, startMs, endMs = Date.now() }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("Invalid weekly PnL time range");
  }

  const settled = await Promise.allSettled(
    Object.entries(fetchers).map(async ([exchange, fetcher]) => {
      try {
        return [exchange, await fetcher(env, startMs, endMs)];
      } catch (error) {
        const cause = error?.cause?.code || error?.cause?.message || "";
        throw new Error(`${exchange}: ${error?.message || error}${cause ? ` (${cause})` : ""}`);
      }
    })
  );

  const records = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === "fulfilled") records.push(...item.value[1]);
    else errors.push(String(item.reason?.message || item.reason));
  }

  const deduped = [...new Map(records.map((item) => [`${item.exchange}:${item.id}`, item])).values()]
    .filter((item) => Number.isFinite(item.pnl) && item.closedAt >= startMs && item.closedAt <= endMs)
    .sort((a, b) => a.closedAt - b.closedAt || a.exchange.localeCompare(b.exchange));

  const rawByExchange = {};
  for (const exchange of Object.keys(fetchers)) {
    const rows = deduped.filter((item) => item.exchange === exchange);
    rawByExchange[exchange] = {
      count: rows.length,
      pnl: rows.reduce((sum, item) => sum + item.pnl, 0)
    };
  }

  const matched = summarizeMatched(deduped);

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    totalPnl: matched.totalPnl,
    count: matched.matchedRecords.length,
    position: matched.position,
    pnlPct: matched.pnlPct,
    pairs: matched.pairs,
    latestRecord: matched.latestRecord,
    byExchange: matched.byExchange,
    clusters: matched.clusters,
    unmatched: matched.unmatched,
    rawByExchange,
    records: deduped,
    errors
  };
}
