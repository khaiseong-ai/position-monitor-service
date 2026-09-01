const SHEET_HEADERS = {
  Summary: ["Key", "Value"],
  Positions: ["Symbol", "Source", "Side", "Size", "Price", "Orders"],
  Orders: ["Symbol", "Source", "Side", "Size", "Price", "Trigger Price", "Watch Price", "Type", "Status"],
  Alerts: ["Symbol", "Reason", "Long", "Short", "Diff", "Rows"],
  OrderAlerts: ["Symbol", "Source", "Side", "Type", "Size", "Current Price", "Order Price", "Lower 0.5x", "Upper 2x", "Reason"],
  MissingTpSlAlerts: ["Symbol", "Source", "Side", "Size", "Current Price", "Missing TP", "Missing SL", "Reason"]
};

const REQUIRED_SECRET_GROUPS = [
  ["BINANCE_API_KEY", "BINANCE_API_SECRET"],
  ["MEXC_API_KEY", "MEXC_API_SECRET"],
  ["BYBIT_API_KEY", "BYBIT_API_SECRET"],
  ["BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE"],
  ["PHEMEX_API_KEY", "PHEMEX_API_SECRET"],
  ["HYPERLIQUID_WALLET"],
  ["BACKPACK_API_KEY", "BACKPACK_API_SECRET"],
  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  ["POSITION_SHEET_WEBAPP_URL", "POSITION_SHEET_SECRET"]
];

const RELAY_REPLACED_SECRET_GROUPS = new Set(["BINANCE_API_KEY", "BYBIT_API_KEY"]);

export function missingRequiredSecrets(env = process.env) {
  const relayEnabled = Boolean(String(env.POSITION_RELAY_URL || "").trim()
    || String(env.POSITION_RELAY_TOKEN || "").trim());
  const groups = relayEnabled
    ? [
      ...REQUIRED_SECRET_GROUPS.filter(([first]) => !RELAY_REPLACED_SECRET_GROUPS.has(first)),
      ["POSITION_RELAY_URL", "POSITION_RELAY_TOKEN"]
    ]
    : REQUIRED_SECRET_GROUPS;
  return groups.flat().filter((name) => !String(env[name] || "").trim());
}

export function buildPositionSheetSnapshot(state, { telegramSent = false, telegramError = "" } = {}) {
  const checkedAt = state.lastCheckedAt || new Date().toISOString();
  const alertCount = state.alerts.length + state.orderAlerts.length + state.missingTpSlAlerts.length;
  const warnings = Array.isArray(state.integrity?.warnings) ? state.integrity.warnings : [];
  const positions = [...state.positions].sort(compareRows);
  const orders = [...state.orders].sort(compareRows);
  const orderCounts = new Map();

  for (const order of orders) {
    const key = `${order.source}:${order.symbol}`;
    orderCounts.set(key, (orderCounts.get(key) || 0) + 1);
  }

  const summary = [
    SHEET_HEADERS.Summary,
    ["Checked UTC", checkedAt],
    ["Status", warnings.length > 0 ? "Degraded" : "Healthy"],
    ["Positions", state.positions.length],
    ["Orders", state.orders.length],
    ["Position Alerts", state.alerts.length],
    ["Order Alerts", state.orderAlerts.length],
    ["Missing TP/SL Alerts", state.missingTpSlAlerts.length],
    ["Total Alerts", alertCount],
    ["Integrity Warnings", safeText(warnings.join(", "))],
    ["Ignored Symbols", safeText((state.ignoredSymbols || []).join(", "))],
    ["Order Ignored Symbols", safeText((state.orderIgnoredSymbols || []).join(", "))],
    ["Missing TP/SL Ignored Symbols", safeText((state.missingTpSlIgnoredSymbols || []).join(", "))]
  ];

  for (const [exchange, coverage] of Object.entries(state.integrity?.coverage || {}).sort()) {
    summary.push([
      safeText(`Coverage ${exchange}`),
      safeText(`positions=${coverage.positions}; orders=${coverage.orders}; transport=${coverage.transport}`)
    ]);
  }

  const positionRows = positions.map((position) => [
    safeText(position.symbol),
    safeText(position.source),
    safeText(position.side),
    numberCell(position.size),
    numberCell(position.price),
    orderCounts.get(`${position.source}:${position.symbol}`) || 0
  ]);

  const orderRows = orders.map((order) => [
    safeText(order.symbol),
    safeText(order.source),
    safeText(order.side),
    numberCell(order.size),
    numberCell(order.price),
    numberCell(order.triggerPrice),
    numberCell(order.watchPrice || order.triggerPrice || order.price),
    safeText(order.type),
    safeText(order.status)
  ]);

  const positionAlertRows = [...state.alerts].sort(compareRows).map((alert) => [
    safeText(alert.symbol),
    safeText(alert.reason),
    numberCell(alert.long),
    numberCell(alert.short),
    numberCell(alert.diff),
    safeText((alert.rows || [])
      .map((row) => `${row.source}:${row.side}:${numberCell(row.size)}`)
      .join("; "))
  ]);

  const orderAlertRows = [...state.orderAlerts].sort(compareRows).map((alert) => [
    safeText(alert.symbol),
    safeText(alert.source),
    safeText(alert.side),
    safeText(alert.type),
    numberCell(alert.size),
    numberCell(alert.currentPrice),
    numberCell(alert.orderPrice || alert.watchPrice),
    numberCell(alert.lowerBound),
    numberCell(alert.upperBound),
    safeText(alert.reason)
  ]);

  const missingTpSlAlertRows = [...state.missingTpSlAlerts].sort(compareRows).map((alert) => [
    safeText(alert.symbol),
    safeText(alert.source),
    safeText(alert.side),
    numberCell(alert.size),
    numberCell(alert.currentPrice),
    alert.missingTp ? "YES" : "NO",
    alert.missingSl ? "YES" : "NO",
    safeText(alert.reason)
  ]);

  return {
    sheets: {
      Summary: summary,
      Positions: [SHEET_HEADERS.Positions, ...positionRows],
      Orders: [SHEET_HEADERS.Orders, ...orderRows],
      Alerts: [SHEET_HEADERS.Alerts, ...positionAlertRows],
      OrderAlerts: [SHEET_HEADERS.OrderAlerts, ...orderAlertRows],
      MissingTpSlAlerts: [SHEET_HEADERS.MissingTpSlAlerts, ...missingTpSlAlertRows]
    },
    run: [
      checkedAt,
      state.positions.length,
      alertCount,
      "",
      telegramSent ? "YES" : "NO",
      safeText(telegramError)
    ]
  };
}

export function failedExchangeNames(errors = []) {
  return [...new Set(errors.map((error) => {
    const prefix = String(error || "").split(":", 1)[0].trim().toLowerCase();
    return prefix.replace(/_orders$/, "");
  }).filter((name) => /^[a-z0-9_-]+$/.test(name)))].sort();
}

export function failedExchangeDiagnostics(errors = []) {
  const diagnostics = new Map();
  for (const error of errors) {
    const [name] = failedExchangeNames([error]);
    if (!name) continue;
    const message = String(error || "");
    let category = "unknown";
    const http = message.match(/\bHTTP\s+(\d{3})\b/i);
    const apiCode = message.match(/\berror:\s*(-?\d+)\b/i) || message.match(/["']code["']\s*:\s*(-?\d+)\b/i);
    if (http) category = `http_${http[1]}`;
    else if (apiCode) category = `api_code_${apiCode[1]}`;
    else if (/fetch failed|network|timed?\s*out|timeout/i.test(message)) category = "network";
    else if (/country|region|restricted|not available|access denied|forbidden|ip address/i.test(message)) category = "geo_or_access";
    else if (/api.?key|signature|permission|unauthorized/i.test(message)) category = "authentication";
    else if (/rate.?limit|too many requests/i.test(message)) category = "rate_limit";
    if (!diagnostics.has(name)) diagnostics.set(name, new Set());
    diagnostics.get(name).add(category);
  }
  return [...diagnostics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, categories]) => `${name}=${[...categories].sort().join("+")}`);
}

export function buildFailureMessage(errors, checkedAt = new Date().toISOString()) {
  const names = failedExchangeNames(errors);
  return [
    "Position monitor failed closed",
    `Time: ${checkedAt}`,
    `Failed: ${names.join(", ") || "unknown"}`,
    "Google Sheet was not overwritten."
  ].join("\n");
}

export function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export async function writePositionSheet({ url, secret, snapshot, fetchImpl = fetch }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw new Error("POSITION_SHEET_WEBAPP_URL must use HTTPS");
  const response = await fetchImpl(parsedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      action: "writePositionSnapshot",
      sheets: snapshot.sheets,
      run: snapshot.run
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Sheet write failed with HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result?.ok) throw new Error("Sheet write was rejected");
  return result;
}

export async function readPositionSheetIgnores({ url, secret, fetchImpl = fetch }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw new Error("POSITION_SHEET_WEBAPP_URL must use HTTPS");
  const response = await fetchImpl(parsedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      action: "readIgnoreConfig"
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Sheet ignore read failed with HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result?.ok || !result.ignores || typeof result.ignores !== "object") {
    throw new Error("Sheet ignore read was rejected");
  }
  return {
    ignoreSymbols: normalizeIgnoreList(result.ignores.ignoreSymbols),
    orderIgnoreSymbols: normalizeIgnoreList(result.ignores.orderIgnoreSymbols),
    missingTpSlIgnoreSymbols: normalizeIgnoreList(result.ignores.missingTpSlIgnoreSymbols)
  };
}

function compareRows(left, right) {
  return String(left.symbol || "").localeCompare(String(right.symbol || ""))
    || String(left.source || "").localeCompare(String(right.source || ""))
    || String(left.side || "").localeCompare(String(right.side || ""));
}

function numberCell(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function safeText(value) {
  const text = String(value || "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function normalizeIgnoreList(values) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error("Sheet ignore config is invalid");
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
