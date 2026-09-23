import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSymbol, makePosition, analyzePositions } from "../lib/position-utils.js";

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
