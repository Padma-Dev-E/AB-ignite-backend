export type ExtractedJsonOutput = {
  value: unknown;
  jsonText: string;
  format: "direct" | "json_string" | "escaped_json" | "markdown_fence" | "embedded";
};

// These are safety bounds, not the expected response depth. Keep enough room
// for several API wrappers, JSON-encoded strings, and Markdown wrappers while
// preventing adversarial output from consuming unbounded CPU or stack.
const MAX_STRING_LAYERS = 32;
const MAX_CANDIDATES = 512;

export function unwrapJsonStringLayers(value: unknown): unknown {
  let current = value;
  for (let layer = 0; layer < MAX_STRING_LAYERS && typeof current === "string"; layer += 1) {
    try {
      current = JSON.parse(current.replace(/^\uFEFF/, "").trim()) as unknown;
    } catch {
      break;
    }
  }
  return current;
}

function result(value: unknown, format: ExtractedJsonOutput["format"]): ExtractedJsonOutput | undefined {
  try {
    const jsonText = JSON.stringify(value);
    return typeof jsonText === "string" ? { value, jsonText, format } : undefined;
  } catch {
    return undefined;
  }
}

function decodeEscapedJson(source: string): string | undefined {
  if (!(source.startsWith("{") || source.startsWith("[")) || !source.includes("\\\"")) return undefined;
  try {
    const decoded: unknown = JSON.parse(`"${source.replace(/\r?\n/g, "\\n")}"`);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function balancedJsonCandidates(source: string): string[] {
  const candidates: string[] = [];
  let startsChecked = 0;
  for (let start = 0; start < source.length && startsChecked < MAX_CANDIDATES; start += 1) {
    const first = source[start];
    if (first !== "{" && first !== "[") continue;
    startsChecked += 1;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let end = start; end < source.length; end += 1) {
      const char = source[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        const opening = stack.pop();
        if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[")) break;
        if (stack.length === 0) {
          candidates.push(source.slice(start, end + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function extract(text: string, depth: number): ExtractedJsonOutput | undefined {
  if (depth > MAX_STRING_LAYERS) return undefined;
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) return undefined;

  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === "string") {
      const nested = extract(value, depth + 1);
      if (nested) return { ...nested, format: "json_string" };
    }
    return result(value, depth === 0 ? "direct" : "json_string");
  } catch { /* Try the other explicitly supported text wrappers. */ }

  const escaped = decodeEscapedJson(source);
  if (escaped !== undefined) {
    const nested = extract(escaped, depth + 1);
    if (nested) return { ...nested, format: "escaped_json" };
  }

  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    const fenced = extract(match[1] ?? "", depth + 1);
    if (fenced) return { ...fenced, format: "markdown_fence" };
  }

  for (const candidate of balancedJsonCandidates(source)) {
    const embedded = extract(candidate, depth + 1);
    if (embedded) return { ...embedded, format: "embedded" };
  }
  return undefined;
}

/** Extract one syntactically valid JSON value from common model text wrappers. */
export function extractJsonOutput(text: string): ExtractedJsonOutput | undefined {
  return extract(text, 0);
}
