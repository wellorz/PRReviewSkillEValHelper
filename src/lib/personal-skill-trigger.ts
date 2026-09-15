export const DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION =
  "Execute the loaded skill as the primary review procedure. Follow its complete role coverage, verification, deduplication, and ranking instructions.";

export const MAX_PERSONAL_SKILL_TRIGGER_LENGTH = 2_000;

const FORBIDDEN_PUBLICATION_OPTIONS = [
  "--allowpublish",
  "--autopublish-active",
  "--publish-existing",
] as const;

export function personalSkillTriggerInstruction(value?: string | null) {
  return value?.trim() || DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION;
}

export function validatePersonalSkillTriggerInstruction(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Trigger instruction must be text");
  }
  const instruction = value.trim();
  if (!instruction) {
    throw new Error("Trigger instruction is required");
  }
  if (/^(?:&\s*)?copilot(?:\.exe)?\s/i.test(instruction)) {
    throw new Error(
      'Enter only the review instruction passed to "copilot -p", not the full Copilot command',
    );
  }
  if (instruction.length > MAX_PERSONAL_SKILL_TRIGGER_LENGTH) {
    throw new Error(
      `Trigger instruction must be ${MAX_PERSONAL_SKILL_TRIGGER_LENGTH} characters or fewer`,
    );
  }
  const forbidden = FORBIDDEN_PUBLICATION_OPTIONS.find((option) =>
    instruction.toLowerCase().includes(option),
  );
  if (forbidden) {
    throw new Error(
      `${forbidden} is disabled because all benchmark reviews are permanently local-only`,
    );
  }
  return instruction;
}
