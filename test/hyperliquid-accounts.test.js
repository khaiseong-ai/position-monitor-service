import assert from "node:assert/strict";
import test from "node:test";
import { fetchHyperliquid, fetchHyperliquidOrders } from "../lib/exchanges.js";
import { analyzeMissingTpSl, analyzePositions } from "../lib/position-utils.js";
import { fetchHyperliquid as fetchPnl } from "../lib/weekly-pnl.js";

test("multiple wallets keep positions and protective orders isolated and deduplicate addresses", async t => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    if (body.type === "clearinghouseState") return Response.json({ assetPositions: [
      { position: { coin: "BTC", szi: body.user === "first" ? "2" : "-2", positionValue: "200", entryPx: "100" } }
    ] });
    return Response.json(body.user === "first" ? [
      { coin: "BTC", side: "A", sz: "0", triggerPx: "200", orderType: "Take Profit Market" },
      { coin: "BTC", side: "A", sz: "0", triggerPx: "50", orderType: "Stop Market" }
    ] : []);
  });
  const config = { wallet: "FIRST", additionalWallets: ["first", "second", "SECOND"], restBase: "https://example.test", dexes: [] };
  const positions = await fetchHyperliquid(config);
  const orders = await fetchHyperliquidOrders(config, positions);
  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map(p => [p.source, p.account, p.side]), [
    ["hyperliquid", "first", "long"], ["hyperliquid_2", "second", "short"]
  ]);
  assert.deepEqual(analyzePositions(positions).alerts, []);
  assert.equal(orders[0].size, 2);
  const missing = analyzeMissingTpSl(positions, orders);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].source, "hyperliquid_2");
  assert.equal(seen.length, 4);
});

test("second-account failure rejects the combined collection", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) =>
    JSON.parse(options.body).user === "second"
      ? Response.json({ error: "unavailable" }, { status: 503 })
      : Response.json({ assetPositions: [] }));
  await assert.rejects(fetchHyperliquid({ wallet: "first", additionalWallets: ["second"], restBase: "https://example.test" }), /503/);
});

test("PNL isolates wallet lifecycles and preserves primary historical IDs", async t => {
  const start = Date.UTC(2026, 9, 30), end = start + 3600000;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.type === "userFunding") return Response.json([]);
    return Response.json([
      { coin: "BTC", startPosition: "0", sz: "2", side: "B", time: start + 1, px: "100", fee: "0" },
      { coin: "BTC", startPosition: "2", sz: "2", side: "A", time: start + 2, px: "110", closedPnl: "20", fee: "0", hash: "same" }
    ]);
  });
  const result = await fetchPnl({ HYPERLIQUID_WALLET: "first", HYPERLIQUID_ADDITIONAL_WALLETS: "second,FIRST" }, start, end);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, `BTC:same:${start + 2}`);
  assert.equal(result[1].id, `second:BTC:same:${start + 2}`);
  assert.deepEqual(result.map(row => [row.account, row.pnl]), [["first", 20], ["second", 20]]);
});
