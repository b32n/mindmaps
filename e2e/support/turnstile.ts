// Helpers for the Turnstile specs: tokens the local Siteverify stand-in
// (e2e/support/fake-turnstile.mjs) accepts or refuses, and what it was sent.
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { turnstileWorker } from "./hosts";

/** A token the stand-in accepts, once. */
export const passing = () => `pass-${randomUUID()}`;
/** A token it refuses. */
export const failing = () => `fail-${randomUUID()}`;
/** A token that makes it answer 500. */
export const outage = () => `outage-${randomUUID()}`;

export interface Call {
  response: string;
  remoteip: string | null;
  idempotency_key: string | null;
  secretOk: boolean;
}

/** What Siteverify (the stand-in) received for a token. */
export async function siteverifyCalls(request: APIRequestContext, token: string): Promise<Call[]> {
  const res = await request.get(`${turnstileWorker.verifyURL}/calls?response=${encodeURIComponent(token)}`);
  expect(res.ok()).toBe(true);
  return res.json();
}
