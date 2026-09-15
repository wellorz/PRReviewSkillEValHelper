import { createWorker, OEM, PSM } from "tesseract.js";
import englishData from "@tesseract.js-data/eng";

export function extractExplicitPrNumbers(text: string) {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(/\bPR[\s#:.-]*(\d{5,10})\b/gi)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  return numbers;
}

export async function recognizePrNumbers(image: Buffer) {
  const [result] = await recognizePrNumberImages([image]);
  if (!result) throw new Error("No screenshot was provided");
  if (result.error) throw new Error(result.error);
  return {
    prNumbers: result.prNumbers,
    confidence: result.confidence,
  };
}

export async function recognizePrNumberImages(images: Buffer[]) {
  const worker = await createWorker(englishData.code, OEM.LSTM_ONLY, {
    langPath: englishData.langPath,
    gzip: englishData.gzip,
    cacheMethod: "readOnly",
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    });
    const results = [];
    for (const image of images) {
      try {
        const result = await worker.recognize(image);
        results.push({
          prNumbers: extractExplicitPrNumbers(result.data.text),
          confidence: result.data.confidence,
          error: null,
        });
      } catch (error) {
        results.push({
          prNumbers: [],
          confidence: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  } finally {
    await worker.terminate();
  }
}
