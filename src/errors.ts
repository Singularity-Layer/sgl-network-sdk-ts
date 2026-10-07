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
  | "invalid_media_data"
  | "unsupported_media_type"
  | "media_too_large"
  | "invalid_duration"
  | "too_many_parts";

/** Deterministic client-side validation error thrown by embedding part helpers. */
export class SGLEmbeddingInputError extends SGLError {
  readonly code: SGLEmbeddingInputErrorCode;

  constructor(code: SGLEmbeddingInputErrorCode, message: string) {
    super(message);
    this.name = "SGLEmbeddingInputError";
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
