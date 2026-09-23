/**
 * End-to-end encryption for the SGL grid (client side).
 *
 * Must match sgl-node/src/encryption.rs, the orchestrator, and the browser/Python
 * clients byte-for-byte: X25519 ECDH -> HKDF-SHA256 -> XChaCha20-Poly1305 (24-byte
 * nonce), AAD-bound. Sealed blob layout: nonce(24) || ciphertext, base58.
 *
 * The orchestrator only ever relays ciphertext — it never sees the prompt or reply.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import bs58 from "bs58";

export const ALGO_V2 = "x25519-xchacha20poly1305-hkdf-v2";
export const ALGO_V2_STREAM = "x25519-xchacha20poly1305-hkdf-v2-stream";

const HKDF_SALT = new TextEncoder().encode("sgl-e2e-v2-salt");
const HKDF_INFO_INPUT = new TextEncoder().encode("sgl-e2e-v2-input");
const HKDF_INFO_OUTPUT = new TextEncoder().encode("sgl-e2e-v2-output");

function v2Key(shared: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, HKDF_SALT, info, 32);
}
function aadInput(nodeB58: string, ephB58: string, respB58: string): Uint8Array {
  return new TextEncoder().encode(`sgl-aad/v2/input|node=${nodeB58}|eph=${ephB58}|resp=${respB58}`);
}
function aadOutput(respB58: string, ephB58: string): Uint8Array {
  return new TextEncoder().encode(`sgl-aad/v2/output|resp=${respB58}|eph=${ephB58}`);
}
function aadStream(respB58: string, ephB58: string, nonceB58: string, seq: number, isFinal: boolean): Uint8Array {
  return new TextEncoder().encode(
    `sgl-aad/v2/stream|resp=${respB58}|eph=${ephB58}|nonce=${nonceB58}|seq=${seq}|final=${isFinal ? 1 : 0}`,
  );
}

function b58enc(u: Uint8Array): string {
  return bs58.encode(u);
}
function b58dec(s: string): Uint8Array {
  return bs58.decode(s);
}
function decodeCiphertext(ciphertext: string, encoding?: string): Uint8Array {
  if (encoding === undefined) return b58dec(ciphertext);
  if (encoding === "base64") {
    const bin = atob(ciphertext);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`unsupported sealed encoding: ${encoding}`);
}
function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export interface ResponseKeypair {
  secret: Uint8Array;
  pubB58: string;
}

/** The caller's response keypair — the node seals its reply to this. */
export function newResponseKeypair(): ResponseKeypair {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, pubB58: b58enc(x25519.getPublicKey(secret)) };
}

/** A per-request nonce bound into every stream chunk's AAD. */
export function randomNonceB58(): string {
  return b58enc(randomBytes(16));
}

/** Seal the prompt to the node's X25519 key. */
export function sealInputV2(
  nodePubB58: string,
  respPubB58: string,
  plaintext: Uint8Array,
): { ciphertext: string; ephemeralPub: string } {
  const nodePub = b58dec(nodePubB58);
  const ephSecret = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const ephB58 = b58enc(ephPub);
  const shared = x25519.getSharedSecret(ephSecret, nodePub);
  const key = v2Key(shared, HKDF_INFO_INPUT);
  const aad = aadInput(nodePubB58, ephB58, respPubB58);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return { ciphertext: b58enc(out), ephemeralPub: ephB58 };
}

/** Open the node's (non-stream) reply sealed to our response key. */
export function openOutputV2(
  respSecret: Uint8Array,
  respPubB58: string,
  nodeEphB58: string,
  ciphertextB58: string,
  encoding?: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(respSecret, b58dec(nodeEphB58));
  const key = v2Key(shared, HKDF_INFO_OUTPUT);
  const aad = aadOutput(respPubB58, nodeEphB58);
  const blob = decodeCiphertext(ciphertextB58, encoding);
  return xchacha20poly1305(key, blob.slice(0, 24), aad).decrypt(blob.slice(24));
}

/** Derive the stream output key once from the node's stream ephemeral (chunk 0). */
export function streamOutKey(respSecret: Uint8Array, nodeStreamEphB58: string): Uint8Array {
  const shared = x25519.getSharedSecret(respSecret, b58dec(nodeStreamEphB58));
  return v2Key(shared, HKDF_INFO_OUTPUT);
}

/** Open one stream chunk with the precomputed key + nonce/seq/final-bound AAD. */
export function openStreamChunk(
  outKey: Uint8Array,
  respPubB58: string,
  streamEphB58: string,
  reqNonceB58: string,
  seq: number,
  isFinal: boolean,
  ctB58: string,
): Uint8Array {
  const aad = aadStream(respPubB58, streamEphB58, reqNonceB58, seq, isFinal);
  const blob = b58dec(ctB58);
  return xchacha20poly1305(outKey, blob.slice(0, 24), aad).decrypt(blob.slice(24));
}

// ─── Reply attribution ──────────────────────────────────────────────────────

/** A sealed reply could not be proven to come from the reserved node. */
export class UnverifiedReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnverifiedReplyError";
  }
}

/**
 * Verify the node's v1 envelope signature over a sealed reply.
 *
 * The signature covers the PUBLIC ciphertext rather than the plaintext, so it
 * verifies exactly — no re-serialising and no key-ordering problem. Message:
 * `sgl-result-v1\n{job_id}\n{kind}\n{sha256hex(ciphertext)}`, hashing the
 * ciphertext as the literal UTF-8 string, not as decoded bytes.
 */
export function verifyResultEnvelope(
  nodeEd25519B58: string | null | undefined,
  jobId: string | null | undefined,
  kind: string,
  ciphertext: string,
  signatureB58: string | null | undefined,
): boolean {
  if (!nodeEd25519B58 || !signatureB58 || !jobId) return false;
  try {
    const digest = Array.from(sha256(new TextEncoder().encode(ciphertext)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const msg = new TextEncoder().encode(`sgl-result-v1\n${jobId}\n${kind}\n${digest}`);
    const sig = bs58.decode(signatureB58);
    const key = bs58.decode(nodeEd25519B58);
    if (sig.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(sig, msg, key);
  } catch {
    return false;
  }
}

/**
 * Refuse a sealed reply we cannot attribute to the reserved node.
 *
 * Mandatory, not best-effort: `client_response_pubkey` reaches the orchestrator
 * in cleartext, so a compromised orchestrator cannot READ a prompt but CAN
 * fabricate a reply, seal it to that key, and have it decrypt cleanly. AEAD
 * proves only that someone sealed it to us; this proves who.
 *
 * A MISSING signature fails exactly like an invalid one. Every sealed reply
 * carries one, so absence means something is wrong — and "warn and continue" is
 * precisely what let this gap go unnoticed for months.
 */
export function requireVerifiedReply(
  reservation: { node_ed25519_pubkey?: string | null },
  data: {
    id?: string;
    job_id?: string;
    sealed_result?: { ciphertext: string };
    result_envelope_signature?: string | null;
    result_envelope_version?: string | null;
  },
  kind = "sealed",
): void {
  if (data.result_envelope_version && data.result_envelope_version !== "v1") {
    throw new UnverifiedReplyError(
      `unknown result envelope version "${data.result_envelope_version}"`,
    );
  }
  // job_id is explicit on current grids; older ones only embed it in `id`.
  const jobId =
    data.job_id ??
    (data.id?.startsWith("chatcmpl-") ? data.id.slice("chatcmpl-".length) : undefined);
  const ok = verifyResultEnvelope(
    reservation.node_ed25519_pubkey,
    jobId,
    kind,
    data.sealed_result?.ciphertext ?? "",
    data.result_envelope_signature,
  );
  if (!ok) {
    // NEVER fall back to `result_signature`: that legacy field signs the
    // PLAINTEXT and is always absent for sealed replies, so reaching for it
    // would make this check silently meaningless.
    throw new UnverifiedReplyError(
      "sealed reply is not signed by the reserved node — refusing it.",
    );
  }
}
