import assert from "node:assert/strict";
import test from "node:test";
import { fetchMexc, fetchPhemex } from "../lib/exchanges.js";

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
