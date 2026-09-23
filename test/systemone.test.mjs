/**
 * GridClient.systemone wire tests: the paths, query and body the orchestrator expects, and how
 * its 402s surface. fetch is stubbed so nothing leaves the process.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GridClient, SGLAPIError } from "../dist/index.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status, payload) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

const BASE = "https://grid.example";

test("models() lists only System One models from /v1/models?type=systemone", async () => {
  const calls = stubFetch(200, {
    object: "list",
    data: [
      { id: "convaiinnovations/laya", object: "model", created: 1, owned_by: "sgl-network", type: "systemone", context_window: 16384, max_questions: 32 },
      { id: "llama-3.1-8b", object: "model", created: 1, owned_by: "sgl-network", type: "chat" },
    ],
  });
  const grid = new GridClient({ baseUrl: BASE });
  const models = await grid.systemone.models();
  assert.equal(calls[0].url, `${BASE}/v1/models?type=systemone`);
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(models.map((m) => m.id), ["convaiinnovations/laya"]);
});

test("models() is empty when the grid has System One off", async () => {
  stubFetch(200, { object: "list", data: [] });
  assert.deepEqual(await new GridClient({ baseUrl: BASE }).systemone.models(), []);
});

test("create() POSTs the typed request to /v1/systemone with the API key", async () => {
  const reply = {
    object: "systemone.result",
    model: "convaiinnovations/laya",
    answers: { route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 } } },
    usage: { input_tokens: 40, output_tokens: 0, cost_usd: 0.000001 },
  };
  const calls = stubFetch(200, reply);
  const grid = new GridClient({ baseUrl: BASE, apiKey: "scg_test" });
  const res = await grid.systemone.create({
    model: "laya",
    state: { ticket: "double charge" },
    questions: {
      route: { type: "choice", instructions: "Which team?", criteria: { billing: "money", support: "other" } },
    },
    lang: "en",
  });

  assert.equal(calls[0].url, `${BASE}/v1/systemone`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-API-Key"], "scg_test");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    model: "laya",
    state: { ticket: "double charge" },
    questions: { route: { type: "choice", instructions: "Which team?", criteria: { billing: "money", support: "other" } } },
    lang: "en",
  });
  // Unset optionals are omitted, not sent as null.
  assert.ok(!("task" in body) && !("tier" in body) && !("user" in body));
  assert.deepEqual(res, reply);
});

test("create() without payment explains the apiKey requirement", async () => {
  stubFetch(402, { x402Version: 1, accepts: [], error: { message: "Payment required.", type: "payment_required" } });
  await assert.rejects(
    new GridClient({ baseUrl: BASE }).systemone.create({ model: "laya", state: { a: 1 }, questions: { q: { type: "noul", instructions: "?" } } }),
    (err) => err instanceof SGLAPIError && err.statusCode === 402 && /pass an apiKey/.test(err.message),
  );
});

test("create() keeps the server message for insufficient credits", async () => {
  stubFetch(402, { error: { message: "Insufficient credits. This request needs ~$0.000010.", type: "insufficient_credits" } });
  await assert.rejects(
    new GridClient({ baseUrl: BASE, apiKey: "scg_test" }).systemone.create({ model: "laya", state: { a: 1 }, questions: { q: { type: "noul", instructions: "?" } } }),
    (err) => err instanceof SGLAPIError && /Insufficient credits/.test(err.message) && err.body?.error?.type === "insufficient_credits",
  );
});
