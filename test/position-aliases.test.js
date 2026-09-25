import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSymbol, makePosition, analyzePositions } from "../lib/position-utils.js";
import { normalizePair } from "../lib/weekly-pnl.js";

test("AMZN aliases balance 1:1 in positions and weekly PNL", () => {
  const symbols = ["AMZN", "AMZN.US", "AMZN.US_USDC_PERP", "AMZNSTOCK_USDT"];
  for (const symbol of symbols) {
    assert.equal(normalizeSymbol(symbol), "AMZN");
    assert.equal(normalizePair(symbol), "AMZN");
  }
  const positions = [
    makePosition({ symbol: "AMZNUSDT", source: "bitget", side: "long", size: 30, price: 200 }),
    makePosition({ symbol: "AMZN.US_USDC_PERP", source: "backpack", side: "short", size: 30, price: 201 })
  ];
  assert.deepEqual(positions.map(p => [p.size, p.price]), [[30, 200], [30, 201]]);
  assert.deepEqual(analyzePositions(positions).alerts, []);
  positions[1].size = 29;
  assert.equal(analyzePositions(positions).alerts.length, 1);
});

test("INTC and TRUMP aliases retain quantities and balance across exchanges", () => {
  const positions = [
    { symbol: "INTCUSDT", source: "bitget", side: "long", size: 30 },
    { symbol: "INTC.US_USDC_PERP", source: "backpack", side: "short", size: 30 },
    { symbol: "TRUMP_USDC_PERP", source: "backpack", side: "short", size: 2200 },
    { symbol: "TRUMPOFFICIAL_USDT", source: "mexc", side: "long", size: 2200 }
  ].map(makePosition);
  assert.deepEqual(positions.map((p) => p.symbol), ["INTC", "INTC", "TRUMP", "TRUMP"]);
  assert.deepEqual(positions.map((p) => p.size), [30, 30, 2200, 2200]);
  assert.deepEqual(analyzePositions(positions).alerts, []);
  positions[1].size = 29;
  assert.equal(analyzePositions(positions).alerts.length, 1);
  assert.equal(normalizeSymbol("INTC.US"), "INTC");
  assert.equal(normalizeSymbol("TRUMPOFFICIAL"), "TRUMP");
});
