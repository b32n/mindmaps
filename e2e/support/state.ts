/** Session of the instance owner, written by e2e/setup/instance.setup.ts. */
export const OWNER_STATE = "e2e/.auth/owner.json";

/**
 * The owner of the sign-up-CLOSED instance (second Worker, see
 * playwright.config.ts): browser session, and the credentials for specs that
 * sign in through the form. Written by e2e/closed-signup/closed.setup.ts.
 */
export const CLOSED_OWNER_STATE = "e2e/.auth/closed-owner.json";
export const CLOSED_OWNER_CREDS = "e2e/.auth/closed-owner.creds.json";
