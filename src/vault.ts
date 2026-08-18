/**
 * Agent Vault — zero-knowledge encrypted agent backup/restore.
 *
 * Pure-JS envelope (noble scrypt + AES-256-GCM), byte-compatible with the
 * agentvault CLI, the pod runner, and the Python SDK:
 * `[4-byte BE header length][JSON header][GCM body, tag appended]`, with the
 * snapshot identity bound into the GCM AAD. Runs in Node AND browsers.
 *
 * Scope: this module encrypts/decrypts BYTES and drives the API. Packing a
 * directory into a tarball is filesystem work — use the `agentvault` CLI or
 * the Python SDK for that, or bring your own archive bytes.
 *
 * Auth: a Singularity compute API key (X-API-Key). Passphrases and plaintext
 * never leave this process.
 */

import { gcm } from "@noble/ciphers/aes";
import { scrypt } from "@noble/hashes/scrypt";
import { SGLAPIError } from "./errors.js";

export const VAULT_URL = "https://compute.x402layer.cc";

const SCRYPT_PARAMS = { N: 1 << 17, r: 8, p: 1 } as const;
const SCRYPT_MIN_N = 1 << 15;

// ─── Envelope (wire-identical to agentvault-core) ───────────────────────────

export interface VaultAad {
  userId: string;
  agentId: string;
  backupId: string;
  formatVersion: 1;
}

const te = new TextEncoder();
const td = new TextDecoder();

function aadBytes(aad: VaultAad): Uint8Array {
  // Canonical key order — byte-identical across CLI, pod runner, Python SDK.
  const { agentId, backupId, formatVersion, userId } = aad;
  return te.encode(JSON.stringify({ agentId, backupId, formatVersion, userId }));
}

function b64(x: Uint8Array): string {
  let s = "";
  for (const b of x) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rand(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Envelope-encrypt arbitrary bytes under a passphrase (scrypt + AES-256-GCM). */
export function encryptEnvelope(plaintext: Uint8Array, passphrase: string, aad: VaultAad): Uint8Array {
  const salt = rand(16);
  const kek = scrypt(te.encode(passphrase), salt, { ...SCRYPT_PARAMS, dkLen: 32 });
  const dek = rand(32);
  const aadBuf = aadBytes(aad);
  const dekNonce = rand(12);
  const wrapped = gcm(kek, dekNonce, aadBuf).encrypt(dek); // ciphertext||tag
  const blobNonce = rand(12);
  const body = gcm(dek, blobNonce, aadBuf).encrypt(plaintext);
  const header = te.encode(JSON.stringify({
    formatVersion: 1,
    kdf: "scrypt",
    kdfParams: { ...SCRYPT_PARAMS, salt: b64(salt) },
    cipher: "aes-256-gcm",
    wrappedDek: { nonce: b64(dekNonce), ciphertext: b64(wrapped) },
    blobNonce: b64(blobNonce),
    aad,
  }));
  const out = new Uint8Array(4 + header.length + body.length);
  new DataView(out.buffer).setUint32(0, header.length, false);
  out.set(header, 4);
  out.set(body, 4 + header.length);
  return out;
}

/** Reverse of encryptEnvelope. Throws on wrong passphrase or AAD mismatch. */
export function decryptEnvelope(blob: Uint8Array, passphrase: string, aad: VaultAad): Uint8Array {
  if (blob.length < 4) throw new SGLAPIError(0, "malformed blob: too short");
  const headerLen = new DataView(blob.buffer, blob.byteOffset).getUint32(0, false);
  if (4 + headerLen > blob.length) throw new SGLAPIError(0, "malformed blob: header length out of bounds");
  let header: {
    kdf?: string;
    kdfParams?: { N?: number; r?: number; p?: number; salt?: string };
    wrappedDek?: { nonce?: string; ciphertext?: string };
    blobNonce?: string;
  };
  try {
    header = JSON.parse(td.decode(blob.subarray(4, 4 + headerLen)));
  } catch {
    throw new SGLAPIError(0, "malformed blob: invalid header JSON");
  }
  if (header.kdf !== "scrypt") {
    throw new SGLAPIError(0, `this backup uses ${String(header.kdf)} key derivation — restore it with the agentvault CLI`);
  }
  const p = header.kdfParams ?? {};
  if (
    !Number.isInteger(p.N) || (p.N as number) < SCRYPT_MIN_N || (p.N as number) > SCRYPT_PARAMS.N ||
    ((p.N as number) & ((p.N as number) - 1)) !== 0 ||
    !Number.isInteger(p.r) || (p.r as number) < 8 || (p.r as number) > 16 ||
    !Number.isInteger(p.p) || (p.p as number) < 1 || (p.p as number) > 4 ||
    typeof p.salt !== "string" || !header.wrappedDek?.nonce || !header.wrappedDek?.ciphertext || !header.blobNonce
  ) {
    throw new SGLAPIError(0, "malformed blob: unsupported header parameters");
  }
  const salt = unb64(p.salt);
  if (salt.length < 16) throw new SGLAPIError(0, "malformed blob: salt too short");
  const kek = scrypt(te.encode(passphrase), salt, { N: p.N as number, r: p.r as number, p: p.p as number, dkLen: 32 });
  const aadBuf = aadBytes(aad);
  try {
    const dek = gcm(kek, unb64(header.wrappedDek.nonce), aadBuf).decrypt(unb64(header.wrappedDek.ciphertext));
    return gcm(dek, unb64(header.blobNonce), aadBuf).decrypt(blob.subarray(4 + headerLen));
  } catch {
    throw new SGLAPIError(0, "incorrect passphrase or corrupted backup");
  }
}

export function parseAadFromKey(r2Key: string): VaultAad {
  const parts = r2Key.split("/");
  if (parts.length !== 5 || parts[0] !== "backups" || parts[4] !== "blob.enc"
      || !parts[1] || !parts[2] || !parts[3]) {
    throw new SGLAPIError(0, `malformed r2 key: ${r2Key}`);
  }
  return { userId: parts[1], agentId: parts[2], backupId: parts[3], formatVersion: 1 };
}

// ─── API client ─────────────────────────────────────────────────────────────

export interface VaultAgent {
  id: string;
  name: string;
  framework: string;
  source: "local" | "pod";
  pod_order_id: string | null;
}

export interface VaultSnapshot {
  id: string;
  agent_id: string;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
}

export interface VaultUsage {
  plan: "free" | "pro";
  planRenewsAt: string | null;
  bytesUsed: number;
  bytesReserved: number;
  maxBytes: number;
  proPriceUsd: number;
}

export interface VaultClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class VaultClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VaultClientOptions) {
    const base = (options.baseUrl ?? VAULT_URL).replace(/\/+$/, "");
    const u = new URL(base);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !local) {
      throw new SGLAPIError(0, "baseUrl must be https (the API key travels in a header)");
    }
    if (u.username || u.password || u.search || u.hash) {
      throw new SGLAPIError(0, "baseUrl must be a bare origin");
    }
    this.base = base;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private static id(v: string): string {
    if (!/^[0-9a-fA-F-]{36}$/.test(v)) throw new SGLAPIError(0, `not a snapshot id: ${v}`);
    return v.toLowerCase();
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new SGLAPIError(res.status, String(data.error ?? `request failed: ${res.status}`));
    return data as T;
  }

  async agents(): Promise<VaultAgent[]> {
    return (await this.call<{ agents: VaultAgent[] }>("GET", "/backups/agents")).agents;
  }

  async createAgent(name: string, framework: string): Promise<VaultAgent> {
    return (await this.call<{ agent: VaultAgent }>("POST", "/backups/agents", { name, framework })).agent;
  }

  async snapshots(agentId?: string): Promise<VaultSnapshot[]> {
    const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    return (await this.call<{ backups: VaultSnapshot[] }>("GET", `/backups${q}`)).backups;
  }

  async usage(): Promise<VaultUsage> {
    return this.call<VaultUsage>("GET", "/backups/usage");
  }

  /** Activate Vault Pro ($3/mo from credits). */
  async subscribePro(): Promise<{ ok: boolean; already?: boolean }> {
    return this.call("POST", "/backups/subscribe");
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.call("DELETE", `/backups/${VaultClient.id(id)}`);
  }

  /**
   * Encrypt + upload arbitrary payload bytes (e.g. a tarball you packed) as a
   * snapshot of `agentId`. Returns the snapshot id.
   */
  async backupBytes(agentId: string, payload: Uint8Array, passphrase: string): Promise<string> {
    const res = await this.call<{ backupId: string; r2Key: string; uploadUrl: string }>(
      "POST", "/backups", { agentId, sizeBytes: payload.length },
    );
    const blob = encryptEnvelope(payload, passphrase, parseAadFromKey(res.r2Key));
    const up = await this.fetchImpl(res.uploadUrl, {
      method: "PUT",
      body: blob as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
    if (!up.ok) throw new SGLAPIError(up.status, `upload failed: ${up.status}`);
    const digest = await crypto.subtle.digest("SHA-256", blob as unknown as ArrayBuffer);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.call("POST", `/backups/${res.backupId}/complete`, { sha256 });
    return res.backupId;
  }

  /** Download + decrypt a snapshot's payload bytes. */
  async restoreBytes(snapshotId: string, passphrase: string): Promise<Uint8Array> {
    const info = await this.call<{ downloadUrl: string; r2Key: string }>("GET", `/backups/${VaultClient.id(snapshotId)}/restore`);
    const dl = await this.fetchImpl(info.downloadUrl);
    if (!dl.ok) throw new SGLAPIError(dl.status, `download failed: ${dl.status}`);
    const blob = new Uint8Array(await dl.arrayBuffer());
    return decryptEnvelope(blob, passphrase, parseAadFromKey(info.r2Key));
  }
}
