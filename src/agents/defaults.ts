// Defaults for agent metadata when upstream does not supply them.
// Keep this aligned with the product-level latest-model baseline.
export const DEFAULT_PROVIDER = "zai";
export const DEFAULT_MODEL = "glm-5.1";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
