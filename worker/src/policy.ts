/**
 * What each deployment mode allows. The one place the Worker asks.
 *
 * Callers ask a question ("are team spaces on?") instead of comparing the mode
 * to a string, so a new mode, or a new rule for an existing one, is a change
 * here and nowhere else. See mode.ts for the setting and docs/MODES.md for the
 * behaviour.
 *
 *   personal      team spaces are hidden: not listed, not created, not offered
 *                 to an agent. Sharing is untouched.
 *   org           as multitenant today; organisation lifecycle comes later.
 *   multitenant   exactly the behaviour from before modes existed.
 *
 * Hiding is not deleting. Nothing here writes to the database: a hidden team
 * space keeps its rows, its members and its mindmaps, and every one of them is
 * back the moment the mode is. It is also not an access boundary. A mindmap in a
 * hidden space that was shared with someone is still theirs, by its id and in
 * their list (that is sharing, and sharing stays), and a direct request by id
 * for anything the caller could already read is answered as it always was.
 * What changes is what is offered: lists, search, recall, creation and the
 * agent's choice of where to work.
 */

import { readMode, type Mode, type ModeEnv } from "./mode";

export interface Policy {
  mode: Mode;
  /** Shared workspaces are visible and can be made. False hides them. */
  teamSpaces: boolean;
}

export function policyFor(env: ModeEnv): Policy {
  const mode = readMode(env);
  return { mode, teamSpaces: mode !== "personal" };
}

/** The refusal for making, or writing into, a team space while they are hidden. */
export const TEAM_SPACES_DISABLED = {
  error: "Team spaces are turned off on this instance (personal mode).",
  code: "team_spaces_disabled",
} as const;
