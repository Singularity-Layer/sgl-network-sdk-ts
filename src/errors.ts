export class SGLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SGLError";
  }
}

export class SGLAPIError extends SGLError {
  readonly statusCode: number;
  readonly body?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = "SGLAPIError";
    this.statusCode = statusCode;
    this.body = body;
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
