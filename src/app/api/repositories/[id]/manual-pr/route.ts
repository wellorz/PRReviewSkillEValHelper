import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const schema = z.union([
  z.object({ value: z.string().trim().min(1) }),
  z.object({
    values: z.array(z.string().trim().min(1)).min(1).max(100),
    requireValuedComments: z.boolean().optional().default(false),
    concurrency: z.number().int().min(1).max(20).optional().default(5),
  }),
]);

function prNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:pull|pullrequest)\/(\d+)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a PR link or number" }, { status: 400 });
  }
  const values =
    "values" in parsed.data ? parsed.data.values : [parsed.data.value];
  const numbers = [...new Set(values.map(prNumber))];
  if (numbers.some((number) => !number)) {
    return NextResponse.json(
      { error: "One or more values do not contain a valid PR number" },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db.prepare("SELECT id FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  let payload:
    | {
        prNumbers: number[];
        requireValuedComments: boolean;
        concurrency: number;
      }
    | { prNumber: number; requireValuedComments: false };
  let concurrency: number;
  if ("values" in parsed.data) {
    payload = {
        prNumbers: numbers as number[],
        requireValuedComments: parsed.data.requireValuedComments,
        concurrency: parsed.data.concurrency,
      };
    concurrency = parsed.data.concurrency;
  } else {
    payload = {
      prNumber: numbers[0] as number,
      requireValuedComments: false,
    };
    concurrency = 1;
  }
  const result = db
    .prepare(
      "INSERT INTO workflow_tasks (repository_id, kind, payload_json, total_items) VALUES (?, 'manual_pr', ?, ?)",
    )
    .run(id, JSON.stringify(payload), numbers.length);
  const taskId = Number(result.lastInsertRowid);
  return NextResponse.json(
    {
      taskId,
      taskIds: [taskId],
      prNumbers: numbers,
      concurrency,
    },
    { status: 201 },
  );
}
