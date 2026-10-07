import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { SGLEmbeddingInputError } from "./errors.js";
import type {
  EmbeddingAudioMimeType,
  EmbeddingAudioPart,
  EmbeddingContentPart,
  EmbeddingImageMimeType,
  EmbeddingImagePart,
  EmbeddingMediaMimeType,
  EmbeddingTextPart,
  EmbeddingVideoMimeType,
  EmbeddingVideoPart,
  InlineEmbeddingMedia,
  MultimodalEmbeddingItem,
} from "./types.js";

export const EMBEDDINGGEMMA2_MODEL = "embeddinggemma-2";
export const EMBEDDINGGEMMA2_PROTOCOL = "embedding-multimodal-v1";

/** Public admission limits enforced by the grid for EmbeddingGemma 2. */
export const EMBEDDINGGEMMA2_LIMITS = {
  maxBodyBytes: 24 * 1024 * 1024,
  maxBatchItems: 16,
  maxPartsPerItem: 16,
  maxImagesPerItem: 8,
  maxImageBytes: 8 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxAudioBytes: 8 * 1024 * 1024,
  maxAudioSeconds: 30,
  maxVideoBytes: 16 * 1024 * 1024,
  maxVideoSeconds: 32,
  maxVideoFrames: 32,
  maxRequestMediaBytes: 20 * 1024 * 1024,
  maxProcessedTokensPerItem: 8192,
  dimensions: [768, 512, 256, 128] as const,
} as const;

export const EMBEDDINGGEMMA2_MIME_TYPES = {
  image: ["image/jpeg", "image/png", "image/webp"],
  audio: ["audio/wav", "audio/flac", "audio/mpeg"],
  video: ["video/mp4"],
} as const;

type BinaryEmbeddingData = Uint8Array | ArrayBuffer;

function toBytes(data: BinaryEmbeddingData): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) {
    throw new SGLEmbeddingInputError("invalid_media_data", "Embedding media must not be empty");
  }
  return bytes;
}

function mediaLimit(mimeType: EmbeddingMediaMimeType): number {
  if ((EMBEDDINGGEMMA2_MIME_TYPES.image as readonly string[]).includes(mimeType)) {
    return EMBEDDINGGEMMA2_LIMITS.maxImageBytes;
  }
  if ((EMBEDDINGGEMMA2_MIME_TYPES.audio as readonly string[]).includes(mimeType)) {
    return EMBEDDINGGEMMA2_LIMITS.maxAudioBytes;
  }
  if ((EMBEDDINGGEMMA2_MIME_TYPES.video as readonly string[]).includes(mimeType)) {
    return EMBEDDINGGEMMA2_LIMITS.maxVideoBytes;
  }
  throw new SGLEmbeddingInputError(
    "unsupported_media_type",
    `Unsupported EmbeddingGemma 2 media type: ${mimeType}`,
  );
}

function base64Encode(bytes: Uint8Array): string {
  // 0x6000 is divisible by three, so only the final chunk can contain padding.
  const chunks: string[] = [];
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    let binary = "";
    for (let i = offset; i < end; i += 1) binary += String.fromCharCode(bytes[i]);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

/**
 * Convert bytes into the grid's canonical inline media envelope. This works in
 * browsers and Node.js 18+, computes SHA-256 locally, and never reads a URL.
 */
export function createInlineEmbeddingMedia(
  data: BinaryEmbeddingData,
  mimeType: EmbeddingMediaMimeType,
): InlineEmbeddingMedia {
  const bytes = toBytes(data);
  const limit = mediaLimit(mimeType);
  if (bytes.byteLength > limit) {
    throw new SGLEmbeddingInputError(
      "media_too_large",
      `${mimeType} media is ${bytes.byteLength} bytes; the limit is ${limit}`,
    );
  }
  return {
    encoding: "base64",
    mime_type: mimeType,
    data: base64Encode(bytes),
    sha256: bytesToHex(sha256(bytes)),
  };
}

export function embeddingText(text: string): EmbeddingTextPart {
  if (!text.length) {
    throw new SGLEmbeddingInputError("empty_text", "Embedding text must not be empty");
  }
  return { type: "text", text };
}

export function embeddingImage(
  data: BinaryEmbeddingData,
  mimeType: EmbeddingImageMimeType,
): EmbeddingImagePart {
  return {
    type: "image",
    media: createInlineEmbeddingMedia(data, mimeType) as EmbeddingImagePart["media"],
  };
}

function requireDuration(durationSeconds: number, max: number, type: "audio" | "video"): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > max) {
    throw new SGLEmbeddingInputError(
      "invalid_duration",
      `${type} duration_seconds must be greater than 0 and at most ${max}`,
    );
  }
}

export function embeddingAudio(
  data: BinaryEmbeddingData,
  mimeType: EmbeddingAudioMimeType,
  durationSeconds: number,
): EmbeddingAudioPart {
  requireDuration(durationSeconds, EMBEDDINGGEMMA2_LIMITS.maxAudioSeconds, "audio");
  return {
    type: "audio",
    media: createInlineEmbeddingMedia(data, mimeType) as EmbeddingAudioPart["media"],
    duration_seconds: durationSeconds,
  };
}

export function embeddingVideo(
  data: BinaryEmbeddingData,
  mimeType: EmbeddingVideoMimeType,
  durationSeconds: number,
): EmbeddingVideoPart {
  requireDuration(durationSeconds, EMBEDDINGGEMMA2_LIMITS.maxVideoSeconds, "video");
  return {
    type: "video",
    media: createInlineEmbeddingMedia(data, mimeType) as EmbeddingVideoPart["media"],
    duration_seconds: durationSeconds,
  };
}

/** Build one ordered multimodal batch item and enforce the public part-count limit. */
export function embeddingItem(...content: EmbeddingContentPart[]): MultimodalEmbeddingItem {
  if (content.length === 0 || content.length > EMBEDDINGGEMMA2_LIMITS.maxPartsPerItem) {
    throw new SGLEmbeddingInputError(
      "too_many_parts",
      `Embedding items require 1-${EMBEDDINGGEMMA2_LIMITS.maxPartsPerItem} ordered content parts`,
    );
  }
  return { content };
}
