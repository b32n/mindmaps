/** A shared document, read-only. */

import { useMemo } from "react";
import { DocumentImpl } from "@b32nio/spindle-docs-core";
import { DocumentProvider, DocumentEditor } from "@b32nio/spindle-docs-react";

export default function DocViewer({
  payload,
  title,
  size,
}: {
  payload: unknown;
  title: string;
  size: { w: number; h: number };
}) {
  const doc = useMemo(() => {
    const p = payload as { id?: string; title?: string };
    const d = new DocumentImpl(p?.id ?? "shared", p?.title || title || "Untitled");
    d.setData(payload as never);
    return d;
  }, [payload, title]);

  return (
    <DocumentProvider document={doc}>
      {/* No ruler: margins cannot be dragged here, and a ruler implies they can. */}
      <DocumentEditor width={size.w} height={size.h} showToolbar={false} showRuler={false} readOnly />
    </DocumentProvider>
  );
}
