import assert from "node:assert/strict";
import test from "node:test";
import {
  COPILOT_MODELS,
  OPTIONAL_COPILOT_MODELS,
  modelLabel,
  normalizeModelId,
} from "@/lib/models";

test("offers GPT-6 Astra for both baseline model selectors", () => {
  const expected = { id: "gpt-6-astra", label: "GPT-6 Astra" };

  assert.deepEqual(
    COPILOT_MODELS.find((model) => model.id === expected.id),
    expected,
  );
  assert.deepEqual(
    OPTIONAL_COPILOT_MODELS.find((model) => model.id === expected.id),
    expected,
  );
  assert.equal(COPILOT_MODELS[0].id, "gpt-5.6-sol");
  assert.equal(OPTIONAL_COPILOT_MODELS[0].id, "none");
});

test("normalizes GPT-6 Astra IDs and display names", () => {
  for (const value of ["gpt-6-astra", "GPT-6 Astra", "  GpT-6 AsTrA  "]) {
    assert.equal(normalizeModelId(value), "gpt-6-astra");
  }
  assert.equal(modelLabel("gpt-6-astra"), "GPT-6 Astra");
});

test("normalizes every offered model ID and display name", () => {
  for (const model of COPILOT_MODELS) {
    assert.equal(normalizeModelId(model.id), model.id);
    assert.equal(normalizeModelId(model.label), model.id);
    assert.equal(modelLabel(model.id), model.label);
  }
  assert.equal(normalizeModelId("none"), "none");
  assert.equal(modelLabel("none"), "None");
});

test("rejects unsupported models", () => {
  assert.throws(
    () => normalizeModelId("gpt-6-unknown"),
    /Unsupported model/,
  );
});
