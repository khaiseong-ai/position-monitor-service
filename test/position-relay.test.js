import assert from "node:assert/strict";
import test from "node:test";
import { fetchPositionRelay } from "../lib/position-relay.js";

const CONFIG = {
  url: "https://relay.example.test/state",
  token: "relay-token",
  exchanges: ["binance", "bybit"],
  credentials: {
    binance: { apiKey: "binance-key", apiSecret: "binance-secret" },
    bybit: { apiKey: "bybit-key", apiSecret: "bybit-secret" }
  }
};

async function withStaticRelayAuth(callback) {
  const names = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("accepts only normalized relay state for configured exchanges", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), CONFIG.url);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer relay-token");
    assert.deepEqual(JSON.parse(options.body), {
      exchanges: ["binance", "bybit"],
      credentials: CONFIG.credentials
    });
    return Response.json({
      ok: true,
      checkedAt: "2026-09-01T12:00:00.000Z",
      positions: [
        { symbol: "BTCUSDT", source: "binance", side: "long", size: 2, price: 100, private: "hidden" },
        { symbol: "IGNORED", source: "mexc", side: "long", size: 1, price: 1 }
      ],
      orders: [],
      coverage: {
        binance: { positions: "complete", orders: "unavailable", transport: "websocket" },
        bybit: { positions: "complete", orders: "complete", transport: "rest" }
      },
      warnings: ["binance_orders_unavailable", "unsafe warning text!"]
    });
  };

  await withStaticRelayAuth(async () => {
    const state = await fetchPositionRelay(CONFIG, fetchImpl);
    assert.deepEqual(state.positions, [
      { symbol: "BTC", source: "binance", side: "long", size: 2, price: 100, raw: undefined }
    ]);
    assert.deepEqual(state.orders, []);
    assert.deepEqual(state.warnings, ["binance_orders_unavailable"]);
    assert.equal(state.coverage.binance.orders, "unavailable");
    assert.doesNotMatch(JSON.stringify(state), /hidden/);
  });
});

test("rejects incomplete relay position coverage", async () => {
  const fetchImpl = async () => Response.json({
    ok: true,
    positions: [],
    orders: [],
    coverage: {
      binance: { positions: "unavailable", orders: "unavailable", transport: "websocket" },
      bybit: { positions: "complete", orders: "complete", transport: "rest" }
    }
  });
  await withStaticRelayAuth(() => assert.rejects(
    () => fetchPositionRelay(CONFIG, fetchImpl),
    /coverage is incomplete for binance/
  ));
});
