import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import middleware from "../../middleware";
import { authSecret, SESSION_COOKIE_NAME } from "./config";
import { stripSessionCookie } from "./session-cookies";

test("a navigation cannot overwrite a newer rotated session cookie", async () => {
  const oldJwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: {
      sub: "1",
      role: "back_office",
      sessionId: "1",
      sessionVersion: 0,
      accessTokenExpires: Date.now() - 60_000,
    },
  });
  const request = new NextRequest("http://localhost/private/admin", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${oldJwt}` },
  });
  const response = (await middleware(request, {} as never))!;

  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)), false);
});

test("forced password-change JWT is limited to password change and auth endpoints", async () => {
  const jwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: { sub: "1", role: "back_office", sessionVersion: 0, mustChangePassword: true },
  });

  const blocked = (await middleware(new NextRequest("http://localhost/private/admin", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(blocked.status, 307);
  assert.equal(blocked.headers.get("location"), "http://localhost/change-password");

  const passwordChange = (await middleware(new NextRequest("http://localhost/change-password", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(passwordChange.status, 200);

  const blockedApi = (await middleware(new NextRequest("http://localhost/api/ideas", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(blockedApi.status, 403);

  const passwordApi = (await middleware(new NextRequest("http://localhost/api/account/password", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(passwordApi.status, 200);
});

test("the first-login password page redirects anonymous and already-updated sessions", async () => {
  const anonymous = (await middleware(new NextRequest("http://localhost/change-password"), {} as never))!;
  assert.equal(anonymous.status, 307);
  assert.equal(anonymous.headers.get("location"), "http://localhost/login");

  const jwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: { sub: "1", role: "employee", sessionVersion: 0, mustChangePassword: false },
  });
  const completed = (await middleware(new NextRequest("http://localhost/change-password", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(completed.status, 307);
  assert.equal(completed.headers.get("location"), "http://localhost/private");
});

test("an admin-only internal path redirects normal users", async () => {
  const jwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: { sub: "1", role: "employee", sessionVersion: 0, mustChangePassword: false },
  });
  const response = (await middleware(new NextRequest("http://localhost/private/admin", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/private");
});

test("a legacy name-only demo JWT cannot access private pages", async () => {
  const jwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: { sub: "1", name: "Legacy Demo", email: "demo-old@demo.abignite.invalid", role: "employee", sessionVersion: 0 },
  });
  const response = (await middleware(new NextRequest("http://localhost/private", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login");
});

test("business owners retain evaluation workspace access", async () => {
  const jwt = await encode({
    secret: authSecret,
    salt: SESSION_COOKIE_NAME,
    token: { sub: "1", role: "business_owner", sessionVersion: 0, mustChangePassword: false },
  });
  const response = (await middleware(new NextRequest("http://localhost/private/admin", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
  }), {} as never))!;
  assert.equal(response.status, 200);
});

test("session endpoint can retain other cookies without reissuing a stale JWT", () => {
  const response = new Response(null, { headers: [
    ["set-cookie", `${SESSION_COOKIE_NAME}=old; Path=/; HttpOnly`],
    ["set-cookie", "csrf=keep; Path=/; HttpOnly"],
  ] });
  stripSessionCookie(response);
  assert.deepEqual(response.headers.getSetCookie(), ["csrf=keep; Path=/; HttpOnly"]);
});
