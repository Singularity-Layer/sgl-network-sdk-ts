/**
 * ProcessorsClient credential-handling tests.
 *
 * These pin the audit findings rather than the happy path. Every one is a bug that existed: the
 * key was sent to any https origin, IPv6 loopback was refused, and `catalogue()` was
 * authenticated and so returned your own processors instead of the catalogue.
 *
 * Uses node:test so the SDK gains no dependency to get a test suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessorsClient, PROCESSORS_BASE_URL } from "../dist/index.mjs";

const KEY = "x402c_test";

test("official host accepts the key", () => {
  assert.ok(new ProcessorsClient({ apiKey: KEY, baseUrl: PROCESSORS_BASE_URL }));
});

test("explicit default port is still the official host", () => {
  // URL.origin normalises :443 away; asserting it so a hand-rolled comparison cannot regress.
  assert.ok(new ProcessorsClient({ apiKey: KEY, baseUrl: "https://processors.x402compute.cc:443" }));
});

for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
  test(`loopback allowed over plain http: ${url}`, () => {
    // The IPv6 form was refused originally: URL keeps the brackets, so "::1" never matched.
    assert.ok(new ProcessorsClient({ apiKey: KEY, baseUrl: url }));
  });
}

test("key is refused on a foreign https host", () => {
  // https alone was the original bug: an attacker-influenced env var pointing at any valid TLS
  // origin was enough to harvest a long-lived full-control credential.
  assert.throws(
    () => new ProcessorsClient({ apiKey: KEY, baseUrl: "https://attacker.example" }),
    /refuses to send an API key/,
  );
});

test("foreign host is fine without a key", () => {
  assert.ok(new ProcessorsClient({ baseUrl: "https://attacker.example" }));
});

test("foreign host allowed with explicit opt-in", () => {
  assert.ok(
    new ProcessorsClient({
      apiKey: KEY,
      baseUrl: "https://attacker.example",
      allowKeyOnCustomHost: true,
    }),
  );
});

for (const url of ["http://evil.tld", "ftp://x", "not a url"]) {
  test(`unsafe base url refused: ${url}`, () => {
    assert.throws(() => new ProcessorsClient({ apiKey: KEY, baseUrl: url }));
  });
}

test("catalogue() sends no credential, list() does", async () => {
  // GET /processors is owner-scoped with a credential and public without one, so a keyed
  // catalogue() used to return your own processors — the opposite of its name.
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(new Headers(init.headers).get("x-api-key"));
    return new Response(JSON.stringify({ processors: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const c = new ProcessorsClient({ apiKey: KEY });
    await c.catalogue();
    await c.list();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0], null, "catalogue() must not send the key");
  assert.equal(seen[1], KEY, "list() must send the key");
});

test("run() sends the invoke token, not the management key", async () => {
  let headers;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    headers = new Headers(init.headers);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await new ProcessorsClient({ apiKey: KEY }).run("s", {}, "sk-sglproc_abc");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(headers.get("authorization"), "Bearer sk-sglproc_abc");
  assert.equal(headers.get("x-api-key"), null, "run() must not send the management key");
});
