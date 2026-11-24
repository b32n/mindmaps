// Reading the mail the email Worker captured (MAIL_TRANSPORT=capture, see
// worker/src/mail.ts), and signing in through the fake Google. Nothing here is
// reachable on a real install: the capture endpoint answers 404 there.
import { expect, type APIRequestContext } from "@playwright/test";

export interface Captured {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  at: number;
}

export async function mailbox(request: APIRequestContext, to: string): Promise<Captured[]> {
  const res = await request.get(`/api/_mail?to=${encodeURIComponent(to)}`);
  expect(res.status(), "captured mail").toBe(200);
  return await res.json();
}

/** Wait until `to` has `count` messages (mail goes out after the response), then return them all. */
export async function waitForMail(request: APIRequestContext, to: string, count = 1): Promise<Captured[]> {
  await expect.poll(async () => (await mailbox(request, to)).length, { message: `mail to ${to}` }).toBeGreaterThanOrEqual(count);
  return mailbox(request, to);
}

/** Give a moment for mail that must NOT arrive, then check the box really is empty. */
export async function expectNoMail(request: APIRequestContext, to: string, settle = 1500) {
  await new Promise((r) => setTimeout(r, settle));
  expect(await mailbox(request, to), `unexpected mail to ${to}`).toHaveLength(0);
}

/** The link in a message's plain-text part. */
export function linkIn(msg: Captured): URL {
  const m = msg.text.match(/https?:\/\/\S+/);
  if (!m) throw new Error(`no link in: ${msg.text}`);
  return new URL(m[0]);
}

export const tokenIn = (msg: Captured) => linkIn(msg).searchParams.get("token")!;

/** A token that is the right shape and was never issued. */
export const unissuedToken = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/**
 * Sign in as Google would report someone: start the flow for a state, then hand
 * the callback a "code" that the fake Google reads as the identity claims.
 * Returns the callback response (a redirect). Cookies land on `request`.
 */
export async function googleSignIn(
  request: APIRequestContext,
  claims: { email: string; sub: string; name?: string; email_verified?: string | boolean },
) {
  const start = await request.get("/api/auth/google", { maxRedirects: 0 });
  expect(start.status(), "start google").toBe(302);
  const state = new URL(start.headers().location).searchParams.get("state")!;
  const code = Buffer.from(
    JSON.stringify({ aud: "e2e-google-client", name: "Google Person", email_verified: "true", ...claims }),
  ).toString("base64url");
  return request.get(`/api/auth/google/callback?code=${code}&state=${state}`, { maxRedirects: 0 });
}
