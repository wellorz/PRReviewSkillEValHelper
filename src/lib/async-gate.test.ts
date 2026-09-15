import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncGate } from "@/lib/async-gate";

test("bounds concurrent work without changing result order", async () => {
  const gate = createAsyncGate(2);
  let active = 0;
  let peak = 0;

  const results = await Promise.all(
    [40, 10, 20, 5].map((delay, index) =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return index;
      }),
    ),
  );

  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("releases capacity after a failed action", async () => {
  const gate = createAsyncGate(1);
  await assert.rejects(
    gate.run(async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(await gate.run(async () => "completed"), "completed");
});
