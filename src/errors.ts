export class SGLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SGLError";
  }
}

export class SGLAPIError extends SGLError {
  readonly statusCode: number;
  readonly body?: Record<string, unknown>;
  /** Stable API error category from `error.type`, when supplied by the server. */
  readonly errorType?: string;
  /** Stable machine-readable detail from `error.code`, when supplied by the server. */
  readonly errorCode?: string;

  constructor(
    statusCode: number,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = "SGLAPIError";
    this.statusCode = statusCode;
    this.body = body;
    const detail = body?.error;
    if (detail && typeof detail === "object") {
      const error = detail as Record<string, unknown>;
      if (typeof error.type === "string") this.errorType = error.type;
      if (typeof error.code === "string") this.errorCode = error.code;
    }
  }
}

export type SGLEmbeddingInputErrorCode =
  | "empty_text"
  | "invalid_batch"
  | "invalid_content_part"
  | "invalid_media_data"
  | "unsupported_media_type"
  | "media_too_large"
  | "request_media_too_large"
  | "invalid_duration"
  | "too_many_parts"
  | "too_many_images"
  | "too_many_audio_parts"
  | "too_many_video_parts"
  | "request_too_large"
  | "context_too_large"
  | "invalid_dimensions"
  | "invalid_input_type"
  | "invalid_encoding_format";

/** Deterministic client-side validation error thrown by embedding part helpers. */
export class SGLEmbeddingInputError extends SGLError {
  readonly code: SGLEmbeddingInputErrorCode;

  constructor(code: SGLEmbeddingInputErrorCode, message: string) {
    super(message);
    this.name = "SGLEmbeddingInputError";
    this.code = code;
  }
}

export type SGLTranscriptionInputErrorCode =
  | "invalid_audio_type"
  | "empty_audio"
  | "invalid_pcm_length"
  | "unsupported_audio_container"
  | "audio_too_long"
  | "invalid_language"
  | "invalid_model"
  | "invalid_request_id"
  | "invalid_option"
  | "file_too_large";

/** Deterministic validation failure raised before transcription audio is sealed or sent. */
export class SGLTranscriptionInputError extends SGLError {
  readonly code: SGLTranscriptionInputErrorCode;

  constructor(code: SGLTranscriptionInputErrorCode, message: string) {
    super(message);
    this.name = "SGLTranscriptionInputError";
    this.code = code;
  }
}

export type SGLTranscriptionResponseErrorCode =
  | "invalid_reservation"
  | "unverified_result"
  | "invalid_envelope"
  | "invalid_result"
  | "binding_mismatch";

/** A transcription response failed signature, envelope, shape, or request-binding checks. */
export class SGLTranscriptionResponseError extends SGLError {
  readonly code: SGLTranscriptionResponseErrorCode;

  constructor(code: SGLTranscriptionResponseErrorCode, message: string) {
    super(message);
    this.name = "SGLTranscriptionResponseError";
    this.code = code;
  }
}

export class SGLAuthError extends SGLAPIError {
  constructor(
    statusCode: number,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(statusCode, message, body);
    this.name = "SGLAuthError";
  }
}

export class SGLNotFoundError extends SGLAPIError {
  constructor(message: string, body?: Record<string, unknown>) {
    super(404, message, body);
    this.name = "SGLNotFoundError";
  }
}

export class SGLConnectionError extends SGLError {
  constructor(message: string) {
    super(message);
    this.name = "SGLConnectionError";
  }
}
