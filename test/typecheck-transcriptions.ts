import { GridClient, type TranscriptionResponse, type TranscriptionRequestOptions, type ChatCompletionResponse, type EmbeddingResponse } from "../src/index.js";
const grid = new GridClient();
const options: TranscriptionRequestOptions = { language: "en", model: "whisper-1", requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
const pcmResult: Promise<TranscriptionResponse> = grid.transcribePcm(new Uint8Array(2), options);
const fileResult: Promise<TranscriptionResponse> = grid.transcribePcmFile(new Blob([new Uint8Array(2)]), options);
const chat: Promise<ChatCompletionResponse> = grid.chatCompletions({ model: "legacy", messages: [{ role: "user", content: "hello" }] });
const embeddings: Promise<EmbeddingResponse> = grid.embed({ model: "embeddinggemma-2", input: ["one"] });
void [pcmResult, fileResult, chat, embeddings];
// @ts-expect-error Only the pinned transcription model is available.
grid.transcribePcm(new Uint8Array(2), { model: "other" });
