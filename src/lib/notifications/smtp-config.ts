export type SmtpConfig = { host: string; port: number; secure: boolean; from: string; user?: string; password?: string };

export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const keys = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_FROM, env.SMTP_USER, env.SMTP_PASSWORD];
  if (keys.every((value) => !value)) return null;
  const host = env.SMTP_HOST?.trim() ?? "";
  const port = Number(env.SMTP_PORT);
  const from = env.SMTP_FROM?.trim() ?? "";
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\S+@\S+\.\S+$/.test(from) || /[\r\n]/.test(from)) throw new Error("SMTP configuration is incomplete or invalid.");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error("SMTP username and password must be configured together.");
  return { host, port, secure: env.SMTP_SECURE === "true" || (env.SMTP_SECURE !== "false" && port === 465), from, user: env.SMTP_USER, password: env.SMTP_PASSWORD };
}

export function eligibleEmail(email: string) {
  return /^\S+@\S+\.\S+$/.test(email) && !email.endsWith("@demo.abignite.invalid") && !/[\r\n]/.test(email);
}
