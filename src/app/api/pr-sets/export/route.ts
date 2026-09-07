import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createPrSetBundle } from "@/lib/pr-set-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const repositoryCount = (
    db.prepare("SELECT COUNT(*) AS count FROM repositories").get() as {
      count: number;
    }
  ).count;
  if (repositoryCount === 0) {
    return NextResponse.json(
      { error: "There are no PR sets to export" },
      { status: 404 },
    );
  }
  const archive = await createPrSetBundle(db);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="pr-sets-${date}.json.gz"`,
      "Cache-Control": "no-store",
    },
  });
}
