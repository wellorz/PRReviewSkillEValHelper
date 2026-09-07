export const COPILOT_MODELS = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export const OPTIONAL_COPILOT_MODELS = [
  { id: "none", label: "None · Model 1 only" },
  ...COPILOT_MODELS,
] as const;

const MODEL_ALIASES: Record<string, string> = {
  none: "none",
  "gpt-6 astra": "gpt-6-astra",
  "gpt-6-astra": "gpt-6-astra",
  "gpt-5.6 sol": "gpt-5.6-sol",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6 luna": "gpt-5.6-luna",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.6 tera": "gpt-5.6-terra",
  "gpt-5.6 terra": "gpt-5.6-terra",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.4": "gpt-5.4",
  "grok 4.6": "grok-4.6",
  "grok-4.6": "grok-4.6",
  "gemini 3.8 flash": "gemini-3.8-flash",
  "gemini-3.8-flash": "gemini-3.8-flash",
};

export function normalizeModelId(value: string) {
  const normalized = MODEL_ALIASES[value.trim().toLowerCase()];
  if (!normalized) {
    throw new Error(
      `Unsupported model "${value}". Select an exact Copilot model from the list.`,
    );
  }
  return normalized;
}

export function modelLabel(id: string) {
  if (id === "none") return "None";
  return COPILOT_MODELS.find((model) => model.id === id)?.label ?? id;
}
