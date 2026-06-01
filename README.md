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
    console.log(`API error ${err.statusCode}: ${err.message}`);
  }
}
```

## Requirements

- Node.js >= 18 (uses native `fetch`)
- Zero dependencies

## License

MIT
