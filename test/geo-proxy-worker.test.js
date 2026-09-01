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

test("authenticated Binance WebSocket diagnostic returns sanitized method results", async () => {
  const sentRequests = [];
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        sentRequests.push(request);
        const successful = request.method === "v2/account.position";
        const response = successful
          ? { id: request.id, status: 200, result: [{ symbol: "PRIVATE", positionAmt: "1" }] }
          : { id: request.id, status: 400, error: { code: -1002, msg: "private upstream detail" } };
        queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify(response) }));
      },
      close() {}
    };
  };

  const response = await handleRequest(
    new Request("https://worker.test/diagnostics/binance-ws", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    ENV,
    async () => { throw new Error("must not fetch"); },
    webSocketFactory
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    methods: {
      positions: { status: 200, count: 1 },
      openOrders: { status: 400, code: "api_-1002" },
      openAlgoOrders: { status: 400, code: "api_-1002" },
      algoOrders: { status: 400, code: "api_-1002" }
    }
  });
  assert.equal(sentRequests.length, 4);
  for (const request of sentRequests) {
    assert.equal(request.params.apiKey, "binance-key");
    assert.match(request.params.signature, /^[0-9a-f]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|private upstream|binance-key|signature/);
});

test("Binance WebSocket diagnostic stops after a sanitized position connection failure", async () => {
  let connectionCount = 0;
  const webSocketFactory = () => {
    connectionCount += 1;
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send() {
        queueMicrotask(() => listeners.get("close")?.({ code: 1006, reason: "private detail" }));
      },
      close() {}
    };
  };

  const response = await handleRequest(
    new Request("https://worker.test/diagnostics/binance-ws", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    ENV,
    async () => { throw new Error("must not fetch"); },
    webSocketFactory
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    methods: {
      positions: { status: 0, code: "ws_closed_1006_after_open" }
    }
  });
  assert.equal(connectionCount, 1);
  assert.doesNotMatch(JSON.stringify(body), /private detail|binance-key|signature/);
});

test("rejects unauthenticated Binance WebSocket diagnostics", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/diagnostics/binance-ws", { method: "POST" }),
    ENV,
    async () => { throw new Error("must not fetch"); },
    () => { throw new Error("must not open websocket"); }
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false });
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
      if (url.hostname.includes("binance")) {
        return Response.json(
          { code: -1003, msg: "private rate-limit detail" },
          { status: 429, headers: { "retry-after": "42" } }
        );
      }
      return Response.json({ retCode: 0, result: { list: [] } });
    }
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    failed: ["binance"],
    failureCodes: { binance: "api_-1003" },
    retryAfterSeconds: { binance: 42 }
  });
  assert.doesNotMatch(JSON.stringify(body), /private|rate-limit detail/);
});
