import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { SGLEmbeddingInputError } from "./errors.js";
import type {
  EmbeddingAudioMimeType,
  EmbeddingAudioPart,
  EmbeddingContentPart,
  EmbeddingImageMimeType,
  EmbeddingImagePart,
  EmbeddingInput,
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
  /** Aggregate decoded image bytes across one item's image parts. */
  maxImageBytesPerItem: 8 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxAudioPartsPerItem: 1,
  maxAudioBytes: 8 * 1024 * 1024,
  maxAudioSeconds: 30,
  maxVideoPartsPerItem: 1,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toBytes(data: BinaryEmbeddingData): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) {
    throw new SGLEmbeddingInputError("invalid_media_data", "Embedding media must not be empty");
  }
  return bytes;
}

function mediaLimit(mimeType: EmbeddingMediaMimeType): number {
  if ((EMBEDDINGGEMMA2_MIME_TYPES.image as readonly string[]).includes(mimeType)) {
    return EMBEDDINGGEMMA2_LIMITS.maxImageBytesPerItem;
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

function mediaModality(mimeType: unknown): "image" | "audio" | "video" | null {
  if (typeof mimeType !== "string") return null;
  if ((EMBEDDINGGEMMA2_MIME_TYPES.image as readonly string[]).includes(mimeType)) return "image";
  if ((EMBEDDINGGEMMA2_MIME_TYPES.audio as readonly string[]).includes(mimeType)) return "audio";
  if ((EMBEDDINGGEMMA2_MIME_TYPES.video as readonly string[]).includes(mimeType)) return "video";
  return null;
}

/** Return decoded byte length only for strict canonical base64. */
function decodedBase64Bytes(data: unknown): number | null {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (padding && data.length - padding < 2) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding && (alphabet.indexOf(data[data.length - padding - 1]) & (padding === 2 ? 15 : 3))) {
    return null;
  }
  return data.length / 4 * 3 - padding;
}

function validateMediaPart(
  part: Record<string, unknown>,
  expected: "image" | "audio" | "video",
): number {
  if (!isRecord(part.media) || part.media.encoding !== "base64") {
    throw new SGLEmbeddingInputError(
      "invalid_media_data",
      `${expected} parts require inline base64 media`,
    );
  }
  const modality = mediaModality(part.media.mime_type);
  if (modality !== expected) {
    throw new SGLEmbeddingInputError(
      "unsupported_media_type",
      `Unsupported ${expected} media type: ${String(part.media.mime_type)}`,
    );
  }
  if (typeof part.media.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(part.media.sha256)) {
    throw new SGLEmbeddingInputError(
      "invalid_media_data",
      `${expected} media requires a lowercase SHA-256 digest`,
    );
  }
  const bytes = decodedBase64Bytes(part.media.data);
  if (bytes === null) {
    throw new SGLEmbeddingInputError(
      "invalid_media_data",
      `${expected} media must use canonical base64`,
    );
  }
  const limit = mediaLimit(part.media.mime_type as EmbeddingMediaMimeType);
  if (bytes > limit) {
    throw new SGLEmbeddingInputError(
      "media_too_large",
      `${expected} media is ${bytes} bytes; the limit is ${limit}`,
    );
  }
  return bytes;
}

/**
 * Validate the SDK-visible EmbeddingGemma 2 request limits before a network call.
 * Runtime media truth (digest, dimensions, duration, and decoding) is still verified by the node.
 */
export function validateEmbeddingGemma2Input(input: EmbeddingInput): void {
  const items = typeof input === "string" ? [input] : input;
  if (!Array.isArray(items) || items.length === 0 || items.length > EMBEDDINGGEMMA2_LIMITS.maxBatchItems) {
    throw new SGLEmbeddingInputError(
      "invalid_batch",
      `EmbeddingGemma 2 requires 1-${EMBEDDINGGEMMA2_LIMITS.maxBatchItems} batch items`,
    );
  }

  let requestMediaBytes = 0;
  for (const entry of items) {
    if (typeof entry === "string") {
      if (!entry.length) {
        throw new SGLEmbeddingInputError("empty_text", "Embedding text must not be empty");
      }
      continue;
    }
    if (!isRecord(entry) || !Array.isArray(entry.content)) {
      throw new SGLEmbeddingInputError("invalid_content_part", "Embedding items require content");
    }
    if (entry.content.length === 0 || entry.content.length > EMBEDDINGGEMMA2_LIMITS.maxPartsPerItem) {
      throw new SGLEmbeddingInputError(
        "too_many_parts",
        `Embedding items require 1-${EMBEDDINGGEMMA2_LIMITS.maxPartsPerItem} ordered content parts`,
      );
    }

    let images = 0;
    let audio = 0;
    let video = 0;
    let imageBytes = 0;
    for (const rawPart of entry.content) {
      if (!isRecord(rawPart)) {
        throw new SGLEmbeddingInputError("invalid_content_part", "Invalid embedding content part");
      }
      if (rawPart.type === "text") {
        if (typeof rawPart.text !== "string" || rawPart.text.length === 0) {
          throw new SGLEmbeddingInputError("empty_text", "Embedding text must not be empty");
        }
        continue;
      }
      if (rawPart.type === "image") {
        images += 1;
        if (images > EMBEDDINGGEMMA2_LIMITS.maxImagesPerItem) {
          throw new SGLEmbeddingInputError("too_many_images", "An item can contain at most 8 images");
        }
        const bytes = validateMediaPart(rawPart, "image");
        imageBytes += bytes;
        requestMediaBytes += bytes;
        if (imageBytes > EMBEDDINGGEMMA2_LIMITS.maxImageBytesPerItem) {
          throw new SGLEmbeddingInputError(
            "media_too_large",
            `Aggregate image media per item cannot exceed ${EMBEDDINGGEMMA2_LIMITS.maxImageBytesPerItem} bytes`,
          );
        }
        continue;
      }
      if (rawPart.type === "audio" || rawPart.type === "video") {
        const type = rawPart.type;
        if (type === "audio") {
          audio += 1;
          if (audio > EMBEDDINGGEMMA2_LIMITS.maxAudioPartsPerItem) {
            throw new SGLEmbeddingInputError("too_many_audio_parts", "An item can contain at most one audio part");
          }
        } else {
          video += 1;
          if (video > EMBEDDINGGEMMA2_LIMITS.maxVideoPartsPerItem) {
            throw new SGLEmbeddingInputError("too_many_video_parts", "An item can contain at most one video part");
          }
        }
        const duration = rawPart.duration_seconds;
        const maxSeconds = type === "audio"
          ? EMBEDDINGGEMMA2_LIMITS.maxAudioSeconds
          : EMBEDDINGGEMMA2_LIMITS.maxVideoSeconds;
        requireDuration(duration as number, maxSeconds, type);
        requestMediaBytes += validateMediaPart(rawPart, type);
        continue;
      }
      throw new SGLEmbeddingInputError("invalid_content_part", "Unsupported embedding content part");
    }
  }

  if (requestMediaBytes > EMBEDDINGGEMMA2_LIMITS.maxRequestMediaBytes) {
    throw new SGLEmbeddingInputError(
      "request_media_too_large",
      `Decoded request media cannot exceed ${EMBEDDINGGEMMA2_LIMITS.maxRequestMediaBytes} bytes`,
    );
  }
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

/** Build and validate one ordered multimodal batch item. */
export function embeddingItem(...content: EmbeddingContentPart[]): MultimodalEmbeddingItem {
  const item = { content };
  validateEmbeddingGemma2Input([item]);
  return item;
}
