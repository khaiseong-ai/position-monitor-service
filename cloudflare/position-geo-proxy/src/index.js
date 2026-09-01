const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_FUNDING_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi4.binance.com"
];
const BINANCE_PROBE_BASES = [
  ["binance", "https://fapi.binance.com"]
];
const BINANCE_WS = "wss://ws-fapi.binance.com/ws-fapi/v1";
const BYBIT_BASE = "https://api.bybit.com";
const HOUR_MS = 60 * 60 * 1000;
const FUNDING_MAX_WINDOW_MS = 7 * 24 * HOUR_MS;
const FUNDING_PAGE_LIMIT = 1000;
const COMMON_FUNDING_INTERVALS = [1, 2, 4, 8, 12, 24];
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff"
};
const UPSTREAM_HEADERS = {
  accept: "application/json",
  "user-agent": "position-monitor-service/1.0"
};
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const GITHUB_OIDC_AUDIENCE = "position-relay";
const GITHUB_REPOSITORY = "khaiseong-ai/position-monitor-service";
const GITHUB_POSITION_DISPATCH_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}`
  + "/actions/workflows/position-monitor.yml/dispatches";
const GITHUB_WORKFLOWS = new Set([
  `${GITHUB_REPOSITORY}/.github/workflows/position-monitor.yml@refs/heads/main`,
  `${GITHUB_REPOSITORY}/.github/workflows/ks-funding-sheet.yml@refs/heads/main`
]);
const REQUIRED_EXCHANGE_SECRETS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET"
];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const hmacKeyCache = new Map();
let githubJwksCache = { expiresAt: 0, keys: [] };

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_controller, env) {
    await dispatchPositionMonitor(env);
  }
};

export async function dispatchPositionMonitor(env = {}, fetchImpl = fetch) {
  const token = String(env.GITHUB_ACTIONS_TOKEN || "").trim();
  if (!token) throw new Error("GitHub Actions scheduler is not configured");

  const response = await fetchImpl(GITHUB_POSITION_DISPATCH_URL, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "position-monitor-scheduler/1.0",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({ ref: "main", inputs: { notify: "true" } })
  });
  if (![200, 204].includes(response.status)) {
    throw new Error(`GitHub Actions dispatch failed with HTTP ${response.status}`);
  }
}

export async function handleRequest(request, env = {}, fetchImpl = fetch, webSocketFactory = defaultWebSocketFactory) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return jsonResponse({ ok: true, service: "position-geo-proxy" });
  }

  if (url.pathname === "/probe") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const [binanceResults, binanceWs, bybit] = await Promise.all([
      Promise.all(BINANCE_PROBE_BASES.map(async ([name, base]) => [
        name,
        await probeEndpoint(`${base}/fapi/v1/time`, fetchImpl)
      ])),
      probeBinanceWebSocket(webSocketFactory),
      probeEndpoint(`${BYBIT_BASE}/v5/market/time`, fetchImpl)
    ]);
    const endpoints = Object.fromEntries([...binanceResults, ["binanceWs", binanceWs], ["bybit", bybit]]);
    return jsonResponse({
      ok: (binanceResults.some(([, status]) => status === "http_200") || binanceWs === "ws_200")
        && bybit === "http_200",
      endpoints
    });
  }

  if (url.pathname === "/diagnostics/binance-ws") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!(await authorized(request, env.PROXY_TOKEN, fetchImpl))) return jsonResponse({ ok: false }, 401);

    const missing = ["BINANCE_API_KEY", "BINANCE_API_SECRET"]
      .filter((name) => !String(env[name] || "").trim());
    if (missing.length > 0) return jsonResponse({ ok: false, reason: "not_configured" }, 503);

    const config = {
      apiKey: String(env.BINANCE_API_KEY).trim(),
      apiSecret: String(env.BINANCE_API_SECRET).trim()
    };
    const runDiagnostic = async (method) => {
      try {
        const payload = await binanceWebSocketRequest(config, method, webSocketFactory);
        return safeWebSocketDiagnostic(payload);
      } catch (error) {
        return { status: 0, code: safeFailureCode(error) };
      }
    };

    const diagnostics = {
      positions: await runDiagnostic("v2/account.position")
    };
    if (diagnostics.positions.status === 200) {
      diagnostics.openOrders = await runDiagnostic("openOrders.status");
      diagnostics.openAlgoOrders = await runDiagnostic("openAlgoOrders.status");
      diagnostics.algoOrders = await runDiagnostic("algoOrders.status");
    }

    return jsonResponse({
      ok: Object.values(diagnostics).every((result) => result.status === 200),
      methods: diagnostics
    });
  }

  if (url.pathname === "/funding") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!(await authorized(request, env.PROXY_TOKEN, fetchImpl))) return jsonResponse({ ok: false }, 401);
    return handleFundingRequest(request, env, fetchImpl, webSocketFactory);
  }

  if (url.pathname !== "/state") return jsonResponse({ ok: false }, 404);
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!(await authorized(request, env.PROXY_TOKEN, fetchImpl))) return jsonResponse({ ok: false }, 401);

  const body = await readOptionalJson(request);
  if (body === null) return jsonResponse({ ok: false, reason: "invalid_request" }, 400);
  const runtimeEnv = withRequestCredentials(env, body);
  const names = requestedExchanges(body);
  const missing = requiredSecretsFor(names).filter((name) => !String(runtimeEnv[name] || "").trim());
  if (missing.length > 0) return jsonResponse({ ok: false, reason: "not_configured" }, 503);

  const results = await Promise.allSettled(names.map((name) => name === "binance"
    ? fetchBinanceState(runtimeEnv, fetchImpl, webSocketFactory)
    : fetchBybitState(runtimeEnv, fetchImpl)));
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [[names[index], safeFailureCode(result.reason)]]
    : []);
  const failed = failures.map(([name]) => name);

  if (failed.length > 0) {
    const retryAfterSeconds = Object.fromEntries(results.flatMap((result, index) => {
      const retryAfter = result.status === "rejected" ? safeRetryAfter(result.reason) : null;
      return retryAfter === null ? [] : [[names[index], retryAfter]];
    }));
    return jsonResponse({
      ok: false,
      failed,
      failureCodes: Object.fromEntries(failures),
      ...(Object.keys(retryAfterSeconds).length > 0 ? { retryAfterSeconds } : {})
    }, 502);
  }

  return jsonResponse({
    ok: true,
    checkedAt: new Date().toISOString(),
    positions: results.flatMap((result) => result.value.positions),
    orders: results.flatMap((result) => result.value.orders),
    coverage: Object.fromEntries(results.map((result, index) => [names[index], result.value.coverage])),
    warnings: [...new Set(results.flatMap((result) => result.value.warnings || []))]
  });
}

async function handleFundingRequest(request, env, fetchImpl, webSocketFactory) {
  const body = await readOptionalJson(request);
  if (body === null) return jsonResponse({ ok: false, reason: "invalid_request" }, 400);

  const endTime = Math.floor(numberValue(body?.endTime));
  const startTime = Math.floor(numberValue(body?.startTime));
  if (!startTime || !endTime || startTime >= endTime || endTime - startTime > FUNDING_MAX_WINDOW_MS) {
    return jsonResponse({ ok: false, reason: "invalid_window" }, 400);
  }

  const runtimeEnv = withRequestCredentials(env, body);
  const names = requestedExchanges(body);
  const missing = requiredSecretsFor(names).filter((name) => !String(runtimeEnv[name] || "").trim());
  if (missing.length > 0) return jsonResponse({ ok: false, reason: "not_configured" }, 503);

  const results = await Promise.allSettled(names.map((name) => name === "binance"
    ? fetchBinanceFundingState(runtimeEnv, startTime, endTime, fetchImpl, webSocketFactory)
    : fetchBybitFundingState(runtimeEnv, startTime, endTime, fetchImpl)));
  const exchanges = {};
  const failures = {};
  results.forEach((result, index) => {
    if (result.status === "fulfilled") exchanges[names[index]] = result.value;
    else failures[names[index]] = safeFailureCode(result.reason);
  });

  if (Object.keys(exchanges).length === 0) {
    return jsonResponse({ ok: false, failures }, 502);
  }
  return jsonResponse({
    ok: true,
    checkedAt: new Date().toISOString(),
    exchanges,
    ...(Object.keys(failures).length > 0 ? { failures } : {})
  });
}

async function readOptionalJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function withRequestCredentials(env, body) {
  const credentials = body?.credentials;
  const binance = credentials?.binance;
  const bybit = credentials?.bybit;
  return {
    ...env,
    BINANCE_API_KEY: String(env.BINANCE_API_KEY || binance?.apiKey || "").trim(),
    BINANCE_API_SECRET: String(env.BINANCE_API_SECRET || binance?.apiSecret || "").trim(),
    BYBIT_API_KEY: String(env.BYBIT_API_KEY || bybit?.apiKey || "").trim(),
    BYBIT_API_SECRET: String(env.BYBIT_API_SECRET || bybit?.apiSecret || "").trim()
  };
}

function requestedExchanges(body) {
  const requested = Array.isArray(body?.exchanges) ? body.exchanges : ["binance", "bybit"];
  const names = [...new Set(requested.map((name) => String(name).toLowerCase()))]
    .filter((name) => name === "binance" || name === "bybit");
  return names.length > 0 ? names : ["binance", "bybit"];
}

function requiredSecretsFor(names) {
  return REQUIRED_EXCHANGE_SECRETS.filter((secret) =>
    names.some((name) => secret.startsWith(`${name.toUpperCase()}_`)));
}

async function fetchBinanceFundingState(env, startTime, endTime, fetchImpl, webSocketFactory) {
  const config = { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET };
  const [positionPayload, balancePayload, incomeRows] = await Promise.all([
    binanceWebSocketRequest(config, "v2/account.position", webSocketFactory),
    binanceWebSocketRequest(config, "v2/account.balance", webSocketFactory).catch(() => null),
    binanceFundingSignedGet(config, "/fapi/v1/income", {
      incomeType: "FUNDING_FEE",
      startTime,
      endTime,
      limit: FUNDING_PAGE_LIMIT
    }, fetchImpl)
  ]);
  if (Number(positionPayload?.status) !== 200 || !Array.isArray(positionPayload?.result)) {
    throw upstreamError(apiFailureCode(positionPayload?.error?.code));
  }

  const rawPositions = positionPayload.result.filter((row) => numberValue(row.positionAmt) !== 0);
  const actualBySymbol = new Map();
  for (const row of asArray(incomeRows)) {
    const symbol = String(row.symbol || "").toUpperCase();
    const timestamp = numberValue(row.time);
    if (!symbol || timestamp < startTime || timestamp > endTime) continue;
    if (!actualBySymbol.has(symbol)) actualBySymbol.set(symbol, []);
    actualBySymbol.get(symbol).push({ timestamp, amount: numberValue(row.income) });
  }

  const scheduleEntries = await Promise.all(rawPositions.map(async (row) => {
    const symbol = String(row.symbol || "").toUpperCase();
    try {
      return [symbol, await fetchBinanceFundingSchedule(symbol, startTime, endTime, fetchImpl)];
    } catch {
      return [symbol, []];
    }
  }));
  const scheduleBySymbol = new Map(scheduleEntries);

  const positions = rawPositions.map((row) => {
    const rawSymbol = String(row.symbol || "").toUpperCase();
    const actual = (actualBySymbol.get(rawSymbol) || []).sort((a, b) => b.timestamp - a.timestamp);
    const schedule = scheduleBySymbol.get(rawSymbol) || [];
    const intervalHours = inferFundingInterval(schedule.length > 1 ? schedule : actual) || 8;
    const records = buildFundingRecords(actual, schedule, intervalHours, startTime, endTime);
    const signedSize = numberValue(row.positionAmt);
    const size = Math.abs(signedSize);
    const markPrice = numberValue(row.markPrice);
    return {
      source: "binance",
      symbol: normalizeSymbol(rawSymbol),
      rawSymbol,
      side: signedSize > 0 ? "long" : "short",
      currentPrice: markPrice,
      entryPrice: numberValue(row.entryPrice),
      positionSize: size,
      positionValue: Math.abs(numberValue(row.notional)) || size * markPrice,
      unrealizedPnl: numberValue(row.unRealizedProfit ?? row.unrealizedProfit),
      count: records.length,
      fundingIntervalHours: intervalHours,
      totalFunding: records.reduce((sum, record) => sum + record.amount, 0),
      fundingRecords: records.map((record) => record.amount),
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString()
    };
  });

  const equity = emptyFundingEquity();
  for (const row of asArray(balancePayload?.result)) {
    const asset = String(row.asset || "").toUpperCase();
    if (asset === "USDT" || asset === "USDC") {
      equity.futures[asset] = numberValue(row.balance) + numberValue(row.crossUnPnl);
    }
  }
  equity.total = sumFundingEquity(equity);
  return { equity, positions, orders: [] };
}

async function fetchBinanceFundingSchedule(symbol, startTime, endTime, fetchImpl) {
  let lastError;
  for (const base of BINANCE_FUNDING_BASES) {
    try {
      const query = new URLSearchParams({
        symbol,
        startTime: String(startTime),
        endTime: String(endTime),
        limit: String(FUNDING_PAGE_LIMIT)
      });
      const rows = await fetchJson(`${base}/fapi/v1/fundingRate?${query}`, {
        headers: UPSTREAM_HEADERS
      }, fetchImpl, "binance");
      return asArray(rows).map((row) => ({ timestamp: numberValue(row.fundingTime) }))
        .filter((row) => row.timestamp >= startTime && row.timestamp <= endTime)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || upstreamError("network");
}

async function binanceFundingSignedGet(config, path, params, fetchImpl) {
  const query = new URLSearchParams(Object.entries({
    ...params,
    recvWindow: 5000,
    timestamp: Date.now()
  }).map(([key, value]) => [key, String(value)])).toString();
  const signature = await hmacHex("binance-funding", config.apiSecret, query);
  let lastError;
  for (const base of BINANCE_FUNDING_BASES) {
    try {
      return await fetchJson(`${base}${path}?${query}&signature=${signature}`, {
        headers: { ...UPSTREAM_HEADERS, "X-MBX-APIKEY": config.apiKey }
      }, fetchImpl, "binance");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || upstreamError("network");
}

async function fetchBybitFundingState(env, startTime, endTime, fetchImpl) {
  const config = { apiKey: env.BYBIT_API_KEY, apiSecret: env.BYBIT_API_SECRET };
  const positionRows = [];
  const orderRows = [];
  for (const settleCoin of ["USDT", "USDC"]) {
    const [positionsJson, ordersJson] = await Promise.all([
      bybitSignedGet(config, "/v5/position/list", { category: "linear", settleCoin }, fetchImpl),
      bybitSignedGet(config, "/v5/order/realtime", { category: "linear", settleCoin, limit: 50 }, fetchImpl)
    ]);
    positionRows.push(...asArray(positionsJson.result?.list).filter((row) => numberValue(row.size) !== 0));
    orderRows.push(...asArray(ordersJson.result?.list));
  }

  const [walletJson, transactionRows] = await Promise.all([
    bybitSignedGet(config, "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT,USDC"
    }, fetchImpl).catch(() => ({ result: { list: [] } })),
    fetchBybitFundingTransactions(config, startTime, endTime, fetchImpl)
  ]);
  const actualBySymbol = new Map();
  for (const row of transactionRows) {
    const symbol = String(row.symbol || "").toUpperCase();
    const timestamp = numberValue(row.transactionTime);
    if (!symbol || timestamp < startTime || timestamp > endTime) continue;
    if (!actualBySymbol.has(symbol)) actualBySymbol.set(symbol, []);
    actualBySymbol.get(symbol).push({ timestamp, amount: numberValue(row.funding) });
  }

  const metadataEntries = await Promise.all(positionRows.map(async (row) => {
    const symbol = String(row.symbol || "").toUpperCase();
    return [symbol, await fetchBybitFundingMetadata(symbol, fetchImpl).catch(() => ({}))];
  }));
  const metadataBySymbol = new Map(metadataEntries);
  const positions = positionRows.map((row) => {
    const rawSymbol = String(row.symbol || "").toUpperCase();
    const actual = (actualBySymbol.get(rawSymbol) || []).sort((a, b) => b.timestamp - a.timestamp);
    const metadata = metadataBySymbol.get(rawSymbol) || {};
    const intervalHours = metadata.intervalHours || inferFundingInterval(actual) || 8;
    const schedule = buildFundingSchedule(intervalHours, metadata.nextFundingTime, startTime, endTime);
    const records = buildFundingRecords(actual, schedule, intervalHours, startTime, endTime);
    const size = Math.abs(numberValue(row.size));
    const markPrice = numberValue(row.markPrice);
    return {
      source: "bybit",
      symbol: normalizeSymbol(rawSymbol),
      rawSymbol,
      side: String(row.side || "").toLowerCase() === "buy" ? "long" : "short",
      currentPrice: markPrice,
      entryPrice: numberValue(row.avgPrice),
      positionSize: size,
      positionValue: Math.abs(numberValue(row.positionValue)) || size * markPrice,
      unrealizedPnl: numberValue(row.unrealisedPnl),
      count: records.length,
      fundingIntervalHours: intervalHours,
      totalFunding: records.reduce((sum, record) => sum + record.amount, 0),
      fundingRecords: records.map((record) => record.amount),
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString()
    };
  });

  const orders = orderRows.map((row) => {
    const triggerPrice = numberValue(row.triggerPrice);
    const limitPrice = numberValue(row.price);
    const orderType = String(row.orderType || row.stopOrderType || "").toUpperCase();
    let kind = "LIMIT";
    if (/TAKE.?PROFIT/.test(orderType)) kind = "TP";
    else if (/STOP/.test(orderType)) kind = "SL";
    else if (triggerPrice && !limitPrice) kind = "TRIGGER";
    return {
      exchange: "bybit",
      symbol: normalizeSymbol(row.symbol),
      side: String(row.side || "").toLowerCase(),
      price: triggerPrice || limitPrice,
      triggerPrice,
      limitPrice,
      amount: Math.abs(numberValue(row.qty)),
      kind,
      orderType
    };
  }).filter((row) => row.price > 0 && row.amount > 0);

  const equity = emptyFundingEquity();
  for (const row of asArray(walletJson.result?.list?.[0]?.coin)) {
    const coin = String(row.coin || "").toUpperCase();
    if (coin === "USDT" || coin === "USDC") equity.futures[coin] = numberValue(row.equity);
  }
  equity.total = sumFundingEquity(equity);
  return { equity, positions, orders };
}

async function fetchBybitFundingTransactions(config, startTime, endTime, fetchImpl) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const json = await bybitSignedGet(config, "/v5/account/transaction-log", {
      accountType: "UNIFIED",
      category: "linear",
      type: "SETTLEMENT",
      startTime,
      endTime,
      limit: 50,
      ...(cursor ? { cursor } : {})
    }, fetchImpl);
    rows.push(...asArray(json.result?.list));
    const nextCursor = String(json.result?.nextPageCursor || "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return rows;
}

async function fetchBybitFundingMetadata(symbol, fetchImpl) {
  const [instrumentJson, tickerJson] = await Promise.all([
    fetchJson(`${BYBIT_BASE}/v5/market/instruments-info?${new URLSearchParams({ category: "linear", symbol })}`, {
      headers: UPSTREAM_HEADERS
    }, fetchImpl, "bybit"),
    fetchJson(`${BYBIT_BASE}/v5/market/tickers?${new URLSearchParams({ category: "linear", symbol })}`, {
      headers: UPSTREAM_HEADERS
    }, fetchImpl, "bybit")
  ]);
  if (instrumentJson.retCode !== 0 || tickerJson.retCode !== 0) throw upstreamError("api_rejected");
  const instrument = asArray(instrumentJson.result?.list)[0] || {};
  const ticker = asArray(tickerJson.result?.list)[0] || {};
  return {
    intervalHours: closestFundingInterval(numberValue(instrument.fundingInterval) / 60),
    nextFundingTime: numberValue(ticker.nextFundingTime)
  };
}

function buildFundingSchedule(intervalHours, nextFundingTime, startTime, endTime) {
  const intervalMs = intervalHours * HOUR_MS;
  if (!intervalMs) return [];
  let anchor = numberValue(nextFundingTime);
  if (!anchor) anchor = Math.floor(endTime / intervalMs) * intervalMs;
  while (anchor > endTime) anchor -= intervalMs;
  while (anchor + intervalMs <= endTime) anchor += intervalMs;
  const rows = [];
  for (let timestamp = anchor; timestamp >= startTime; timestamp -= intervalMs) rows.push({ timestamp });
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

function buildFundingRecords(actual, schedule, intervalHours, startTime, endTime) {
  const intervalMs = intervalHours * HOUR_MS;
  let expected = schedule.slice();
  if (intervalMs) {
    let anchor = expected[0]?.timestamp
      || actual[0]?.timestamp
      || Math.floor(endTime / intervalMs) * intervalMs;
    while (anchor > endTime) anchor -= intervalMs;
    while (anchor + intervalMs <= endTime) anchor += intervalMs;
    for (let timestamp = anchor; timestamp >= startTime; timestamp -= intervalMs) {
      if (timestamp <= endTime) expected.push({ timestamp });
    }
  }
  const merged = [...new Map(expected.map((row) => [numberValue(row.timestamp), {
    timestamp: numberValue(row.timestamp),
    amount: 0
  }])).values()].filter((row) => row.timestamp >= startTime && row.timestamp <= endTime)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (merged.length === 0) return actual;

  for (const record of actual) {
    let best = null;
    let distance = Infinity;
    for (const slot of merged) {
      const candidate = Math.abs(record.timestamp - slot.timestamp);
      if (candidate < distance) {
        distance = candidate;
        best = slot;
      }
    }
    if (best) best.amount += numberValue(record.amount);
  }
  return merged;
}

function inferFundingInterval(records) {
  const timestamps = [...new Set(records.map((row) => numberValue(row.timestamp)).filter(Boolean))]
    .sort((a, b) => a - b);
  if (timestamps.length < 2) return 0;
  const counts = new Map();
  for (let index = 1; index < timestamps.length; index += 1) {
    const hours = closestFundingInterval((timestamps[index] - timestamps[index - 1]) / HOUR_MS);
    if (hours > 0 && hours <= 24) counts.set(hours, (counts.get(hours) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] || 0;
}

function closestFundingInterval(hours) {
  if (!hours) return 0;
  return COMMON_FUNDING_INTERVALS.reduce((closest, candidate) =>
    Math.abs(candidate - hours) < Math.abs(closest - hours) ? candidate : closest
  );
}

function emptyFundingEquity() {
  return {
    futures: { USDT: 0, USDC: 0 },
    spot: { USDT: 0, USDC: 0 },
    funding: { USDT: 0, USDC: 0 },
    unrealizedPnl: 0,
    total: 0
  };
}

function sumFundingEquity(equity) {
  return ["futures", "spot", "funding"].reduce((total, bucket) =>
    total + numberValue(equity[bucket]?.USDT) + numberValue(equity[bucket]?.USDC), 0
  );
}

async function fetchBinanceState(env, fetchImpl, webSocketFactory) {
  const config = { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET };
  if (String(env.BINANCE_WS_POSITIONS_ONLY || "").toLowerCase() === "true") {
    return fetchBinanceWebSocketState(config, webSocketFactory);
  }
  try {
    return await fetchBinanceRestState(config, fetchImpl);
  } catch (restError) {
    try {
      return await fetchBinanceWebSocketState(config, webSocketFactory);
    } catch {
      throw restError;
    }
  }
}

async function fetchBinanceRestState(config, fetchImpl) {
  const [positionRows, openOrderRows, algoOrderRows] = await Promise.all([
    binanceSignedGet(config, "/fapi/v3/positionRisk", fetchImpl),
    binanceSignedGet(config, "/fapi/v1/openOrders", fetchImpl),
    binanceSignedGet(config, "/fapi/v1/openAlgoOrders", fetchImpl)
  ]);

  const positions = asArray(positionRows).map((row) => normalizePosition({
    symbol: row.symbol,
    source: "binance",
    side: numberValue(row.positionAmt) > 0 ? "long" : "short",
    size: row.positionAmt,
    price: row.markPrice
  })).filter(Boolean);

  const orders = [...asArray(openOrderRows), ...asArray(algoOrderRows)].map((row) => normalizeOrder({
    symbol: row.symbol,
    source: "binance",
    side: row.side,
    size: row.origQty || row.quantity || row.qty,
    price: row.price,
    triggerPrice: row.stopPrice || row.triggerPrice,
    type: row.type || row.algoType,
    status: row.status || row.orderStatus
  })).filter(Boolean);

  return {
    positions,
    orders,
    coverage: { positions: "complete", orders: "complete", transport: "rest" },
    warnings: []
  };
}

async function fetchBinanceWebSocketState(config, webSocketFactory) {
  const payload = await binanceWebSocketRequest(config, "v2/account.position", webSocketFactory);
  if (Number(payload?.status) !== 200 || !Array.isArray(payload?.result)) {
    throw upstreamError(apiFailureCode(payload?.error?.code));
  }
  const positions = payload.result.map((row) => normalizePosition({
    symbol: row.symbol,
    source: "binance",
    side: numberValue(row.positionAmt) > 0 ? "long" : "short",
    size: row.positionAmt,
    price: row.markPrice
  })).filter(Boolean);
  return {
    positions,
    orders: [],
    coverage: { positions: "complete", orders: "unavailable", transport: "websocket" },
    warnings: ["binance_orders_unavailable"]
  };
}

async function binanceSignedGet(config, path, fetchImpl) {
  const query = new URLSearchParams({
    timestamp: String(Date.now()),
    recvWindow: "5000"
  }).toString();
  const signature = await hmacHex("binance", config.apiSecret, query);
  return fetchJson(`${BINANCE_BASE}${path}?${query}&signature=${signature}`, {
    headers: { ...UPSTREAM_HEADERS, "X-MBX-APIKEY": config.apiKey }
  }, fetchImpl, "binance");
}

async function fetchBybitState(env, fetchImpl) {
  const config = { apiKey: env.BYBIT_API_KEY, apiSecret: env.BYBIT_API_SECRET };
  const positions = [];
  const orders = [];

  for (const settleCoin of ["USDT", "USDC"]) {
    const [positionJson, orderJson] = await Promise.all([
      bybitSignedGet(config, "/v5/position/list", { category: "linear", settleCoin }, fetchImpl),
      bybitSignedGet(config, "/v5/order/realtime", { category: "linear", settleCoin, limit: 50 }, fetchImpl)
    ]);
    positions.push(...asArray(positionJson.result?.list).map((row) => normalizePosition({
      symbol: row.symbol,
      source: "bybit",
      side: row.side === "Buy" ? "long" : "short",
      size: row.size,
      price: row.markPrice
    })).filter(Boolean));
    orders.push(...asArray(orderJson.result?.list).map((row) => normalizeOrder({
      symbol: row.symbol,
      source: "bybit",
      side: row.side,
      size: row.qty,
      price: row.price,
      triggerPrice: row.triggerPrice,
      type: row.orderType || row.stopOrderType,
      status: row.orderStatus
    })).filter(Boolean));
  }

  return {
    positions,
    orders,
    coverage: { positions: "complete", orders: "complete", transport: "rest" },
    warnings: []
  };
}

async function bybitSignedGet(config, path, params, fetchImpl) {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const signature = await hmacHex("bybit", config.apiSecret, `${timestamp}${config.apiKey}${recvWindow}${query}`);
  const json = await fetchJson(`${BYBIT_BASE}${path}?${query}`, {
    headers: {
      ...UPSTREAM_HEADERS,
      "X-BAPI-API-KEY": config.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature
    }
  }, fetchImpl, "bybit");
  if (json.retCode !== 0) throw upstreamError(apiFailureCode(json.retCode));
  return json;
}

async function fetchJson(url, options, fetchImpl, label) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(15000)
  });
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  let json;
  try {
    json = await response.json();
  } catch {
    if (!response.ok) throw upstreamError(`http_${response.status}`, retryAfter);
    throw upstreamError("invalid_json");
  }
  if (!response.ok) {
    const apiCode = json && typeof json === "object" ? json.code ?? json.retCode : undefined;
    throw upstreamError(
      apiCode === undefined ? `http_${response.status}` : apiFailureCode(apiCode),
      retryAfter
    );
  }
  return json;
}

function upstreamError(safeCode, retryAfterSeconds = null) {
  const error = new Error("upstream unavailable");
  error.safeCode = safeCode;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function apiFailureCode(value) {
  const normalized = String(value ?? "").replace(/[^0-9-]/g, "");
  return /^-?\d+$/.test(normalized) ? `api_${normalized}` : "api_rejected";
}

function safeFailureCode(error) {
  const code = String(error?.safeCode || "network");
  return /^[a-z0-9_-]+$/i.test(code) ? code : "network";
}

function safeRetryAfter(error) {
  const seconds = Number(error?.retryAfterSeconds);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

async function probeEndpoint(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 403 && response.status !== 451) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
      try {
        await response.body?.cancel();
      } catch {
        // The status is sufficient; a consumed body is not required.
      }
      const retrySuffix = Number.isFinite(retryAfter) && retryAfter >= 0
        ? `_retry_${retryAfter}`
        : "";
      return `http_${response.status}${retrySuffix}`;
    }
    const text = await response.text().catch(() => "");
    if (/restricted location|not available in your (country|region)|country or region/i.test(text)) {
      return `http_${response.status}_geo`;
    }
    if (/access denied|forbidden|cloudfront|request blocked/i.test(text)) {
      return `http_${response.status}_access`;
    }
    return `http_${response.status}`;
  } catch {
    return "network";
  }
}

async function probeBinanceWebSocket(webSocketFactory) {
  let socket;
  let timer;
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close(1000, "probe complete");
        } catch {
          // The peer may already have closed the socket.
        }
        resolve(result);
      };

      socket = webSocketFactory(BINANCE_WS);
      timer = setTimeout(() => finish("ws_timeout"), 10000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: "probe", method: "time", params: {} }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data || ""));
          finish(payload.status === 200 ? "ws_200" : "ws_rejected");
        } catch {
          finish("ws_invalid");
        }
      });
      socket.addEventListener("error", () => finish("ws_error"));
      socket.addEventListener("close", () => finish("ws_closed"));
    });
  } catch {
    clearTimeout(timer);
    return "ws_error";
  }
}

async function binanceWebSocketRequest(config, method, webSocketFactory) {
  const id = crypto.randomUUID();
  const params = {
    apiKey: config.apiKey,
    recvWindow: 5000,
    timestamp: Date.now()
  };
  const signaturePayload = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  params.signature = await hmacHex("binance-ws", config.apiSecret, signaturePayload);

  let socket;
  let timer;
  return new Promise((resolve, reject) => {
    let settled = false;
    let opened = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close(1000, "diagnostic complete");
      } catch {
        // The peer may already have closed the socket.
      }
      callback(value);
    };

    try {
      socket = webSocketFactory(BINANCE_WS);
      timer = setTimeout(() => finish(reject, upstreamError("ws_timeout")), 15000);
      socket.addEventListener("open", () => {
        opened = true;
        socket.send(JSON.stringify({ id, method, params }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data || ""));
          if (payload.id === id) finish(resolve, payload);
        } catch {
          finish(reject, upstreamError("ws_invalid"));
        }
      });
      socket.addEventListener("error", () => {
        // The close event carries the useful protocol-level diagnostic code.
      });
      socket.addEventListener("close", (event) => {
        const rawCode = Number(event?.code);
        const closeCode = Number.isInteger(rawCode) && rawCode >= 1000 && rawCode <= 4999
          ? rawCode
          : 0;
        const phase = opened ? "after_open" : "before_open";
        finish(reject, upstreamError(`ws_closed_${closeCode}_${phase}`));
      });
    } catch {
      finish(reject, upstreamError("ws_error"));
    }
  });
}

function safeWebSocketDiagnostic(payload) {
  const status = Number(payload?.status);
  if (!Number.isInteger(status)) return { status: 0, code: "ws_invalid" };
  if (status === 200) {
    return {
      status,
      ...(Array.isArray(payload.result) ? { count: payload.result.length } : {})
    };
  }
  return {
    status,
    code: apiFailureCode(payload?.error?.code)
  };
}

function defaultWebSocketFactory(url) {
  return new WebSocket(url);
}

async function hmacHex(label, secret, payload) {
  let cached = hmacKeyCache.get(label);
  if (!cached || cached.secret !== secret) {
    cached = {
      secret,
      key: await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    };
    hmacKeyCache.set(label, cached);
  }
  const signature = await crypto.subtle.sign("HMAC", cached.key, textEncoder.encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorized(request, token, fetchImpl) {
  const expected = `Bearer ${String(token || "")}`;
  const actual = String(request.headers.get("authorization") || "");
  if (token && actual.length === expected.length) {
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
      difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    if (difference === 0) return true;
  }
  if (!actual.startsWith("Bearer ")) return false;
  return verifyGithubOidcToken(actual.slice("Bearer ".length), fetchImpl);
}

export async function verifyGithubOidcToken(token, fetchImpl = fetch) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(textDecoder.decode(decodeBase64Url(parts[0])));
    const claims = JSON.parse(textDecoder.decode(decodeBase64Url(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return false;

    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== GITHUB_OIDC_ISSUER
      || !audiences.includes(GITHUB_OIDC_AUDIENCE)
      || claims.repository !== GITHUB_REPOSITORY
      || claims.ref !== "refs/heads/main"
      || !["schedule", "workflow_dispatch"].includes(claims.event_name)
      || !GITHUB_WORKFLOWS.has(claims.workflow_ref)
      || numberValue(claims.exp) < now - 30
      || numberValue(claims.nbf) > now + 30) return false;

    const jwk = await githubOidcKey(header.kid, fetchImpl);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      decodeBase64Url(parts[2]),
      textEncoder.encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}

async function githubOidcKey(kid, fetchImpl) {
  const cached = githubJwksCache.keys.find((item) => item.kid === kid);
  if (cached && githubJwksCache.expiresAt > Date.now()) return cached;
  const response = await fetchImpl(GITHUB_OIDC_JWKS, {
    headers: UPSTREAM_HEADERS,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  githubJwksCache = { expiresAt: Date.now() + 60 * 60 * 1000, keys };
  return keys.find((item) => item.kid === kid) || null;
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function normalizePosition({ symbol, source, side, size, price }) {
  const numericSize = Math.abs(numberValue(size));
  if (!symbol || numericSize === 0 || !["long", "short"].includes(side)) return null;
  return {
    symbol: normalizeSymbol(symbol),
    source,
    side,
    size: numericSize,
    price: numberValue(price)
  };
}

function normalizeOrder({ symbol, source, side, size, price, triggerPrice, type, status }) {
  const numericPrice = numberValue(price);
  const numericTriggerPrice = numberValue(triggerPrice);
  if (!symbol || (!numericPrice && !numericTriggerPrice)) return null;
  return {
    symbol: normalizeSymbol(symbol),
    source,
    side: String(side || "").toLowerCase(),
    size: Math.abs(numberValue(size)),
    price: numericPrice,
    triggerPrice: numericTriggerPrice,
    type: String(type || ""),
    status: String(status || "")
  };
}

function normalizeSymbol(symbol) {
  let normalized = String(symbol || "").trim().toUpperCase().replace(/[-_/]/g, "");
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/(STOCK|USDT|USDC|USD|PERP|SWAP)$/u, "");
  }
  const aliases = { BROCCOLI714: "BROCCOLI", MONAD: "MON", PUMPFUN: "PUMP" };
  return aliases[normalized] || normalized;
}

function numberValue(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function methodNotAllowed(allowed) {
  return jsonResponse({ ok: false }, 405, { allow: allowed });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers }
  });
}
