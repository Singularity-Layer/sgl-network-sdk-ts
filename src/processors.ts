/**
 * Singularity Processors.
 *
 * A processor is a function we host: deploy one and you get a paid HTTP endpoint, an OpenAPI
 * document and an MCP server. Buyers pay the PUBLISHER directly in USDC over x402 — the platform
 * never holds it and takes no cut. The publisher pays for compute instead.
 *
 * ─── WHY THIS IS A SEPARATE CLIENT ──────────────────────────────────────────
 * Processors live on their own worker at `https://processors.x402compute.cc`, not on the grid.
 * Until 0.9.0 these methods hung off `GridClient` and pointed at `/grid/processors`, which has
 * never existed — every call 404'd. Fixing that by teaching `GridClient` a second base URL would
 * have meant a per-call host override inside the shared request path that chat, embeddings and
 * jobs all use, which is a real risk to working features for no benefit. A separate client with
 * its own base URL touches none of that.
 *
 * ─── AUTH ───────────────────────────────────────────────────────────────────
 * A compute API key (`x402c_…`) with the `processors:write` scope, sent as `X-API-Key`.
 *
 * `processors:write` is FULL CONTROL of processors owned by that key's wallet, delete and secrets
 * included — the same shape as a Cloudflare API token. If you want a credential that cannot change
 * anything, mint `processors:read`. Three things to know before relying on it: compute keys do not
 * expire, there is no audit log of what a key did, and delete is permanent — the code is wiped and
 * the slug is burned forever, so a leaked key can destroy a name you can never reclaim.
 *
 * Two routes never accept a key: `suspend` (moderation) and `auth-session`. Both need a wallet
 * signature, and neither is a publisher action.
 *
 * ─── RUNNING A PROCESSOR IS NOT DONE WITH THE API KEY ────────────────────────
 * `run()` takes the INVOKE TOKEN that `deploy()` returns, because the run route is the only one
 * with both a money path and an anonymous buyer lane and deliberately does not read an API key as
 * an ownership claim. Anonymous buyers pay with x402 instead; see `runWithPayment`.
 */

import { SGLAPIError, SGLAuthError, SGLConnectionError, SGLNotFoundError } from "./errors.js";

export const PROCESSORS_BASE_URL = "https://processors.x402compute.cc";

const DEFAULT_TIMEOUT = 60_000;

/**
 * A base URL override must not become a way to post the management key somewhere else.
 *
 * The key is long-lived, does not expire, and grants full control of the caller's processors, so
 * an `http://` or attacker-supplied origin is a credential disclosure rather than a
 * misconfiguration. Plain HTTP is allowed only for loopback, which is how you point this at a
 * local worker during development.
 */
function isLoopback(hostname: string): boolean {
  // URL normalises an IPv6 literal WITH its brackets, so "::1" never appears here.
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function parseBaseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ProcessorsClient baseUrl is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new Error(
      `ProcessorsClient baseUrl must be https (or http on localhost); got ${u.protocol}//${u.hostname}. ` +
        "The API key is a long-lived full-control credential and must not be sent in the clear.",
    );
  }
  return u;
}

/**
 * May the management key be sent to this host?
 *
 * https alone is not the question. `https://attacker.example` is a perfectly valid TLS origin,
 * and if `baseUrl` is ever wired to an environment variable — which is exactly how people
 * configure a staging host — then influencing that variable is enough to harvest a long-lived
 * full-control credential. So the key travels only to the official host or to loopback unless the
 * caller says otherwise, in one explicit flag they cannot set by accident.
 */
function keyAllowedOnHost(u: URL): boolean {
  return u.origin === new URL(PROCESSORS_BASE_URL).origin || isLoopback(u.hostname);
}

export interface ProcessorsClientOptions {
  /** Compute API key (`x402c_…`) holding `processors:read` or `processors:write`. */
  apiKey?: string;
  /** Override the base URL. Defaults to https://processors.x402compute.cc */
  baseUrl?: string;
  /**
   * Send the API key to a `baseUrl` that is neither the official host nor loopback.
   *
   * Off by default on purpose: see `keyAllowedOnHost`. Set it only when you genuinely run your
   * own processors host and mean to hand it your credential.
   */
  allowKeyOnCustomHost?: boolean;
  timeoutMs?: number;
}

/** Limits are declared, not discovered: the runtime hold before each run derives from `timeout_ms`. */
export interface ProcessorLimits {
  timeout_ms: number;
  cpu_ms: number;
  /** Must be >= 1. */
  subrequests: number;
}

export interface ProcessorSecretDeclaration {
  name: string;
  /** Hosts this secret may be injected at. Every one must also appear in `egress.allow`. */
  hosts?: string[];
  /** Header injection. `format` must contain the literal `{value}` placeholder. */
  inject?: { header: string; format: string };
  /** `env` makes the value readable by your own code — a deliberate downgrade, opt in per secret. */
  mode?: "env";
}

/** One `price_usd` is the price on EVERY chain: all three assets are 6-decimal stablecoins. */
export interface ProcessorPayout {
  /** base58 wallet. Defaults to the deploying wallet. */
  solana?: string;
  /** 0x… — USDC on Base. */
  base?: string;
  /** 0x… — USDG on Robinhood Chain. */
  robinhood?: string;
}

export interface ProcessorManifest {
  manifest_version: 1;
  /** Lowercase, permanent, and NEVER reusable — `pause` exists so nobody burns one to stop traffic. */
  slug: string;
  name: string;
  description: string;
  lane?: "managed" | "self_hosted" | "pod";
  price_usd?: string;
  methods?: Array<"GET" | "POST">;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  limits: ProcessorLimits;
  egress?: { allow: string[] };
  secrets?: ProcessorSecretDeclaration[];
  payout?: ProcessorPayout;
  pricing?: Record<string, unknown>;
  inference?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeployProcessorInput {
  manifest: ProcessorManifest;
  /** A single ES module. Use `bundle` instead if you need imports or npm packages. */
  code?: string;
  /** esbuild output, bundled on YOUR machine. We never run `npm install` for you. */
  bundle?: string;
  files?: Record<string, string>;
}

export interface ProcessorDeployResult {
  id: string;
  slug: string;
  /** Shown EXACTLY ONCE. Store it — there is no way to read it back, only to rotate it. */
  invoke_token: string;
  listing_state: string;
  note?: string;
}

export interface ProcessorSummary {
  id: string;
  slug: string;
  lane: string;
  price_micro: number;
  status: string;
  listed?: boolean;
  listing_state?: string;
  run_count?: number;
  last_run_at?: string | null;
  created_at: string;
  config_rev?: number;
  code_hash?: string | null;
  manifest?: ProcessorManifest | null;
  paused_at?: string | null;
}

export interface ProcessorListResponse {
  processors: ProcessorSummary[];
  /** Present on the owner-scoped list; the wallet the credential resolved to. */
  owner?: string;
}

export interface ProcessorRun {
  id: string;
  status: string;
  error: string | null;
  run_ms: number | null;
  cpu_ms: number | null;
  attempt_count?: number;
  created_at: string;
  finished_at?: string | null;
  output?: unknown;
}

export interface ProcessorRunsResponse {
  runs: ProcessorRun[];
  /** Publisher-caused failures only. Platform faults are excluded, so it measures YOUR code. */
  failure_rate_30d?: number;
  runs_30d?: number;
}

export interface ProcessorEarnings {
  sales?: unknown;
  runtime?: unknown;
  [key: string]: unknown;
}

export interface ProcessorWebhookRegistration {
  url: string;
  /** Returned EXACTLY ONCE on registration. There is no way to read it back. */
  secret?: string;
  active?: boolean;
  [key: string]: unknown;
}

export class ProcessorsClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(options: ProcessorsClientOptions = {}) {
    const parsed = parseBaseUrl(options.baseUrl ?? PROCESSORS_BASE_URL);
    this.baseUrl = (options.baseUrl ?? PROCESSORS_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (options.apiKey) {
      if (!keyAllowedOnHost(parsed) && !options.allowKeyOnCustomHost) {
        throw new Error(
          `ProcessorsClient refuses to send an API key to ${parsed.origin}. It is neither ` +
            `${new URL(PROCESSORS_BASE_URL).origin} nor loopback. If you really do run your own ` +
            "processors host, pass allowKeyOnCustomHost: true.",
        );
      }
      this.headers["X-API-Key"] = options.apiKey;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    /**
     * Send the management key? Default yes. Routes that carry their OWN credential — the public
     * catalogue, and the two run paths, which authenticate with an invoke token or an x402
     * payment — pass false, so a long-lived management key is not scattered through request logs
     * and traces on calls that have no use for it.
     */
    sendApiKey = true,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      const base = { ...this.headers };
      if (!sendApiKey) delete base["X-API-Key"];
      response = await fetch(url, {
        method,
        headers: { ...base, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new SGLConnectionError(
        `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // `{}` rather than undefined: several methods below promise an object, and a 204
    // would otherwise break that contract at runtime while typechecking fine.
    if (response.status === 204) return {} as T;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      // The worker answers `{ error, detail }`; `detail` is the human sentence when present.
      const detail =
        (typeof body?.detail === "string" && body.detail) ||
        (typeof body?.error === "string" && body.error) ||
        "";
      if (response.status === 401 || response.status === 403) {
        throw new SGLAuthError(response.status, detail || "unauthorized", body);
      }
      // 404 is "not yours" as well as "no such slug", deliberately: confirming which private slugs
      // exist to a non-owner is exactly what the rest of the surface refuses to do.
      if (response.status === 404) {
        throw new SGLNotFoundError(detail || "not found", body);
      }
      throw new SGLAPIError(response.status, detail || `HTTP ${response.status}`, body);
    }

    return parsed as T;
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  /**
   * The public catalogue.
   *
   * Sends NO credential, even when the client holds one. `GET /processors` is owner-scoped when a
   * key is presented and public otherwise, so passing the key here would silently return your own
   * processors instead of the catalogue — the opposite of what the name promises. Use `list()`
   * when you want yours.
   */
  async catalogue(): Promise<ProcessorListResponse> {
    return this.request<ProcessorListResponse>("GET", "/processors", undefined, undefined, false);
  }

  /** Processors owned by this key's wallet. Needs `processors:read`. */
  async list(): Promise<ProcessorListResponse> {
    return this.request<ProcessorListResponse>("GET", "/processors");
  }

  /** Owner projection when the key owns it, public projection otherwise. */
  async get(slug: string): Promise<ProcessorSummary> {
    return this.request<ProcessorSummary>("GET", `/processors/${encodeURIComponent(slug)}`);
  }

  // ── Lifecycle (needs processors:write) ───────────────────────────────────

  /**
   * Deploy. The wallet behind the key becomes `owner_wallet`, which is also the x402 `payTo` and
   * the runtime-billing account — so the key must be minted on a SOLANA wallet or this returns
   * `400 solana_wallet_required`.
   *
   * The `invoke_token` in the response is shown once and never again.
   */
  async deploy(input: DeployProcessorInput): Promise<ProcessorDeployResult> {
    return this.request<ProcessorDeployResult>("POST", "/processors", input);
  }

  /** Push new code, a new manifest, or both. Omitting `manifest` keeps the stored one. */
  async update(
    slug: string,
    input: { manifest?: ProcessorManifest; code?: string; bundle?: string; files?: Record<string, string> },
  ): Promise<{ slug: string; config_rev: number; config_changed: boolean }> {
    return this.request("PATCH", `/processors/${encodeURIComponent(slug)}`, input);
  }

  /**
   * Delete. **Irreversible, and the slug is burned forever** — it can never be reused, by you or
   * anyone. In-flight runs finish first; the code is wiped when they drain.
   */
  async delete(slug: string): Promise<{ slug: string; status: string; note?: string }> {
    return this.request("DELETE", `/processors/${encodeURIComponent(slug)}`);
  }

  /** Stop or restart traffic WITHOUT losing the slug. This is the switch, not `delete`. */
  async setPaused(slug: string, paused: boolean): Promise<unknown> {
    return this.request("PUT", `/processors/${encodeURIComponent(slug)}/pause`, { paused });
  }

  /**
   * List or unlist publicly. Instant, no review step.
   *
   * Unlisting is NOT stopping: an unlisted processor keeps answering anyone holding the URL or an
   * invoke token, earning nothing while still drawing compute from your balance. Use `setPaused`.
   */
  async setListing(slug: string, listed: boolean): Promise<unknown> {
    return this.request("PUT", `/processors/${encodeURIComponent(slug)}/listing`, { listed });
  }

  /** Set secret VALUES. Each name must already be declared in `manifest.secrets`. */
  async setSecrets(slug: string, values: Record<string, string>): Promise<unknown> {
    return this.request("PUT", `/processors/${encodeURIComponent(slug)}/secrets`, { values });
  }

  /** Mint a new invoke token. The old one stops working immediately. */
  async rotateToken(slug: string): Promise<{ invoke_token: string }> {
    return this.request("POST", `/processors/${encodeURIComponent(slug)}/rotate-token`);
  }

  // ── Observability ────────────────────────────────────────────────────────

  async runs(slug: string): Promise<ProcessorRunsResponse> {
    return this.request<ProcessorRunsResponse>("GET", `/processors/${encodeURIComponent(slug)}/runs`);
  }

  async run_(slug: string, runId: string): Promise<ProcessorRun> {
    return this.request<ProcessorRun>(
      "GET",
      `/processors/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  /** Sales (paid straight to your wallet, with the on-chain tx per row) and runtime spend. */
  async earnings(slug: string): Promise<ProcessorEarnings> {
    return this.request<ProcessorEarnings>("GET", `/processors/${encodeURIComponent(slug)}/earnings`);
  }

  /** The processor's own key/value state. Read-only from out here, by design. */
  async kv(slug: string): Promise<unknown> {
    return this.request("GET", `/processors/${encodeURIComponent(slug)}/kv`);
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  async getWebhook(slug: string): Promise<ProcessorWebhookRegistration> {
    return this.request("GET", `/processors/${encodeURIComponent(slug)}/webhook`);
  }

  /**
   * Register or replace. We immediately POST a signed verification to the URL: it must answer 2xx
   * or the webhook stays registered-but-inactive and delivers nothing. The signing secret comes
   * back EXACTLY ONCE.
   */
  async setWebhook(slug: string, url: string): Promise<ProcessorWebhookRegistration> {
    return this.request("PUT", `/processors/${encodeURIComponent(slug)}/webhook`, { url });
  }

  async deleteWebhook(slug: string): Promise<unknown> {
    return this.request("DELETE", `/processors/${encodeURIComponent(slug)}/webhook`);
  }

  async testWebhook(slug: string): Promise<unknown> {
    return this.request("POST", `/processors/${encodeURIComponent(slug)}/webhook/test`);
  }

  // ── Invoking ─────────────────────────────────────────────────────────────

  /**
   * Run YOUR OWN processor with the invoke token from `deploy()`.
   *
   * Not the API key: the run route deliberately does not read a key as an ownership claim, because
   * it is the only route with both a money path and an anonymous buyer lane. You pay for the
   * compute; nobody pays at call time.
   */
  async run(
    slug: string,
    input: Record<string, unknown>,
    invokeToken: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/processors/${encodeURIComponent(slug)}/run`,
      { input },
      { Authorization: `Bearer ${invokeToken}` },
      false,
    );
  }

  /**
   * Run someone else's processor as a buyer, with an x402 payment header.
   *
   * Call once WITHOUT `paymentHeader` to get the 402 and its `accepts` array — one entry per chain
   * that publisher takes. Match on `network`, pay that entry, and retry with the header.
   *
   * Re-sending the SAME header returns the run that payment already bought and does NOT charge
   * again. That is the recovery path for every failure mode, because **there are no refunds**: the
   * money went straight to the publisher and the platform never held it.
   */
  async runWithPayment(
    slug: string,
    input: Record<string, unknown>,
    paymentHeader?: string,
    acceptNetworks?: Array<"solana" | "base" | "robinhood">,
  ): Promise<unknown> {
    const extra: Record<string, string> = {};
    if (paymentHeader) extra["X-Payment"] = paymentHeader;
    // Robinhood is withheld from the 402 unless asked for: the reference x402 client validates the
    // WHOLE accepts array against a fixed chain list and throws on the first name it does not know,
    // so advertising it unprompted would stop a conformant buyer paying on Solana or Base either.
    if (acceptNetworks?.length) extra["X-Accept-Networks"] = acceptNetworks.join(",");
    return this.request("POST", `/processors/${encodeURIComponent(slug)}/run`, { input }, extra, false);
  }
}
