import { createHmac } from "node:crypto";

export const DEMO_EMAIL_DOMAIN = "demo.abignite.invalid";
export const DEMO_DEPARTMENTS = ["Technology", "Transformation", "Retail Banking", "Branch Banking", "Other"] as const;

export function normalizeDemoName(raw: string) {
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80 || /[\x00-\x1f\x7f<>]/.test(name)) throw new Error("Enter a name between 2 and 80 characters.");
  return name;
}

export function demoEmail(name: string, secret: string) {
  if (secret.length < 24) throw new Error("A strong AUTH_SECRET is required for demo access.");
  const digest = createHmac("sha256", secret).update(normalizeDemoName(name).toLocaleLowerCase("en-US")).digest("hex");
  return `demo-${digest}@${DEMO_EMAIL_DOMAIN}`;
}
