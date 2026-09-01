import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../cloudflare/position-geo-proxy/src/index.js";

const ENV = {
  PROXY_TOKEN: "test-token",
  BINANCE_API_KEY: "binance-key",
  BINANCE_API_SECRET: "binance-secret",
  BYBIT_API_KEY: "bybit-key",
  BYBIT_API_SECRET: "bybit-secret"
};

test("rejects unauthenticated state requests without calling exchanges", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/state", { method: "POST" }),
    ENV,
    async () => { throw new Error("must not fetch"); }
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("public probe returns status categories only", async () => {
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send() { queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify({ status: 200 }) })); },
      close() {}
    };
  };
  const response = await handleRequest(
    new Request("https://worker.test/probe"),
    {},
    async (url) => String(url).includes("bybit")
      ? new Response("Access denied", { status: 403 })
      : new Response("private ban detail", { status: 418, headers: { "retry-after": "120" } }),
    webSocketFactory
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    endpoints: {
      binance: "http_418_retry_120",
      binanceWs: "ws_200",
      bybit: "http_403_access"
    }
  });
  assert.doesNotMatch(JSON.stringify(body), /private|ban detail/);
});

test("returns only normalized Binance and Bybit state", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/fapi/v3/positionRisk") {
      return Response.json([
        { symbol: "BTCUSDT", positionAmt: "2", markPrice: "100", accountAlias: "private" },
        { symbol: "ETHUSDT", positionAmt: "0", markPrice: "10" }
      ]);
    }
    if (url.pathname === "/fapi/v1/openOrders") {
      return Response.json([{ symbol: "BTCUSDT", side: "SELL", origQty: "2", price: "130", type: "LIMIT", status: "NEW" }]);
    }
    if (url.pathname === "/fapi/v1/openAlgoOrders") return Response.json([]);
    if (url.pathname === "/v5/position/list") {
      const rows = url.searchParams.get("settleCoin") === "USDT"
        ? [{ symbol: "SOLUSDT", side: "Sell", size: "3", markPrice: "20", accountId: "private" }]
        : [];
      return Response.json({ retCode: 0, result: { list: rows } });
    }
    if (url.pathname === "/v5/order/realtime") {
      const rows = url.searchParams.get("settleCoin") === "USDT"
        ? [{ symbol: "SOLUSDT", side: "Buy", qty: "3", price: "0", triggerPrice: "25", orderType: "Market", orderStatus: "Untriggered" }]
        : [];
      assert.equal(url.searchParams.has("orderFilter"), false);
      return Response.json({ retCode: 0, result: { list: rows } });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };

  const response = await handleRequest(
    new Request("https://worker.test/state", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    ENV,
    fetchImpl
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.positions, [
    { symbol: "BTC", source: "binance", side: "long", size: 2, price: 100 },
    { symbol: "SOL", source: "bybit", side: "short", size: 3, price: 20 }
  ]);
  assert.equal(body.orders.length, 2);
  assert.equal(body.orders[1].triggerPrice, 25);
  assert.doesNotMatch(JSON.stringify(body), /private|accountAlias|accountId/);
});

test("fails closed with exchange names and no upstream details", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/state", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    ENV,
    async (input) => {
      const url = new URL(input);
      if (url.hostname.includes("binance")) return new Response("private restriction detail", { status: 451 });
      return Response.json({ retCode: 0, result: { list: [] } });
    }
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    failed: ["binance"],
    failureCodes: { binance: "http_451" }
  });
  assert.doesNotMatch(JSON.stringify(body), /private|restriction/);
});
