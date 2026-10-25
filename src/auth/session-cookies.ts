import { SESSION_COOKIE_NAME } from "./config";

export function stripSessionCookie(response: Response): Response {
  const cookies = response.headers.getSetCookie().filter((cookie) => {
    const name = cookie.slice(0, cookie.indexOf("="));
    return name !== SESSION_COOKIE_NAME && !name.startsWith(`${SESSION_COOKIE_NAME}.`);
  });
  response.headers.delete("set-cookie");
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}
