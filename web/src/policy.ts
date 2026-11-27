/**
 * What the deployment mode changes in the app. The one place the web app asks.
 *
 * Components ask a question ("are team spaces on?") rather than compare the mode
 * to a string. The Worker enforces the same rules (worker/src/policy.ts); this
 * is only so the app does not offer what the server would refuse. See
 * docs/MODES.md.
 *
 *   personal      no team spaces: no workspace switcher, no way to make one.
 *                 Sharing is untouched.
 *   org, multitenant, and a mode not known yet: everything as before.
 */

import type { Mode } from "./api";
import { useMode } from "./AuthContext";

export interface ModePolicy {
  /** Shared workspaces are shown and can be made. */
  teamSpaces: boolean;
}

export const modePolicy = (mode: Mode | null): ModePolicy => ({ teamSpaces: mode !== "personal" });

export const useModePolicy = (): ModePolicy => modePolicy(useMode());
