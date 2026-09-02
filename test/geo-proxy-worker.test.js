import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchPositionMonitor,
  handleRequest,
  verifyGithubOidcToken
} from "../cloudflare/position-geo-proxy/src/index.js";
import {
  dispatchFundingClear,
  dispatchFundingSheet,
  handleRequest as handleFundingRelayRequest
} from "../cloudflare/ks-funding-relay/src/index.js";

const ENV = {
  PROXY_TOKEN: "test-token",
  BINANCE_API_KEY: "binance-key",
  BINANCE_API_SECRET: "binance-secret",
  BYBIT_API_KEY: "bybit-key",
  BYBIT_API_SECRET: "bybit-secret"
};

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function signedGithubOidcToken(claimOverrides = {}) {
  const keys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const kid = `test-${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const claims = base64Url(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    aud: "position-relay",
    repository: "khaiseong-ai/position-monitor-service",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    workflow_ref: "khaiseong-ai/position-monitor-service/.github/workflows/position-monitor.yml@refs/heads/main",
    nbf: now - 30,
    exp: now + 300,
    ...claimOverrides
  }));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keys.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return {
    token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
    publicJwk
  };
}

test("accepts only signed GitHub OIDC tokens for the main workflow repository", async () => {
  const valid = await signedGithubOidcToken();
  const fetchJwks = async (url) => {
    assert.equal(String(url), "https://token.actions.githubusercontent.com/.well-known/jwks");
    return Response.json({ keys: [valid.publicJwk] });
  };
  assert.equal(await verifyGithubOidcToken(valid.token, fetchJwks), true);

  const wrongRepository = await signedGithubOidcToken({ repository: "someone/else" });
  assert.equal(await verifyGithubOidcToken(wrongRepository.token, async () => {
    throw new Error("claims must fail before key lookup");
  }), false);

  const wrongWorkflow = await signedGithubOidcToken({
    workflow_ref: "khaiseong-ai/position-monitor-service/.github/workflows/untrusted.yml@refs/heads/main"
  });
  assert.equal(await verifyGithubOidcToken(wrongWorkflow.token, async () => {
    throw new Error("workflow claims must fail before key lookup");
  }), false);
});

test("dispatches the position workflow without exposing scheduler failures", async () => {
  let captured;
  await dispatchPositionMonitor({ GITHUB_ACTIONS_TOKEN: "actions-only-token" }, async (url, options) => {
    captured = { url: String(url), options };
    return new Response(null, { status: 204 });
  });

  assert.equal(captured.url,
    "https://api.github.com/repos/khaiseong-ai/position-monitor-service/actions/workflows/position-monitor.yml/dispatches");
  assert.equal(captured.options.headers.authorization, "Bearer actions-only-token");
  assert.deepEqual(JSON.parse(captured.options.body), {
    ref: "main",
    inputs: { notify: "true" }
  });
  await dispatchPositionMonitor(
    { GITHUB_ACTIONS_TOKEN: "actions-only-token" },
    async () => Response.json({ workflow_run_id: 123 }, { status: 200 })
  );
  await assert.rejects(() => dispatchPositionMonitor({}, async () => {
    throw new Error("must not call GitHub");
  }), /scheduler is not configured/);
  await assert.rejects(() => dispatchPositionMonitor(
    { GITHUB_ACTIONS_TOKEN: "actions-only-token" },
    async () => new Response("private response", { status: 403 })
  ), (error) => {
    assert.equal(error.safeCode, "github_http_403");
    assert.doesNotMatch(error.message, /actions-only-token|private response/);
    return true;
  });
});

test("dispatches the KS funding workflow from an authenticated Sheet button", async () => {
  let captured;
  await dispatchFundingSheet({ GITHUB_ACTIONS_TOKEN: "actions-only-token" }, async (url, options) => {
    captured = { url: String(url), options };
    return new Response(null, { status: 204 });
  });
  assert.equal(captured.url,
    "https://api.github.com/repos/khaiseong-ai/position-monitor-service/actions/workflows/ks-funding-sheet.yml/dispatches");
  assert.deepEqual(JSON.parse(captured.options.body), { ref: "main" });

  const unauthorized = await handleFundingRelayRequest(
    new Request("https://worker.test/dispatch/ks-funding?token=wrong"),
    { MANUAL_FUNDING_TOKEN: "right" },
    async () => { throw new Error("must not dispatch"); }
  );
  assert.equal(unauthorized.status, 401);

  const accepted = await handleFundingRelayRequest(
    new Request("https://worker.test/dispatch/ks-funding?token=right"),
    { MANUAL_FUNDING_TOKEN: "right", GITHUB_ACTIONS_TOKEN: "actions-only-token" },
    async (url) => String(url).includes("fapi.binance.com")
      ? Response.json({ serverTime: Date.now() })
      : new Response(null, { status: 204 })
  );
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /更新已启动/);

  let clearRequest;
  const unavailable = await handleFundingRelayRequest(
    new Request("https://worker.test/dispatch/ks-funding?token=right"),
    {
      MANUAL_FUNDING_TOKEN: "right",
      GITHUB_ACTIONS_TOKEN: "actions-only-token"
    },
    async (url, options = {}) => {
      if (String(url).includes("fapi.binance.com")) return new Response("blocked", { status: 403 });
      clearRequest = { url: String(url), options };
      return new Response(null, { status: 204 });
    }
  );
  assert.equal(unavailable.status, 503);
  assert.match(await unavailable.text(), /正在清空旧数据/);
  assert.equal(clearRequest.url,
    "https://api.github.com/repos/khaiseong-ai/position-monitor-service/actions/workflows/ks-funding-sheet.yml/dispatches");
  const clearBody = JSON.parse(clearRequest.options.body);
  assert.deepEqual(clearBody, { ref: "main", inputs: { clear_only: "true" } });
  assert.match(clearRequest.options.headers.authorization, /^Bearer /);
});

test("rejects a failed funding clear dispatch without exposing the token", async () => {
  await assert.rejects(() => dispatchFundingClear({
    GITHUB_ACTIONS_TOKEN: "actions-only-token"
  }, async () => new Response("private error", { status: 500 })), (error) => {
    assert.equal(error.safeCode, "github_http_500");
    assert.doesNotMatch(error.message, /actions-only-token|private error/);
    return true;
  });
});

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
      algoOrders: { status: 400, code: "api_-1002" },
      openOrdersRest: { status: 0, code: "network" },
      openAlgoOrdersRest: { status: 0, code: "network" }
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

test("state diagnostics use request-scoped Binance credentials without returning them", async () => {
  const sentRequests = [];
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        sentRequests.push(request);
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
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({
        diagnostics: "binance",
        exchanges: ["binance"],
        credentials: { binance: { apiKey: "request-key", apiSecret: "request-secret" } }
      })
    }),
    { ...ENV, BINANCE_API_KEY: "", BINANCE_API_SECRET: "" },
    async () => Response.json([]),
    webSocketFactory
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.methods.openOrders.status, 200);
  assert.equal(body.methods.openAlgoOrdersRest.status, 200);
  assert.equal(sentRequests.length, 4);
  assert.ok(sentRequests.every((request) => request.params.apiKey === "request-key"));
  assert.doesNotMatch(JSON.stringify(body), /request-key|request-secret|signature/);
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
  const response = await handleFundingRelayRequest(
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

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/fapi/v3/positionRisk") {
      return Response.json([{
        symbol: "QQQUSDT",
        positionAmt: "4",
        markPrice: "720",
        entryPrice: "710",
        notional: "2880",
        unRealizedProfit: "40",
        accountAlias: "hidden"
      }]);
    }
    if (url.pathname === "/fapi/v3/balance") {
      return Response.json([
        { asset: "USDT", balance: "100", crossUnPnl: "5", privateField: "hidden" }
      ]);
    }
    if (url.pathname === "/fapi/v1/income") {
      assert.equal(url.searchParams.get("incomeType"), "FUNDING_FEE");
      return Response.json([{ symbol: "QQQUSDT", time: latestSlot, income: "0.25" }]);
    }
    if (url.pathname === "/fapi/v1/fundingRate") {
      return Response.json(Array.from({ length: 4 }, (_, index) => ({
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

  const response = await handleFundingRelayRequest(
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
    () => { throw new Error("funding must not open a websocket"); }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.failures?.binance, undefined, JSON.stringify(body));
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

test("falls back to position-scoped Binance order requests", async () => {
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        const response = request.method === "v2/account.position"
          ? {
              id: request.id,
              status: 200,
              result: [
                { symbol: "BTCUSDT", positionAmt: "2", markPrice: "100", privateField: "hidden" },
                { symbol: "ETHUSDT", positionAmt: "0", markPrice: "10" }
              ]
            }
          : { id: request.id, status: 400, error: { code: -1003 } };
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify(response)
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
        const symbol = url.searchParams.get("symbol");
        if (symbol === "BTCUSDT" && url.pathname === "/fapi/v1/openOrders") {
          return Response.json([{
            symbol,
            side: "SELL",
            origQty: "2",
            price: "130",
            type: "LIMIT",
            status: "NEW"
          }]);
        }
        if (symbol === "BTCUSDT" && url.pathname === "/fapi/v1/openAlgoOrders") {
          return Response.json([{
            symbol,
            side: "SELL",
            quantity: "2",
            triggerPrice: "90",
            orderType: "STOP_MARKET",
            algoStatus: "NEW"
          }]);
        }
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
  assert.deepEqual(body.orders, [
    { symbol: "BTC", source: "binance", side: "sell", size: 2, price: 130, triggerPrice: 0, type: "LIMIT", status: "NEW" },
    { symbol: "BTC", source: "binance", side: "sell", size: 2, price: 0, triggerPrice: 90, type: "STOP_MARKET", status: "NEW" }
  ]);
  assert.deepEqual(body.coverage, {
    binance: { positions: "complete", orders: "complete", transport: "websocket" },
    bybit: { positions: "complete", orders: "complete", transport: "rest" }
  });
  assert.deepEqual(body.warnings, []);
  assert.doesNotMatch(JSON.stringify(body), /private|rate-limit detail/);
});

test("keeps Binance positions available when every order transport is unavailable", async () => {
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        const response = request.method === "v2/account.position"
          ? { id: request.id, status: 200, result: [{ symbol: "BTCUSDT", positionAmt: "2", markPrice: "100" }] }
          : { id: request.id, status: 400, error: { code: -1002 } };
        queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify(response) }));
      },
      close() {}
    };
  };
  const response = await handleRequest(
    new Request("https://worker.test/state", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ exchanges: ["binance"] })
    }),
    ENV,
    async () => Response.json({ code: -1003 }, { status: 429 }),
    webSocketFactory
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.positions.length, 1);
  assert.deepEqual(body.orders, []);
  assert.deepEqual(body.coverage.binance, {
    positions: "complete",
    orders: "unavailable",
    transport: "websocket"
  });
  assert.deepEqual(body.warnings, ["binance_orders_unavailable"]);
});

test("explicit Binance WebSocket mode gets complete account orders through REST", async () => {
  const binanceRestCalls = [];
  const webSocketFactory = () => {
    const listeners = new Map();
    queueMicrotask(() => listeners.get("open")?.());
    return {
      addEventListener(name, listener) { listeners.set(name, listener); },
      send(value) {
        const request = JSON.parse(value);
        const result = request.method === "v2/account.position"
          ? [{ symbol: "BTCUSDT", positionAmt: "2", markPrice: "100" }]
          : [];
        queueMicrotask(() => listeners.get("message")?.({
          data: JSON.stringify({
            id: request.id,
            status: 200,
            result
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
    { ...ENV, BINANCE_WS_POSITIONS_ONLY: "true" },
    async (input) => {
      const url = new URL(input);
      if (url.hostname.includes("binance")) {
        binanceRestCalls.push(url);
        if (url.pathname === "/fapi/v1/openAlgoOrders") {
          return Response.json([{
            symbol: "SOLUSDT",
            side: "BUY",
            quantity: "3",
            triggerPrice: "90",
            orderType: "STOP_MARKET",
            algoStatus: "NEW"
          }]);
        }
        return Response.json([]);
      }
      return Response.json({ retCode: 0, result: { list: [] } });
    },
    webSocketFactory
  );
  assert.equal(response.status, 200);
  assert.equal(binanceRestCalls.length, 1);
  assert.ok(binanceRestCalls.every((url) => !url.searchParams.has("symbol")));
  assert.deepEqual(binanceRestCalls.map((url) => url.pathname).sort(), [
    "/fapi/v1/openAlgoOrders"
  ]);
  const body = await response.json();
  assert.deepEqual(body.orders, [{
    symbol: "SOL",
    source: "binance",
    side: "buy",
    size: 3,
    price: 0,
    triggerPrice: 90,
    type: "STOP_MARKET",
    status: "NEW"
  }]);
  assert.deepEqual(body.coverage.binance, {
    positions: "complete",
    orders: "complete",
    transport: "websocket"
  });
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
