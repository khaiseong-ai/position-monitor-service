import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSymbol, makePosition, analyzePositions } from "../lib/position-utils.js";
import { normalizePair } from "../lib/weekly-pnl.js";

const pairs = [["GOOGL.US", "GOOGL"], ["NGAS", "NATGAS"], ["TESLA", "TSLA"], ["TSLA.US", "TSLA"], ["QNTSTOCK", "QNTX"], ["USDESTOCK", "USDEX"]];
for (const [alias, canonical] of pairs) {
  test(alias + " maps without changing quantity or price", () => {
    for (const suffix of ["", "_USDT", "_USDC_PERP"]) {
      assert.equal(normalizeSymbol(alias + suffix), canonical);
      assert.equal(normalizePair(alias + suffix), canonical);
    }
    const positions = [
      makePosition({ symbol: alias + "_USDT", source: "mexc", side: "long", size: 4, price: 12 }),
      makePosition({ symbol: canonical, source: "binance", side: "short", size: 4, price: 12 })
    ];
    assert.deepEqual(positions.map(p => [p.size, p.price]), [[4, 12], [4, 12]]);
    assert.deepEqual(analyzePositions(positions).alerts, []);
  });
}
test("crypto QNT and USDE remain separate from stocks", () => {
  for (const fn of [normalizeSymbol, normalizePair]) {
    assert.equal(fn("QNT_USDT"), "QNT");
    assert.equal(fn("USDE_USDT"), "USDE");
    assert.equal(fn("QNT.US_USDC_PERP"), "QNTX");
    assert.equal(fn("USDE.US_USDC_PERP"), "USDEX");
  }
});
