const HEADER = [
  "Checked UTC",
  "Type",
  "Symbol",
  "Exchange",
  "Side",
  "Size",
  "Current Price",
  "Order Price",
  "Value USD",
  "Long Total",
  "Short Total",
  "Details"
];

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

export function missingRequiredSecrets(env = process.env) {
  return REQUIRED_SECRET_GROUPS.flat().filter((name) => !String(env[name] || "").trim());
}

export function buildSheetRows(state) {
  const checkedAt = state.lastCheckedAt || new Date().toISOString();
  const rows = [HEADER];
  const alertCount = state.alerts.length + state.orderAlerts.length + state.missingTpSlAlerts.length;
  rows.push([
    checkedAt,
    "STATUS",
    "",
    "",
    "",
    state.positions.length,
    "",
    state.orders.length,
    "",
    "",
    "",
    `Healthy; ${alertCount} alert(s)`
  ]);

  for (const position of [...state.positions].sort(compareRows)) {
    rows.push([
      checkedAt,
      "POSITION",
      safeText(position.symbol),
      safeText(position.source),
      safeText(position.side),
      numberCell(position.size),
      numberCell(position.price),
      "",
      numberCell(Math.abs(Number(position.size) * Number(position.price))),
      "",
      "",
      ""
    ]);
  }

  for (const order of [...state.orders].sort(compareRows)) {
    rows.push([
      checkedAt,
      "ORDER",
      safeText(order.symbol),
      safeText(order.source),
      safeText(order.side),
      numberCell(order.size),
      "",
      numberCell(order.watchPrice || order.triggerPrice || order.price),
      "",
      "",
      "",
      safeText([order.type, order.status].filter(Boolean).join(" / "))
    ]);
  }

  for (const alert of [...state.alerts].sort(compareRows)) {
    rows.push([
      checkedAt,
      "POSITION_ALERT",
      safeText(alert.symbol),
      "",
      "",
      numberCell(alert.diff),
      "",
      "",
      "",
      numberCell(alert.long),
      numberCell(alert.short),
      safeText(alert.reason)
    ]);
  }

  for (const alert of [...state.orderAlerts].sort(compareRows)) {
    rows.push([
      checkedAt,
      "ORDER_ALERT",
      safeText(alert.symbol),
      safeText(alert.source),
      safeText(alert.side),
      numberCell(alert.size),
      numberCell(alert.currentPrice),
      numberCell(alert.orderPrice || alert.watchPrice),
      "",
      "",
      "",
      "Order is inside the 0.5x-2x price band"
    ]);
  }

  for (const alert of [...state.missingTpSlAlerts].sort(compareRows)) {
    rows.push([
      checkedAt,
      "TP_SL_ALERT",
      safeText(alert.symbol),
      safeText(alert.source),
      safeText(alert.side),
      numberCell(alert.size),
      numberCell(alert.currentPrice),
      "",
      "",
      "",
      "",
      safeText(alert.reason)
    ]);
  }

  return rows;
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

export async function writePositionSheet({ url, secret, sheetName, rows, fetchImpl = fetch }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw new Error("POSITION_SHEET_WEBAPP_URL must use HTTPS");
  const response = await fetchImpl(parsedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      action: "writeSheet",
      sheetName,
      rows
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Sheet write failed with HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result?.ok) throw new Error("Sheet write was rejected");
  return result;
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
