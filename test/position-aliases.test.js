import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSymbol, makePosition, analyzePositions } from "../lib/position-utils.js";
import { normalizePair } from "../lib/weekly-pnl.js";

test("maps only the mkts USBOND contract to its TLT display symbol", () => {
  assert.equal(normalizeSymbol("mkts:USBOND"), "TLT");
  assert.equal(normalizeSymbol("USBOND"), "USBOND");
  assert.equal(normalizeSymbol("other:USBOND"), "USBOND");
  assert.deepEqual(analyzePositions([
    makePosition({ symbol: "mkts:USBOND", source: "hyperliquid", side: "long", size: 40 }),
    makePosition({ symbol: "TLT_USDT", source: "mexc", side: "short", size: 40 })
  ]).alerts, []);
});

test("META.US aliases balance without scaling in positions and weekly PNL", () => {
  for (const symbol of ["META", "META.US", "META.US_USDC_PERP", "METASTOCK_USDT"]) {
    assert.equal(normalizeSymbol(symbol), "META");
    assert.equal(normalizePair(symbol), "META");
  }
  const positions = [
    makePosition({ symbol: "METAUSDT", source: "bitget", side: "long", size: 12, price: 500 }),
    makePosition({ symbol: "META.US_USDC_PERP", source: "backpack", side: "short", size: 12, price: 501 })
  ];
  assert.deepEqual(positions.map(p => [p.size, p.price]), [[12, 500], [12, 501]]);
  assert.deepEqual(analyzePositions(positions).alerts, []);
});

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
