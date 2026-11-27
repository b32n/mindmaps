// Who is signed in where, by e-mail address, for this test process.
//
// Inviting an existing account to a workspace no longer adds them: the invite
// waits until they accept it. Most specs only need "this person is in the
// workspace" as a starting point, so `addMember` (support/api.ts) accepts on
// the invitee's behalf when it knows their session. This map is how it knows:
// `register` in fixtures.ts records every account it creates.
import type { APIRequestContext } from "@playwright/test";

const sessions = new Map<string, APIRequestContext>();

export const rememberSession = (email: string, request: APIRequestContext) => {
  sessions.set(email.trim().toLowerCase(), request);
};

export const sessionFor = (email: string): APIRequestContext | undefined =>
  sessions.get(email.trim().toLowerCase());
