import type { StructuredGenerationRequest, StructuredGenerationResponse } from "./types";

export interface AiProvider {
  generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationResponse>;
}
