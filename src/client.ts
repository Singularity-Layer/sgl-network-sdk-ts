import { SGLAPIError, SGLAuthError, SGLConnectionError, SGLNotFoundError } from "./errors.js";
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

  // -- OpenAI-compatible ---------------------------------------------------

  async chatCompletions(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    if (request.stream) {
      throw new Error(
        "Streaming (stream: true) is not yet supported by this SDK; responses are returned as a single JSON object.",
      );
    }
    return this.request<ChatCompletionResponse>(
      "POST",
      "/v1/chat/completions",
      request,
    );
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
