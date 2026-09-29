/** A shared deck, read-only. Present mode still works, which is the point. */

import { useMemo } from "react";
import { DeckImpl } from "@b32nio/spindle-slides-core";
import { DeckProvider, SlidesEditor } from "@b32nio/spindle-slides-react";

export default function DeckViewer({
  payload,
  title,
  size,
}: {
  payload: unknown;
  title: string;
  size: { w: number; h: number };
}) {
  const deck = useMemo(() => {
    const p = payload as { id?: string; title?: string };
    const d = new DeckImpl(p?.id ?? "shared", p?.title || title || "Untitled");
    d.setData(payload as never);
    return d;
  }, [payload, title]);

  return (
    <DeckProvider deck={deck}>
      <SlidesEditor style={{ width: size.w, height: size.h }} readOnly />
    </DeckProvider>
  );
}
