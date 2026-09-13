import assert from "node:assert/strict";
import test from "node:test";
import { fetchBinance, fetchMexc, fetchPhemex } from "../lib/exchanges.js";
import { normalizeSymbol, symbolUnitMultiplier } from "../lib/position-utils.js";

test("normalizes 1000LUNC to LUNC", () => {
  assert.equal(normalizeSymbol("1000LUNCUSDT"), "LUNC");
  assert.equal(normalizeSymbol("LUNC_USDT_PERP"), "LUNC");
  assert.equal(symbolUnitMultiplier("1000LUNCUSDT"), 1000);
  assert.equal(symbolUnitMultiplier("LUNCUSDT"), 1);
});

test("converts Binance 1000LUNC contracts to LUNC base units", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{
    symbol: "1000LUNCUSDT",
    positionAmt: "-60000",
    markPrice: "0.123"
  }])));

  const [position] = await fetchBinance({
    apiKey: "key",
    apiSecret: "secret",
    restBase: "https://example.test"
  });
  assert.equal(position.symbol, "LUNC");
  assert.equal(position.side, "short");
  assert.equal(position.size, 60000000);
  assert.equal(position.price, 0.000123);
});

const config = {
  apiKey: "key",
  apiSecret: "secret",
  restBase: "https://example.test",
  currency: "USDT",
  sizeMultipliers: {}
};

test("rejects an HTTP 200 MEXC API error instead of treating it as no positions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/private/position/")) {
      return new Response(JSON.stringify({ success: false, code: 602, message: "denied" }));
    }
    return new Response(JSON.stringify({ success: true, code: 0, data: [] }));
  });

  await assert.rejects(fetchMexc(config), /mexc .* error: 602/);
});

test("accepts a successful empty MEXC position response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify({ success: true, code: 0, data: [] }))
  ));

  assert.deepEqual(await fetchMexc(config), []);
});

test("falls back to the realtime Phemex position endpoint when the account snapshot is empty", async (t) => {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    const positions = String(url).includes("/g-accounts/positions")
      ? [{ symbol: "BTCUSDT", side: "Buy", sizeRq: "2", markPriceRp: "100" }]
      : [];
    return new Response(JSON.stringify({ code: 0, msg: "", data: { positions } }));
  });

  const positions = await fetchPhemex(config);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].source, "phemex");
  assert.equal(positions[0].side, "long");
  assert.equal(requested.length, 2);
  assert.match(requested[1], /\/g-accounts\/positions\?/);
});
