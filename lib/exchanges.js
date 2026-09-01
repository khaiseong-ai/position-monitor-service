import crypto from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { makeOrder, makePosition, numberValue, normalizeSymbol } from "./position-utils.js";

function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function hmacBase64(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== "")).toString();
}

async function readJson(response, label) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON: ${text.slice(0, 180)}`);
  }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return json;
}

function requireKeys(name, config, keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) return { ok: false, reason: `${name}: missing ${missing.join(", ")}` };
  return { ok: true };
}

export async function fetchAllPositions(config, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((name) => String(name).toLowerCase()));
  const tasks = [
    ["binance", () => fetchBinance(config.exchanges.binance)],
    ["mexc", () => fetchMexc(config.exchanges.mexc)],
    ["bybit", () => fetchBybit(config.exchanges.bybit)],
    ["bitget", () => fetchBitget(config.exchanges.bitget)],
    ["phemex", () => fetchPhemex(config.exchanges.phemex)],
    ["hyperliquid", () => fetchHyperliquid(config.exchanges.hyperliquid)],
    ["backpack", () => fetchBackpack(config.exchanges.backpack)]
  ].filter(([name]) => !excluded.has(name));

  const settled = await Promise.allSettled(tasks.map(async ([name, fn]) => {
    try {
      return { name, positions: await fn() };
    } catch (error) {
      throw new Error(`${name}: ${error.message || String(error)}`, { cause: error });
    }
  }));
  const positions = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      positions.push(...item.value.positions);
    } else {
      errors.push(formatExchangeError(item.reason));
    }
  }
  return { positions, errors };
}

export async function fetchAllOrders(config, positions = [], { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((name) => String(name).toLowerCase()));
  const tasks = [
    ["binance_orders", () => fetchBinanceOrders(config.exchanges.binance)],
    ["mexc_orders", () => fetchMexcOrders(config.exchanges.mexc)],
    ["bybit_orders", () => fetchBybitOrders(config.exchanges.bybit)],
    ["bitget_orders", () => fetchBitgetOrders(config.exchanges.bitget)],
    ["phemex_orders", () => fetchPhemexOrders(config.exchanges.phemex, positions)],
    ["hyperliquid_orders", () => fetchHyperliquidOrders(config.exchanges.hyperliquid, positions)],
    ["backpack_orders", () => fetchBackpackOrders(config.exchanges.backpack)]
  ].filter(([name]) => !excluded.has(name.replace(/_orders$/, "")));

  const settled = await Promise.allSettled(tasks.map(async ([name, fn]) => {
    try {
      return { name, orders: await fn() };
    } catch (error) {
      throw new Error(`${name}: ${error.message || String(error)}`, { cause: error });
    }
  }));
  const orders = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      orders.push(...item.value.orders);
    } else {
      errors.push(formatExchangeError(item.reason));
    }
  }
  return { orders, errors };
}

function formatExchangeError(error) {
  const message = error?.message || String(error);
  const cause = error?.cause?.message || error?.cause?.code;
  return cause ? `${message}: ${cause}` : message;
}

export async function fetchBinance(config) {
  const gate = requireKeys("binance", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const params = { timestamp: Date.now(), recvWindow: 5000 };
  const query = qs(params);
  const signature = hmacHex(config.apiSecret, query);
  const response = await fetch(`${config.restBase}/fapi/v3/positionRisk?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": config.apiKey }
  });
  const json = await readJson(response, "binance positions");
  return json.map((row) => {
    const amount = numberValue(row.positionAmt);
    return makePosition({
      symbol: row.symbol,
      source: "binance",
      side: amount > 0 ? "long" : "short",
      size: amount,
      price: row.markPrice,
      raw: row
    });
  }).filter(Boolean);
}

export async function fetchBinanceOrders(config) {
  const gate = requireKeys("binance", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const openOrders = await binanceSignedGet(config, "/fapi/v1/openOrders");
  const algoOrders = await binanceSignedGet(config, "/fapi/v1/openAlgoOrders").catch(() => []);
  return [...openOrders, ...asArray(algoOrders)].map((row) => makeOrder({
    symbol: row.symbol,
    source: "binance",
    side: row.side,
    size: row.origQty || row.quantity || row.qty,
    price: row.price,
    triggerPrice: row.stopPrice || row.triggerPrice,
    type: row.type || row.algoType,
    status: row.status || row.orderStatus,
    raw: row
  })).filter(Boolean);
}

async function binanceSignedGet(config, path, params = {}) {
  const query = qs({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const signature = hmacHex(config.apiSecret, query);
  const response = await fetch(`${config.restBase}${path}?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": config.apiKey }
  });
  return readJson(response, `binance ${path}`);
}

export async function fetchMexc(config) {
  const gate = requireKeys("mexc", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const [positionsJson, tickerPrices, contractSizes] = await Promise.all([
    mexcGet(config, "/api/v1/private/position/open_positions"),
    fetchMexcTickerPrices(config),
    fetchMexcContractSizes(config)
  ]);
  return (positionsJson.data || []).map((row) => {
    const symbol = normalizeSymbol(row.symbol);
    const exactSymbol = String(row.symbol || "").toUpperCase();
    const multiplier = contractSizes.get(exactSymbol) || config.sizeMultipliers?.[symbol] || 1;
    return makePosition({
      symbol: row.symbol,
      source: "mexc",
      side: Number(row.positionType) === 1 ? "long" : "short",
      size: numberValue(row.holdVol) * multiplier,
      price: tickerPrices.get(exactSymbol) || tickerPrices.get(symbol) || row.lastPrice || row.fairPrice || row.markPrice || row.indexPrice,
      raw: row
    });
  }).filter(Boolean);
}

async function fetchMexcContractSizes(config) {
  const response = await fetch(`${config.restBase}/api/v1/contract/detail`);
  const json = await readJson(response, "mexc contract detail");
  const rows = Array.isArray(json.data) ? json.data : [];
  const sizes = new Map();
  for (const row of rows) {
    const exactSymbol = String(row.symbol || "").toUpperCase();
    const contractSize = numberValue(row.contractSize);
    if (exactSymbol && contractSize > 0) sizes.set(exactSymbol, contractSize);
  }
  return sizes;
}

async function fetchMexcTickerPrices(config) {
  const response = await fetch(`${config.restBase}/api/v1/contract/ticker`);
  const json = await readJson(response, "mexc ticker");
  const rows = Array.isArray(json.data) ? json.data : [];
  const prices = new Map();
  for (const row of rows) {
    const exactSymbol = String(row.symbol || "").toUpperCase();
    const symbol = normalizeSymbol(row.symbol);
    const price = numberValue(row.lastPrice) || numberValue(row.fairPrice) || numberValue(row.indexPrice);
    if (exactSymbol && price > 0) prices.set(exactSymbol, price);
    if (symbol && price > 0 && !prices.has(symbol)) prices.set(symbol, price);
  }
  return prices;
}

export async function fetchMexcOrders(config) {
  const gate = requireKeys("mexc", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const positionsJson = await mexcGet(config, "/api/v1/private/position/open_positions");
  const symbols = [...new Set((positionsJson.data || []).map((row) => row.symbol).filter(Boolean))];
  const all = [];
  for (const symbol of symbols) {
    const open = await mexcGet(config, `/api/v1/private/order/list/open_orders/${encodeURIComponent(symbol)}`).catch(() => ({ data: [] }));
    const plan = await mexcGet(config, "/api/v1/private/planorder/list/orders", { symbol, states: "1", page_num: 1, page_size: 100 }).catch(() => ({ data: [] }));
    const stop = await mexcGet(config, "/api/v1/private/stoporder/list/orders", { symbol, is_finished: 0, page_num: 1, page_size: 100 }).catch(() => ({ data: [] }));
    all.push(...(open.data || []));
    all.push(...mexcOrderList(plan.data));
    all.push(...mexcStopOrders(stop.data));
  }
  return all.map((row) => makeOrder({
    symbol: row.symbol,
    source: "mexc",
    side: Number(row.side) === 1 || Number(row.side) === 4 ? "buy" : "sell",
    size: row.vol,
    price: row.price,
    triggerPrice: row.triggerPrice,
    type: row.orderType || row.type,
    status: row.state,
    raw: row
  })).filter(Boolean);
}

function mexcOrderList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.resultList)) return data.resultList;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.orders)) return value.orders;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function mexcStopOrders(data) {
  return mexcOrderList(data).flatMap((row) => {
    const side = Number(row.positionType) === 1 ? "sell" : "buy";
    return [
      makeOrder({
        symbol: row.symbol,
        source: "mexc",
        side,
        size: row.vol || row.realityVol,
        triggerPrice: row.takeProfitPrice,
        type: "stoporder_take_profit",
        status: row.state,
        raw: row
      }),
      makeOrder({
        symbol: row.symbol,
        source: "mexc",
        side,
        size: row.vol || row.realityVol,
        triggerPrice: row.stopLossPrice,
        type: "stoporder_stop_loss",
        status: row.state,
        raw: row
      })
    ].filter(Boolean);
  });
}

async function mexcGet(config, path, params = {}) {
  const requestParam = qs(Object.fromEntries(Object.entries(params).sort()));
  const requestTime = String(Date.now());
  const signature = hmacHex(config.apiSecret, `${config.apiKey}${requestTime}${requestParam}`);
  const url = `${config.restBase}${path}${requestParam ? `?${requestParam}` : ""}`;
  const response = await fetch(url, {
    headers: {
      ApiKey: config.apiKey,
      "Request-Time": requestTime,
      Signature: signature,
      "Content-Type": "application/json"
    }
  });
  return readJson(response, "mexc positions");
}

export async function fetchBybit(config) {
  const gate = requireKeys("bybit", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const all = [];
  for (const settleCoin of config.settleCoins) {
    const json = await bybitGet(config, "/v5/position/list", { category: "linear", settleCoin });
    all.push(...(json.result?.list || []));
  }
  return all.map((row) => makePosition({
    symbol: row.symbol,
    source: "bybit",
    side: row.side === "Buy" ? "long" : "short",
    size: row.size,
    price: row.markPrice,
    raw: row
  })).filter(Boolean);
}

export async function fetchBybitOrders(config) {
  const gate = requireKeys("bybit", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const all = [];
  const filters = ["Order", "StopOrder", "tpslOrder"];
  for (const settleCoin of config.settleCoins) {
    for (const orderFilter of filters) {
      const json = await bybitGet(config, "/v5/order/realtime", { category: "linear", settleCoin, orderFilter, limit: 50 }).catch(() => ({ result: { list: [] } }));
      all.push(...(json.result?.list || []));
    }
  }
  return all.map((row) => makeOrder({
    symbol: row.symbol,
    source: "bybit",
    side: row.side,
    size: row.qty,
    price: row.price,
    triggerPrice: row.triggerPrice,
    type: row.orderType || row.stopOrderType,
    status: row.orderStatus,
    raw: row
  })).filter(Boolean);
}

async function bybitGet(config, path, params) {
  const query = qs(params);
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const signature = hmacHex(config.apiSecret, `${timestamp}${config.apiKey}${recvWindow}${query}`);
  const response = await fetch(`${config.restBase}${path}?${query}`, {
    headers: {
      "X-BAPI-API-KEY": config.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature
    }
  });
  const json = await readJson(response, "bybit positions");
  if (json.retCode !== 0) throw new Error(`bybit positions error: ${json.retCode} ${json.retMsg}`);
  return json;
}

export async function fetchBitget(config) {
  const gate = requireKeys("bitget", config, ["apiKey", "apiSecret", "passphrase"]);
  if (!gate.ok) return [];
  const params = { productType: config.productType, marginCoin: config.marginCoin };
  const query = qs(params);
  const path = "/api/v2/mix/position/all-position";
  const timestamp = String(Date.now());
  const signature = hmacBase64(config.apiSecret, `${timestamp}GET${path}?${query}`);
  const response = await fetch(`${config.restBase}${path}?${query}`, {
    headers: {
      "ACCESS-KEY": config.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": config.passphrase,
      locale: "en-US"
    }
  });
  const json = await readJson(response, "bitget positions");
  if (json.code && json.code !== "00000") throw new Error(`bitget positions error: ${json.code} ${json.msg}`);
  return (json.data || []).map((row) => makePosition({
    symbol: row.symbol,
    source: "bitget",
    side: row.holdSide,
    size: row.total || row.available || row.openDelegateSize,
    price: row.markPrice,
    raw: row
  })).filter(Boolean);
}

export async function fetchBitgetOrders(config) {
  const gate = requireKeys("bitget", config, ["apiKey", "apiSecret", "passphrase"]);
  if (!gate.ok) return [];
  const normal = await bitgetSignedGet(config, "/api/v2/mix/order/orders-pending", {
    productType: config.productType
  }).catch(() => ({ data: { entrustedList: [] } }));
  const planTypes = ["normal_plan", "profit_loss", "profit_plan", "loss_plan", "pos_profit", "pos_loss", "moving_plan"];
  const planResults = await Promise.all(planTypes.map((planType) =>
    bitgetSignedGet(config, "/api/v2/mix/order/orders-plan-pending", {
      productType: config.productType,
      planType
    }).catch(() => ({ data: { entrustedList: [] } }))
  ));
  const tpslResults = await Promise.all(planTypes.map((planType) =>
    bitgetSignedGet(config, "/api/v2/mix/order/orders-tpsl-pending", {
      productType: config.productType,
      planType
    }).catch(() => ({ data: { entrustedList: [] } }))
  ));
  const rows = [
    ...bitgetOrderList(normal.data),
    ...planResults.flatMap((result) => bitgetOrderList(result.data)),
    ...tpslResults.flatMap((result) => bitgetOrderList(result.data))
  ];
  return rows.map((row) => makeOrder({
    symbol: row.symbol,
    source: "bitget",
    side: row.side || row.tradeSide,
    size: row.size || row.baseVolume,
    price: row.price,
    triggerPrice: row.triggerPrice || row.executePrice,
    type: row.orderType || row.planType,
    status: row.status,
    raw: row
  })).filter(Boolean);
}

function bitgetOrderList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entrustedList)) return data.entrustedList;
  if (Array.isArray(data?.orderList)) return data.orderList;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

async function bitgetSignedGet(config, path, params = {}) {
  const query = qs(params);
  const timestamp = String(Date.now());
  const suffix = query ? `?${query}` : "";
  const signature = hmacBase64(config.apiSecret, `${timestamp}GET${path}${suffix}`);
  const response = await fetch(`${config.restBase}${path}${suffix}`, {
    headers: {
      "ACCESS-KEY": config.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": config.passphrase,
      locale: "en-US"
    }
  });
  const json = await readJson(response, `bitget ${path}`);
  if (json.code && json.code !== "00000") throw new Error(`bitget ${path} error: ${json.code} ${json.msg}`);
  return json;
}

export async function fetchPhemex(config) {
  const gate = requireKeys("phemex", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const path = "/g-accounts/accountPositions";
  const query = qs({ currency: config.currency });
  const expiry = String(Math.floor(Date.now() / 1000) + 60);
  const signature = hmacHex(config.apiSecret, `${path}${query}${expiry}`);
  const response = await fetch(`${config.restBase}${path}?${query}`, {
    headers: {
      "x-phemex-access-token": config.apiKey,
      "x-phemex-request-expiry": expiry,
      "x-phemex-request-signature": signature
    }
  });
  const json = await readJson(response, "phemex positions");
  if (json.code !== 0) throw new Error(`phemex positions error: ${json.code} ${json.msg}`);
  return (json.data?.positions || []).map((row) => makePosition({
    symbol: row.symbol,
    source: "phemex",
    side: String(row.posSide || row.side).toLowerCase().startsWith("long") || row.side === "Buy" ? "long" : "short",
    size: row.sizeRq || row.size,
    price: row.markPriceRv || row.markPrice || row.avgEntryPriceRv,
    raw: row
  })).filter(Boolean);
}

export async function fetchPhemexOrders(config, positions = []) {
  const gate = requireKeys("phemex", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const symbols = [...new Set(
    positions
      .filter((position) => position.source === "phemex")
      .map((position) => position.raw?.symbol)
      .filter(Boolean)
  )];
  const all = [];
  let stopActiveOrderLookup = false;
  for (const symbol of symbols) {
    if (stopActiveOrderLookup) break;
    const json = await phemexGet(config, "/g-orders/activeList", { currency: config.currency, symbol }).catch((error) => {
      const message = String(error.message || error);
      if (message.includes("OM_ORDER_NOT_FOUND")) return { data: { rows: [] } };
      if (message.includes("Too many requests")) {
        stopActiveOrderLookup = true;
        return { data: { rows: [] } };
      }
      throw error;
    });
    all.push(...(json.data?.rows || json.data || []));
  }
  const rows = all;
  return rows.map((row) => makeOrder({
    symbol: row.symbol,
    source: "phemex",
    side: row.side,
    size: row.orderQtyRq || row.orderQty,
    price: row.priceRp || row.price,
    triggerPrice: row.stopPxRp || row.triggerPriceRp || row.triggerPrice,
    type: row.ordType || row.orderType,
    status: row.ordStatus || row.status,
    raw: row
  })).filter(Boolean);
}

async function phemexGet(config, path, params = {}) {
  const query = qs(params);
  const expiry = String(Math.floor(Date.now() / 1000) + 60);
  const signature = hmacHex(config.apiSecret, `${path}${query}${expiry}`);
  const response = await fetch(`${config.restBase}${path}${query ? `?${query}` : ""}`, {
    headers: {
      "x-phemex-access-token": config.apiKey,
      "x-phemex-request-expiry": expiry,
      "x-phemex-request-signature": signature
    }
  });
  const json = await readJson(response, `phemex ${path}`);
  if (json.code !== 0) throw new Error(`phemex ${path} error: ${json.code} ${json.msg}`);
  return json;
}

export async function fetchHyperliquid(config) {
  if (!config.wallet) return [];
  const states = await Promise.all(hyperliquidDexes(config).map((dex) =>
    hyperliquidInfo(config, { type: "clearinghouseState", user: config.wallet, ...(dex ? { dex } : {}) })
  ));
  return states.flatMap((json) => json.assetPositions || []).map((item) => {
    const pos = item.position || item;
    const szi = numberValue(pos.szi);
    const markPrice = szi ? Math.abs(numberValue(pos.positionValue) / szi) : 0;
    return makePosition({
      symbol: pos.coin,
      source: "hyperliquid",
      side: szi > 0 ? "long" : "short",
      size: szi,
      price: markPrice || pos.entryPx,
      raw: item
    });
  }).filter(Boolean);
}

export async function fetchHyperliquidOrders(config, positions = []) {
  if (!config.wallet) return [];
  const rows = (await Promise.all(hyperliquidDexes(config).map((dex) =>
    hyperliquidInfo(config, { type: "frontendOpenOrders", user: config.wallet, ...(dex ? { dex } : {}) })
  ))).flat();
  const sizeBySymbol = new Map(
    positions.filter((position) => position.source === "hyperliquid")
      .map((position) => [normalizeSymbol(position.symbol), position.size])
  );
  return rows.map((row) => makeOrder({
    symbol: row.coin,
    source: "hyperliquid",
    side: row.side === "B" ? "buy" : "sell",
    size: numberValue(row.sz || row.origSz) || sizeBySymbol.get(normalizeSymbol(row.coin)),
    price: row.limitPx,
    triggerPrice: row.triggerPx,
    type: row.orderType || (row.isTrigger ? "trigger" : "limit"),
    status: "open",
    raw: row
  })).filter(Boolean);
}

function hyperliquidDexes(config) {
  return ["", ...(config.dexes || [])].filter((dex, index, values) => values.indexOf(dex) === index);
}

async function hyperliquidInfo(config, body) {
  const response = await fetch(`${config.restBase}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson(response, `hyperliquid ${body.type}${body.dex ? ` ${body.dex}` : ""}`);
}

export async function fetchBackpack(config) {
  const hasDirectCredentials = Boolean(config.apiKey && config.apiSecret);
  if (!hasDirectCredentials && config.proxyUrl) {
    const json = await fetchBackpackProxy(config.proxyUrl);
    return asArray(json.result).filter((row) => row.source === "backpack").map((row) => makePosition({
      symbol: row.symbol || row.rawSymbol,
      source: "backpack",
      side: row.side,
      size: row.positionSize,
      price: row.currentPrice,
      raw: row
    })).filter(Boolean);
  }
  const gate = requireKeys("backpack", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const rows = await backpackSignedGet(config, "/api/v1/position", "positionQuery");
  return asArray(rows).map((row) => {
    const quantity = numberValue(row.netQuantity ?? row.netExposureQuantity);
    return makePosition({
      symbol: row.symbol,
      source: "backpack",
      side: quantity < 0 ? "short" : "long",
      size: quantity,
      price: row.markPrice,
      raw: row
    });
  }).filter(Boolean);
}

export async function fetchBackpackOrders(config) {
  const hasDirectCredentials = Boolean(config.apiKey && config.apiSecret);
  if (!hasDirectCredentials && config.proxyUrl) {
    const json = await fetchBackpackProxy(config.proxyUrl);
    return asArray(json.result)
      .filter((row) => row.source === "backpack")
      .flatMap((row) => asArray(row.tpSlClose).map((order) => makeOrder({
        symbol: row.symbol || row.rawSymbol,
        source: "backpack",
        side: order.side,
        size: order.amount || row.positionSize,
        price: order.price || order.limitPrice,
        triggerPrice: order.triggerPrice,
        type: order.kind || order.orderType,
        status: "open",
        raw: order
      })).filter(Boolean));
  }
  const gate = requireKeys("backpack", config, ["apiKey", "apiSecret"]);
  if (!gate.ok) return [];
  const rows = await backpackSignedGet(config, "/api/v1/orders", "orderQueryAll");
  return asArray(rows).flatMap((row) => {
    const common = {
      symbol: row.symbol,
      source: "backpack",
      side: row.side === "Bid" ? "buy" : row.side === "Ask" ? "sell" : row.side,
      size: row.triggerQuantity || row.quantity,
      status: row.status,
      raw: row
    };
    return [
      makeOrder({ ...common, price: row.price, triggerPrice: row.triggerPrice, type: row.orderType }),
      makeOrder({ ...common, price: row.takeProfitLimitPrice, triggerPrice: row.takeProfitTriggerPrice, type: "take_profit" }),
      makeOrder({ ...common, price: row.stopLossLimitPrice, triggerPrice: row.stopLossTriggerPrice, type: "stop_loss" })
    ].filter(Boolean);
  });
}

async function backpackSignedGet(config, path, instruction, params = {}) {
  const timestamp = String(Date.now());
  const window = "60000";
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(value) ? JSON.stringify(value) : value)}`)
    .join("&");
  const payload = `instruction=${instruction}${query ? `&${query}` : ""}&timestamp=${timestamp}&window=${window}`;
  const signature = Buffer
    .from(ed25519.sign(Buffer.from(payload), Buffer.from(config.apiSecret, "base64")))
    .toString("base64");
  const response = await fetch(`${config.restBase}${path}${query ? `?${query}` : ""}`, {
    headers: {
      "X-API-Key": config.apiKey,
      "X-Signature": signature,
      "X-Timestamp": timestamp,
      "X-Window": window
    }
  });
  return readJson(response, `backpack ${path}`);
}

let backpackProxyCache = { url: "", expiresAt: 0, promise: null };

async function fetchBackpackProxy(url) {
  const now = Date.now();
  if (backpackProxyCache.url === url && backpackProxyCache.promise && now < backpackProxyCache.expiresAt) {
    return backpackProxyCache.promise;
  }
  const promise = fetch(url, { signal: AbortSignal.timeout(120000) })
    .then((response) => readJson(response, "backpack funding proxy"))
    .then((json) => {
      if (!json.success || !Array.isArray(json.result)) throw new Error("backpack funding proxy returned an invalid result");
      return json;
    });
  backpackProxyCache = { url, expiresAt: now + 60000, promise };
  try {
    return await promise;
  } catch (error) {
    backpackProxyCache = { url: "", expiresAt: 0, promise: null };
    throw error;
  }
}

export async function createBinanceListenKey(config) {
  const gate = requireKeys("binance", config, ["apiKey"]);
  if (!gate.ok) throw new Error(gate.reason);
  const response = await fetch(`${config.restBase}/fapi/v1/listenKey`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": config.apiKey }
  });
  const json = await readJson(response, "binance listenKey");
  return json.listenKey;
}

export async function keepAliveBinanceListenKey(config, listenKey) {
  await fetch(`${config.restBase}/fapi/v1/listenKey?listenKey=${encodeURIComponent(listenKey)}`, {
    method: "PUT",
    headers: { "X-MBX-APIKEY": config.apiKey }
  });
}
