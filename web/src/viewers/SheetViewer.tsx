/**
 * A shared spreadsheet, read-only.
 *
 * Its own module so the spreadsheet engine is only downloaded by someone who
 * opens a shared sheet — a shared deck should not pull it in.
 */

import { useMemo } from "react";
import { WorkbookImpl } from "@b32nio/spindle-sheets-core";
import { WorkbookProvider, WorkbookCanvas } from "@b32nio/spindle-sheets-react";

export default function SheetViewer({
  payload,
  title,
  size,
}: {
  payload: unknown;
  title: string;
  size: { w: number; h: number };
}) {
  const wb = useMemo(() => {
    const p = payload as { id?: string; name?: string };
    const w = new WorkbookImpl(p?.id ?? "shared", p?.name || title || "Untitled");
    w.setData(payload as never);
    return w;
  }, [payload, title]);

  return (
    <WorkbookProvider workbook={wb}>
      <WorkbookCanvas width={size.w} height={size.h} readOnly />
    </WorkbookProvider>
  );
}
