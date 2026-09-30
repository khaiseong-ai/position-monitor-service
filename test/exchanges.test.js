import assert from "node:assert/strict";
import test from "node:test";
import { fetchBinance, fetchBybit, fetchBybitOrders, fetchHyperliquid, fetchHyperliquidOrders, fetchMexc, fetchPhemex } from "../lib/exchanges.js";
import { normalizeSymbol, symbolUnitMultiplier } from "../lib/position-utils.js";
import { buildConfig } from "../lib/config.js";

test("includes mkts TLT positions and conditional orders", async (t) => {
  const dexes = buildConfig().exchanges.hyperliquid.dexes;
  assert.ok(dexes.includes("mkts"));
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(`${body.type}:${body.dex || ""}`);
    const match = body.dex === "mkts";
    return Response.json(body.type === "clearinghouseState"
      ? { assetPositions: match ? [{ position: { coin: "mkts:TLT", szi: "40", positionValue: "3140" } }] : [] }
      : match ? [{ coin: "mkts:TLT", side: "A", sz: "40", triggerPx: "200", orderType: "Take Profit Market", isTrigger: true }] : []);
  });
  const config = { wallet: "test-wallet", restBase: "https://example.test", dexes };
  const positions = await fetchHyperliquid(config);
  assert.equal(positions[0].symbol, "TLT");
  assert.equal(positions[0].size, 40);
  assert.equal(positions[0].side, "long");
  const orders = await fetchHyperliquidOrders(config, positions);
  assert.equal(orders[0].symbol, "TLT");
  assert.equal(orders[0].triggerPrice, 200);
  assert.ok(seen.includes("clearinghouseState:xyz"));
  assert.ok(seen.includes("frontendOpenOrders:mkts"));
});

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

test("converts Bybit bundled LUNC positions and orders exactly once", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ retCode: 0, result: { list: [
    { symbol: "1000LUNCUSDT", side: "Sell", size: "160000", qty: "160000", markPrice: "0.123", price: "0.2", triggerPrice: "0.18" },
    { symbol: "LUNCUSDT", side: "Buy", size: "160000000", qty: "160000000", markPrice: "0.000123", price: "0.0002", triggerPrice: "0.00018" }
  ] } }));
  const bybitConfig = { ...config, settleCoins: ["USDT"] };
  const positions = await fetchBybit(bybitConfig);
  for (const position of positions) {
    assert.equal(position.symbol, "LUNC");
    assert.equal(position.size, 160000000);
    assert.equal(position.price, 0.000123);
  }
  const orders = await fetchBybitOrders(bybitConfig);
  for (const order of orders) {
    assert.equal(order.size, 160000000);
    assert.equal(order.price, 0.0002);
    assert.ok(Math.abs(order.triggerPrice - 0.00018) < 1e-15);
  }
});

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
