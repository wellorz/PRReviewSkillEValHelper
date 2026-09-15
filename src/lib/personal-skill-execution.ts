export const PERSONAL_SKILL_EXECUTION_MODES = [
  "copilot-skill",
  "devloop-local",
] as const;

export type PersonalSkillExecutionMode =
  (typeof PERSONAL_SKILL_EXECUTION_MODES)[number];

export function isDevLoopLocalExecution(
  mode: string | null | undefined,
): mode is "devloop-local" {
  return mode === "devloop-local";
}

export function isNativeWzReviewPath(skillPath: string) {
  return skillPath
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase()
    .endsWith("/wz-review");
}

export function personalSkillResultConfiguration(
  executionMode: string | null | undefined,
  configured: {
    model: string;
    modelSecondary: string;
    contextTier: string;
  },
) {
  return {
    model: configured.model,
    modelSecondary: isDevLoopLocalExecution(executionMode)
      ? "none"
      : configured.modelSecondary,
    contextTier: configured.contextTier,
  };
}
