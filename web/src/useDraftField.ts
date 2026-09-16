import { useEffect, useRef, useState } from "react";

/**
 * Local-first text field.
 *
 * Canvas nodes re-render constantly — a sibling moves, a fetch lands, the graph
 * rebuilds. If an input's value round-trips through parent state on every
 * keystroke, the node can remount mid-word and the caret is lost.
 *
 * So the input owns its value while you type, and the change is pushed upward
 * on a debounce. The prop is only re-adopted when the field switches to a
 * different node (`key`) or changes upstream while we are not mid-edit —
 * otherwise a slow save would clobber characters typed since.
 */
export function useDraftField(
  key: string,
  incoming: string,
  commit: (value: string) => void,
  delay = 400,
) {
  const [value, setValue] = useState(incoming);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const latest = useRef(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  latest.current = value;

  // Moving to a different node: adopt its value unconditionally.
  useEffect(() => {
    dirty.current = false;
    setValue(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Upstream change while we're idle: adopt it. While editing: ignore.
  useEffect(() => {
    if (!dirty.current) setValue(incoming);
  }, [incoming]);

  // Don't lose the last keystrokes if the field unmounts before the timer.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (dirty.current) commitRef.current(latest.current);
      }
    },
    [],
  );

  const onChange = (next: string) => {
    dirty.current = true;
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      commitRef.current(next);
    }, delay);
  };

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    if (dirty.current) {
      dirty.current = false;
      commitRef.current(latest.current);
    }
  };

  return { value, onChange, flush };
}
