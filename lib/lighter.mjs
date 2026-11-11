import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const base = "https://mainnet.zklighter.elliot.ai/api/v1/";
export const accountIndex = 14825;
const wallet = "0x8bb349ca9e50e12a19f2fe9a97652cdf90595e9c";

export async function readToken(env = process.env) {
  if (env.LIGHTER_READ_TOKEN) return env.LIGHTER_READ_TOKEN.trim();
  if (!env.LOCALAPPDATA) return "";
  try {
    const file = path.join(env.LOCALAPPDATA, "Codex", "lighter-read-token");
    await fs.access(file);
    const script = '$ErrorActionPreference = "Stop"; $s = Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA "Codex/lighter-read-token") | ConvertTo-SecureString; [System.Net.NetworkCredential]::new("", $s).Password';
    try {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10000, env: childEnv });
      if (!stdout.trim()) throw Error("Empty credential");
      return stdout.trim();
    } catch {
      throw Error("Unable to decrypt Lighter read-only token for this Windows user");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

export async function lighterGet(endpoint, params = {}, token = "") {
  const response = await fetch(base + endpoint + "?" + new URLSearchParams(params), {
    headers: token ? { Authorization: token } : {},
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw Error(`Lighter ${endpoint} HTTP ${response.status}`);
  const data = await response.json();
  if (data.code !== 200) throw Error(`Lighter ${endpoint} rejected request (code ${Number(data.code)})`);
  return data;
}

export async function getLighterAccount() {
  const { accounts } = await lighterGet("account", { by: "index", value: accountIndex, active_only: true });
  const account = accounts?.find(row => row.index === accountIndex && row.l1_address?.toLowerCase() === wallet);
  if (!Array.isArray(account?.positions)) throw Error("Lighter account missing or mismatched");
  return account;
}

export function lighterPositions(account) {
  return account.positions.flatMap(row => {
    const size = Math.abs(Number(row.position));
    if (size === 0) return [];
    const value = Math.abs(Number(row.position_value));
    if (!Number.isFinite(size) || !Number.isFinite(value) || ![1, -1].includes(row.sign) || !row.symbol)
      throw Error("Invalid Lighter position");
    return [{ symbol: row.symbol, side: row.sign === -1 ? "short" : "long", size, price: value / size, raw: row }];
  });
}

export async function getLighterOrders(positions, token) {
  if (!token) throw Error("Lighter read-only token missing");
  const { orders } = await lighterGet("accountActiveOrders", { account_index: accountIndex }, token);
  if (!Array.isArray(orders)) throw Error("Lighter orders missing");
  return orders.filter(row => row.market_kind === "perps").map(row => {
    if (row.owner_account_index !== accountIndex || !row.order_id || !row.market_symbol || typeof row.is_ask !== "boolean")
      throw Error("Invalid Lighter order");
    const side = row.is_ask ? "sell" : "buy";
    const position = positions.find(p => p.raw.market_id === row.market_index && (p.side === "short") === (side === "buy"));
    const size = Number(row.remaining_base_amount);
    const fullClose = size === 0 && row.reduce_only === true && Number(row.trigger_price) > 0 && row.parent_order_id === "0";
    return { symbol: row.market_symbol, side, size: fullClose ? position?.size ?? 0 : size,
      price: Number(row.price), triggerPrice: Number(row.trigger_price), type: row.type, status: row.status, raw: row };
  });
}

export async function lighterFunding(startMs, endMs, token) {
  if (!token) throw Error("Lighter read-only token missing");
  const rows = new Map();
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const data = await lighterGet("positionFunding", {
      account_index: accountIndex, limit: 100, start_timestamp: Math.floor(startMs / 1000),
      end_timestamp: Math.ceil(endMs / 1000), ...(cursor ? { cursor } : {})
    }, token);
    if (!Array.isArray(data.position_fundings)) throw Error("Lighter funding history missing");
    for (const row of data.position_fundings) {
      const timestamp = Number(row.timestamp) * 1000;
      const amount = Number(row.change);
      if (!Number.isFinite(timestamp) || !Number.isFinite(amount)) throw Error("Invalid Lighter funding record");
      if (timestamp >= startMs && timestamp <= endMs) rows.set(`${row.market_id}:${row.funding_id}`, { ...row, timestamp, amount });
    }
    cursor = data.next_cursor;
    if (!cursor) return [...rows.values()].sort((a, b) => b.timestamp - a.timestamp);
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw Error("Lighter funding pagination incomplete");
}
