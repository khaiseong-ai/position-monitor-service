import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFailureMessage,
  buildSheetRows,
  envFlag,
  failedExchangeDiagnostics,
  failedExchangeNames,
  missingRequiredSecrets,
  writePositionSheet
} from "../lib/github-monitor.js";

function sampleState() {
  return {
    lastCheckedAt: "2026-09-01T12:00:00.000Z",
    positions: [
      { symbol: "BTC", source: "binance", side: "long", size: 2, price: 100 },
      { symbol: "BTC", source: "backpack", side: "short", size: 2, price: 101 }
    ],
    orders: [
      { symbol: "BTC", source: "binance", side: "sell", size: 2, watchPrice: 130, type: "stop", status: "open" }
    ],
    alerts: [{ symbol: "=FORMULA", long: 2, short: 1, diff: 1, reason: "size_mismatch" }],
    orderAlerts: [{ symbol: "BTC", source: "binance", side: "sell", size: 2, currentPrice: 100, orderPrice: 130 }],
    missingTpSlAlerts: [{ symbol: "BTC", source: "backpack", side: "short", size: 2, currentPrice: 101, reason: "missing_sl" }]
  };
}

test("builds a flat sheet snapshot and protects formula-like text", () => {
  const rows = buildSheetRows(sampleState());
  assert.equal(rows[0].length, 12);
  assert.equal(rows[1][1], "STATUS");
  assert.equal(rows.filter((row) => row[1] === "POSITION").length, 2);
  assert.equal(rows.find((row) => row[1] === "POSITION_ALERT")[2], "'=FORMULA");
  assert.equal(rows.find((row) => row[1] === "POSITION" && row[3] === "binance")[8], 200);
});

test("reduces exchange failures to safe labels", () => {
  const errors = [
    "bybit: bybit HTTP 401: private response",
    "bybit_orders: bybit HTTP 401: private response",
    "mexc: request failed"
  ];
  assert.deepEqual(failedExchangeNames(errors), ["bybit", "mexc"]);
  const message = buildFailureMessage(errors, "2026-09-01T12:00:00.000Z");
  assert.match(message, /Failed: bybit, mexc/);
  assert.doesNotMatch(message, /private response/);
});

test("classifies failures without logging exchange response text", () => {
  const diagnostics = failedExchangeDiagnostics([
    "binance: request HTTP 451: private response",
    "bybit: bybit positions error: 10003 private response",
    "mexc_orders: fetch failed: private response"
  ]);
  assert.deepEqual(diagnostics, ["binance=http_451", "bybit=api_code_10003", "mexc=network"]);
  assert.doesNotMatch(diagnostics.join(" "), /private response/);
});

test("requires all monitoring credentials without exposing values", () => {
  const env = Object.fromEntries([
    "BINANCE_API_KEY", "BINANCE_API_SECRET", "MEXC_API_KEY", "MEXC_API_SECRET",
    "BYBIT_API_KEY", "BYBIT_API_SECRET", "BITGET_API_KEY", "BITGET_API_SECRET",
    "BITGET_API_PASSPHRASE", "PHEMEX_API_KEY", "PHEMEX_API_SECRET",
    "HYPERLIQUID_WALLET", "BACKPACK_API_KEY", "BACKPACK_API_SECRET",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "POSITION_SHEET_WEBAPP_URL",
    "POSITION_SHEET_SECRET"
  ].map((name) => [name, "configured"]));
  assert.deepEqual(missingRequiredSecrets(env), []);
  delete env.BYBIT_API_SECRET;
  assert.deepEqual(missingRequiredSecrets(env), ["BYBIT_API_SECRET"]);
});

test("parses notification flags", () => {
  assert.equal(envFlag("true"), true);
  assert.equal(envFlag("1"), true);
  assert.equal(envFlag("false"), false);
});

test("posts only the expected writeSheet payload", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await writePositionSheet({
    url: "https://example.test/exec",
    secret: "secret",
    sheetName: "Position_Monitor",
    rows: [["header"]],
    fetchImpl
  });
  const payload = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://example.test/exec");
  assert.deepEqual(payload, {
    secret: "secret",
    action: "writeSheet",
    sheetName: "Position_Monitor",
    rows: [["header"]]
  });
});
