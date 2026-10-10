import {
  SGLAPIError,
  SGLAuthError,
  SGLConnectionError,
  SGLNotFoundError,
  SGLTranscriptionInputError,
  SGLTranscriptionResponseError,
} from "./errors.js";
import * as e2e from "./e2e.js";
import { EMBEDDINGGEMMA2_MODEL, validateEmbeddingGemma2Request } from "./embeddings.js";
import {
  TRANSCRIPTION_BITS_PER_SAMPLE,
  TRANSCRIPTION_CHANNELS,
  TRANSCRIPTION_MAX_PCM_BYTES,
  TRANSCRIPTION_MAX_RESULT_ENVELOPE_BYTES,
  TRANSCRIPTION_MODEL_REVISION,
  TRANSCRIPTION_MODEL_SHA256,
  TRANSCRIPTION_PROTOCOL,
  TRANSCRIPTION_SAMPLE_RATE,
  createTranscriptionPlaintext,
  validateSealedTranscriptionResult,
  validateTranscriptionOptions,
  validateTranscriptionPcm,
  validateTranscriptionReservation,
  type SealedTranscriptionWireResponse,
} from "./transcriptions.js";
import type {
  AttestationProof,
  CapacityResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  GridClientOptions,
  JobResponse,
  JobResult,
  ModelInfo,
  PricingInfo,
  ProviderInfo,
  ProvidersResponse,
  ReserveResponse,
  SystemOneRequest,
  SystemOneResponse,
  TranscriptionRequestOptions,
  TranscriptionResponse,
  V1ModelInfo,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://grid.x402compute.cc";

const DEFAULT_TIMEOUT = 60_000;

export class GridClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly transcriptionHeaders: Record<string, string>;
  private readonly transcriptionTimeout: number;
  private readonly timeout: number;

  constructor(options: GridClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.transcriptionTimeout = options.transcriptionTimeout ?? 120_000;
    this.headers = { Accept: "application/json", "Content-Type": "application/json" };
    this.transcriptionHeaders = options.transcriptionCanaryToken
      ? { "X-SGL-STT-Canary": options.transcriptionCanaryToken }
      : {};
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
      // Grid credit billing reads X-API-Key; send both so reserve + chat resolve
      // the paying wallet (credits mode) rather than falling back to anonymous x402.
      this.headers["X-API-Key"] = options.apiKey;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    timeout = this.timeout,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: { ...this.headers, ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        let errorBody: Record<string, unknown> | undefined;
        let message = response.statusText;
        try {
          errorBody = (await response.json()) as Record<string, unknown>;
          const err = errorBody?.error;
          if (typeof err === "string") message = err;
          else if (err && typeof err === "object" && "message" in err)
            message = String((err as { message: unknown }).message);
        } catch (err) {
          if (controller.signal.aborted) throw err;
          /* body not JSON */
        }
        if (response.status === 401 || response.status === 403) {
          throw new SGLAuthError(response.status, message, errorBody);
        }
        if (response.status === 404) {
          throw new SGLNotFoundError(message, errorBody);
        }
        throw new SGLAPIError(response.status, message, errorBody);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof SGLAPIError || err instanceof SyntaxError) throw err;
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new SGLConnectionError(`Request to ${url} timed out`);
      }
      throw new SGLConnectionError(
        `Could not connect to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Fetch can resolve before the response body arrives. Keep the deadline
      // armed through body consumption and JSON parsing as well as headers.
      clearTimeout(timer);
    }
  }

  // -- Public endpoints (no auth) ------------------------------------------

  async capacity(): Promise<CapacityResponse> {
    return this.request<CapacityResponse>("GET", "/grid/capacity");
  }

  async models(): Promise<ModelInfo[]> {
    const data = await this.request<{ models: ModelInfo[] }>("GET", "/grid/models");
    return data.models ?? [];
  }

  async pricing(): Promise<PricingInfo[]> {
    const data = await this.request<{ pricing: PricingInfo[] }>("GET", "/grid/pricing");
    return data.pricing ?? [];
  }

  async v1Models(options?: { type?: string }): Promise<V1ModelInfo[]> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const data = await this.request<{ data: V1ModelInfo[] }>("GET", `/v1/models${suffix}`);
    return data.data ?? [];
  }

  /** List Laya/Jev-style System One typed-decision models. */
  async systemOneModels(): Promise<V1ModelInfo[]> {
    return this.v1Models({ type: "systemone" });
  }

  /**
   * List the nodes serving a model with each node's effective per-token price
   * (operator's custom price if set, else the platform reference), cheapest
   * first. Pass a chosen `node_id` as `node` on `chatCompletions` to pin it,
   * or omit to let the grid route. Optional `cluster` filter (slug or id).
   */
  async providers(
    model: string,
    options?: { cluster?: string },
  ): Promise<ProviderInfo[]> {
    const params = new URLSearchParams({ model });
    if (options?.cluster) params.set("cluster", options.cluster);
    const data = await this.request<ProvidersResponse>(
      "GET",
      `/v1/providers?${params.toString()}`,
    );
    return data.providers ?? [];
  }

  // -- Authenticated endpoints ---------------------------------------------

  async submitJob(
    model: string,
    input: Record<string, unknown>,
    options?: { submitterWallet?: string; submitterChain?: string },
  ): Promise<JobResponse> {
    const body: Record<string, unknown> = { model, input };
    if (options?.submitterWallet) body.submitter_wallet = options.submitterWallet;
    if (options?.submitterChain) body.submitter_chain = options.submitterChain;
    return this.request<JobResponse>("POST", "/grid/jobs", body);
  }

  async getJob(jobId: string): Promise<JobResult> {
    return this.request<JobResult>("GET", `/grid/jobs/${jobId}`);
  }

  async getAttestation(jobId: string): Promise<AttestationProof> {
    return this.request<AttestationProof>("GET", `/grid/jobs/${jobId}/attestation`);
  }

  // -- OpenAI-compatible (end-to-end encrypted) ----------------------------

  /** Reserve a node + learn its X25519 key so we can seal the prompt to it.
   * Forwards an optional pinned `node` (see `providers()`), `cluster` filter,
   * and `pay_in_coin` so the orchestrator reserves + quotes accordingly. */
  private async reserve(req: {
    model: string;
    node?: string;
    cluster?: string;
    pay_in_coin?: boolean;
    max_price?: number;
  }): Promise<ReserveResponse> {
    const body: Record<string, unknown> = { model: req.model };
    if (req.node) body.node = req.node;
    if (req.cluster) body.cluster = req.cluster;
    if (req.pay_in_coin) body.pay_in_coin = req.pay_in_coin;
    if (req.max_price != null) body.max_price = req.max_price;
    const res = await this.request<ReserveResponse>("POST", "/v1/reserve", body);
    if (!res.node_x25519_pubkey) {
      throw new SGLAPIError(503, "Reserved node does not support E2E encryption");
    }
    return res;
  }

  /**
   * Transcribe one bounded raw PCM utterance through the confidential Grid route.
   *
   * `pcm` must already be mono, 16 kHz, signed 16-bit little-endian PCM. The SDK
   * validates the 60-second/1.92 MB bound before its first request, reserves a
   * node using metadata only, and seals the audio directly to that node. The
   * submit is intentionally attempted once: an automatic retry after a timeout
   * could duplicate a paid request whose outcome is still being reconciled.
   */
  async transcribePcm(
    pcm: Uint8Array,
    options: TranscriptionRequestOptions = {},
  ): Promise<TranscriptionResponse> {
    const sampleCount = validateTranscriptionPcm(pcm);
    // Callers may reuse their recording buffer while the metadata request waits.
    const raw = Uint8Array.from(pcm);
    const checked = validateTranscriptionOptions(options);
    const reserveBody: Record<string, unknown> = {
      model: checked.model,
      model_revision: TRANSCRIPTION_MODEL_REVISION,
      model_sha256: TRANSCRIPTION_MODEL_SHA256,
      transcription_protocol: TRANSCRIPTION_PROTOCOL,
      request_id: checked.requestId,
      sample_rate: TRANSCRIPTION_SAMPLE_RATE,
      channels: TRANSCRIPTION_CHANNELS,
      bits_per_sample: TRANSCRIPTION_BITS_PER_SAMPLE,
      sample_count: sampleCount,
      language: checked.language,
      use_credits: checked.useCredits,
    };
    if (checked.node) reserveBody.node = checked.node;
    if (checked.maxPrice !== undefined) reserveBody.max_price = checked.maxPrice;

    let reserveValue: unknown;
    try {
      reserveValue = await this.request(
        "POST",
        "/v1/audio/transcriptions/reserve",
        reserveBody,
        this.transcriptionHeaders,
        this.transcriptionTimeout,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription reservation was not valid JSON");
      }
      if (error instanceof SGLAPIError && error.statusCode === 402) {
        throw new SGLAPIError(
          402,
          "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.",
          error.body,
        );
      }
      throw error;
    }
    const reservation = validateTranscriptionReservation(reserveValue, {
      requestId: checked.requestId,
      sampleCount,
      model: checked.model,
      language: checked.language,
    });
    if (checked.node !== undefined && reservation.node_id !== checked.node) {
      throw new SGLTranscriptionResponseError("binding_mismatch", "Reserved node does not match the requested node");
    }
    if (checked.maxPrice !== undefined && reservation.quote.price_usd > checked.maxPrice + 1e-9) {
      throw new SGLTranscriptionResponseError(
        "binding_mismatch",
        "Transcription quote exceeds maxPrice",
      );
    }
    if (!e2e.verifyKeybindSignature({
      nodeId: reservation.node_id,
      ed25519B58: reservation.node_ed25519_pubkey,
      x25519B58: reservation.node_x25519_pubkey,
      keyVersion: reservation.key_version,
      signatureB58: reservation.node_x25519_pubkey_sig,
    })) {
      throw new SGLTranscriptionResponseError(
        "invalid_reservation",
        "Reserved transcription node has an invalid transport-key binding",
      );
    }

    const { secret, pubB58 } = e2e.newResponseKeypair();
    let sealed: ReturnType<typeof e2e.sealInputV2Base64>;
    try {
      sealed = e2e.sealInputV2Base64(
        reservation.node_x25519_pubkey,
        pubB58,
        createTranscriptionPlaintext(raw, reservation),
      );
    } catch {
      throw new SGLTranscriptionResponseError("invalid_reservation", "Reserved node transport key cannot seal transcription audio");
    }
    const submitBody = {
      reservation_token: reservation.reservation_token,
      enc: {
        ciphertext: sealed.ciphertext,
        client_ephemeral_pubkey: sealed.ephemeralPub,
        client_response_pubkey: pubB58,
        algorithm: e2e.ALGO_V2,
        encoding: "base64" as const,
      },
    };

    let data: SealedTranscriptionWireResponse;
    try {
      data = await this.request(
        "POST",
        "/v1/audio/transcriptions",
        submitBody,
        this.transcriptionHeaders,
        this.transcriptionTimeout,
      );
    } catch (error) {
      if (error instanceof SGLConnectionError) {
        throw new SGLConnectionError(`Transcription submit outcome may be unknown; reconcile request ${checked.requestId} before retrying`);
      }
      if (error instanceof SyntaxError) {
        throw new SGLTranscriptionResponseError("invalid_envelope", "Transcription response was not valid JSON");
      }
      if (error instanceof SGLAPIError && error.statusCode === 402) {
        throw new SGLAPIError(
          402,
          "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.",
          error.body,
        );
      }
      throw error;
    }
    if (
      !data || typeof data !== "object" || Array.isArray(data) || data.object !== "transcription" ||
      data.job_id !== reservation.request_id ||
      data.result_envelope_version !== "v1" ||
      typeof data.result_envelope_signature !== "string" ||
      data.result_envelope_signature.length < 64 || data.result_envelope_signature.length > 88 ||
      !data.sealed_result || data.sealed_result.algorithm !== e2e.ALGO_V2 ||
      data.sealed_result.encoding !== "base64" ||
      typeof data.sealed_result.ephemeral_public_key !== "string" ||
      data.sealed_result.ephemeral_public_key.length < 32 || data.sealed_result.ephemeral_public_key.length > 44 ||
      typeof data.sealed_result.ciphertext !== "string" ||
      data.sealed_result.ciphertext.length > 4 * Math.ceil(TRANSCRIPTION_MAX_RESULT_ENVELOPE_BYTES / 3) ||
      (data.sealed_result.ciphertext.length / 4) * 3 -
        (data.sealed_result.ciphertext.endsWith("==") ? 2 : data.sealed_result.ciphertext.endsWith("=") ? 1 : 0) > TRANSCRIPTION_MAX_RESULT_ENVELOPE_BYTES
    ) {
      throw new SGLTranscriptionResponseError(
        "invalid_envelope",
        "Transcription response did not contain the negotiated signed envelope",
      );
    }
    try {
      e2e.requireVerifiedReply(
        reservation,
        {
          job_id: data.job_id,
          sealed_result: { ciphertext: data.sealed_result.ciphertext },
          result_envelope_signature: data.result_envelope_signature,
          result_envelope_version: data.result_envelope_version,
        },
        "transcription",
      );
    } catch {
      throw new SGLTranscriptionResponseError(
        "unverified_result",
        "Transcription result is not signed by the reserved node",
      );
    }

    let parsed: unknown;
    try {
      const plain = e2e.openOutputV2Base64(
        secret,
        pubB58,
        data.sealed_result.ephemeral_public_key,
        data.sealed_result.ciphertext,
      );
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    } catch {
      throw new SGLTranscriptionResponseError(
        "invalid_envelope",
        "Transcription result could not be decrypted and decoded",
      );
    }
    return validateSealedTranscriptionResult(
      parsed,
      data.job_id,
      reservation,
      data.usage,
      data.billing_pending,
    );
  }

  /** Read and transcribe a Blob containing raw PCM. Oversized blobs are refused before reading. */
  async transcribePcmFile(
    file: Blob,
    options: TranscriptionRequestOptions = {},
  ): Promise<TranscriptionResponse> {
    if (!(file instanceof Blob)) {
      throw new SGLTranscriptionInputError("invalid_audio_type", "file must be a Blob containing raw PCM");
    }
    if (file.size > TRANSCRIPTION_MAX_PCM_BYTES) {
      throw new SGLTranscriptionInputError(
        "file_too_large",
        `PCM file must be at most ${TRANSCRIPTION_MAX_PCM_BYTES} bytes`,
      );
    }
    return this.transcribePcm(new Uint8Array(await file.arrayBuffer()), options);
  }

  /**
   * End-to-end encrypted chat completion. The prompt is sealed in this client to
   * the serving node's key and only decrypts inside its TEE — the orchestrator
   * only relays ciphertext. Requires an `apiKey` (credits); without one the grid
   * replies 402 (the SDK does not sign x402 payments — use the wallet/browser flow).
   */
  async chatCompletions(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    if (request.stream) {
      // Collapse the stream into a single response for the non-streaming API.
      let content = "";
      for await (const delta of this.chatCompletionStream(request)) content += delta;
      return {
        id: "", object: "chat.completion", created: 0, model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      };
    }

    const reservation = await this.reserve(request);
    const { secret, pubB58 } = e2e.newResponseKeypair();
    const maxTokens = request.max_tokens ?? 512;
    const sealed = e2e.sealInputV2(
      reservation.node_x25519_pubkey,
      pubB58,
      new TextEncoder().encode(JSON.stringify({
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: maxTokens,
      })),
    );
    const body = {
      reservation_token: reservation.reservation_token,
      max_tokens: maxTokens, // cleartext, only used to quote the x402 price
      enc: {
        ciphertext: sealed.ciphertext,
        client_ephemeral_pubkey: sealed.ephemeralPub,
        client_response_pubkey: pubB58,
        algorithm: e2e.ALGO_V2,
      },
    };

    let data: {
      id?: string; job_id?: string; created?: number;
      sealed_result?: { ephemeral_public_key: string; ciphertext: string };
      result_envelope_signature?: string | null;
      result_envelope_version?: string | null;
      usage?: ChatCompletionResponse["usage"];
    };
    try {
      data = await this.request("POST", "/v1/chat/completions", body);
    } catch (err) {
      if (err instanceof SGLAPIError && err.statusCode === 402) {
        throw new SGLAPIError(402, "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.");
      }
      throw err;
    }

    if (!data.sealed_result) throw new SGLAPIError(500, "No sealed result returned");
    // Prove WHO produced this before opening it. AEAD only proves someone sealed
    // it to our key, and the orchestrator is given that key in cleartext.
    e2e.requireVerifiedReply(reservation, data);
    const plain = e2e.openOutputV2(secret, pubB58, data.sealed_result.ephemeral_public_key, data.sealed_result.ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as { content?: string; usage?: ChatCompletionResponse["usage"] };

    return {
      id: data.id ?? "",
      object: "chat.completion",
      created: data.created ?? 0,
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content: parsed.content ?? "" }, finish_reason: "stop" }],
      usage: data.usage ?? parsed.usage,
      attestation: {
        nodeId: reservation.node_id,
        teeType: reservation.tee_type ?? null,
        verified: !!reservation.attestation_verified,
      },
    };
  }

  /**
   * Create embeddings via the grid's OpenAI-compatible `/v1/embeddings` endpoint.
   *
   * `input` remains compatible with a string or string array. EmbeddingGemma 2 also
   * accepts ordered text/image/audio/video content items created by the exported
   * embedding helpers. `dimensions` truncates Matryoshka models and `input_type`
   * selects the retrieval prefix. Billed on input tokens only — there is no generation.
   * Requires an `apiKey` (credits); the TS SDK does not sign x402 payments. Unlike
   * chat, the input is not client-sealed — the orchestrator seals it to the node in-TEE.
   * The returned `data` is ordered to match `input`.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body: Record<string, unknown> = { model: request.model, input: request.input };
    if (request.dimensions != null) body.dimensions = request.dimensions;
    if (request.input_type != null) body.input_type = request.input_type;
    if (request.encoding_format != null) body.encoding_format = request.encoding_format;
    if (request.tier != null) body.tier = request.tier;
    if (request.model === EMBEDDINGGEMMA2_MODEL) {
      validateEmbeddingGemma2Request(body as unknown as EmbeddingRequest);
    }
    try {
      return (await this.request("POST", "/v1/embeddings", body)) as EmbeddingResponse;
    } catch (err) {
      if (err instanceof SGLAPIError && err.statusCode === 402) {
        throw new SGLAPIError(402, "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.", err.body);
      }
      throw err;
    }
  }

  /**
   * Call Laya/System One typed decisions via `/v1/systemone`.
   *
   * This is not a chat-completions model. Use it for compact typed outputs such
   * as choices, scores, and no-output-language summaries. Requires `apiKey`
   * (credits); the TS SDK does not sign x402 payments.
   */
  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    const body: Record<string, unknown> = {
      model: request.model ?? "convaiinnovations/laya",
      state: request.state,
      questions: request.questions,
    };
    if (request.node != null) body.node = request.node;
    if (request.cluster != null) body.cluster = request.cluster;
    if (request.max_price != null) body.max_price = request.max_price;
    try {
      return (await this.request("POST", "/v1/systemone", body)) as SystemOneResponse;
    } catch (err) {
      if (err instanceof SGLAPIError && err.statusCode === 402) {
        throw new SGLAPIError(402, "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.");
      }
      throw err;
    }
  }

  /**
   * Streaming end-to-end encrypted chat completion. Yields decoded text as it
   * arrives; each chunk is decrypted and its ordering + termination verified (a
   * truncated stream throws). Requires `apiKey` (credits). If the server isn't
   * streaming (toggle off), the whole reply is yielded as a single chunk.
   */
  async *chatCompletionStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<string, void, unknown> {
    const reservation = await this.reserve(request);
    const { secret, pubB58 } = e2e.newResponseKeypair();
    const nonce = e2e.randomNonceB58();
    const maxTokens = request.max_tokens ?? 512;
    const sealed = e2e.sealInputV2(
      reservation.node_x25519_pubkey,
      pubB58,
      new TextEncoder().encode(JSON.stringify({
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: maxTokens,
        stream: true,
        nonce,
      })),
    );
    const body = {
      reservation_token: reservation.reservation_token,
      stream: true,
      max_tokens: maxTokens,
      enc: {
        ciphertext: sealed.ciphertext,
        client_ephemeral_pubkey: sealed.ephemeralPub,
        client_response_pubkey: pubB58,
        algorithm: e2e.ALGO_V2,
      },
    };

    const controller = new AbortController();
    const overall = setTimeout(() => controller.abort(), this.timeout);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(overall);
      throw new SGLConnectionError(
        `Could not connect to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      clearTimeout(overall);
      if (resp.status === 402) {
        throw new SGLAPIError(402, "Payment required — pass an apiKey (credits). The TS SDK does not sign x402 payments; use the wallet/browser flow for pay-per-call.");
      }
      let message = resp.statusText;
      try {
        const j = (await resp.json()) as { error?: unknown };
        if (typeof j.error === "string") message = j.error;
        else if (j.error && typeof j.error === "object" && "message" in j.error) message = String((j.error as { message: unknown }).message);
      } catch { /* ignore */ }
      throw new SGLAPIError(resp.status, message);
    }

    const ctype = resp.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream") || !resp.body) {
      clearTimeout(overall);
      const data = (await resp.json()) as {
        id?: string; job_id?: string;
        sealed_result?: { ephemeral_public_key: string; ciphertext: string };
        result_envelope_signature?: string | null;
        result_envelope_version?: string | null;
      };
      if (!data.sealed_result) throw new SGLAPIError(500, "No sealed result returned");
      // Same check on the non-streaming fallback: an orchestrator that can force
      // this path must not get an unverified reply through it.
      e2e.requireVerifiedReply(reservation, data);
      const plain = e2e.openOutputV2(secret, pubB58, data.sealed_result.ephemeral_public_key, data.sealed_result.ciphertext);
      const content = (JSON.parse(new TextDecoder().decode(plain)) as { content?: string }).content ?? "";
      if (content) yield content;
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const INACTIVITY_MS = 60_000;
    const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new SGLConnectionError("stream timed out (no tokens)")), INACTIVITY_MS);
      });
      try {
        return (await Promise.race([reader.read(), timeout])) as ReadableStreamReadResult<Uint8Array>;
      } finally {
        if (t) clearTimeout(t);
      }
    };

    let buf = "";
    let expectedSeq = 0;
    let outKey: Uint8Array | null = null;
    let streamEph: string | null = null;
    let sawFinal = false;
    try {
      for (;;) {
        if (sawFinal) break;
        const { value, done } = await readChunk();
        if (done) break;
        // Normalize CRLF so \n\n event framing works regardless of line endings.
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.includes("event: error")) throw new SGLAPIError(502, "stream aborted by server");
          const dataStr = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!dataStr || dataStr === "[DONE]") continue;
          // Fail closed: a malformed or non-chunk data event is a protocol error.
          let chunk: { seq?: number; final?: boolean; eph?: string; ct?: string; job?: string; sig?: string; sigv?: string };
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            throw new SGLAPIError(502, "malformed stream chunk");
          }
          if (typeof chunk.seq !== "number" || !chunk.ct) {
            throw new SGLAPIError(502, "invalid stream chunk (missing seq/ciphertext)");
          }
          if (chunk.seq !== expectedSeq) throw new SGLAPIError(502, `stream out of order (expected ${expectedSeq}, got ${chunk.seq})`);
          if (chunk.seq === 0) {
            if (!chunk.eph) throw new SGLAPIError(502, "stream chunk 0 missing ephemeral key");
            streamEph = chunk.eph;
            outKey = e2e.streamOutKey(secret, streamEph);
          }
          const isFinal = chunk.final === true;
          // Verify EVERY chunk before opening it. The node signs each with kind
          // `stream:{seq}:{final}` over the chunk ciphertext, and the
          // orchestrator relays that signature rather than consuming it.
          // Without this a compromised relay could splice or invent chunks —
          // editing the answer as it arrives.
          if (chunk.sigv && chunk.sigv !== "v1") {
            throw new e2e.UnverifiedReplyError(`unknown chunk envelope version "${chunk.sigv}"`);
          }
          const chunkKind = `stream:${chunk.seq}:${isFinal ? 1 : 0}`;
          if (!e2e.verifyResultEnvelope(reservation.node_ed25519_pubkey, chunk.job, chunkKind, chunk.ct, chunk.sig)) {
            throw new e2e.UnverifiedReplyError(`stream chunk ${chunk.seq} is not signed by the reserved node`);
          }
          const text = new TextDecoder().decode(
            e2e.openStreamChunk(outKey as Uint8Array, pubB58, streamEph as string, nonce, chunk.seq, isFinal, chunk.ct),
          );
          if (text) yield text;
          expectedSeq++;
          if (isFinal) { sawFinal = true; break; }
        }
      }
    } finally {
      clearTimeout(overall);
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    if (!sawFinal) throw new SGLAPIError(502, "stream ended before final chunk (truncated)");
  }

}
