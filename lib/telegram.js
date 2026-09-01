import { formatSize } from "./position-utils.js";

export async function sendTelegram(config, text) {
  if (!config.botToken || !config.chatId) return { skipped: true, reason: "telegram_not_configured" };
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(`Telegram failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

export function buildAlertMessage(positionAlerts, source = "poll", orderAlerts = [], missingTpSlAlerts = []) {
  const lines = [
    "Position monitor alert",
    `Source: ${source}`,
    `Time: ${new Date().toISOString()}`,
    ""
  ];

  if (positionAlerts.length > 0) lines.push("Position alerts:");
  for (const alert of positionAlerts.slice(0, 15)) {
    const reason = alert.reason === "single_leg" ? "single leg" : "long/short size imbalanced";
    lines.push(`${alert.symbol}: ${reason}`);
    lines.push(`Long ${formatSize(alert.long)} / Short ${formatSize(alert.short)} / Diff ${formatSize(alert.diff)}`);
    lines.push(alert.rows.map((row) => `${row.source} ${row.side} ${formatSize(row.size)}`).join("; "));
    lines.push("");
  }
  if (positionAlerts.length > 15) lines.push(`Other position alerts not shown: ${positionAlerts.length - 15}`);

  if (orderAlerts.length > 0) {
    lines.push("");
    lines.push("Order alerts:");
  }
  for (const alert of orderAlerts.slice(0, 15)) {
    lines.push(`${alert.symbol} ${alert.source}: order inside 0.5x-2x price band`);
    lines.push(`Current ${formatSize(alert.currentPrice)} / Order ${formatSize(alert.orderPrice)}`);
    lines.push(`Expected < ${formatSize(alert.lowerBound)} or > ${formatSize(alert.upperBound)}`);
    lines.push(`${alert.side} ${alert.type} size ${formatSize(alert.size)}`);
    lines.push("");
  }
  if (orderAlerts.length > 15) lines.push(`Other order alerts not shown: ${orderAlerts.length - 15}`);

  if (missingTpSlAlerts.length > 0) {
    lines.push("");
    lines.push("Missing TP/SL alerts:");
  }
  for (const alert of missingTpSlAlerts.slice(0, 15)) {
    lines.push(`${alert.symbol} ${alert.source} ${alert.side}: ${alert.reason}`);
    lines.push(`Size ${formatSize(alert.size)} / Current ${formatSize(alert.currentPrice)}`);
    lines.push("");
  }
  if (missingTpSlAlerts.length > 15) lines.push(`Other missing TP/SL alerts not shown: ${missingTpSlAlerts.length - 15}`);

  return escapeHtml(lines.join("\n"));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
