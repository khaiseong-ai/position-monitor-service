import assert from "node:assert/strict";
import test from "node:test";
import { mergeBybitClosedPositions, normalizePair } from "../lib/weekly-pnl.js";

test("normalizes cross-exchange aliases and derivative suffixes", () => {
  assert.equal(normalizePair("DATAIPUSDT"), "DATA");
  assert.equal(normalizePair("DATA_USDT_PERP"), "DATA");
  assert.equal(normalizePair("MONAD_USDT"), "MON");
  assert.equal(normalizePair("MON-USDC"), "MON");
});

test("merges Bybit partial closes into one closed position", () => {
  const rows = [
    { exchange: "bybit", symbol: "SNOWUSDT", side: "short", pnl: -45.14210796, qty: 6.31,
      entryPrice: 322.96116, closePrice: 330.51, openedAt: 0, closedAt: 1786175601987, id: "first" },
    { exchange: "bybit", symbol: "SNOWUSDT", side: "short", pnl: -34.24636966, qty: 3.69,
      entryPrice: 322.96116, closePrice: 332.70639567, openedAt: 0, closedAt: 1786253536935, id: "last" }
  ];
  const [position] = mergeBybitClosedPositions(rows);
  assert.equal(position.qty, 10);
  assert.equal(position.pnl, -79.38847762);
  assert.ok(Math.abs(position.closePrice - 331.32047000223) < 1e-9);
  assert.equal(position.closedAt, 1786253536935);
});
