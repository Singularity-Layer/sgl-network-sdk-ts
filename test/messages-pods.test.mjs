/**
 * Anthropic Messages helpers and the pods Sandbox/clone/BYOK surface.
 *
 * Fetch is replaced with a recorder, so these pin the wire contract: path, method, headers and
 * body, plus how errors and stream events come back. No network.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GridClient, PodsClient, SGLAPIError, ANTHROPIC_VERSION } from "../dist/index.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function recorder(respond) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    return respond(String(url), init);
  };
  return { calls, fn };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("messages posts to /v1/messages with key + anthropic-version", async () => {
  const r = recorder(() => json({ id: "msg_1", type: "message", role: "assistant", model: "qwen-2.5-32b", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } }));
  globalThis.fetch = r.fn;
  const c = new GridClient({ apiKey: "x402c_k" });
  const msg = await c.messages({ model: "qwen-2.5-32b", max_tokens: 16, messages: [{ role: "user", content: "hello" }] });
  assert.equal(msg.content[0].text, "hi");
  assert.equal(r.calls[0].url, "https://grid.x402compute.cc/v1/messages");
  assert.equal(r.calls[0].method, "POST");
  assert.equal(r.calls[0].headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(r.calls[0].headers["X-API-Key"], "x402c_k");
  assert.equal(r.calls[0].body.max_tokens, 16);
});

test("messages maps 402 and reads the Anthropic error message", async () => {
  globalThis.fetch = recorder(() => json({ type: "error", error: { type: "billing_error", message: "pay" } }, 402)).fn;
  await assert.rejects(new GridClient().messages({ model: "m", max_tokens: 1, messages: [] }), (e) => e instanceof SGLAPIError && e.statusCode === 402 && /apiKey/.test(e.message));
  globalThis.fetch = recorder(() => json({ type: "error", error: { type: "invalid_request_error", message: "top_p is not supported" } }, 400)).fn;
  await assert.rejects(new GridClient({ apiKey: "k" }).messages({ model: "m", max_tokens: 1, messages: [] }), /top_p is not supported/);
});

test("messagesStream yields parsed events and stops at message_stop", async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\r\n\r\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const r = recorder(() => new Response(new ReadableStream({ start(ctl) { for (const s of sse) ctl.enqueue(new TextEncoder().encode(s)); ctl.close(); } }), { headers: { "content-type": "text/event-stream" } }));
  globalThis.fetch = r.fn;
  const types = []; let text = "";
  for await (const ev of new GridClient({ apiKey: "k" }).messagesStream({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] })) {
    types.push(ev.type);
    if (ev.type === "content_block_delta") text += ev.delta.text;
  }
  assert.deepEqual(types, ["message_start", "ping", "content_block_delta", "content_block_delta", "message_stop"]);
  assert.equal(text, "Hello");
  assert.equal(r.calls[0].body.stream, true);
});

test("messagesStream throws on an error event", async () => {
  globalThis.fetch = recorder(() => new Response('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"node failed"}}\n\n', { headers: { "content-type": "text/event-stream" } })).fn;
  const run = async () => { for await (const _ of new GridClient({ apiKey: "k" }).messagesStream({ model: "m", max_tokens: 8, messages: [] })) { /* drain */ } };
  await assert.rejects(run, /node failed/);
});

test("countMessageTokens posts to count_tokens", async () => {
  const r = recorder(() => json({ input_tokens: 4 }));
  globalThis.fetch = r.fn;
  const out = await new GridClient().countMessageTokens({ model: "m", messages: [{ role: "user", content: "hello" }] });
  assert.equal(out.input_tokens, 4);
  assert.equal(r.calls[0].url, "https://grid.x402compute.cc/v1/messages/count_tokens");
});

const POD = "11111111-2222-3333-4444-555555555555";
function pods(respond) {
  const r = recorder(respond);
  return { r, c: new PodsClient({ apiKey: "x402c_k", fetch: r.fn }) };
}

test("createPod sends engine and BYOK fallbacks", async () => {
  const { r, c } = pods(() => json({ pod: { id: POD, status: "provisioning" } }, 201));
  await c.createPod({ engine: "pipod", ai: { mode: "byok", preset: "venice", api_key: "vk", fallbacks: [{ preset: "openrouter", model: "x/y", api_key: "ok" }, { preset: "singularity", model: "z-ai/glm-5.3" }], managed_models: true } });
  assert.equal(r.calls[0].body.engine, "pipod");
  assert.equal(r.calls[0].body.ai.fallbacks.length, 2);
  assert.ok(r.calls[0].headers["Idempotency-Key"]);
});

test("exec, files and ports hit the sandbox routes", async () => {
  const { r, c } = pods((url, init) => {
    if (url.endsWith("/exec")) return json({ exec: { exit_code: 0, timed_out: false, duration_ms: 5, stdout: "hi\n", stderr: "", truncated: false, cwd: "/opt/pod/workspace" } });
    if (url.includes("/files?path=")) return json({ file: { path: "a b.txt", content: "x", modified: null, managed: false } });
    if (url.endsWith("/files") && init.method === "PUT") return json({ file: { path: "a.txt", size: 1, modified: null } });
    if (url.endsWith("/files")) return json({ files: [{ path: "a.txt" }], root: "/opt/pod/workspace" });
    if (url.endsWith("/ports") && init.method === "POST") return json({ port: { port: 8080, visibility: "public", url: "https://u/" }, rotated: false }, 201);
    if (url.endsWith("/ports")) return json({ ports: [{ port: 8080, visibility: "public" }], limit: 5 });
    if (url.endsWith("/ports/8080")) return json({ closed: true, port: 8080 });
    return json({}, 404);
  });
  const ex = await c.exec(POD, { command: "echo hi", timeout_seconds: 5 });
  assert.equal(ex.stdout, "hi\n");
  assert.deepEqual(r.calls[0].body, { command: "echo hi", timeout_seconds: 5 });
  assert.equal(r.calls[0].url, `https://compute.x402layer.cc/pods/v1/pods/${POD}/exec`);
  assert.equal((await c.listFiles(POD)).files.length, 1);
  assert.equal((await c.readFile(POD, "a b.txt")).content, "x");
  assert.ok(r.calls[2].url.endsWith("path=a%20b.txt"));
  assert.equal((await c.writeFile(POD, "a.txt", "x")).size, 1);
  assert.deepEqual(r.calls[3].body, { path: "a.txt", content: "x" });
  const opened = await c.openPort(POD, 8080);
  assert.equal(opened.port.url, "https://u/");
  assert.deepEqual(r.calls[4].body, { port: 8080, visibility: "public" });
  assert.equal((await c.listPorts(POD)).limit, 5);
  assert.equal((await c.closePort(POD, 8080)).closed, true);
  assert.equal(r.calls[6].method, "DELETE");
});

test("sandbox errors keep the API code", async () => {
  const { c } = pods(() => json({ error: { code: "forbidden", message: "needs pods:control:write" } }, 403));
  await assert.rejects(c.exec(POD, { command: "ls" }), /pods:control:write/);
});

test("clonePod sends an Idempotency-Key and returns the clone block", async () => {
  const { r, c } = pods(() => json({ pod: { id: "new", status: "provisioning" }, clone: { source_pod_id: POD, backup_id: "b", restore: { status: "pending" } } }, 201));
  const out = await c.clonePod(POD, { passphrase: "correct horse", idempotencyKey: "clone-1" });
  assert.equal(out.clone.restore.status, "pending");
  assert.equal(r.calls[0].headers["Idempotency-Key"], "clone-1");
  assert.deepEqual(r.calls[0].body, { passphrase: "correct horse" });
  assert.equal(r.calls[0].url, `https://compute.x402layer.cc/pods/v1/pods/${POD}/clone`);
});

test("cloneStatus unwraps clone", async () => {
  const { c } = pods(() => json({ clone: { status: "restored", attempts: 1 } }));
  assert.equal((await c.cloneStatus(POD)).status, "restored");
});
