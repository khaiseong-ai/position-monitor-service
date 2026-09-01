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
const relayToken = String(process.env.POSITION_RELAY_TOKEN || "").trim();
if (relayUrl && relayToken) {
  let diagnostic = { status: "network" };
  try {
    const url = new URL(relayUrl);
    url.pathname = "/diagnostics/binance-ws";
    url.search = "";
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${relayToken}` },
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => null);
    diagnostic = {
      status: `http_${response.status}`,
      methods: sanitizeMethods(body?.methods)
    };
  } catch {
    // Do not expose relay or exchange response details in workflow logs.
  }
  console.log(`binance_ws_diagnostic=${JSON.stringify(diagnostic)}`);
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
