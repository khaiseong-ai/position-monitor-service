export function normalizeSymbol(symbol) {
  let raw = String(symbol || "").trim().toUpperCase();
  if (raw.includes(":") && !raw.includes("/")) {
    raw = raw.split(":").pop();
  }

  let normalized = raw
    .trim()
    .replace(/[-_/]/g, "");

  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/(STOCK|USDT|USDC|USD|PERP|SWAP)$/u, "");
  }

  const aliases = {
    BROCCOLI714: "BROCCOLI",
    CL: "XTI",
    MONAD: "MON",
    PUMPFUN: "PUMP"
  };

  return aliases[normalized] || normalized;
}

export function numberValue(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function makePosition({ symbol, source, side, size, price = 0, raw }) {
  const cleanSide = String(side || "").toLowerCase();
  if (!["long", "short"].includes(cleanSide)) return null;
  const cleanSize = Math.abs(numberValue(size));
  if (!symbol || cleanSize === 0) return null;
  return {
    symbol: normalizeSymbol(symbol),
    source,
    side: cleanSide,
    size: cleanSize,
    price: numberValue(price),
    raw
  };
}

export function analyzePositions(positions, tolerance = 0) {
  const groups = new Map();
  for (const position of positions) {
    if (!groups.has(position.symbol)) {
      groups.set(position.symbol, { symbol: position.symbol, long: 0, short: 0, rows: [] });
    }
    const group = groups.get(position.symbol);
    group[position.side] += position.size;
    group.rows.push(position);
  }

  const alerts = [];
  for (const group of groups.values()) {
    const long = round(group.long);
    const short = round(group.short);
    const hasLong = long > 0;
    const hasShort = short > 0;
    const diff = round(Math.abs(long - short));
    const effectiveTolerance = Math.max(Number(tolerance) || 0, 1e-8);
    if (!hasLong || !hasShort || diff > effectiveTolerance) {
      alerts.push({
        symbol: group.symbol,
        reason: !hasLong || !hasShort ? "single_leg" : "imbalanced_size",
        long,
        short,
        diff,
        rows: group.rows
      });
    }
  }

  alerts.sort((a, b) => b.diff - a.diff || a.symbol.localeCompare(b.symbol));
  return { groups: [...groups.values()], alerts };
}

export function alertSignature(alerts) {
  return alerts
    .map((item) => `${item.symbol}:${item.reason}:${round(item.long)}:${round(item.short)}`)
    .sort()
    .join("|");
}

export function formatSize(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function makeOrder({ symbol, source, side, size, price, triggerPrice, type, status, raw }) {
  if (!symbol) return null;
  const orderPrice = numberValue(triggerPrice) || numberValue(price);
  if (!orderPrice) return null;
  return {
    symbol: normalizeSymbol(symbol),
    source,
    side: String(side || "").toLowerCase(),
    size: Math.abs(numberValue(size)),
    price: numberValue(price),
    triggerPrice: numberValue(triggerPrice),
    watchPrice: orderPrice,
    type: String(type || ""),
    status: String(status || ""),
    raw
  };
}

export function analyzeOrders(positions, orders, ignoredSymbols = []) {
  const ignored = new Set(ignoredSymbols.map(normalizeSymbol).filter(Boolean));
  const priceBySymbol = new Map();
  const priceBySourceSymbol = new Map();
  for (const position of positions) {
    if (!ignored.has(position.symbol) && position.price > 0) {
      if (!priceBySymbol.has(position.symbol)) priceBySymbol.set(position.symbol, position.price);
      priceBySourceSymbol.set(`${position.source}:${position.symbol}`, position.price);
    }
  }

  const alerts = [];
  for (const order of orders) {
    if (ignored.has(order.symbol)) continue;
    const currentPrice = priceBySourceSymbol.get(`${order.source}:${order.symbol}`) || priceBySymbol.get(order.symbol);
    if (!currentPrice || !order.watchPrice) continue;
    const lowerBound = currentPrice / 2;
    const upperBound = currentPrice * 2;
    const insideDoubleBand = order.watchPrice >= lowerBound && order.watchPrice <= upperBound;
    if (insideDoubleBand) {
      alerts.push({
        symbol: order.symbol,
        source: order.source,
        side: order.side,
        type: order.type,
        size: order.size,
        currentPrice,
        orderPrice: order.watchPrice,
        lowerBound,
        upperBound,
        reason: "order_inside_2x_band"
      });
    }
  }
  alerts.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.source.localeCompare(b.source));
  return alerts;
}

export function analyzeMissingTpSl(positions, orders, ignoredSymbols = []) {
  const ignored = new Set(ignoredSymbols.map(normalizeSymbol).filter(Boolean));
  const orderMap = new Map();
  for (const order of orders) {
    if (ignored.has(order.symbol)) continue;
    const key = `${order.source}:${order.symbol}`;
    if (!orderMap.has(key)) orderMap.set(key, []);
    orderMap.get(key).push(order);
  }

  const alerts = [];
  for (const position of positions) {
    if (ignored.has(position.symbol)) continue;
    const key = `${position.source}:${position.symbol}`;
    const relatedOrders = orderMap.get(key) || [];
    const hasTp = relatedOrders.some((order) => isTakeProfitOrder(order, position));
    const hasSl = relatedOrders.some((order) => isStopLossOrder(order, position));
    if (!hasTp || !hasSl) {
      alerts.push({
        symbol: position.symbol,
        source: position.source,
        side: position.side,
        size: position.size,
        currentPrice: position.price,
        missingTp: !hasTp,
        missingSl: !hasSl,
        reason: !hasTp && !hasSl ? "missing_tp_and_sl" : !hasTp ? "missing_tp" : "missing_sl"
      });
    }
  }

  alerts.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.source.localeCompare(b.source));
  return alerts;
}

function isTakeProfitOrder(order, position) {
  const type = String(order.type || "").toLowerCase();
  if (order.source === "phemex" && type.includes("marketiftouched")) return true;
  if (type.includes("take") || type.includes("profit") || type.includes("tp")) return true;
  if (!position.price || !order.watchPrice) return false;
  return position.side === "long" ? order.watchPrice > position.price : order.watchPrice < position.price;
}

function isStopLossOrder(order, position) {
  const type = String(order.type || "").toLowerCase();
  if (order.source === "phemex" && type === "stop") return true;
  if (type.includes("loss") || type.includes("sl")) return true;
  if (!position.price || !order.watchPrice) return false;
  return position.side === "long" ? order.watchPrice < position.price : order.watchPrice > position.price;
}

export function extractPositionOrders(positions) {
  const orders = [];
  for (const position of positions) {
    orders.push(...extractRawPositionOrders(position));
  }
  return orders;
}

function extractRawPositionOrders(position) {
  const raw = position.raw || {};
  const symbol = position.symbol;
  const source = position.source;
  const size = position.size;
  const closeSide = position.side === "long" ? "sell" : "buy";
  const candidates = [
    ["take_profit", firstValue(raw, ["takeProfit", "takeProfitPrice", "tpTriggerPrice", "takeProfitPriceRp", "takeProfitRp", "takeProfitEp", "tpPrice"])],
    ["stop_loss", firstValue(raw, ["stopLoss", "stopLossPrice", "slTriggerPrice", "stopLossPriceRp", "stopLossRp", "stopLossEp", "slPrice"])]
  ];

  return candidates
    .map(([type, price]) => makeOrder({
      symbol,
      source,
      side: closeSide,
      size,
      triggerPrice: normalizeRawOrderPrice(price),
      type: `position_${type}`,
      status: "position_attached",
      raw
    }))
    .filter(Boolean);
}

function firstValue(raw, keys) {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && String(raw[key]) !== "" && Number(raw[key]) !== 0) {
      return raw[key];
    }
  }
  return 0;
}

function normalizeRawOrderPrice(value) {
  const parsed = numberValue(value);
  if (parsed > 100000000) return parsed / 100000000;
  if (parsed > 10000 && parsed % 10000 === 0) return parsed / 10000;
  return parsed;
}

function round(value) {
  return Math.round(value * 1e8) / 1e8;
}
