import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { normalizeModelId } from "@/lib/models";

const schema = z.object({
  model: z.string().trim().min(1),
  modelSecondary: z.string().trim().min(1).default("none"),
  contextTier: z.enum(["default", "long_context"]),
  name: z.string().trim().min(1, "Profile name is required").max(100),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const profiles = db
    .prepare(`
      SELECT * FROM baseline_profiles
      WHERE repository_id = ? AND active = 1
      ORDER BY model, model_secondary, context_tier
    `)
    .all(id);
  return NextResponse.json({ profiles });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid baseline profile" },
      { status: 400 },
    );
  }
  let model: string;
  let modelSecondary: string;
  try {
    model = normalizeModelId(parsed.data.model);
    if (model === "none") throw new Error("A baseline profile requires a model");
    modelSecondary = normalizeModelId(parsed.data.modelSecondary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const duplicateName = db
    .prepare(`
      SELECT id FROM baseline_profiles
      WHERE repository_id = ? AND LOWER(TRIM(name)) = LOWER(?)
      LIMIT 1
    `)
    .get(id, parsed.data.name) as { id: number } | undefined;
  if (duplicateName) {
    return NextResponse.json(
      {
        error: `A baseline profile named "${parsed.data.name}" already exists.`,
      },
      { status: 409 },
    );
  }
  const duplicateSettings = db
    .prepare(`
      SELECT id FROM baseline_profiles
      WHERE repository_id = ? AND model = ? AND model_secondary = ?
        AND context_tier = ?
      LIMIT 1
    `)
    .get(
      id,
      model,
      modelSecondary,
      parsed.data.contextTier,
    ) as { id: number } | undefined;
  if (duplicateSettings) {
    return NextResponse.json(
      {
        error:
          "A baseline profile with the same model and context settings already exists.",
      },
      { status: 409 },
    );
  }
  const inserted = db.prepare(`
    INSERT INTO baseline_profiles (
      repository_id, model, model_secondary, context_tier, name
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    model,
    modelSecondary,
    parsed.data.contextTier,
    parsed.data.name,
  );
  const profile = db
    .prepare("SELECT * FROM baseline_profiles WHERE id = ?")
    .get(Number(inserted.lastInsertRowid));
  return NextResponse.json({ profile }, { status: 201 });
}
