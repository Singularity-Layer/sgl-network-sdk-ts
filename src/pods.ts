/**
 * Agent Pods — hosted agents you can create, drive and destroy over an API key.
 *
 * A pod is a running agent on its own machine: it holds a conversation, keeps a workspace,
 * can be given scheduled tasks and connectors, and exposes an OpenAI-compatible endpoint so
 * anything that already speaks to OpenAI can speak to it instead.
 *
 * Two things about this client are worth knowing before you use it.
 *
 * CREATE IS IDEMPOTENT, AND THE KEY IS NOT OPTIONAL. Creating a pod provisions a machine and
 * charges for it, so a retry after a timeout must not do it twice. `createPod` generates an
 * idempotency key when you do not pass one, and replaying the same key returns the original
 * response byte for byte rather than making a second pod. Pass your own key when your caller
 * has a natural id for the attempt (an order number, a job id) — that is what makes a retry
 * after a crash safe rather than merely likely to be safe.
 *
 * DELETE IS NOT INSTANT. Providers refuse to delete a machine that is still installing, so a
 * destroy can come back as `destroying` rather than `destroyed`. `deletePod` reports which,
 * and `waitForDestroyed` will hold until the machine is genuinely gone. Treating a 202 as
 * "done" is how you end up paying for something you thought you deleted.
 */

import { SGLAPIError, SGLAuthError, SGLNotFoundError } from "./errors.js";

export const DEFAULT_PODS_BASE_URL = "https://compute.x402layer.cc";

export interface PodsClientOptions {
  /** Your API key. Mint one in the dashboard under Settings → API Keys. */
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Creating a pod is the slow one; it provisions a machine. */
  timeout?: number;
  fetch?: typeof globalThis.fetch;
}

/** What a pod may do. Omit it entirely and the pod gets everything. */
export interface PodCapabilities {
  endpoint?: boolean;
  wallet?: boolean;
  platform_tools?: boolean;
  connectors?: boolean;
  channels?: boolean;
  scheduler?: boolean;
  backups?: boolean;
}

export interface CreatePodOptions {
  tier?: string;
  /** Display name, and the machine's label. */
  name?: string;
  /**
   * YOUR id for this pod, echoed back on reads and usable as a list filter. The point is that
   * you can find a pod again from your own database without storing ours.
   */
  external_ref?: string;
  model?: string;
  system_prompt?: string;
  region?: string;
  /** Minimum 24. Prepaid, and refunded pro-rata if you destroy early. */
  term_hours?: number;
  capabilities?: PodCapabilities;
  /** Bring your own LLM key instead of using ours. */
  ai?: { mode: "managed" | "byok"; api_key?: string; base_url?: string; api?: string };
  /**
   * Supply this when your caller has a natural id for the attempt. Left out, one is generated,
   * which still protects an automatic retry inside this call but not a retry from your side
   * after a process death.
   */
  idempotencyKey?: string;
}

export type PodStatus = "provisioning" | "online" | "offline" | "grace" | "destroying" | "destroyed";

export interface Pod {
  id: string;
  name: string | null;
  slug: string | null;
  external_ref: string | null;
  status: PodStatus;
  tier: string | null;
  model: string | null;
  ai: { mode: string } | null;
  capabilities: Required<PodCapabilities>;
  endpoint: { base_url: string } | null;
  billing: { expires_at: string | null; auto_renew: boolean | null; is_trial: boolean } | null;
  created_at: string | null;
}

export interface PodUpdates {
  mode: "auto" | "manual";
  /** The version we are telling the pod to be on. In auto this is simply the latest. */
  serving_version: string;
  latest_version: string;
  update_available: boolean;
  /** The date the pod updates itself regardless. Null in auto. */
  hold_expires_at: string | null;
  /** True once the 30-day ceiling has passed: still `manual`, no longer holding anything. */
  hold_expired: boolean;
}

export interface PodEvent {
  id: string;
  /** The paging cursor. Store the highest one you have handled. */
  seq: number;
  type: string;
  pod_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface PodWebhook {
  id: string;
  url: string;
  event_types: string[] | null;
  enabled: boolean;
  disabled_by_us_at: string | null;
  failure_count: number;
  last_error: string | null;
  last_delivery_at: string | null;
  created_at: string;
  /** Returned ONCE, at creation. Store it: it is how you verify our deliveries. */
  secret?: string;
}

function randomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `sdk-${c.randomUUID()}`;
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class PodsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: PodsClientOptions) {
    if (!options?.apiKey) throw new SGLAuthError(401, "An apiKey is required. Mint one under Settings → API Keys.");
    this.baseUrl = (options.baseUrl ?? DEFAULT_PODS_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 120_000;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let resp: Response;
    try {
      resp = await this.doFetch(`${this.baseUrl}/pods/v1${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

    if (!resp.ok) {
      const err = parsed?.error ?? {};
      const message = err.message ?? `HTTP ${resp.status}`;
      // The request id is echoed on every response and is the fastest way for us to find
      // your request in our logs, so it travels with the error rather than being dropped.
      const requestId = resp.headers.get("x-request-id") ?? undefined;
      const detail = requestId ? `${message} (request id ${requestId})` : message;
      // The API's own machine-readable code and the request id travel in `body`, so a caller
      // can branch on the first and quote the second at us without parsing the message.
      const body = { code: err.code, details: err.details, request_id: requestId };
      if (resp.status === 401 || resp.status === 403) throw new SGLAuthError(resp.status, detail, body);
      if (resp.status === 404) throw new SGLNotFoundError(detail, body);
      throw new SGLAPIError(resp.status, detail, body);
    }
    return parsed as T;
  }

  // ── Pods ───────────────────────────────────────────────────────────────────────────────

  /**
   * Create a pod. Provisions a machine and charges for it.
   *
   * Returns as soon as the order exists, with `status: "provisioning"` — the machine takes a
   * few minutes to boot. Use {@link waitForOnline} if you need to wait for it.
   */
  async createPod(options: CreatePodOptions = {}): Promise<Pod> {
    const { idempotencyKey, ...body } = options;
    const res = await this.request<{ pod: Pod }>("POST", "/pods", body, {
      "Idempotency-Key": idempotencyKey ?? randomKey(),
    });
    return res.pod;
  }

  async getPod(podId: string): Promise<Pod> {
    return (await this.request<{ pod: Pod }>("GET", `/pods/${podId}`)).pod;
  }

  /** List pods, newest first. `external_ref` filters by YOUR id. */
  async listPods(opts: { limit?: number; cursor?: string; external_ref?: string } = {}): Promise<{ pods: Pod[]; next_cursor: string | null }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.external_ref) q.set("external_ref", opts.external_ref);
    const qs = q.toString();
    return this.request("GET", `/pods${qs ? `?${qs}` : ""}`);
  }

  async updatePod(podId: string, patch: { name?: string; model?: string; slug?: string; auto_renew?: boolean }): Promise<Pod> {
    return (await this.request<{ pod: Pod }>("PATCH", `/pods/${podId}`, patch)).pod;
  }

  /**
   * Destroy a pod.
   *
   * `destroyed` means the machine is confirmed gone. `destroying` means the provider would
   * not delete it yet (usually because it is still installing) and a sweep will retry — it
   * may bill for a few more minutes. Do not treat the second as the first.
   */
  async deletePod(podId: string): Promise<{ status: "destroyed" | "destroying"; message: string }> {
    const res = await this.request<{ pod: { status: "destroyed" | "destroying" }; message: string }>("DELETE", `/pods/${podId}`);
    return { status: res.pod.status, message: res.message };
  }

  /** Poll until the pod is online, or throw when it lands somewhere it cannot leave. */
  async waitForOnline(podId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Pod> {
    return this.waitFor(podId, (p) => p.status === "online", ["destroyed", "destroying"], opts);
  }

  /** Poll until the machine is genuinely gone, not merely accepted for teardown. */
  async waitForDestroyed(podId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Pod> {
    return this.waitFor(podId, (p) => p.status === "destroyed", [], opts);
  }

  private async waitFor(podId: string, done: (p: Pod) => boolean, fatal: PodStatus[],
    { timeoutMs = 15 * 60_000, intervalMs = 10_000 }: { timeoutMs?: number; intervalMs?: number }): Promise<Pod> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pod = await this.getPod(podId);
      if (done(pod)) return pod;
      if (fatal.includes(pod.status)) {
        throw new SGLAPIError(409, `Pod ${podId} is ${pod.status}; it will not come online.`, { code: "conflict" });
      }
      if (Date.now() >= deadline) {
        throw new SGLAPIError(504, `Timed out waiting for pod ${podId}; it is ${pod.status}.`, { code: "timeout", last_status: pod.status });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ── Talking to a pod ───────────────────────────────────────────────────────────────────

  /**
   * The pod's OpenAI-compatible base URL, for use with any OpenAI client.
   *
   * Point an OpenAI SDK at this with a key from {@link mintPodKey} and use the model id
   * `agent-pod`. Anything that already speaks OpenAI works unchanged.
   */
  endpointUrl(pod: Pod | string): string {
    if (typeof pod !== "string") return pod.endpoint?.base_url ?? `${this.baseUrl}/pods/${pod.id}/v1`;
    return `${this.baseUrl}/pods/${pod}/v1`;
  }

  /** Mint a key for the pod's own endpoint. The secret is returned ONCE. */
  async mintPodKey(podId: string, opts: { label?: string; daily_cap_usd?: number } = {}): Promise<{ id: string; secret: string; prefix: string }> {
    return (await this.request<{ key: any }>("POST", `/pods/${podId}/keys`, opts)).key;
  }

  async listPodKeys(podId: string): Promise<Array<{ id: string; prefix: string; last4: string }>> {
    return (await this.request<{ keys: any[] }>("GET", `/pods/${podId}/keys`)).keys;
  }

  async revokePodKey(podId: string, keyId: string): Promise<void> {
    await this.request("DELETE", `/pods/${podId}/keys/${keyId}`);
  }

  // ── Operating a pod ────────────────────────────────────────────────────────────────────

  async usage(podId: string): Promise<Record<string, unknown>> {
    return (await this.request<{ usage: any }>("GET", `/pods/${podId}/usage`)).usage;
  }

  /**
   * Queue a lifecycle action. Applied on the pod's next check-in, usually within a minute,
   * which is why this returns 202 rather than pretending it already happened.
   *
   * `diagnose` and `logs` write their output back; read it from {@link getActions}.
   */
  async queueAction(podId: string, action: "restart" | "stop" | "redeploy" | "update" | "diagnose" | "logs"): Promise<{ queued: string; result_available: boolean }> {
    return (await this.request<{ action: any }>("POST", `/pods/${podId}/actions`, { action })).action;
  }

  async getActions(podId: string): Promise<{ pending: string[]; last_result: any; last_seen_at: string | null }> {
    return (await this.request<{ actions: any }>("GET", `/pods/${podId}/actions`)).actions;
  }

  async listTasks(podId: string): Promise<{ tasks: any[]; known: boolean }> {
    return this.request("GET", `/pods/${podId}/tasks`);
  }

  async addTask(podId: string, task: { name: string; kind: "cron" | "every" | "at"; schedule: string; message?: string; session?: "main" | "isolated" }): Promise<{ accepted: boolean }> {
    return this.request("POST", `/pods/${podId}/tasks`, task);
  }

  async removeTask(podId: string, jobId: string): Promise<{ accepted: boolean }> {
    return this.request("DELETE", `/pods/${podId}/tasks/${jobId}`);
  }

  async getWallet(podId: string): Promise<Record<string, unknown>> {
    return (await this.request<{ wallet: any }>("GET", `/pods/${podId}/wallet`)).wallet;
  }

  /**
   * Change a pod wallet's spend controls.
   *
   * Needs `pods:wallet:write` — a general key that manages pods must not be able to raise the
   * cap on the money it can spend. The field is `per_tx_cap_usd`, not `spend_cap_usd`; the
   * API will list the editable names if you get it wrong.
   */
  async updateWallet(podId: string, patch: { send_enabled?: boolean; per_tx_cap_usd?: number; daily_cap_usd?: number; autonomy_mode?: string }): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/pods/${podId}/wallet`, patch);
  }

  /**
   * Attach an MCP connector, giving the agent a new tool.
   *
   * Needs `pods:control:write` for the same reason: handing an agent new tools is not
   * something a general-purpose key should do.
   */
  async addConnector(podId: string, connector: { name: string; url: string; transport?: string; headers?: Record<string, string> }): Promise<any[]> {
    return (await this.request<{ connectors: any[] }>("POST", `/pods/${podId}/connectors`, connector)).connectors;
  }

  async removeConnector(podId: string, connectorId: string): Promise<any[]> {
    return (await this.request<{ connectors: any[] }>("DELETE", `/pods/${podId}/connectors/${connectorId}`)).connectors;
  }

  /** Turn automatic backups on or off. Setting a passphrase needs `pods:wallet:write`. */
  async updateBackups(podId: string, patch: { enabled: boolean; passphrase?: string }): Promise<{ enabled: boolean; passphrase_set: boolean }> {
    return (await this.request<{ backups: any }>("PATCH", `/pods/${podId}/backups`, patch)).backups;
  }

  /** Mint a Telegram join code, or poll whether a group has claimed one. */
  async telegramJoinCode(podId: string): Promise<{ code: string | null; expires_at: string | null }> {
    return (await this.request<{ join: any }>("POST", `/pods/${podId}/channels/telegram/join-code`)).join;
  }

  async telegramJoinStatus(podId: string): Promise<{ active: boolean; claimed: any; next_step: string }> {
    return (await this.request<{ join: any }>("GET", `/pods/${podId}/channels/telegram/join-code`)).join;
  }

  /**
   * Who decides WHEN this pod takes our updates.
   *
   * By default we do: the pod polls every six hours and applies whatever we answer,
   * restarting its gateway for about forty seconds. Fine for a pod you run for yourself,
   * wrong for pods you run for customers who did not choose that moment.
   *
   * `manual` makes us keep answering with the version the pod already has, so it never
   * updates itself, and you apply it with `queueAction(id, "update")` when it suits you.
   * The hold expires after 30 days, because security fixes ride these bundles; the response
   * always names the date so it is never a surprise.
   */
  async getUpdatePolicy(podId: string): Promise<PodUpdates> {
    return (await this.request<{ updates: PodUpdates }>("GET", `/pods/${podId}/updates`)).updates;
  }

  async setUpdatePolicy(podId: string, mode: "auto" | "manual"): Promise<PodUpdates> {
    return (await this.request<{ updates: PodUpdates }>("PATCH", `/pods/${podId}/updates`, { mode })).updates;
  }

  /**
   * A short-lived ticket for the pod's streaming chat socket.
   *
   * `scope` tells you what the socket will accept. Without `pods:control:write` it is `chat`,
   * which is conversation only. Most integrations want the OpenAI endpoint instead; this is
   * for live sessions.
   */
  async chatTicket(podId: string): Promise<{ ticket: string; expires_in_seconds: number; scope: string; websocket_url: string; shared_session: string | null }> {
    return (await this.request<{ chat: any }>("POST", `/pods/${podId}/chat-ticket`)).chat;
  }

  /**
   * Attach the Telegram group that claimed the join code.
   *
   * Takes no chat id: it attaches only the group that claimed the code, because a claim
   * proves somebody typed it inside that room. Existing groups are preserved.
   */
  async connectTelegramGroup(podId: string, opts: { require_mention?: boolean; prompt?: string } = {}): Promise<{ chat_id: string; title: string | null }> {
    return (await this.request<{ channel: any }>("POST", `/pods/${podId}/channels/telegram/connect`, opts)).channel;
  }

  /**
   * Approve someone to DM the agent.
   *
   * A stranger who finds the bot can DM it, and unlike a group nobody else sees that
   * conversation, so the agent refuses unknown people and shows them a code. The code must
   * come from the agent, so this approves a request somebody already made.
   */
  async approvePairing(podId: string, code: string, channel = "telegram"): Promise<{ approved_code: string }> {
    return (await this.request<{ pairing: any }>("POST", `/pods/${podId}/channels/${channel}/pair`, { code })).pairing;
  }

  /**
   * Move funds out of the pod's wallet. Needs `pods:wallet:write`.
   *
   * The spend cap is enforced server-side before the transfer and the pod holds no keys, so
   * this cannot exceed the policy set by {@link updateWallet}.
   */
  async walletSend(podId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/pods/${podId}/wallet/send`, body);
  }

  /** Pay an x402 endpoint from the pod's wallet. Needs `pods:wallet:write`. */
  async walletPayX402(podId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/pods/${podId}/wallet/x402/pay`, body);
  }

  async listConnectors(podId: string): Promise<any[]> {
    return (await this.request<{ connectors: any[] }>("GET", `/pods/${podId}/connectors`)).connectors;
  }

  async getBackups(podId: string): Promise<{ enabled: boolean; passphrase_set: boolean; last_auto_at: string | null }> {
    return (await this.request<{ backups: any }>("GET", `/pods/${podId}/backups`)).backups;
  }

  // ── Events and webhooks ────────────────────────────────────────────────────────────────

  /**
   * Page the event log.
   *
   * Paged by `seq`, an integer that only goes up, NOT by timestamp — two events can share a
   * millisecond, and a timestamp cursor would either skip one or repeat it forever. Store the
   * `next_after` you get back and pass it as `after` next time.
   *
   * This is also the answer to a missed webhook: delivery is a cursor over these same rows,
   * so anything a broken endpoint dropped is still here.
   */
  async listEvents(opts: { after?: number; limit?: number; type?: string; pod_id?: string } = {}): Promise<{ events: PodEvent[]; next_after: number; has_more: boolean }> {
    const q = new URLSearchParams();
    if (opts.after !== undefined) q.set("after", String(opts.after));
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.type) q.set("type", opts.type);
    if (opts.pod_id) q.set("pod_id", opts.pod_id);
    const qs = q.toString();
    return this.request("GET", `/events${qs ? `?${qs}` : ""}`);
  }

  /**
   * Register a webhook. HTTPS only.
   *
   * The signing `secret` comes back ONCE. Store it — it is how you verify a delivery really
   * came from us. Omit `event_types` to receive everything; an empty array is refused,
   * because a subscription to nothing is a webhook that silently never fires.
   */
  async createWebhook(url: string, eventTypes?: string[]): Promise<PodWebhook> {
    return (await this.request<{ webhook: PodWebhook }>("POST", "/webhooks", { url, ...(eventTypes ? { event_types: eventTypes } : {}) })).webhook;
  }

  async listWebhooks(): Promise<PodWebhook[]> {
    return (await this.request<{ webhooks: PodWebhook[] }>("GET", "/webhooks")).webhooks;
  }

  async updateWebhook(id: string, patch: { url?: string; event_types?: string[]; enabled?: boolean; skip_to_now?: boolean }): Promise<PodWebhook> {
    return (await this.request<{ webhook: PodWebhook }>("PATCH", `/webhooks/${id}`, patch)).webhook;
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request("DELETE", `/webhooks/${id}`);
  }
}

/**
 * Verify a webhook delivery came from us and is recent.
 *
 * Pass the RAW request body, not a re-serialised object: re-encoding JSON changes bytes
 * (key order, spacing) and the signature is over the bytes we sent.
 *
 * The timestamp is inside the signed string, so a captured delivery cannot be replayed later
 * under a fresh one. `toleranceSec` is what stops an old capture being accepted at all.
 */
export async function verifyPodWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<boolean> {
  const tolerance = opts.toleranceSec ?? 300;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(signatureHeader || "").trim());
  if (!m) return false;
  const ts = Number(m[1]);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > tolerance) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${rawBody}`));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time compare: a length-dependent early return leaks how much of a forged
  // signature was right, which is enough to reconstruct one byte at a time.
  const given = m[2];
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
