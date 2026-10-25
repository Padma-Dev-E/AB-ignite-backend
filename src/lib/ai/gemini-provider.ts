import "server-only";

import { getAiConfig, type AiConfig } from "./config";
import { createGeminiProvider as createCoreGeminiProvider, type GeminiProviderDependencies } from "./gemini-provider-core";

export type { GeminiClientLike, GeminiProviderDependencies } from "./gemini-provider-core";

export function createGeminiProvider(config: AiConfig = getAiConfig(), dependencies: GeminiProviderDependencies = {}) {
  return createCoreGeminiProvider(config, dependencies);
}
