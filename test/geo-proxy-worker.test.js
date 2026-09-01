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
    assert.match(request.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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

test("rejects unauthenticated funding requests without calling exchanges", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/funding", {
      method: "POST",
      body: JSON.stringify({ startTime: 1, endTime: 2 })
    }),
    ENV,
    async () => { throw new Error("must not fetch"); },
    () => { throw new Error("must not open websocket"); }
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false });
});

test("returns complete three-day Binance and Bybit funding slots including zero amounts", async () => {
  const endTime = Date.parse("2026-09-01T00:30:00.000Z");
  const startTime = endTime - 72 * 60 * 60 * 1000;
  const latestSlot = Date.parse("2026-09-01T00:00:00.000Z");
  let bybitTransactionPages = 0;

  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        const result = request.method === "v2/account.position"
          ? [{
              symbol: "QQQUSDT",
              positionAmt: "4",
              markPrice: "720",
              entryPrice: "710",
              notional: "2880",
              unRealizedProfit: "40",
              accountAlias: "hidden"
            }]
          : [{ asset: "USDT", balance: "100", crossUnPnl: "5", privateField: "hidden" }];
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({ id: request.id, status: 200, result })
        }));
      },
      close() {}
    };
  };

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/fapi/v1/income") {
      assert.equal(url.searchParams.get("incomeType"), "FUNDING_FEE");
      return Response.json([{ symbol: "QQQUSDT", time: latestSlot, income: "0.25" }]);
    }
    if (url.pathname === "/fapi/v1/fundingRate") {
      return Response.json(Array.from({ length: 9 }, (_, index) => ({
        symbol: "QQQUSDT",
        fundingTime: latestSlot - index * 8 * 60 * 60 * 1000
      })));
    }
    if (url.pathname === "/v5/position/list") {
      const list = url.searchParams.get("settleCoin") === "USDT"
        ? [{
            symbol: "LABUSDT",
            side: "Buy",
            size: "100",
            markPrice: "15",
            avgPrice: "14",
            positionValue: "1500",
            unrealisedPnl: "100",
            accountId: "hidden"
          }]
        : [];
      return Response.json({ retCode: 0, result: { list } });
    }
    if (url.pathname === "/v5/order/realtime") {
      return Response.json({ retCode: 0, result: { list: [] } });
    }
    if (url.pathname === "/v5/account/wallet-balance") {
      return Response.json({
        retCode: 0,
        result: { list: [{ coin: [{ coin: "USDT", equity: "250" }] }] }
      });
    }
    if (url.pathname === "/v5/account/transaction-log") {
      bybitTransactionPages += 1;
      if (!url.searchParams.get("cursor")) {
        return Response.json({
          retCode: 0,
          result: {
            list: [{ symbol: "LABUSDT", transactionTime: latestSlot, funding: "0" }],
            nextPageCursor: "next-page"
          }
        });
      }
      return Response.json({
        retCode: 0,
        result: {
          list: [{
            symbol: "LABUSDT",
            transactionTime: latestSlot - 4 * 60 * 60 * 1000,
            funding: "2"
          }],
          nextPageCursor: ""
        }
      });
    }
    if (url.pathname === "/v5/market/instruments-info") {
      return Response.json({ retCode: 0, result: { list: [{ fundingInterval: "240" }] } });
    }
    if (url.pathname === "/v5/market/tickers") {
      return Response.json({
        retCode: 0,
        result: { list: [{ nextFundingTime: String(latestSlot + 4 * 60 * 60 * 1000) }] }
      });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };

  const response = await handleRequest(
    new Request("https://worker.test/funding", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        startTime,
        endTime,
        credentials: {
          binance: { apiKey: "binance-key", apiSecret: "binance-secret" },
          bybit: { apiKey: "bybit-key", apiSecret: "bybit-secret" }
        }
      })
    }),
    { PROXY_TOKEN: "test-token" },
    fetchImpl,
    webSocketFactory
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.exchanges).sort(), ["binance", "bybit"]);
  assert.equal(body.exchanges.binance.positions[0].count, 9);
  assert.equal(body.exchanges.binance.positions[0].fundingIntervalHours, 8);
  assert.equal(body.exchanges.binance.positions[0].totalFunding, 0.25);
  assert.equal(body.exchanges.bybit.positions[0].count, 18);
  assert.equal(body.exchanges.bybit.positions[0].fundingIntervalHours, 4);
  assert.equal(body.exchanges.bybit.positions[0].fundingRecords.filter((value) => value === 0).length, 17);
  assert.equal(body.exchanges.bybit.positions[0].totalFunding, 2);
  assert.equal(bybitTransactionPages, 2);
  assert.doesNotMatch(JSON.stringify(body), /privateField|accountAlias|accountId|hidden/);
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

test("falls back to Binance WebSocket positions and marks order coverage unavailable", async () => {
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({
            id: request.id,
            status: 200,
            result: [
              { symbol: "BTCUSDT", positionAmt: "2", markPrice: "100", privateField: "hidden" },
              { symbol: "ETHUSDT", positionAmt: "0", markPrice: "10" }
            ]
          })
        }));
      },
      close() {}
    };
  };
  const response = await handleRequest(
    new Request("https://worker.test/state", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    ENV,
    async (input) => {
      const url = new URL(input);
      if (url.hostname.includes("binance")) {
        return Response.json({ code: -1003, msg: "private rate-limit detail" }, { status: 429 });
      }
      return Response.json({ retCode: 0, result: { list: [] } });
    },
    webSocketFactory
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.positions, [
    { symbol: "BTC", source: "binance", side: "long", size: 2, price: 100 }
  ]);
  assert.deepEqual(body.orders, []);
  assert.deepEqual(body.coverage, {
    binance: { positions: "complete", orders: "unavailable", transport: "websocket" },
    bybit: { positions: "complete", orders: "complete", transport: "rest" }
  });
  assert.deepEqual(body.warnings, ["binance_orders_unavailable"]);
  assert.doesNotMatch(JSON.stringify(body), /private|rate-limit detail/);
});

test("explicit Binance WebSocket mode skips banned REST requests", async () => {
  let binanceRestCalls = 0;
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({ id: request.id, status: 200, result: [] })
        }));
      },
      close() {}
    };
  };
  const response = await handleRequest(
    new Request("https://worker.test/state", {
      method: "POST",
      headers: { authorization: "Bearer test-token" }
    }),
    { ...ENV, BINANCE_WS_POSITIONS_ONLY: "true" },
    async (input) => {
      if (new URL(input).hostname.includes("binance")) {
        binanceRestCalls += 1;
        throw new Error("must not call Binance REST");
      }
      return Response.json({ retCode: 0, result: { list: [] } });
    },
    webSocketFactory
  );
  assert.equal(response.status, 200);
  assert.equal(binanceRestCalls, 0);
  assert.equal((await response.json()).coverage.binance.transport, "websocket");
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
    },
    () => { throw new Error("websocket unavailable"); }
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
