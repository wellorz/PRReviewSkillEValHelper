import assert from "node:assert/strict";
import test from "node:test";
import { hasRecentRepositoryScanProgress } from "@/lib/worker-availability";

test("accepts recent repository scan progress as worker liveness", () => {
  assert.equal(
    hasRecentRepositoryScanProgress({
      status: "syncing",
      updated_at: new Date().toISOString(),
    }),
    true,
  );
});

test("does not accept stale or inactive repository state", () => {
  assert.equal(
    hasRecentRepositoryScanProgress({
      status: "syncing",
      updated_at: "2020-01-01 00:00:00",
    }),
    false,
  );
  assert.equal(
    hasRecentRepositoryScanProgress({
      status: "ready",
      updated_at: new Date().toISOString(),
    }),
    false,
  );
});
