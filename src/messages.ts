/**
 * Anthropic Messages API types for the Grid.
 *
 * The Grid speaks the Anthropic Messages format at `POST /v1/messages` next to the OpenAI one.
 * It is a translation layer over the same chat path: auth, credits, x402, node routing and
 * billing are unchanged. Model ids are Grid model ids (for example `qwen-2.5-32b`), never
 * Claude ids. See `GridClient.messages`, `GridClient.messagesStream` and
 * `GridClient.countMessageTokens`.
 *
 * These types cover what the Grid accepts. Fields the Grid rejects (extended thinking with a
 * budget, server tools, documents, `top_p`, `top_k`, assistant prefill) are left out on purpose.
 */

/** The `anthropic-version` header value the SDK sends. The Grid accepts it and does not enforce it. */
export const ANTHROPIC_VERSION = "2023-06-01";

export interface MessageTextBlock {
  type: "text";
  text: string;
}

/** Base64 images only, on vision models, one image per request, non-streaming only. */
export interface MessageImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface MessageToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MessageToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | MessageTextBlock[];
  is_error?: boolean;
}

export type MessageContentBlock =
  | MessageTextBlock
  | MessageImageBlock
  | MessageToolUseBlock
  | MessageToolResultBlock;

export interface MessageParam {
  role: "user" | "assistant" | "system";
  content: string | MessageContentBlock[];
}

export interface MessageTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type MessageToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

export interface MessagesRequest {
  /** A Grid model id. List them with `v1Models()` or `GET /v1/models`. */
  model: string;
  messages: MessageParam[];
  max_tokens: number;
  system?: string | MessageTextBlock[];
  stop_sequences?: string[];
  temperature?: number;
  tools?: MessageTool[];
  tool_choice?: MessageToolChoice;
  /** Set by `messagesStream`; leave it out for `messages`. */
  stream?: boolean;
  /** Accepted and ignored by the Grid, so clients built for Claude keep working. */
  metadata?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface MessagesUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Grid extra: what this request was charged, in US dollars. */
  cost_usd?: number;
}

export type MessageStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal";

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<MessageTextBlock | MessageToolUseBlock>;
  stop_reason: MessageStopReason | null;
  stop_sequence: string | null;
  usage: MessagesUsage;
}

/**
 * One server-sent event from a streaming `/v1/messages` call, parsed. `type` is the Anthropic
 * event name: `message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`, `ping` or `error`.
 */
export interface MessageStreamEvent {
  type: string;
  [field: string]: unknown;
}

export interface CountTokensRequest {
  model: string;
  messages: MessageParam[];
  system?: string | MessageTextBlock[];
  tools?: MessageTool[];
}

/** An estimate from the Grid's own estimator, not a model tokenizer count. */
export interface CountTokensResponse {
  input_tokens: number;
}
