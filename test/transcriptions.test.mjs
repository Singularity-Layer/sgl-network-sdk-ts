import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import {
  GridClient,
  SGLConnectionError,
  SGLAPIError,
  SGLTranscriptionInputError,
  SGLTranscriptionResponseError,
  TRANSCRIPTION_MAX_PCM_BYTES,
  TRANSCRIPTION_MODEL_REVISION,
  TRANSCRIPTION_MODEL_SHA256,
  validateTranscriptionPcm,
  validateTranscriptionOptions,
} from "../dist/index.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ALGORITHM = "x25519-xchacha20poly1305-hkdf-v2";
const NODE_ID = "11111111-2222-4333-8444-555566667777";
const REQUEST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const JOB_ID = REQUEST_ID;
const nodeSecret = new Uint8Array(32).fill(7);
const nodePublic = bs58.encode(x25519.getPublicKey(nodeSecret));
const edSecret = new Uint8Array(32).fill(9);
const edPublicBytes = ed25519.getPublicKey(edSecret);
const edPublic = bs58.encode(edPublicBytes);
const encoder = new TextEncoder();
const SALT = encoder.encode("sgl-e2e-v2-salt");
const INFO_INPUT = encoder.encode("sgl-e2e-v2-input");
const INFO_OUTPUT = encoder.encode("sgl-e2e-v2-output");

function uuidBytes(value) {
  return Uint8Array.from(value.replaceAll("-", "").match(/../g), (hex) => Number.parseInt(hex, 16));
}

function keybindSignature(version = 1, transportKey = nodePublic) {
  const prefix = encoder.encode("SGL-NODE-KEYBIND-v1");
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version, true);
  const message = new Uint8Array(prefix.length + 1 + 16 + 32 + 32 + 4);
  let offset = 0;
  message.set(prefix, offset); offset += prefix.length;
  message[offset] = 0; offset += 1;
  message.set(uuidBytes(NODE_ID), offset); offset += 16;
  message.set(edPublicBytes, offset); offset += 32;
  message.set(bs58.decode(transportKey), offset); offset += 32;
  message.set(versionBytes, offset);
  return bs58.encode(ed25519.sign(message, edSecret));
}

function reservation(request, mutate) {
  const value = {
    reservation_token: "signed-reservation",
    request_id: request.request_id,
    model: request.model,
    model_revision: TRANSCRIPTION_MODEL_REVISION,
    model_sha256: TRANSCRIPTION_MODEL_SHA256,
    transcription_protocol: request.transcription_protocol,
    sample_count: request.sample_count,
    language: request.language,
    node_id: NODE_ID,
    node_x25519_pubkey: nodePublic,
    node_ed25519_pubkey: edPublic,
    node_x25519_pubkey_sig: keybindSignature(),
    key_version: 1,
    tee_type: "tdx",
    attestation_verified: true,
    expires_in_ms: 60_000,
    quote: { sample_count: request.sample_count, audio_seconds: request.sample_count / 16_000,
      rate_usd_per_second: 0.0001, minimum_charge_usd: 0.0001,
      price_usd: Math.max(100, Math.ceil(request.sample_count / 160)) / 1e6, currency: "USDC" },
  };
  return mutate ? mutate(value) ?? value : value;
}

function decryptRequest(enc) {
  const shared = x25519.getSharedSecret(nodeSecret, bs58.decode(enc.client_ephemeral_pubkey));
  const key = hkdf(sha256, shared, SALT, INFO_INPUT, 32);
  const aad = encoder.encode(
    `sgl-aad/v2/input|node=${nodePublic}|eph=${enc.client_ephemeral_pubkey}|resp=${enc.client_response_pubkey}`,
  );
  const blob = new Uint8Array(Buffer.from(enc.ciphertext, "base64"));
  return JSON.parse(new TextDecoder().decode(
    xchacha20poly1305(key, blob.slice(0, 24), aad).decrypt(blob.slice(24)),
  ));
}

function sealResult(responsePublic, result, plaintextBytes) {
  const ephemeralSecret = new Uint8Array(32).fill(11);
  const ephemeralPublic = bs58.encode(x25519.getPublicKey(ephemeralSecret));
  const shared = x25519.getSharedSecret(ephemeralSecret, bs58.decode(responsePublic));
  const key = hkdf(sha256, shared, SALT, INFO_OUTPUT, 32);
  const aad = encoder.encode(`sgl-aad/v2/output|resp=${responsePublic}|eph=${ephemeralPublic}`);
  const nonce = new Uint8Array(24).fill(13);
  const encrypted = xchacha20poly1305(key, nonce, aad).encrypt(plaintextBytes ?? encoder.encode(JSON.stringify(result)));
  const blob = new Uint8Array(nonce.length + encrypted.length);
  blob.set(nonce);
  blob.set(encrypted, nonce.length);
  return { ephemeralPublic, ciphertext: Buffer.from(blob).toString("base64") };
}

function resultSignature(ciphertext) {
  const digest = Array.from(sha256(encoder.encode(ciphertext)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return bs58.encode(ed25519.sign(encoder.encode(`sgl-result-v1\n${JOB_ID}\ntranscription\n${digest}`), edSecret));
}

async function runExchange({
  pcm = new Uint8Array(320).map((_, index) => index % 251),
  mutateReservation,
  mutateResult,
  mutateEnvelope,
  throwOnSubmit = false,
  onSubmit,
  onReserve,
  submitStatus,
  plaintextBytes,
  clientOptions = {},
  responseBody,
  stallSubmitBody = false,
} = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    if (calls.length === 1) {
      if (onReserve) onReserve();
      return new Response(JSON.stringify(reservation(body, mutateReservation)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (onSubmit) onSubmit();
    if (stallSubmitBody) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('{"text":'));
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      } }), { headers: { "content-type": "application/json" } });
    }
    if (responseBody !== undefined) return new Response(JSON.stringify(responseBody));
    if (throwOnSubmit) throw new Error("connection closed after submit");
    if (submitStatus) return new Response(JSON.stringify({ error: { code: "outcome_unknown", type: "payment_error" } }), { status: submitStatus });
    const inner = decryptRequest(body.enc);
    const result = {
      object: "transcription",
      protocol: "transcription-v1",
      request_id: inner.request_id,
      job_id: JOB_ID,
      model: inner.model,
      model_revision: inner.model_revision,
      model_sha256: inner.model_sha256,
      sample_count: inner.audio.sample_count,
      text: "Synthetic transcript.",
      language_hint: inner.language,
      language: "en",
      duration_seconds: inner.audio.sample_count / 16_000,
      segments: [{ start: 0, end: inner.audio.sample_count / 16_000, text: "Synthetic transcript." }],
    };
    if (mutateResult) mutateResult(result, inner);
    const sealed = sealResult(body.enc.client_response_pubkey, result, plaintextBytes);
    const response = {
      object: "transcription",
      job_id: JOB_ID,
      sealed_result: {
        algorithm: ALGORITHM,
        encoding: "base64",
        ephemeral_public_key: sealed.ephemeralPublic,
        ciphertext: sealed.ciphertext,
      },
      result_envelope_signature: resultSignature(sealed.ciphertext),
      result_envelope_version: "v1",
      usage: { audio_seconds: inner.audio.sample_count / 16_000, cost_usd: Math.max(100, Math.ceil(inner.audio.sample_count / 160)) / 1e6 },
    };
    if (mutateEnvelope) mutateEnvelope(response);
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  try {
    const client = new GridClient({
      apiKey: "x402c_test",
      baseUrl: "https://grid.test",
      transcriptionCanaryToken: "private-test-token",
      ...clientOptions,
    });
    const response = await client.transcribePcm(pcm, { requestId: REQUEST_ID, language: "en" });
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("transcribePcm seals raw PCM and returns only a verified bound result", async () => {
  const pcm = new Uint8Array(320).map((_, index) => index % 251);
  const { response, calls } = await runExchange({ pcm });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://grid.test/v1/audio/transcriptions/reserve");
  assert.deepEqual(calls[0].body, {
    model: "whisper-1",
    model_revision: TRANSCRIPTION_MODEL_REVISION,
    model_sha256: TRANSCRIPTION_MODEL_SHA256,
    transcription_protocol: "transcription-v1",
    request_id: REQUEST_ID,
    sample_rate: 16_000,
    channels: 1,
    bits_per_sample: 16,
    sample_count: 160,
    language: "en",
    use_credits: true,
  });
  assert.equal(calls[1].url, "https://grid.test/v1/audio/transcriptions");
  assert.deepEqual(Object.keys(calls[1].body), ["reservation_token", "enc"]);
  assert.equal(calls[1].body.enc.algorithm, ALGORITHM);
  assert.equal(calls[1].body.enc.encoding, "base64");
  assert.equal(JSON.stringify(calls[1].body).includes(Buffer.from(pcm).toString("base64")), false);
  const inner = decryptRequest(calls[1].body.enc);
  assert.deepEqual(Object.keys(inner), ["protocol", "request_id", "model", "model_revision", "model_sha256", "language", "audio"]);
  assert.deepEqual(Object.keys(inner.audio), ["format", "sample_rate", "channels", "bits_per_sample", "sample_count", "data"]);
  assert.equal(inner.model_revision, TRANSCRIPTION_MODEL_REVISION);
  assert.equal(inner.model_sha256, TRANSCRIPTION_MODEL_SHA256);
  assert.equal(inner.audio.sample_count, 160);
  assert.equal(inner.audio.data, Buffer.from(pcm).toString("base64"));
  assert.equal(response.text, "Synthetic transcript.");
  assert.equal(response.attestation.verified, true);
  assert.equal(calls[0].headers["X-SGL-STT-Canary"], "private-test-token");
  assert.equal(calls[1].headers["X-SGL-STT-Canary"], "private-test-token");
});

test("PCM bounds and language are rejected before network access", async () => {
  assert.throws(() => validateTranscriptionPcm(new Uint8Array()), (error) => error.code === "empty_audio");
  assert.throws(() => validateTranscriptionPcm(new Uint8Array(3)), (error) => error.code === "invalid_pcm_length");
  assert.throws(
    () => validateTranscriptionPcm(new TextEncoder().encode("RIFF0000WAVE")),
    (error) => error.code === "unsupported_audio_container",
  );
  assert.throws(
    () => validateTranscriptionPcm(new Uint8Array(TRANSCRIPTION_MAX_PCM_BYTES + 2)),
    (error) => error.code === "audio_too_long",
  );
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(
      new GridClient({ baseUrl: "https://grid.test" }).transcribePcm(new Uint8Array(2), { language: "ENG" }),
      (error) => error instanceof SGLTranscriptionInputError && error.code === "invalid_language",
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [name, mutate] of [
  ["request id", (r) => { r.request_id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"; }],
  ["model", (r) => { r.model = "other"; }],
  ["model revision", (r) => { r.model_revision = "b".repeat(64); }],
  ["model hash", (r) => { r.model_sha256 = "b".repeat(64); }],
  ["sample count", (r) => { r.sample_count += 1; }],
  ["language", (r) => { r.language = "fr"; }],
  ["key signature", (r) => { r.node_x25519_pubkey_sig = bs58.encode(new Uint8Array(64)); }],
  ["key version", (r) => { r.key_version = 2; }],
]) {
  test(`reservation rejects changed ${name} before audio submit`, async () => {
    await assert.rejects(
      runExchange({ mutateReservation: mutate }),
      (error) => error instanceof SGLTranscriptionResponseError,
    );
  });
}

for (const [name, mutate] of [
  ["request id", (r) => { r.request_id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"; }],
  ["model", (r) => { r.model = "other"; }],
  ["model revision", (r) => { r.model_revision = "b".repeat(64); }],
  ["model hash", (r) => { r.model_sha256 = "b".repeat(64); }],
  ["sample count", (r) => { r.sample_count += 1; }],
  ["language hint", (r) => { r.language_hint = "fr"; }],
]) {
  test(`sealed result rejects changed ${name}`, async () => {
    await assert.rejects(
      runExchange({ mutateResult: mutate }),
      (error) => error instanceof SGLTranscriptionResponseError && error.code === "binding_mismatch",
    );
  });
}

test("bad result signature and unsupported algorithm or encoding are refused", async () => {
  await assert.rejects(
    runExchange({ mutateEnvelope: (r) => { r.result_envelope_signature = bs58.encode(new Uint8Array(64)); } }),
    (error) => error.code === "unverified_result",
  );
  for (const field of ["algorithm", "encoding"]) {
    await assert.rejects(
      runExchange({ mutateEnvelope: (r) => { r.sealed_result[field] = "unsupported"; } }),
      (error) => error.code === "invalid_envelope",
    );
  }
});

test("submit transport failure is surfaced after one attempt and never retried", async () => {
  let submitAttempts = 0;
  await assert.rejects(
    runExchange({ throwOnSubmit: true, onSubmit: () => { submitAttempts += 1; } }),
    (error) => error instanceof SGLConnectionError,
  );
  assert.equal(submitAttempts, 1);
});

test("transcribePcmFile refuses oversized blobs before reading or fetching", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    const file = new Blob([new Uint8Array(TRANSCRIPTION_MAX_PCM_BYTES + 1)]);
    await assert.rejects(
      new GridClient({ baseUrl: "https://grid.test" }).transcribePcmFile(file),
      (error) => error.code === "file_too_large",
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [name, mutate] of [
  ["quote duration", (r) => { r.quote.audio_seconds = 1; }],
  ["quote rate", (r) => { r.quote.rate_usd_per_second = 0.01; }],
  ["quote minimum", (r) => { r.quote.minimum_charge_usd = 0; }],
  ["quote price", (r) => { r.quote.price_usd = 0.0002; }],
  ["node UUID", (r) => { r.node_id = r.node_id.replaceAll("-", ""); }],
]) {
  test(`invalid reservation ${name} never submits`, async () => {
    let submits = 0;
    await assert.rejects(runExchange({ mutateReservation: mutate, onSubmit: () => submits++ }), SGLTranscriptionResponseError);
    assert.equal(submits, 0);
  });
}

for (const [name, mutate] of [
  ["oversized text", (r) => { r.text = "a".repeat(65537); }],
  ["control character", (r) => { r.text = "unsafe\u0000"; }],
  ["C1 control", (r) => { r.text = "unsafe\u0085"; }],
  ["unpaired surrogate", (r) => { r.text = "\ud800"; }],
  ["segment surrogate", (r) => { r.segments[0].text = "\udc00"; }],
  ["invalid language", (r) => { r.language = "ENG"; }],
  ["missing language", (r) => { delete r.language; }],
  ["excessive duration", (r) => { r.duration_seconds = 2; }],
  ["non-monotonic segments", (r) => { r.segments.push({ start: 0, end: 0.01, text: "a" }); r.segments[0].end = 0.2; }],
  ["segment beyond duration", (r) => { r.segments[0].end = 0.2; }],
  ["too many segments", (r) => { r.segments = Array(257).fill(r.segments[0]); }],
  ["wrong job", (r) => { r.job_id = NODE_ID; }],
]) {
  test(`signed result rejects ${name}`, async () => {
    await assert.rejects(runExchange({ mutateResult: mutate }), SGLTranscriptionResponseError);
  });
}

for (const status of [402, 409, 502, 504]) {
  test(`submit HTTP ${status} preserves payment identity and makes one attempt`, async () => {
    let submits = 0;
    await assert.rejects(runExchange({ submitStatus: status, onSubmit: () => submits++ }),
      (error) => error instanceof SGLAPIError && error.statusCode === status && error.errorCode === "outcome_unknown");
    assert.equal(submits, 1);
  });
}

test("invalid UTF-8 is rejected after authenticated decryption", async () => {
  await assert.rejects(runExchange({ plaintextBytes: new Uint8Array([0xff]) }),
    (error) => error.code === "invalid_envelope");
});

test("result signature is checked before decrypting invalid output keys", async () => {
  await assert.rejects(runExchange({ mutateEnvelope: (r) => {
    r.sealed_result.ephemeral_public_key = "1".repeat(32);
    r.result_envelope_signature = bs58.encode(new Uint8Array(64));
  } }), (error) => error.code === "unverified_result");
});

test("signed noncanonical base64 and wrong envelope shape are rejected", async () => {
  for (const mutate of [
    (r) => { r.sealed_result.ciphertext += "\n"; r.result_envelope_signature = resultSignature(r.sealed_result.ciphertext); },
    (r) => { r.object = "other"; },
    (r) => { r.result_envelope_version = "v2"; },
    (r) => { r.sealed_result.ciphertext = "A".repeat(1400000); },
  ]) await assert.rejects(runExchange({ mutateEnvelope: mutate }), (error) => error.code === "invalid_envelope");
});

test("fractional duration and micro-USDC boundary rounding are exact", async () => {
  for (const samples of [1, 16000, 16001, 16080, 32000, 960000]) {
    const { response } = await runExchange({ pcm: new Uint8Array(samples * 2) });
    assert.equal(response.usage.audio_seconds, samples / 16000);
    assert.equal(response.usage.cost_usd, Math.max(100, Math.ceil(samples / 160)) / 1e6);
  }
  for (const mutate of [
    (r) => { r.usage.audio_seconds = 1; },
    (r) => { r.usage.cost_usd = 0; },
    (r) => { r.usage.cost_usd = 0.0002; },
    (r) => { r.billing_pending = "true"; },
  ]) await assert.rejects(runExchange({ mutateEnvelope: mutate }), SGLTranscriptionResponseError);
});

test("PCM is snapshotted before reserve allows callers to mutate a recording buffer", async () => {
  const pcm = new Uint8Array(320).fill(1);
  const { calls } = await runExchange({ pcm, onReserve: () => pcm.fill(2) });
  assert.equal(decryptRequest(calls[1].body.enc).audio.data, Buffer.alloc(320, 1).toString("base64"));
});

test("negative PCM samples are valid even when their bytes resemble an MP3 frame sync", () => {
  assert.equal(validateTranscriptionPcm(new Uint8Array([0xff, 0xff, 0xff, 0xff])), 2);
});

test("STT reserve/submit use a separate 120-second timeout with an override", async () => {
  const original = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return original(callback, delay, ...args);
  };
  try {
    await runExchange({ clientOptions: { timeout: 1234 } });
    assert.deepEqual(delays, [120000, 120000]);
    delays.length = 0;
    await runExchange({ clientOptions: { transcriptionTimeout: 180000 } });
    assert.deepEqual(delays, [180000, 180000]);
  } finally {
    globalThis.setTimeout = original;
  }
});

test("non-object submit bodies produce a typed response failure", async () => {
  for (const responseBody of [null, [], true, "invalid"]) {
    await assert.rejects(runExchange({ responseBody }),
      (error) => error instanceof SGLTranscriptionResponseError && error.code === "invalid_envelope");
  }
});

test("a signed low-order transport key is rejected without submitting audio", async () => {
  let submits = 0;
  await assert.rejects(runExchange({ onSubmit: () => submits++, mutateReservation: (r) => {
    r.node_x25519_pubkey = bs58.encode(new Uint8Array(32));
    r.node_x25519_pubkey_sig = keybindSignature(1, r.node_x25519_pubkey);
  } }), (error) => error instanceof SGLTranscriptionResponseError && error.code === "invalid_reservation");
  assert.equal(submits, 0);
});

test("oversized base58 key strings are rejected before expensive decode", async () => {
  await assert.rejects(runExchange({ mutateReservation: (r) => { r.node_x25519_pubkey = "1".repeat(10000); } }),
    (error) => error.code === "invalid_reservation");
  await assert.rejects(runExchange({ mutateEnvelope: (r) => { r.sealed_result.ephemeral_public_key = "1".repeat(10000); } }),
    (error) => error.code === "invalid_envelope");
});

test("a stalled submit body is aborted after headers, with one attempt and reconciliation ID", async () => {
  let submits = 0;
  const originalFetch = globalThis.fetch;
  let deadline;
  try {
    await assert.rejects(Promise.race([
      runExchange({ stallSubmitBody: true, onSubmit: () => submits++, clientOptions: { transcriptionTimeout: 50 } }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("body deadline was cleared after headers")), 1000); }),
    ]), (error) => error instanceof SGLConnectionError && error.message.includes(REQUEST_ID) && error.message.includes("reconcile"));
    assert.equal(submits, 1);
  } finally {
    clearTimeout(deadline);
    globalThis.fetch = originalFetch;
  }
});

test("request IDs require canonical lowercase UUIDv4 before network access", () => {
  for (const requestId of [REQUEST_ID.toUpperCase(), REQUEST_ID.replace("4ccc", "1ccc"), REQUEST_ID.replace("4ccc", "7ccc"), REQUEST_ID.replaceAll("-", ""), REQUEST_ID + "\n"]) {
    assert.throws(() => validateTranscriptionOptions({ requestId }),
      (error) => error instanceof SGLTranscriptionInputError && error.code === "invalid_request_id");
  }
  assert.equal(validateTranscriptionOptions({ requestId: REQUEST_ID }).requestId, REQUEST_ID);
  assert.match(validateTranscriptionOptions().requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("signed silence with an empty transcript and no segments is valid", async () => {
  const { response } = await runExchange({ mutateResult: (r) => { r.text = ""; r.segments = []; r.language = null; } });
  assert.equal(response.text, "");
  assert.deepEqual(response.segments, []);
  assert.equal(response.usage.audio_seconds, 0.01);
});

test("aggregate segment UTF-8 bytes are bounded independently of transcript text", async () => {
  for (const text of ["a".repeat(32769), "é".repeat(16385)]) {
    await assert.rejects(runExchange({ mutateResult: (r) => { r.segments = [
      { start: 0, end: 0.004, text }, { start: 0.004, end: 0.01, text },
    ]; } }), (error) => error.code === "invalid_result");
  }
  const { response } = await runExchange({ mutateResult: (r) => { r.segments = [
    { start: 0, end: 0.004, text: "é".repeat(16384) }, { start: 0.004, end: 0.01, text: "é".repeat(16384) },
  ]; } });
  assert.equal(response.segments.length, 2);
});

test("segment starts and ends cannot move backward within the overlap tolerance", async () => {
  for (const segments of [
    [{ start: 0.005, end: 0.01, text: "a" }, { start: 0.004, end: 0.009, text: "b" }],
    [{ start: 0, end: 0.01, text: "a" }, { start: 0.001, end: 0.009, text: "b" }],
    [{ start: 0.005, end: 0.008, text: "a" }, { start: 0.004, end: 0.01, text: "b" }],
  ]) await assert.rejects(runExchange({ mutateResult: (r) => { r.segments = segments; } }), (error) => error.code === "invalid_result");
  const { response } = await runExchange({ mutateResult: (r) => { r.segments = [
    { start: 0, end: 0.006, text: "a" }, { start: 0.004, end: 0.01, text: "b" },
  ]; } });
  assert.equal(response.segments.length, 2);
});

test("valid zero-duration segmentation can keep equal timestamps", async () => {
  const { response } = await runExchange({ mutateResult: (r) => { r.segments = [
    { start: 0, end: 0, text: "a" }, { start: 0, end: 0, text: "b" },
  ]; } });
  assert.equal(response.segments.length, 2);
});
