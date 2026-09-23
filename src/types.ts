export interface TeeCapacity {
  tee_type: string;
  total_nodes: number;
  active_nodes: number;
  available_nodes: number;
}

export interface CapacityResponse {
  total_nodes: number;
  active_nodes: number;
  available_nodes: number;
  by_tee_type: TeeCapacity[];
  updated_at?: string;
}

export interface ModelPricing {
  price_per_1k_input_tokens_usd: number;
  price_per_1k_output_tokens_usd: number;
}

export interface ModelInfo {
  id: string;
  owned_by: string;
  sgl_node_count: number;
  sgl_tee_types: string[];
  sgl_pricing?: ModelPricing;
}

export interface PricingInfo {
  model: string;
  price_per_1k_input_tokens_usd: number;
  price_per_1k_output_tokens_usd: number;
}

export interface JobSubmission {
  model: string;
  input: Record<string, unknown>;
  submitter_wallet?: string;
  submitter_chain?: string;
}

export interface JobResponse {
  job_id: string;
  status: string;
  model: string;
  node_id?: string;
  tee_type?: string;
  estimated_cost_usd?: number;
  created_at?: string;
}

export interface AttestationProof {
  node_id: string;
  tee_type: string;
  job_id: string;
  attestation_signature: string;
  attestation_report?: string;
  verified: boolean;
  verified_at?: string;
}

export interface JobResult {
  id: string;
  status: string;
  model: string;
  node_id?: string;
  tee_type?: string;
  result?: Record<string, unknown>;
  encrypted_result?: string;
  attestation_proof?: AttestationProof;
  cost_usd?: number;
  created_at?: string;
  completed_at?: string;
  error?: string;
}

export interface GridClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

/** A part of a multimodal message: text, or an image (data URL or https URL). Send an
 *  `image_url` part to a vision model to ask about an image. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain text, or an array of content parts for multimodal (vision) requests. */
  content: string | ChatContentPart[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Pin a specific provider node (else the grid routes). See `providers()`. */
  node?: string;
  /** Restrict to a cluster's nodes (cluster slug or id). */
  cluster?: string;
  /** Pay in the cluster's token instead of USDC (cluster requests only). */
  pay_in_coin?: boolean;
  /** Max blended price (USD per 1M tokens) you'll accept — routes only to
   * nodes at/under this and never bills above it. Omit for no cap. */
  max_price?: number;
}

/** Request for {@link SGLClient.embed}. `input` is a string or an array of strings. */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  /** Truncate Matryoshka models (e.g. nomic 768→256). Ignored by fixed-size models. */
  dimensions?: number;
  /** Asymmetric-retrieval hint for models that support it. */
  input_type?: "query" | "document";
  /** Route tier: 'standard' (any node) or 'confidential' (attested only). */
  tier?: "standard" | "confidential";
}

/** One embedding vector plus its position in the input array. */
export interface EmbeddingDatum {
  object: "embedding";
  index: number;
  embedding: number[];
}

/** OpenAI-compatible response from `/v1/embeddings`. */
export interface EmbeddingResponse {
  object: "list";
  data: EmbeddingDatum[];
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ─── System One ──────────────────────────────────────────────────────────────
//
// Typed decision models (e.g. Laya). The caller sends application `state` plus a map of
// questions keyed by id; the node answers each one with a typed judgment. A separate modality
// from chat: billed on input only, and the orchestrator structurally validates every answer
// before it is returned (or charged).

export type SystemOneQuestionType = "choice" | "score" | "noul";

/** Pick one of the `criteria` keys. Needs at least two options. */
export interface SystemOneChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option id → description of when to pick it. */
  criteria: Record<string, string>;
}

/** Score `state` against a list of criteria. */
export interface SystemOneScoreQuestion {
  type: "score";
  instructions: string;
  /** Non-empty strings. */
  criteria: string[];
}

/** Free-form scalar answer (string, number or boolean). */
export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: string;
}

export type SystemOneQuestion =
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion
  | SystemOneNoulQuestion;

/** Request for {@link GridClient.systemone}`.create`. */
export interface SystemOneRequest {
  /** A System One model id, e.g. `convaiinnovations/laya` (or the `laya` alias). */
  model: string;
  /** Application state the questions are asked about. Any JSON value; must be non-empty. */
  state: unknown;
  /** Questions keyed by id (`[A-Za-z0-9_.:-]{1,96}`). Answers come back under the same ids. */
  questions: Record<string, SystemOneQuestion>;
  task?: string;
  lang?: string;
  /** Route tier: 'standard' (any node) or 'confidential' (attested only). */
  tier?: "standard" | "confidential";
  user?: string;
}

export interface SystemOneChoiceAnswer {
  type: "choice";
  /** One of the question's `criteria` keys. */
  choice: string;
  /** Option id → probability in [0, 1]. */
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface SystemOneScoreAnswer {
  type: "score";
  score: number;
  confidence?: number;
}

export interface SystemOneNoulAnswer {
  type: "noul";
  value?: string | number | boolean | null;
  confidence?: number;
}

export type SystemOneAnswer =
  | SystemOneChoiceAnswer
  | SystemOneScoreAnswer
  | SystemOneNoulAnswer;

/** Response from `POST /v1/systemone`. */
export interface SystemOneResponse {
  object: "systemone.result";
  model: string;
  /** One answer per question id in the request. */
  answers: Record<string, SystemOneAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** What this call was billed, in USD. */
    cost_usd: number;
  };
}

/** A System One model from `GET /v1/models?type=systemone`. */
export interface SystemOneModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  type: "systemone";
  /** Max input tokens (state + questions). */
  context_window: number;
  /** Max questions per request. */
  max_questions: number;
  /** true when the grid listed it from a fallback (e.g. its database was slow). */
  degraded?: boolean;
}

/** A node serving a model, with its effective per-token price. From `providers()`. */
export interface ProviderInfo {
  node_id: string;
  input_per_m: number;
  output_per_m: number;
  blended_per_1k: number;
  /** true if the operator set a custom price; false = platform reference. */
  is_custom: boolean;
  reputation?: number;
  load?: number;
  max_concurrent_jobs?: number;
  tee_type?: string;
  online: boolean;
}

export interface ProvidersResponse {
  model: string;
  cluster: string | null;
  count: number;
  providers: ProviderInfo[];
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Confidential-compute attestation of the serving node (E2E path). */
  attestation?: Attestation;
}

/** Confidential-compute attestation of the node that served the request. */
export interface Attestation {
  nodeId: string;
  teeType: string | null;
  verified: boolean;
}

/** Response from POST /v1/reserve — the node + the X25519 key to seal the prompt to. */
export interface ReserveResponse {
  reservation_token: string;
  node_id: string;
  node_x25519_pubkey: string;
  node_ed25519_pubkey: string | null;
  tee_type?: string | null;
  attestation_verified?: boolean;
  expires_in_ms: number;
}


export interface WalletAuth {
  address: string;
  chain?: string;
  signature: string;
  timestamp: string;
  nonce: string;
}
