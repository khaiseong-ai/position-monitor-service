import { makeOrder, makePosition } from "./position-utils.js";

const COVERAGE_VALUES = new Set(["complete", "unavailable"]);
const TRANSPORT_VALUES = new Set(["rest", "websocket"]);

export async function fetchPositionRelay(config, fetchImpl = fetch) {
  const url = new URL(config.url);
  if (url.protocol !== "https:") throw new Error("position relay URL must use HTTPS");
  if (!String(config.token || "").trim()) throw new Error("position relay token is missing");

  const exchanges = config.exchanges.map((name) => String(name).toLowerCase());
  const credentials = Object.fromEntries(exchanges.flatMap((name) => {
    const value = config.credentials?.[name];
    return value ? [[name, value]] : [];
  }));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ exchanges, credentials }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`position relay HTTP ${response.status}`);

  const body = await response.json().catch(() => null);
  if (!body?.ok || !Array.isArray(body.positions) || !Array.isArray(body.orders)) {
    throw new Error("position relay returned an invalid response");
  }

  const expected = new Set(config.exchanges.map((name) => String(name).toLowerCase()));
  const coverage = sanitizeCoverage(body.coverage, expected);
  for (const name of expected) {
    if (!coverage[name] || coverage[name].positions !== "complete") {
      throw new Error(`position relay coverage is incomplete for ${name}`);
    }
  }

  const positions = body.positions.map((row) => {
    const source = String(row?.source || "").toLowerCase();
    if (!expected.has(source)) return null;
    return makePosition({
      symbol: row.symbol,
      source,
      side: row.side,
      size: row.size,
      price: row.price
    });
  }).filter(Boolean);

  const orders = body.orders.map((row) => {
    const source = String(row?.source || "").toLowerCase();
    if (!expected.has(source)) return null;
    return makeOrder({
      symbol: row.symbol,
      source,
      side: row.side,
      size: row.size,
      price: row.price,
      triggerPrice: row.triggerPrice,
      type: row.type,
      status: row.status
    });
  }).filter(Boolean);

  const warnings = Array.isArray(body.warnings)
    ? [...new Set(body.warnings.map((value) => String(value)).filter((value) => /^[a-z0-9_-]+$/i.test(value)))]
    : [];

  return {
    checkedAt: String(body.checkedAt || ""),
    positions,
    orders,
    coverage,
    warnings
  };
}

function sanitizeCoverage(value, expected) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawName, rawCoverage] of Object.entries(value)) {
    const name = String(rawName).toLowerCase();
    if (!expected.has(name) || !rawCoverage || typeof rawCoverage !== "object") continue;
    const positions = String(rawCoverage.positions || "");
    const orders = String(rawCoverage.orders || "");
    const transport = String(rawCoverage.transport || "");
    if (!COVERAGE_VALUES.has(positions) || !COVERAGE_VALUES.has(orders) || !TRANSPORT_VALUES.has(transport)) continue;
    result[name] = { positions, orders, transport };
  }
  return result;
}
