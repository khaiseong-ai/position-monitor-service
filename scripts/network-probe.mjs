const endpoints = [
  ["binance_fapi", "https://fapi.binance.com/fapi/v1/time"],
  ["binance_fapi1", "https://fapi1.binance.com/fapi/v1/time"],
  ["binance_fapi2", "https://fapi2.binance.com/fapi/v1/time"],
  ["binance_fapi3", "https://fapi3.binance.com/fapi/v1/time"],
  ["binance_fapi4", "https://fapi4.binance.com/fapi/v1/time"],
  ["bybit_api", "https://api.bybit.com/v5/market/time"],
  ["bybit_bytick", "https://api.bytick.com/v5/market/time"]
];

for (const [name, url] of endpoints) {
  let result = "network";
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });
    result = `http_${response.status}@${new URL(response.url).hostname}`;
  } catch {
    // The status category is enough for diagnosing runner reachability.
  }
  console.log(`${name}=${result}`);
}

const relayUrl = String(process.env.POSITION_RELAY_URL || "").trim();
const relayToken = await relayAuthorizationToken();
const binanceCredentials = {
  apiKey: String(process.env.BINANCE_API_KEY || "").trim(),
  apiSecret: String(process.env.BINANCE_API_SECRET || "").trim()
};
if (relayUrl && relayToken) {
  let diagnostic = { status: "network" };
  try {
    const url = new URL(relayUrl);
    url.pathname = "/state";
    url.search = "";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        exchanges: ["binance"],
        credentials: {
          binance: binanceCredentials
        }
      }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => null);
    diagnostic = {
      status: `http_${response.status}`,
      ok: body?.ok === true,
      positions: Array.isArray(body?.positions) ? body.positions.length : 0,
      orders: Array.isArray(body?.orders) ? body.orders.length : 0,
      coverage: sanitizeCoverage(body?.coverage?.binance),
      warnings: sanitizeWarnings(body?.warnings),
      failureCode: sanitizeFailureCode(body?.failureCodes?.binance)
    };
  } catch {
    // Do not expose relay or exchange response details in workflow logs.
  }
  console.log(`binance_ws_diagnostic=${JSON.stringify(diagnostic)}`);

  let methodDiagnostic = { status: "network", methods: {} };
  try {
    const url = new URL(relayUrl);
    url.pathname = "/state";
    url.search = "";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        diagnostics: "binance",
        exchanges: ["binance"],
        credentials: { binance: binanceCredentials }
      }),
      signal: AbortSignal.timeout(90000)
    });
    const body = await response.json().catch(() => null);
    methodDiagnostic = {
      status: `http_${response.status}`,
      methods: sanitizeMethods(body?.methods)
    };
  } catch {
    // Do not expose relay or exchange response details in workflow logs.
  }
  console.log(`binance_method_diagnostic=${JSON.stringify(methodDiagnostic)}`);
}

async function relayAuthorizationToken() {
  const requestUrl = String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || "").trim();
  const requestToken = String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "").trim();
  if (requestUrl && requestToken) {
    try {
      const url = new URL(requestUrl);
      url.searchParams.set("audience", "position-relay");
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${requestToken}` },
        signal: AbortSignal.timeout(30000)
      });
      const body = await response.json().catch(() => null);
      if (response.ok && String(body?.value || "").trim()) return String(body.value).trim();
    } catch {
      // Fall through to the configured relay token outside GitHub Actions.
    }
  }
  return String(process.env.POSITION_RELAY_TOKEN || "").trim();
}

function sanitizeCoverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const positions = String(value.positions || "");
  const orders = String(value.orders || "");
  const transport = String(value.transport || "");
  return {
    ...(["complete", "unavailable"].includes(positions) ? { positions } : {}),
    ...(["complete", "unavailable"].includes(orders) ? { orders } : {}),
    ...(["rest", "websocket"].includes(transport) ? { transport } : {})
  };
}

function sanitizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => /^[a-z0-9_-]+$/i.test(item));
}

function sanitizeFailureCode(value) {
  const code = String(value || "");
  return /^[a-z0-9_-]+$/i.test(code) ? code : "";
}

function sanitizeMethods(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[a-z0-9_-]+$/i.test(name) || !item || typeof item !== "object") continue;
    const status = Number(item.status);
    const count = Number(item.count);
    const code = String(item.code || "");
    result[name] = {
      status: Number.isInteger(status) ? status : 0,
      ...(Number.isInteger(count) && count >= 0 ? { count } : {}),
      ...(/^[a-z0-9_-]+$/i.test(code) ? { code } : {})
    };
  }
  return result;
}
