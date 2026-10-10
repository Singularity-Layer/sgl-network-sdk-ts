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

/** Model descriptor returned by OpenAI-compatible `GET /v1/models`. */
export interface V1ModelInfo {
  id: string;
  object: "model" | string;
  created?: number;
  owned_by?: string;
  permission?: unknown[];
  root?: string | null;
  parent?: string | null;
  /** `systemone` for Laya/Jev-style typed decision models. */
  type?: string;
  context_window?: number;
  max_questions?: number;
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
  /** Timeout for STT reserve/submit only; defaults to 120000 ms. */
  transcriptionTimeout?: number;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  /** Exact private-canary token, sent only to transcription reserve/submit routes. */
  transcriptionCanaryToken?: string;
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

export type EmbeddingModality = "text" | "image" | "audio" | "video";

export type EmbeddingInputType = "query" | "document" | "unspecified";

/** Matryoshka output sizes supported by EmbeddingGemma 2. */
export type EmbeddingGemma2Dimension = 768 | 512 | 256 | 128;

export type EmbeddingImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type EmbeddingAudioMimeType = "audio/wav" | "audio/flac" | "audio/mpeg";
export type EmbeddingVideoMimeType = "video/mp4";
export type EmbeddingMediaMimeType =
  | EmbeddingImageMimeType
  | EmbeddingAudioMimeType
  | EmbeddingVideoMimeType;

/** Inline media accepted by EmbeddingGemma 2. Remote URLs and local paths are not accepted. */
export interface InlineEmbeddingMedia {
  encoding: "base64";
  mime_type: EmbeddingMediaMimeType;
  data: string;
  /** Lowercase SHA-256 of the decoded bytes. */
  sha256: string;
}

export interface EmbeddingTextPart {
  type: "text";
  text: string;
}

export interface EmbeddingImagePart {
  type: "image";
  media: InlineEmbeddingMedia & { mime_type: EmbeddingImageMimeType };
}

export interface EmbeddingAudioPart {
  type: "audio";
  media: InlineEmbeddingMedia & { mime_type: EmbeddingAudioMimeType };
  duration_seconds: number;
}

export interface EmbeddingVideoPart {
  type: "video";
  media: InlineEmbeddingMedia & { mime_type: EmbeddingVideoMimeType };
  duration_seconds: number;
}

/** Ordered content. Part order is preserved when the grid builds the embedding input. */
export type EmbeddingContentPart =
  | EmbeddingTextPart
  | EmbeddingImagePart
  | EmbeddingAudioPart
  | EmbeddingVideoPart;

export interface MultimodalEmbeddingItem {
  content: EmbeddingContentPart[];
}

/** A legacy text input or an ordered batch mixing legacy text and multimodal items. */
export type EmbeddingInput = string | Array<string | MultimodalEmbeddingItem>;

/** Request for {@link GridClient.embed}. */
export interface EmbeddingRequest {
  model: string;
  input: EmbeddingInput;
  /** Truncate Matryoshka models. EmbeddingGemma 2 supports 768, 512, 256, and 128. */
  dimensions?: number;
  /** Retrieval hint. `unspecified` is supported by EmbeddingGemma 2 and adds no prefix. */
  input_type?: EmbeddingInputType;
  /** The grid currently returns float vectors only. */
  encoding_format?: "float";
  /** Route tier: 'standard' (any node) or 'confidential' (attested only). */
  tier?: "standard" | "confidential";
}

/** One embedding vector plus its position in the input array. */
export interface EmbeddingDatum {
  object: "embedding";
  index: number;
  embedding: number[];
}

export interface EmbeddingUsageBreakdown {
  text: number;
  image: number;
  audio: number;
  video: number;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
  cost_usd?: number;
  /** Present for EmbeddingGemma 2; values sum to `prompt_tokens`. */
  breakdown?: EmbeddingUsageBreakdown;
}

/** Stable server-side categories returned by the embeddings endpoint. */
export type EmbeddingErrorType =
  | "invalid_request_error"
  | "model_not_found"
  | "model_not_available"
  | "node_not_available"
  | "invalid_api_key"
  | "insufficient_scope"
  | "invalid_session"
  | "insufficient_credits"
  | "pod_cap_reached"
  | "payment_required"
  | "payment_error"
  | "timeout"
  | "inference_error"
  | "server_error";

/** Privacy-safe synchronous codes that can accompany `invalid_request_error`. */
export type EmbeddingFailureCode =
  | "embedding_input_invalid"
  | "embedding_context_overflow";

/** OpenAI-compatible response from `/v1/embeddings`. */
export interface EmbeddingResponse {
  object: "list";
  data: EmbeddingDatum[];
  model: string;
  usage?: EmbeddingUsage;
  /** Present for EmbeddingGemma 2 responses. */
  processor_revision?: string;
  /** Present for EmbeddingGemma 2 responses. */
  embedding_protocol?: "embedding-multimodal-v1";
}

export type SystemOneQuestionType = "choice" | "score" | "noul" | string;

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: unknown;
  [key: string]: unknown;
}

/** Request body for `POST /v1/systemone` (Laya/System One typed decisions). */
export interface SystemOneRequest {
  /** Defaults to `convaiinnovations/laya`. */
  model?: string;
  state: Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
  /** Pin a specific provider node when supported by the grid route. */
  node?: string;
  /** Restrict to a cluster's nodes (cluster slug or id). */
  cluster?: string;
  /** Max blended price you'll accept when supported by the grid route. */
  max_price?: number;
}

/** Response from `POST /v1/systemone`. Answer values depend on each question type. */
export interface SystemOneResponse {
  object: string;
  model: string;
  answers: Record<string, unknown>;
  usage?: Record<string, unknown>;
  attestation?: Attestation;
  [key: string]: unknown;
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
  node_x25519_pubkey_sig?: string | null;
  key_version?: number | null;
  tee_type?: string | null;
  attestation_verified?: boolean;
  expires_in_ms: number;
}

/** Options for one bounded, non-streaming transcription request. */
export interface TranscriptionRequestOptions {
  /** The v1 Grid model. Other model IDs are rejected before network access. */
  model?: "whisper-1";
  /** `auto` (default) or a lowercase ISO 639-1 language hint. */
  language?: string;
  /** Canonical lowercase UUIDv4. Generated when omitted; reuse only to reconcile one request. */
  requestId?: string;
  /** Ask the reservation endpoint to use API-key/session credits. Defaults to true. */
  useCredits?: boolean;
  /** Pin an eligible transcription node. */
  node?: string;
  /** Maximum accepted quoted price in USD. */
  maxPrice?: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionUsage {
  /** Billable seconds derived from the authenticated PCM sample count. */
  audio_seconds: number;
  cost_usd: number;
}

/** Validated final result from `POST /v1/audio/transcriptions`. */
export interface TranscriptionResponse {
  object: "transcription";
  job_id: string;
  request_id: string;
  model: "whisper-1";
  model_revision: string;
  model_sha256: string;
  transcription_protocol: "transcription-v1";
  sample_count: number;
  text: string;
  /** Language hint authenticated in the request (`auto` or a two-letter code). */
  language_hint: string;
  /** Detected output language, when the runtime reports one. */
  language: string | null;
  duration_seconds: number;
  segments: TranscriptionSegment[];
  usage: TranscriptionUsage;
  billing_pending?: boolean;
  attestation: Attestation;
}


export interface WalletAuth {
  address: string;
  chain?: string;
  signature: string;
  timestamp: string;
  nonce: string;
}
