import { useCallback, useRef, useState } from "react";

export interface Command {
  /** short description, for the button tooltip */
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

const LIMIT = 100;

/**
 * Undo/redo for structural board edits — create, delete, move, resize, link.
 *
 * Command-based rather than snapshot-based: each action records how to reverse
 * itself, so undo issues the matching API call instead of diffing whole board
 * states against the server.
 *
 * Text inside a card's document is deliberately NOT covered — the markdown editor has its
 * own undo stack, and the keyboard handler steps aside whenever a text field or
 * the editor has focus, so ⌘Z there means "undo my typing", as expected.
 */
export function useHistory() {
  const past = useRef<Command[]>([]);
  const future = useRef<Command[]>([]);
  const busy = useRef(false);
  // depths are mirrored into state purely so the toolbar buttons can re-render
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });

  const sync = () => setDepth({ undo: past.current.length, redo: future.current.length });

  const push = useCallback((cmd: Command) => {
    // an action taken after undoing discards the redo branch
    past.current.push(cmd);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    sync();
  }, []);

  const undo = useCallback(async () => {
    if (busy.current) return;
    const cmd = past.current.pop();
    if (!cmd) return;
    busy.current = true;
    try {
      await cmd.undo();
      future.current.push(cmd);
    } finally {
      busy.current = false;
      sync();
    }
  }, []);

  const redo = useCallback(async () => {
    if (busy.current) return;
    const cmd = future.current.pop();
    if (!cmd) return;
    busy.current = true;
    try {
      await cmd.redo();
      past.current.push(cmd);
    } finally {
      busy.current = false;
      sync();
    }
  }, []);

  const clear = useCallback(() => {
    past.current = [];
    future.current = [];
    sync();
  }, []);

  return { push, undo, redo, clear, depth };
}

/** True when the keystroke belongs to a text field rather than the board. */
export function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.closest) return false;
  return !!(
    el.closest("input, textarea, [contenteditable=true]") || el.closest(".card-doc")
  );
}
