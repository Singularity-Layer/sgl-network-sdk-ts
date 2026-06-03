import { SGLAPIError, SGLAuthError, SGLConnectionError, SGLNotFoundError } from "./errors.js";
import * as e2e from "./e2e.js";
import type {
  AttestationProof,
  CapacityResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  DeployProcessorOptions,
  GridClientOptions,
  JobResponse,
  JobResult,
  ModelInfo,
  PricingInfo,
  ProcessorDeployResult,
  ProcessorInfo,
  ProcessorInvokeResult,
  ProcessorListResponse,
  ProcessorLogEntry,
  ProcessorLogsResponse,
  ReserveResponse,
  WalletAuth,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://grid.x402compute.cc";

const DEFAULT_TIMEOUT = 60_000;

export class GridClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(options: GridClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.headers = { Accept: "application/json", "Content-Type": "application/json" };
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
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SGLConnectionError(`Request to ${url} timed out`);
      }
      throw new SGLConnectionError(
        `Could not connect to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: Record<string, unknown> | undefined;
      let message = response.statusText;
      try {
        errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error;
        if (typeof err === "string") message = err;
        else if (err && typeof err === "object" && "message" in err)
          message = String((err as { message: unknown }).message);
      } catch {
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

  /** Reserve a node + learn its X25519 key so we can seal the prompt to it. */
  private async reserve(model: string): Promise<ReserveResponse> {
    const res = await this.request<ReserveResponse>("POST", "/v1/reserve", { model });
    if (!res.node_x25519_pubkey) {
      throw new SGLAPIError(503, "Reserved node does not support E2E encryption");
    }
    return res;
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

    const reservation = await this.reserve(request.model);
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
      id?: string; created?: number; sealed_result?: { ephemeral_public_key: string; ciphertext: string };
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
   * Streaming end-to-end encrypted chat completion. Yields decoded text as it
   * arrives; each chunk is decrypted and its ordering + termination verified (a
   * truncated stream throws). Requires `apiKey` (credits). If the server isn't
   * streaming (toggle off), the whole reply is yielded as a single chunk.
   */
  async *chatCompletionStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<string, void, unknown> {
    const reservation = await this.reserve(request.model);
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
      const data = (await resp.json()) as { sealed_result?: { ephemeral_public_key: string; ciphertext: string } };
      if (!data.sealed_result) throw new SGLAPIError(500, "No sealed result returned");
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
          let chunk: { seq?: number; final?: boolean; eph?: string; ct?: string };
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

  // -- Processor helpers ----------------------------------------------------

  private async requestWithWalletAuth<T>(
    method: string,
    path: string,
    wallet: WalletAuth,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const reqHeaders: Record<string, string> = {
      ...this.headers,
      "X-Auth-Address": wallet.address,
      "X-Auth-Chain": wallet.chain ?? "solana",
      "X-Auth-Signature": wallet.signature,
      "X-Auth-Timestamp": wallet.timestamp,
      "X-Auth-Nonce": wallet.nonce,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SGLConnectionError(`Request to ${url} timed out`);
      }
      throw new SGLConnectionError(
        `Could not connect to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: Record<string, unknown> | undefined;
      let message = response.statusText;
      try {
        errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error;
        if (typeof err === "string") message = err;
        else if (err && typeof err === "object" && "message" in err)
          message = String((err as { message: unknown }).message);
      } catch {
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
  }

  private async requestWithPayment<T>(
    method: string,
    path: string,
    body?: unknown,
    paymentHeader?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const reqHeaders: Record<string, string> = { ...this.headers };
    if (paymentHeader) {
      reqHeaders["X-Payment"] = paymentHeader;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new SGLConnectionError(`Request to ${url} timed out`);
      }
      throw new SGLConnectionError(
        `Could not connect to ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 402) {
      const requirements = (await response.json()) as Record<string, unknown>;
      throw new SGLAPIError(402, "Payment required", requirements);
    }

    if (!response.ok) {
      let errorBody: Record<string, unknown> | undefined;
      let message = response.statusText;
      try {
        errorBody = (await response.json()) as Record<string, unknown>;
        const err = errorBody?.error;
        if (typeof err === "string") message = err;
      } catch {
        /* body not JSON */
      }
      throw new SGLAPIError(response.status, message, errorBody);
    }

    return (await response.json()) as T;
  }

  // -- Processors -----------------------------------------------------------

  async deployProcessor(
    wallet: WalletAuth,
    options: DeployProcessorOptions,
  ): Promise<ProcessorDeployResult> {
    return this.requestWithWalletAuth<ProcessorDeployResult>(
      "POST",
      "/grid/processors",
      wallet,
      options,
    );
  }

  async invokeProcessor(
    processorName: string,
    input: Record<string, unknown>,
    options?: { paymentHeader?: string; paymentToken?: "USDC" | "SGL" },
  ): Promise<ProcessorInvokeResult> {
    const body: Record<string, unknown> = { input };
    if (options?.paymentToken) body.payment_token = options.paymentToken;
    return this.requestWithPayment<ProcessorInvokeResult>(
      "POST",
      `/grid/processors/${encodeURIComponent(processorName)}/invoke`,
      body,
      options?.paymentHeader,
    );
  }

  async listProcessors(options?: {
    owner?: string;
    page?: number;
    limit?: number;
  }): Promise<ProcessorListResponse> {
    const params = new URLSearchParams();
    if (options?.owner) params.set("owner", options.owner);
    if (options?.page != null) params.set("page", String(options.page));
    if (options?.limit != null) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<ProcessorListResponse>(
      "GET",
      `/grid/processors${qs ? `?${qs}` : ""}`,
    );
  }

  async getProcessor(processorId: string): Promise<ProcessorInfo> {
    return this.request<ProcessorInfo>("GET", `/grid/processors/${processorId}`);
  }

  async deleteProcessor(
    processorId: string,
    wallet: WalletAuth,
  ): Promise<{ deleted: boolean; id: string }> {
    return this.requestWithWalletAuth<{ deleted: boolean; id: string }>(
      "DELETE",
      `/grid/processors/${processorId}`,
      wallet,
    );
  }

  async getProcessorLogs(
    processorId: string,
    wallet: WalletAuth,
    options?: { page?: number; limit?: number },
  ): Promise<ProcessorLogsResponse> {
    const params = new URLSearchParams();
    if (options?.page != null) params.set("page", String(options.page));
    if (options?.limit != null) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.requestWithWalletAuth<ProcessorLogsResponse>(
      "GET",
      `/grid/processors/${processorId}/logs${qs ? `?${qs}` : ""}`,
      wallet,
    );
  }
}
