import test from "node:test";
import assert from "node:assert/strict";
import { lighterPositions } from "../lib/lighter.mjs";
import { closedLighterTrades } from "../lib/lighter-weekly.mjs";

test("Lighter uses sign rather than unsigned position size", () => {
  const rows = lighterPositions({ positions: [
    { symbol: "ANTHROPIC", position: "2", sign: -1, position_value: "3600" },
    { symbol: "BTC", position: "0" }
  ] });
  assert.deepEqual(rows.map(({ raw, ...row }) => row), [{ symbol: "ANTHROPIC", side: "short", size: 2, price: 1800 }]);
});

test("Lighter closes a short only after both reducing fills and refuses incomplete PNL", () => {
  const base = { market_kind: "perps", market_id: 193, market_symbol: "ANTHROPIC", price: "1800" };
  const fills = [
    { ...base, trade_id_str: "1", timestamp: 1, ask_account_id: 14825, bid_account_id: 1, is_maker_ask: false, size: "2", taker_position_size_before: "0" },
    { ...base, trade_id_str: "2", timestamp: 2, ask_account_id: 1, bid_account_id: 14825, is_maker_ask: true, size: "1", taker_position_size_before: "-2", bid_account_pnl: "10" },
    { ...base, trade_id_str: "3", timestamp: 3, ask_account_id: 1, bid_account_id: 14825, is_maker_ask: true, size: "1", taker_position_size_before: "-1", bid_account_pnl: "12" },
  ];
  assert.deepEqual(closedLighterTrades(fills.slice(0, 2), 0, 10), []);
  const [row] = closedLighterTrades(fills, 0, 10);
  assert.equal(row.pricePnl, 22);
  assert.equal(row.qty, 2);
  assert.equal(row.side, "short");
  assert.throws(() => closedLighterTrades(fills.slice(1), 0, 10), /reconciliation/);
});
