import { randomUUID } from "node:crypto";

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

/** Satisfies the policy in worker/src/auth.ts (12+ chars, mixed case, digit, symbol). */
export function strongPassword(): string {
  return `Aa1!${randomUUID().replace(/-/g, "").slice(0, 12)}x`;
}

/** A user nobody else will collide with, in this run or a re-used server's. */
export function newUser(label = "user"): TestUser {
  const id = randomUUID().slice(0, 8);
  return {
    name: `E2E ${label} ${id}`,
    email: `e2e-${label}-${id}@example.test`,
    // randomUUID hex has no 4-in-a-row guarantee, so re-roll if the policy would object.
    password: (() => {
      for (;;) {
        const p = strongPassword();
        if (!/(.)\1{3,}/.test(p)) return p;
      }
    })(),
  };
}
