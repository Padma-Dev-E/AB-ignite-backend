export class ArticleUrlError extends Error {}

export function validateExternalArticleUrl(value: string | null) {
  if (value === null) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ArticleUrlError("External article links must be valid HTTPS URLs."); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) throw new ArticleUrlError("External article links must use HTTPS and cannot contain credentials.");
}

export function validateArticleLink(contentType: "internal" | "external", value: string | null) {
  if (contentType === "external" && !value) throw new ArticleUrlError("External articles require an HTTPS link.");
  if (contentType === "external" || value) validateExternalArticleUrl(value);
}
