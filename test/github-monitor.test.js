import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFailureMessage,
  buildPositionSheetSnapshot,
  envFlag,
  failedExchangeDiagnostics,
  failedExchangeNames,
  missingRequiredSecrets,
  readPositionSheetIgnores,
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
    missingTpSlAlerts: [{ symbol: "BTC", source: "backpack", side: "short", size: 2, currentPrice: 101, reason: "missing_sl" }],
    ignoredSymbols: ["DOGE"],
    orderIgnoredSymbols: ["ETH"],
    missingTpSlIgnoredSymbols: ["SOL"]
  };
}

test("builds the original position workbook tabs and protects formula-like text", () => {
  const snapshot = buildPositionSheetSnapshot(sampleState());
  assert.deepEqual(Object.keys(snapshot.sheets), [
    "Summary", "Positions", "Orders", "Alerts", "OrderAlerts", "MissingTpSlAlerts"
  ]);
  assert.deepEqual(snapshot.sheets.Positions[0], ["Symbol", "Source", "Side", "Size", "Price", "Orders"]);
  assert.equal(snapshot.sheets.Positions.length, 3);
  assert.equal(snapshot.sheets.Positions.find((row) => row[1] === "binance")[5], 1);
  assert.equal(snapshot.sheets.Alerts[1][0], "'=FORMULA");
  assert.deepEqual(snapshot.sheets.Summary.find((row) => row[0] === "Ignored Symbols"), ["Ignored Symbols", "DOGE"]);
  assert.deepEqual(snapshot.run.slice(0, 5), ["2026-09-01T12:00:00.000Z", 2, 3, "", "NO"]);
});

test("writes degraded relay coverage into the status snapshot", () => {
  const state = sampleState();
  state.integrity = {
    coverage: {
      binance: { positions: "complete", orders: "unavailable", transport: "websocket" }
    },
    warnings: ["binance_orders_unavailable"]
  };
  const snapshot = buildPositionSheetSnapshot(state);
  assert.deepEqual(snapshot.sheets.Summary.find((row) => row[0] === "Status"), ["Status", "Degraded"]);
  assert.match(snapshot.sheets.Summary.find((row) => row[0] === "Integrity Warnings")[1], /binance_orders_unavailable/);
  assert.match(snapshot.sheets.Summary.find((row) => row[0] === "Coverage binance")[1], /orders=unavailable/);
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
    "mexc_orders: fetch failed: private response",
    "phemex: access from this country is restricted"
  ]);
  assert.deepEqual(diagnostics, ["binance=http_451", "bybit=api_code_10003", "mexc=network", "phemex=geo_or_access"]);
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

  delete env.BINANCE_API_KEY;
  delete env.BINANCE_API_SECRET;
  delete env.BYBIT_API_KEY;
  env.POSITION_RELAY_URL = "https://relay.example.test/state";
  env.POSITION_RELAY_TOKEN = "configured";
  assert.deepEqual(missingRequiredSecrets(env), []);
  delete env.POSITION_RELAY_TOKEN;
  assert.deepEqual(missingRequiredSecrets(env), ["POSITION_RELAY_TOKEN"]);
});

test("parses notification flags", () => {
  assert.equal(envFlag("true"), true);
  assert.equal(envFlag("1"), true);
  assert.equal(envFlag("false"), false);
});

test("posts only the expected multi-tab position payload", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await writePositionSheet({
    url: "https://example.test/exec",
    secret: "secret",
    snapshot: {
      sheets: { Summary: [["Key", "Value"]] },
      run: ["checked", 0, 0, "", "NO", ""]
    },
    fetchImpl
  });
  const payload = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://example.test/exec");
  assert.deepEqual(payload, {
    secret: "secret",
    action: "writePositionSnapshot",
    sheets: { Summary: [["Key", "Value"]] },
    run: ["checked", 0, 0, "", "NO", ""]
  });
});

test("reads and normalizes all three original ignore lists", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), options };
    return {
      ok: true,
      json: async () => ({
        ok: true,
        ignores: {
          ignoreSymbols: ["BTC", " BTC ", ""],
          orderIgnoreSymbols: ["ETH"],
          missingTpSlIgnoreSymbols: ["SOL"]
        }
      })
    };
  };
  const ignores = await readPositionSheetIgnores({
    url: "https://example.test/exec",
    secret: "secret",
    fetchImpl
  });
  assert.deepEqual(ignores, {
    ignoreSymbols: ["BTC"],
    orderIgnoreSymbols: ["ETH"],
    missingTpSlIgnoreSymbols: ["SOL"]
  });
  assert.equal(captured.url, "https://example.test/exec");
  assert.deepEqual(JSON.parse(captured.options.body), {
    secret: "secret",
    action: "readIgnoreConfig"
  });
});
