import { readFile } from "node:fs/promises";
import {
  GridClient,
  embeddingAudio,
  embeddingImage,
  embeddingItem,
  embeddingText,
} from "@singularity-layer/grid";

const grid = new GridClient({ apiKey: process.env.SGL_API_KEY });
const [image, audio] = await Promise.all([
  readFile("./product.png"),
  readFile("./description.wav"),
]);

const response = await grid.embed({
  model: "embeddinggemma-2",
  input: [
    embeddingItem(
      embeddingText("Find products like this one."),
      embeddingImage(image, "image/png"),
      embeddingAudio(audio, "audio/wav", 8.4),
    ),
  ],
  input_type: "query",
  dimensions: 256,
});

console.log(response.data[0].embedding);
console.log(response.usage?.breakdown);
