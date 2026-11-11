import { accountIndex, lighterFunding, lighterGet, readToken } from "./lighter.mjs";

const epsilon = 1e-8;

export function closedLighterTrades(trades, start, end) {
  const states = new Map();
  const closed = [];
  for (const trade of trades) {
    if (trade.market_kind !== "perps" || trade.timestamp > end) continue;
    const ask = trade.ask_account_id === accountIndex;
    const bid = trade.bid_account_id === accountIndex;
    if (ask === bid) throw Error("Ambiguous Lighter fill ownership");
    const role = ask === trade.is_maker_ask ? "maker" : "taker";
    const before = Number(trade[role + "_position_size_before"]);
    const qty = Number(trade.size);
    const price = Number(trade.price);
    const at = Number(trade.timestamp);
    if (![before, qty, price, at].every(Number.isFinite) || qty <= 0 || price <= 0 || !trade.trade_id_str)
      throw Error("Invalid Lighter fill");
    const market = trade.market_id;
    const after = before + (ask ? -qty : qty);
    const increases = Math.abs(before) < epsilon || Math.sign(before) === (ask ? -1 : 1);
    let state = states.get(market);
    if (Math.abs(before) < epsilon) state = { qty: 0, openedAt: at, entered: 0, entryValue: 0, exited: 0, exitValue: 0, pricePnl: 0, maxQty: 0 };
    if (state && Math.abs(state.qty - before) > epsilon) throw Error("Lighter fill history discontinuity");
    if (state) {
      state.qty = after;
      if (Number(trade[role + "_fee"] || 0) || Number(trade["integrator_" + role + "_fee"] || 0)) state.hasFee = true;
      if (increases) {
        state.entered += qty;
        state.entryValue += qty * price;
        state.maxQty = Math.max(state.maxQty, Math.abs(after));
      } else {
        const amount = Math.min(Math.abs(before), qty);
        const realized = trade[ask ? "ask_account_pnl" : "bid_account_pnl"];
        if (realized == null || !Number.isFinite(Number(realized))) state.missingPnl = true;
        else state.pricePnl += Number(realized);
        state.exited += amount;
        state.exitValue += amount * price;
      }
      states.set(market, state);
    }
    if (increases || (Math.abs(after) >= epsilon && Math.sign(after) === Math.sign(before))) continue;
    if (at >= start) {
      if (!state || state.missingPnl || state.hasFee) throw Error("Lighter closed position requires PNL/fee reconciliation");
      closed.push({
        exchange: "lighter", market, symbol: trade.market_symbol, side: before > 0 ? "long" : "short",
        qty: state.maxQty, pricePnl: state.pricePnl, entryPrice: state.entryValue / state.entered,
        closePrice: state.exitValue / state.exited, openedAt: state.openedAt, closedAt: at,
        id: `${accountIndex}:${market}:${trade.trade_id_str}`
      });
    }
    states.delete(market);
    if (Math.abs(after) >= epsilon) {
      states.set(market, {
        qty: after, openedAt: at, entered: Math.abs(after), entryValue: Math.abs(after) * price,
        exited: 0, exitValue: 0, pricePnl: 0, maxQty: Math.abs(after), hasFee: state?.hasFee
      });
    }
  }
  return closed;
}

export async function fetchLighterWeekly(env, startMs, endMs) {
  const token = await readToken(env);
  if (!token) throw Error("Lighter read-only token missing");
  const fills = new Map();
  const cursors = new Set();
  const lookback = startMs - 90 * 86400000;
  let cursor;
  let complete = false;
  for (let page = 0; page < 100; page++) {
    const data = await lighterGet("trades", {
      account_index: accountIndex, sort_by: "timestamp", sort_dir: "desc", limit: 100,
      ...(cursor ? { cursor } : {})
    }, token);
    if (!Array.isArray(data.trades)) throw Error("Lighter trade history missing");
    for (const fill of data.trades) {
      if (!fill.trade_id_str || !Number.isFinite(Number(fill.timestamp))) throw Error("Invalid Lighter trade history row");
      if (fill.timestamp >= lookback) fills.set(fill.trade_id_str, fill);
    }
    cursor = data.next_cursor;
    if (!cursor || data.trades.some(fill => fill.timestamp < lookback)) { complete = true; break; }
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  if (!complete) throw Error("Lighter trade pagination incomplete");
  const trades = [...fills.values()].sort((a, b) => a.timestamp - b.timestamp ||
    (BigInt(a.trade_id_str) < BigInt(b.trade_id_str) ? -1 : 1));
  const closed = closedLighterTrades(trades, startMs, endMs);
  if (!closed.length) return closed;
  const funding = await lighterFunding(Math.min(...closed.map(r => r.openedAt)), endMs, token);
  return closed.map(row => {
    const fundingPnl = funding.filter(f => f.market_id === row.market && f.position_side === row.side &&
      f.timestamp >= row.openedAt && f.timestamp < row.closedAt).reduce((sum, f) => sum + f.amount, 0);
    return { ...row, fundingPnl, pnl: row.pricePnl + fundingPnl };
  });
}
