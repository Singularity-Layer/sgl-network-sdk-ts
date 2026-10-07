export { GridClient, DEFAULT_BASE_URL } from "./client.js";
export { PodsClient, DEFAULT_PODS_BASE_URL, verifyPodWebhook } from "./pods.js";
export type {
  Pod,
  PodStatus,
  PodEvent,
  PodWebhook,
  PodUpdates,
  PodCapabilities,
  PodsClientOptions,
  CreatePodOptions,
} from "./pods.js";
export {
  VaultClient,
  VAULT_URL,
  encryptEnvelope,
  decryptEnvelope,
  parseAadFromKey,
} from "./vault.js";
export type {
  VaultAad,
  VaultAgent,
  VaultSnapshot,
  VaultUsage,
  VaultClientOptions,
} from "./vault.js";
export {
  SGLError,
  SGLAPIError,
  SGLAuthError,
  SGLNotFoundError,
  SGLConnectionError,
  SGLEmbeddingInputError,
} from "./errors.js";
export type { SGLEmbeddingInputErrorCode } from "./errors.js";
export {
  EMBEDDINGGEMMA2_LIMITS,
  EMBEDDINGGEMMA2_MIME_TYPES,
  EMBEDDINGGEMMA2_MODEL,
  EMBEDDINGGEMMA2_PROTOCOL,
  createInlineEmbeddingMedia,
  embeddingAudio,
  embeddingImage,
  embeddingItem,
  embeddingText,
  embeddingVideo,
  validateEmbeddingGemma2Input,
} from "./embeddings.js";
export type {
  Attestation,
  AttestationProof,
  CapacityResponse,
  ChatChoice,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingDatum,
  EmbeddingAudioMimeType,
  EmbeddingAudioPart,
  EmbeddingContentPart,
  EmbeddingErrorType,
  EmbeddingFailureCode,
  EmbeddingGemma2Dimension,
  EmbeddingImageMimeType,
  EmbeddingImagePart,
  EmbeddingInput,
  EmbeddingInputType,
  EmbeddingMediaMimeType,
  EmbeddingModality,
  EmbeddingTextPart,
  EmbeddingUsage,
  EmbeddingUsageBreakdown,
  EmbeddingVideoMimeType,
  EmbeddingVideoPart,
  InlineEmbeddingMedia,
  MultimodalEmbeddingItem,
  ReserveResponse,
  GridClientOptions,
  JobResponse,
  JobResult,
  JobSubmission,
  ModelInfo,
  ModelPricing,
  PricingInfo,
  TeeCapacity,
  SystemOneQuestion,
  SystemOneQuestionType,
  SystemOneRequest,
  SystemOneResponse,
  V1ModelInfo,
  WalletAuth,
} from "./types.js";

// ─── Processors ──────────────────────────────────────────────────────────────
//
// A SEPARATE client, on a separate host. Until 0.9.0 these lived on GridClient and pointed at
// `/grid/processors`, which has never existed — every call 404'd. Processors are served by
// processors.x402compute.cc, and giving GridClient a second base URL would have meant a per-call
// host override in the request path that chat, embeddings and jobs share. Not worth the risk.
export {
  ProcessorsClient,
  PROCESSORS_BASE_URL,
  type ProcessorsClientOptions,
  type ProcessorManifest,
  type ProcessorLimits,
  type ProcessorSecretDeclaration,
  type ProcessorPayout,
  type DeployProcessorInput,
  type ProcessorDeployResult,
  type ProcessorSummary,
  type ProcessorListResponse,
  type ProcessorRun,
  type ProcessorRunsResponse,
  type ProcessorEarnings,
  type ProcessorWebhookRegistration,
} from "./processors.js";
