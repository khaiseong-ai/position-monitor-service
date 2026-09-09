import assert from "node:assert/strict";
import test from "node:test";
import { fetchMexc } from "../lib/exchanges.js";

const config = {
  apiKey: "key",
  apiSecret: "secret",
  restBase: "https://example.test",
  sizeMultipliers: {}
};

test("rejects an HTTP 200 MEXC API error instead of treating it as no positions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/private/position/")) {
      return new Response(JSON.stringify({ success: false, code: 602, message: "denied" }));
    }
    return new Response(JSON.stringify({ success: true, code: 0, data: [] }));
  });

  await assert.rejects(fetchMexc(config), /mexc .* error: 602/);
});

test("accepts a successful empty MEXC position response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify({ success: true, code: 0, data: [] }))
  ));

  assert.deepEqual(await fetchMexc(config), []);
});
