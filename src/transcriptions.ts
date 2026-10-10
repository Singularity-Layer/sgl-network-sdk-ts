import { SGLTranscriptionInputError, SGLTranscriptionResponseError } from "./errors.js";
import type {
  Attestation,
  TranscriptionRequestOptions,
  TranscriptionResponse,
  TranscriptionSegment,
  TranscriptionUsage,
} from "./types.js";

export const TRANSCRIPTION_PROTOCOL = "transcription-v1" as const;
export const TRANSCRIPTION_MODEL = "whisper-1" as const;
export const TRANSCRIPTION_MODEL_REVISION =
  "5359861c739e955e79d9a303bcbc70fb988958b1" as const;
export const TRANSCRIPTION_MODEL_SHA256 =
  "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" as const;
export const TRANSCRIPTION_AUDIO_FORMAT = "pcm_s16le" as const;
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const TRANSCRIPTION_CHANNELS = 1;
export const TRANSCRIPTION_BITS_PER_SAMPLE = 16;
export const TRANSCRIPTION_MAX_DURATION_SECONDS = 60;
export const TRANSCRIPTION_MAX_SAMPLES =
  TRANSCRIPTION_SAMPLE_RATE * TRANSCRIPTION_MAX_DURATION_SECONDS;
export const TRANSCRIPTION_MAX_PCM_BYTES =
  TRANSCRIPTION_MAX_SAMPLES * (TRANSCRIPTION_BITS_PER_SAMPLE / 8);
export const TRANSCRIPTION_MAX_TEXT_BYTES = 64 * 1024;
export const TRANSCRIPTION_MAX_SEGMENTS = 256;
export const TRANSCRIPTION_MAX_RESULT_ENVELOPE_BYTES = 1024 * 1024;
export const TRANSCRIPTION_RATE_USD_PER_SECOND = 0.0001;
export const TRANSCRIPTION_MINIMUM_CHARGE_USD = 0.0001;

export function transcriptionPriceUsd(sampleCount: number): number {
  // One micro-USDC per 160 samples; compute in integer samples to avoid
  // floating-point over-rounding of an exact micro-USDC boundary.
  return Math.max(100, Math.ceil(sampleCount / 160)) / 1_000_000;
}

const LANGUAGE = /^(?:auto|[a-z]{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export interface ValidatedTranscriptionOptions {
  model: typeof TRANSCRIPTION_MODEL;
  language: string;
  requestId: string;
  useCredits: boolean;
  node?: string;
  maxPrice?: number;
}

export interface TranscriptionReservation {
  reservation_token: string;
  request_id: string;
  model: typeof TRANSCRIPTION_MODEL;
  model_revision: string;
  model_sha256: string;
  transcription_protocol: typeof TRANSCRIPTION_PROTOCOL;
  sample_count: number;
  language: string;
  node_id: string;
  node_x25519_pubkey: string;
  node_ed25519_pubkey: string;
  node_x25519_pubkey_sig: string;
  key_version: number;
  tee_type?: string | null;
  attestation_verified?: boolean;
  expires_in_ms: number;
  quote: {
    sample_count: number;
    audio_seconds: number;
    rate_usd_per_second: number;
    minimum_charge_usd: number;
    price_usd: number;
    currency: "USDC";
  };
}

export interface SealedTranscriptionWireResponse {
  object?: unknown;
  job_id?: unknown;
  sealed_result?: {
    algorithm?: unknown;
    encoding?: unknown;
    ephemeral_public_key?: unknown;
    ciphertext?: unknown;
  };
  result_envelope_signature?: unknown;
  result_envelope_version?: unknown;
  usage?: unknown;
  billing_pending?: unknown;
}


function makeUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateTranscriptionPcm(pcm: Uint8Array): number {
  if (!(pcm instanceof Uint8Array)) {
    throw new SGLTranscriptionInputError("invalid_audio_type", "Audio must be raw PCM bytes");
  }
  if (pcm.byteLength === 0) {
    throw new SGLTranscriptionInputError("empty_audio", "Audio must contain at least one PCM sample");
  }
  if (pcm.byteLength % 2 !== 0) {
    throw new SGLTranscriptionInputError(
      "invalid_pcm_length",
      "Signed 16-bit PCM must contain a whole number of two-byte samples",
    );
  }
  const isRiffWave = pcm.byteLength >= 12 &&
    String.fromCharCode(...pcm.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...pcm.subarray(8, 12)) === "WAVE";
  const prefix4 = pcm.byteLength >= 4 ? String.fromCharCode(...pcm.subarray(0, 4)) : "";
  const isMp4 = pcm.byteLength >= 8 && String.fromCharCode(...pcm.subarray(4, 8)) === "ftyp";
  const isMp3 = pcm.byteLength >= 3 && String.fromCharCode(...pcm.subarray(0, 3)) === "ID3";
  if (isRiffWave || prefix4 === "fLaC" || prefix4 === "OggS" || isMp4 || isMp3) {
    throw new SGLTranscriptionInputError(
      "unsupported_audio_container",
      "Audio containers are not accepted; decode to raw mono 16 kHz signed 16-bit PCM first",
    );
  }
  if (pcm.byteLength > TRANSCRIPTION_MAX_PCM_BYTES) {
    throw new SGLTranscriptionInputError(
      "audio_too_long",
      `Audio must be at most ${TRANSCRIPTION_MAX_DURATION_SECONDS} seconds (${TRANSCRIPTION_MAX_PCM_BYTES} bytes)`,
    );
  }
  return pcm.byteLength / 2;
}

export function validateTranscriptionOptions(
  options: TranscriptionRequestOptions = {},
): ValidatedTranscriptionOptions {
  const model = options.model ?? TRANSCRIPTION_MODEL;
  if (model !== TRANSCRIPTION_MODEL) {
    throw new SGLTranscriptionInputError("invalid_model", `model must be ${TRANSCRIPTION_MODEL}`);
  }
  const language = options.language ?? "auto";
  if (typeof language !== "string" || !LANGUAGE.test(language) || (language !== "auto" && language.length !== 2)) {
    throw new SGLTranscriptionInputError(
      "invalid_language",
      'language must be "auto" or a lowercase two-letter code',
    );
  }
  const requestId = options.requestId ?? makeUuid();
  if (typeof requestId !== "string" || requestId.length !== 36 || !UUID.test(requestId)) {
    throw new SGLTranscriptionInputError("invalid_request_id", "requestId must be a canonical lowercase UUIDv4");
  }
  if (options.useCredits !== undefined && typeof options.useCredits !== "boolean") {
    throw new SGLTranscriptionInputError("invalid_option", "useCredits must be a boolean");
  }
  if (
    options.node !== undefined &&
    (typeof options.node !== "string" || !options.node || options.node.length > 128)
  ) {
    throw new SGLTranscriptionInputError("invalid_option", "node must be a nonempty bounded identifier");
  }
  if (
    options.maxPrice !== undefined &&
    (!Number.isFinite(options.maxPrice) || options.maxPrice <= 0)
  ) {
    throw new SGLTranscriptionInputError("invalid_option", "maxPrice must be a positive finite number");
  }
  return {
    model,
    language,
    requestId,
    useCredits: options.useCredits ?? true,
    node: options.node,
    maxPrice: options.maxPrice,
  };
}

export function encodeCanonicalBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function createTranscriptionPlaintext(
  pcm: Uint8Array,
  reservation: TranscriptionReservation,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    protocol: TRANSCRIPTION_PROTOCOL,
    request_id: reservation.request_id,
    model: reservation.model,
    model_revision: reservation.model_revision,
    model_sha256: reservation.model_sha256,
    language: reservation.language,
    audio: {
      format: TRANSCRIPTION_AUDIO_FORMAT,
      sample_rate: TRANSCRIPTION_SAMPLE_RATE,
      channels: TRANSCRIPTION_CHANNELS,
      bits_per_sample: TRANSCRIPTION_BITS_PER_SAMPLE,
      sample_count: reservation.sample_count,
      data: encodeCanonicalBase64(pcm),
    },
  }));
}

export function validateTranscriptionReservation(
  value: unknown,
  expected: { requestId: string; sampleCount: number; model: string; language: string },
): TranscriptionReservation {
  if (!record(value)) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription reservation is not an object");
  }
  const requiredStrings = [
    "reservation_token", "request_id", "model", "model_revision", "model_sha256", "transcription_protocol",
    "language", "node_id", "node_x25519_pubkey", "node_ed25519_pubkey",
    "node_x25519_pubkey_sig",
  ];
  if (requiredStrings.some((field) => typeof value[field] !== "string" || value[field] === "")) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription reservation is incomplete");
  }
  if ((value.reservation_token as string).length > 16_384 ||
      ["node_x25519_pubkey", "node_ed25519_pubkey"].some((field) =>
        (value[field] as string).length < 32 || (value[field] as string).length > 44) ||
      (value.node_x25519_pubkey_sig as string).length < 64 || (value.node_x25519_pubkey_sig as string).length > 88) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription reservation keys or token exceed their bounds");
  }
  if (
    value.request_id !== expected.requestId ||
    value.model !== expected.model ||
    value.language !== expected.language ||
    value.sample_count !== expected.sampleCount ||
    value.transcription_protocol !== TRANSCRIPTION_PROTOCOL
  ) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription reservation does not match the request");
  }
  if (
    !REVISION.test(value.model_revision as string) ||
    value.model_revision !== TRANSCRIPTION_MODEL_REVISION
  ) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription model revision is invalid");
  }
  if (!SHA256.test(value.model_sha256 as string) || value.model_sha256 !== TRANSCRIPTION_MODEL_SHA256) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription model hash is invalid");
  }
  if (!Number.isInteger(value.expires_in_ms) || (value.expires_in_ms as number) <= 0) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription reservation expiry is invalid");
  }
  if (!Number.isInteger(value.key_version) || (value.key_version as number) < 0) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription node key version is invalid");
  }
  if ((value.key_version as number) > 0xffffffff) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription node key version is invalid");
  }
  const quote = value.quote;
  const expectedAudioSeconds = expected.sampleCount / TRANSCRIPTION_SAMPLE_RATE;
  if (
    !record(quote) || quote.audio_seconds !== expectedAudioSeconds ||
    quote.sample_count !== expected.sampleCount || quote.currency !== "USDC" ||
    quote.rate_usd_per_second !== TRANSCRIPTION_RATE_USD_PER_SECOND ||
    quote.minimum_charge_usd !== TRANSCRIPTION_MINIMUM_CHARGE_USD ||
    typeof quote.price_usd !== "number" || !Number.isFinite(quote.price_usd) ||
    Math.abs(quote.price_usd - transcriptionPriceUsd(expected.sampleCount)) > 1e-9
  ) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription quote does not match the reserved audio");
  }
  if (
    (value.attestation_verified !== true && value.attestation_verified !== false) ||
    (value.tee_type !== null && typeof value.tee_type !== "string")
  ) {
    throw new SGLTranscriptionResponseError("invalid_reservation", "Transcription attestation metadata is invalid");
  }
  return value as unknown as TranscriptionReservation;
}

function validateUsage(value: unknown, sampleCount: number, quote: TranscriptionReservation["quote"]): TranscriptionUsage {
  if (!record(value)) throw new SGLTranscriptionResponseError("invalid_result", "Transcription usage is invalid");
  const audioSeconds = value.audio_seconds;
  const costUsd = value.cost_usd;
  const billableSeconds = sampleCount / TRANSCRIPTION_SAMPLE_RATE;
  if (audioSeconds !== billableSeconds || typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription billing metadata does not match the audio");
  }
  if (Math.abs(costUsd - transcriptionPriceUsd(sampleCount)) > 1e-9 || Math.abs(costUsd - quote.price_usd) > 1e-9) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription billing does not match the reserved quote");
  }
  return { audio_seconds: audioSeconds, cost_usd: costUsd };
}

export function validateSealedTranscriptionResult(
  value: unknown,
  outerJobId: string,
  reservation: TranscriptionReservation,
  usageValue: unknown,
  billingPendingValue: unknown,
): TranscriptionResponse {
  if (!record(value)) {
    throw new SGLTranscriptionResponseError("invalid_result", "Decrypted transcription result is not an object");
  }
  const expectedBindings =
    value.object === "transcription" &&
    value.protocol === TRANSCRIPTION_PROTOCOL &&
    value.request_id === reservation.request_id &&
    value.job_id === outerJobId &&
    value.model === reservation.model &&
    value.model_revision === reservation.model_revision &&
    value.model_sha256 === reservation.model_sha256 &&
    value.sample_count === reservation.sample_count &&
    value.language_hint === reservation.language;
  if (!expectedBindings) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription result does not match its reservation");
  }
  if (
    typeof value.text !== "string" ||
    utf8Bytes(value.text) > TRANSCRIPTION_MAX_TEXT_BYTES ||
    UNPAIRED_SURROGATE.test(value.text) ||
    CONTROL_CHARACTERS.test(value.text)
  ) {
    throw new SGLTranscriptionResponseError("invalid_result", "Transcription text is invalid");
  }
  if (value.language !== null && (typeof value.language !== "string" || value.language.length !== 2 || !/^[a-z]{2}$/.test(value.language))) {
    throw new SGLTranscriptionResponseError("invalid_result", "Detected language is invalid");
  }
  const duration = value.duration_seconds;
  const inputSeconds = reservation.sample_count / TRANSCRIPTION_SAMPLE_RATE;
  if (
    typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
    duration > Math.min(inputSeconds + 1, TRANSCRIPTION_MAX_DURATION_SECONDS + 1)
  ) {
    throw new SGLTranscriptionResponseError("binding_mismatch", "Transcription duration contradicts the audio");
  }
  if (!Array.isArray(value.segments) || value.segments.length > TRANSCRIPTION_MAX_SEGMENTS) {
    throw new SGLTranscriptionResponseError("invalid_result", "Transcription segments are invalid");
  }
  let lastStart = 0;
  let lastEnd = 0;
  let segmentTextBytes = 0;
  const segments: TranscriptionSegment[] = [];
  for (const segment of value.segments) {
    if (
      !record(segment) || typeof segment.start !== "number" || typeof segment.end !== "number" ||
      typeof segment.text !== "string" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end < segment.start || segment.start < lastStart ||
      segment.end < lastEnd || segment.start < lastEnd - 0.05 ||
      segment.end > inputSeconds + 1 || utf8Bytes(segment.text) > TRANSCRIPTION_MAX_TEXT_BYTES ||
      segment.end > duration + 0.05 || UNPAIRED_SURROGATE.test(segment.text) ||
      CONTROL_CHARACTERS.test(segment.text)
    ) {
      throw new SGLTranscriptionResponseError("invalid_result", "Transcription segments are invalid");
    }
    segmentTextBytes += utf8Bytes(segment.text);
    if (segmentTextBytes > TRANSCRIPTION_MAX_TEXT_BYTES) {
      throw new SGLTranscriptionResponseError("invalid_result", "Aggregate transcription segment text exceeds its byte limit");
    }
    lastStart = segment.start;
    lastEnd = segment.end;
    segments.push({ start: segment.start, end: segment.end, text: segment.text });
  }
  if (billingPendingValue !== undefined && typeof billingPendingValue !== "boolean") {
    throw new SGLTranscriptionResponseError("invalid_result", "Transcription billing state is invalid");
  }
  const attestation: Attestation = {
    nodeId: reservation.node_id,
    teeType: reservation.tee_type ?? null,
    verified: reservation.attestation_verified === true,
  };
  return {
    object: "transcription",
    job_id: outerJobId,
    request_id: reservation.request_id,
    model: reservation.model,
    model_revision: reservation.model_revision,
    model_sha256: reservation.model_sha256,
    transcription_protocol: TRANSCRIPTION_PROTOCOL,
    sample_count: reservation.sample_count,
    text: value.text,
    language_hint: reservation.language,
    language: value.language,
    duration_seconds: duration,
    segments,
    usage: validateUsage(usageValue, reservation.sample_count, reservation.quote),
    ...(billingPendingValue === true ? { billing_pending: true } : {}),
    attestation,
  };
}
