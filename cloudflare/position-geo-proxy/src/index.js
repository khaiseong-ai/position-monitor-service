const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_PROBE_BASES = [
  ["binance", "https://fapi.binance.com"]
];
const BINANCE_WS = "wss://ws-fapi.binance.com/ws-fapi/v1";
const BYBIT_BASE = "https://api.bybit.com";
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff"
};
const UPSTREAM_HEADERS = {
  accept: "application/json",
  "user-agent": "position-monitor-service/1.0"
};
const REQUIRED_SECRETS = [
  "PROXY_TOKEN",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET"
];
const textEncoder = new TextEncoder();
const hmacKeyCache = new Map();

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};

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
    if (!authorized(request, env.PROXY_TOKEN)) return jsonResponse({ ok: false }, 401);

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

  if (url.pathname !== "/state") return jsonResponse({ ok: false }, 404);
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!authorized(request, env.PROXY_TOKEN)) return jsonResponse({ ok: false }, 401);

  const missing = REQUIRED_SECRETS.filter((name) => !String(env[name] || "").trim());
  if (missing.length > 0) return jsonResponse({ ok: false, reason: "not_configured" }, 503);

  const results = await Promise.allSettled([
    fetchBinanceState(env, fetchImpl),
    fetchBybitState(env, fetchImpl)
  ]);
  const names = ["binance", "bybit"];
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
    orders: results.flatMap((result) => result.value.orders)
  });
}

async function fetchBinanceState(env, fetchImpl) {
  const config = { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET };
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

  return { positions, orders };
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

  return { positions, orders };
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
  const id = `${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function authorized(request, token) {
  const expected = `Bearer ${String(token || "")}`;
  const actual = String(request.headers.get("authorization") || "");
  if (!token || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
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
