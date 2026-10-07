import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDINGGEMMA2_LIMITS,
  EMBEDDINGGEMMA2_PROTOCOL,
  GridClient,
  SGLAPIError,
  SGLEmbeddingInputError,
  createInlineEmbeddingMedia,
  embeddingAudio,
  embeddingImage,
  embeddingItem,
  embeddingText,
  embeddingVideo,
} from "../dist/index.mjs";

const okResponse = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
  model: "embeddinggemma-2",
  usage: {
    prompt_tokens: 12,
    total_tokens: 12,
    cost_usd: 0.000001,
    breakdown: { text: 12, image: 0, audio: 0, video: 0 },
  },
  processor_revision: "a".repeat(40),
  embedding_protocol: EMBEDDINGGEMMA2_PROTOCOL,
};

async function captureEmbed(request) {
  let captured;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await new GridClient({ apiKey: "x402c_test", baseUrl: "https://grid.test" }).embed(request);
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

test("legacy string and string-array embedding inputs remain unchanged", async () => {
  assert.equal((await captureEmbed({ model: "nomic-embed-text-v1.5", input: "hello" })).input, "hello");
  assert.deepEqual(
    (await captureEmbed({ model: "nomic-embed-text-v1.5", input: ["one", "two"] })).input,
    ["one", "two"],
  );
});

test("multimodal request preserves batch and content-part order", async () => {
  const item = embeddingItem(
    embeddingText("before"),
    embeddingImage(new Uint8Array([1, 2, 3]), "image/png"),
    embeddingText("after"),
  );
  const body = await captureEmbed({
    model: "embeddinggemma-2",
    input: [item, "legacy text in the same batch"],
    input_type: "unspecified",
    dimensions: 256,
    encoding_format: "float",
    tier: "confidential",
  });

  assert.deepEqual(body.input[0].content.map((part) => part.type), ["text", "image", "text"]);
  assert.equal(body.input[1], "legacy text in the same batch");
  assert.equal(body.input_type, "unspecified");
  assert.equal(body.dimensions, 256);
  assert.equal(body.encoding_format, "float");
  assert.equal(body.tier, "confidential");
});

test("inline media helper creates canonical base64 and SHA-256", () => {
  const media = createInlineEmbeddingMedia(new TextEncoder().encode("hello"), "image/png");
  assert.deepEqual(media, {
    encoding: "base64",
    mime_type: "image/png",
    data: "aGVsbG8=",
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
});

test("audio and video helpers enforce duration limits with stable client codes", () => {
  const bytes = new Uint8Array([1]);
  assert.equal(embeddingAudio(bytes, "audio/wav", 30).duration_seconds, 30);
  assert.equal(embeddingVideo(bytes, "video/mp4", 32).duration_seconds, 32);
  assert.throws(
    () => embeddingAudio(bytes, "audio/wav", EMBEDDINGGEMMA2_LIMITS.maxAudioSeconds + 1),
    (error) => error instanceof SGLEmbeddingInputError && error.code === "invalid_duration",
  );
});

test("server embedding error type and safe runtime code remain inspectable", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Embedding input could not be processed.",
      type: "invalid_request_error",
      code: "embedding_context_overflow",
    },
  }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      new GridClient({ apiKey: "x402c_test", baseUrl: "https://grid.test" }).embed({
        model: "embeddinggemma-2",
        input: "too much",
      }),
      (error) => {
        assert.ok(error instanceof SGLAPIError);
        assert.equal(error.errorType, "invalid_request_error");
        assert.equal(error.errorCode, "embedding_context_overflow");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("402 rewrite preserves the server's stable payment type", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "Payment required", type: "payment_required" },
  }), { status: 402, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      new GridClient({ baseUrl: "https://grid.test" }).embed({ model: "embeddinggemma-2", input: "hello" }),
      (error) => error instanceof SGLAPIError && error.errorType === "payment_required",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
