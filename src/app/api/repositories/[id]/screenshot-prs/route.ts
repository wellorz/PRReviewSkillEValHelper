import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recognizePrNumberImages } from "@/lib/screenshot-pr-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 10;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
type ScreenshotFileResult = {
  fileName: string;
  prNumbers: number[];
  confidence: number;
  error: string | null;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db
    .prepare("SELECT id FROM repositories WHERE id = ?")
    .get(id) as { id: number } | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const images = [
    ...formData.getAll("images"),
    ...(formData.has("images") ? [] : formData.getAll("image")),
  ].filter((value): value is File => value instanceof File);
  if (images.length === 0) {
    return NextResponse.json(
      { error: "Choose one or more screenshots to scan" },
      { status: 400 },
    );
  }
  if (images.length > MAX_IMAGES) {
    return NextResponse.json(
      { error: `Upload at most ${MAX_IMAGES} screenshots at a time` },
      { status: 400 },
    );
  }

  const fileResults: Array<ScreenshotFileResult | null> = images.map((image) => {
    if (!SUPPORTED_IMAGE_TYPES.has(image.type)) {
      return {
        fileName: image.name,
        prNumbers: [] as number[],
        confidence: 0,
        error: "Use a PNG, JPEG, or WebP screenshot",
      };
    }
    if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
      return {
        fileName: image.name,
        prNumbers: [] as number[],
        confidence: 0,
        error: "Screenshot size must be between 1 byte and 12 MB",
      };
    }
    return null;
  });
  const validImages = images
    .map((image, index) => ({ image, index }))
    .filter(({ index }) => fileResults[index] === null);

  try {
    const recognized = await recognizePrNumberImages(
      await Promise.all(
        validImages.map(async ({ image }) =>
          Buffer.from(await image.arrayBuffer()),
        ),
      ),
    );
    for (let index = 0; index < recognized.length; index += 1) {
      const target = validImages[index];
      const result = recognized[index];
      fileResults[target.index] = {
        fileName: target.image.name,
        prNumbers: result.prNumbers,
        confidence: result.confidence,
        error: result.error
          ? `Screenshot OCR failed: ${result.error}`
          : result.prNumbers.length === 0
            ? "No explicit 'PR <number>' entries were found"
            : null,
      };
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: `Screenshot OCR initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 500 },
    );
  }

  const completedFileResults = fileResults.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  );
  const prNumbers = [
    ...new Set(completedFileResults.flatMap((result) => result.prNumbers)),
  ];
  if (prNumbers.length === 0) {
    return NextResponse.json(
      {
        error: "No explicit 'PR <number>' entries were found",
        fileResults: completedFileResults,
      },
      { status: 422 },
    );
  }

  const placeholders = prNumbers.map(() => "?").join(",");
  const existingPrNumbers = (
    db
      .prepare(`
        SELECT number FROM pull_requests
        WHERE repository_id = ? AND number IN (${placeholders})
      `)
      .all(repository.id, ...prNumbers) as Array<{ number: number }>
  ).map((row) => row.number);
  const successfulResults = completedFileResults.filter(
    (result) => !result.error,
  );

  return NextResponse.json({
    prNumbers,
    existingPrNumbers,
    confidence:
      successfulResults.reduce(
        (total, result) => total + result.confidence,
        0,
      ) / successfulResults.length,
    fileResults: completedFileResults,
  });
}
