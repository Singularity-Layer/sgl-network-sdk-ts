# @singularity-layer/grid

TypeScript SDK for the [SGL Network](https://singularitylayer.xyz) — a decentralized confidential compute grid with TEE-verified hardware.

## Install

```bash
npm install @singularity-layer/grid
```

## Quick Start

### OpenAI-compatible chat

```typescript
import { GridClient } from "@singularity-layer/grid";

const grid = new GridClient();

const response = await grid.chatCompletions({
  model: "gemma2:2b",
  messages: [{ role: "user", content: "What is 2+2?" }],
});

console.log(response.choices[0].message.content);
```

### With the OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL:
    "https://grid.x402compute.cc/v1",
  apiKey: "sgl-anonymous",
});

const completion = await client.chat.completions.create({
  model: "gemma2:2b",
  messages: [{ role: "user", content: "Hello from the grid!" }],
});
```

### Grid discovery

```typescript
import { GridClient } from "@singularity-layer/grid";

const grid = new GridClient();

// Check available capacity
const capacity = await grid.capacity();
console.log(`${capacity.active_nodes} nodes online`);

// List available models
const models = await grid.models();
models.forEach((m) => console.log(`${m.id} — ${m.sgl_node_count} nodes`));

// Get pricing
const pricing = await grid.pricing();
pricing.forEach((p) =>
  console.log(`${p.model}: $${p.price_per_1k_input_tokens_usd}/1k tokens`),
);
```

### Multimodal embeddings

EmbeddingGemma 2 accepts text, images, audio, and video in one ordered input. The helper
functions encode bytes as canonical base64 and add the required SHA-256 digest locally.

```typescript
import {
  GridClient,
  embeddingImage,
  embeddingItem,
  embeddingText,
} from "@singularity-layer/grid";

const grid = new GridClient({ apiKey: "x402c_..." });
const imageBytes = new Uint8Array(await (await fetch("/product.png")).arrayBuffer());

const response = await grid.embed({
  model: "embeddinggemma-2",
  input: [
    embeddingItem(
      embeddingText("Find results that match this image."),
      embeddingImage(imageBytes, "image/png"),
    ),
  ],
  input_type: "query",
  dimensions: 256,
});

console.log(response.data[0].embedding);
console.log(response.usage?.breakdown); // { text, image, audio, video }
```

Legacy text calls remain valid: `input` can still be a string or `string[]`. A multimodal
batch can mix those strings with ordered `embeddingItem(...)` values. Use `embeddingAudio`
and `embeddingVideo` when those media types are needed; both require `duration_seconds`.

Media must be inline. Supported types are JPEG, PNG, WebP, WAV, FLAC, MP3, and MP4. The
request limits are exported as `EMBEDDINGGEMMA2_LIMITS`: 16 batch items, 16 parts per item,
8 images per item, 8 MiB per image or audio file, 16 MiB per video, 20 MiB decoded media per
request, 30 seconds of audio, 32 seconds of video sampled at up to 32 frames, and 8192
processed tokens per item. Output dimensions are 768, 512, 256, and 128. Remote media URLs
are not accepted.

### System One / Laya

Laya is served as a typed-decision model, not as chat completions.

```typescript
import { GridClient } from "@singularity-layer/grid";

const grid = new GridClient({ apiKey: "x402c_..." });

const systemOneModels = await grid.systemOneModels();
console.log(systemOneModels.map((model) => model.id));

const decision = await grid.systemOne({
  model: "convaiinnovations/laya",
  state: { ticket: "Enterprise customer cannot access billing exports" },
  questions: {
    route: {
      type: "choice",
      instructions: "Choose the best team.",
      criteria: {
        billing: "Billing, invoice, refund, or account credit issue.",
        support: "Product defect or technical troubleshooting.",
      },
    },
    urgency: {
      type: "score",
      instructions: "Score urgency from 0 to 1.",
    },
  },
});

console.log(decision.answers);
```

### Submit a job

```typescript
import { GridClient } from "@singularity-layer/grid";

const grid = new GridClient({ apiKey: "scg_..." });

const job = await grid.submitJob("gemma2:2b", {
  messages: [{ role: "user", content: "Summarize quantum computing" }],
});

console.log(`Job ${job.job_id}: ${job.status}`);

// Poll for result
const result = await grid.getJob(job.job_id);
if (result.status === "completed") {
  console.log(result.result);
}

// Verify TEE attestation
const attestation = await grid.getAttestation(job.job_id);
console.log(`Verified: ${attestation.verified}, TEE: ${attestation.tee_type}`);
```

## Configuration

```typescript
const grid = new GridClient({
  apiKey: "scg_...", // Optional — required for job submission
  baseUrl: "https://custom-orchestrator.example.com", // Override orchestrator URL
  timeout: 30_000, // Request timeout in ms (default: 60000)
});
```

## Error Handling

```typescript
import {
  GridClient,
  SGLAPIError,
  SGLAuthError,
  SGLConnectionError,
  SGLNotFoundError,
} from "@singularity-layer/grid";

try {
  const result = await grid.getJob("nonexistent");
} catch (err) {
  if (err instanceof SGLNotFoundError) {
    console.log("Job not found");
  } else if (err instanceof SGLAuthError) {
    console.log("Invalid API key");
  } else if (err instanceof SGLConnectionError) {
    console.log("Orchestrator unreachable");
  } else if (err instanceof SGLAPIError) {
    console.log(`API error ${err.statusCode} (${err.errorType}): ${err.message}`);
    // Embedding input failures can also expose a privacy-safe `errorCode`, such as
    // "embedding_context_overflow". Raw node errors are never returned.
    console.log(err.errorCode);
  }
}
```

## Requirements

- Node.js >= 18 (uses native `fetch`)
- Zero dependencies

## License

MIT

## Processors

Processors are served by `processors.x402compute.cc`, not the grid, so they have their own client.

```ts
import { ProcessorsClient } from "@singularity-layer/grid";

const p = new ProcessorsClient({ apiKey: process.env.SGL_API_KEY });

await p.catalogue();                       // public, no credential
await p.list();                            // yours          (processors:read)
await p.deploy({ manifest, code });        // returns the invoke token ONCE
await p.update("my-processor", { code });
await p.setListing("my-processor", true);
await p.run("my-processor", { name: "world" }, invokeToken);
```

> **`processors:write` is full control** of processors owned by that key's wallet — delete and
> secrets included, the same as a Cloudflare API token. Mint `processors:read` if you want a
> credential that cannot change anything. Note that compute keys do not expire, there is no audit
> log, and **delete is permanent**: the code is wiped and the slug is burned forever.

`run()` takes the **invoke token** from `deploy()`, not the API key — the run route is the only one
with both a money path and an anonymous buyer lane, so it does not read a key as an ownership
claim. Buyers use `runWithPayment()` with an x402 header instead.

### Upgrading from 0.8.x

The six processor methods on `GridClient` (`deployProcessor`, `invokeProcessor`,
`listProcessors`, `getProcessor`, `deleteProcessor`, `getProcessorLogs`) are **removed**. They
pointed at `/grid/processors`, which has never existed — every call returned 404 — and their types
described an older design that was never shipped. Use `ProcessorsClient`. Nothing else changed:
chat, embeddings, jobs, models, capacity, pricing, reserve and the vault are untouched.
