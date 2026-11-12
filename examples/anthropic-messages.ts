/**
 * Anthropic Messages API on the Singularity Layer Grid.
 *
 *   SGL_API_KEY=x402c_... npx tsx examples/anthropic-messages.ts
 *
 * Model ids are Grid model ids. Claude Code users: set ANTHROPIC_BASE_URL=https://grid.x402compute.cc
 * and ANTHROPIC_API_KEY to your compute key, and pick a large-context model (Claude Code's own
 * prompt is about 13k tokens; today qwen-2.5-32b at 32k fits).
 */
import { GridClient } from "@singularity-layer/grid";

const MODEL = process.env.SGL_MODEL ?? "qwen-2.5-32b";
const grid = new GridClient({ apiKey: process.env.SGL_API_KEY });

const { input_tokens } = await grid.countMessageTokens({
  model: MODEL,
  messages: [{ role: "user", content: "Name three uses of a trusted execution environment." }],
});
console.log(`estimated input tokens: ${input_tokens}`);

const msg = await grid.messages({
  model: MODEL,
  max_tokens: 256,
  system: "Be brief.",
  messages: [{ role: "user", content: "Name three uses of a trusted execution environment." }],
});
for (const block of msg.content) if (block.type === "text") console.log(block.text);
console.log(`stop: ${msg.stop_reason}, usage:`, msg.usage);

// Tools: the model answers with a tool_use block you run yourself.
const withTool = await grid.messages({
  model: MODEL,
  max_tokens: 256,
  tools: [{
    name: "get_weather",
    description: "Current weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }],
  messages: [{ role: "user", content: "What is the weather in Paris?" }],
});
console.log(withTool.stop_reason, withTool.content);

// Streaming
for await (const ev of grid.messagesStream({
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "Count from 1 to 5." }],
})) {
  const delta = (ev as { delta?: { type?: string; text?: string } }).delta;
  if (ev.type === "content_block_delta" && delta?.type === "text_delta") process.stdout.write(delta.text ?? "");
}
console.log();
