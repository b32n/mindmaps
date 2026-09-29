/**
 * The sheet editor, on its own route.
 *
 * Not an in-card expansion. A grid wants the whole window, and putting it here
 * means a board that holds no sheets never downloads the spreadsheet engine:
 * this module is behind a `React.lazy` boundary, so the code arrives when you
 * open one and not before.
 *
 * The payload lives in R2 and is fetched by id (ARTEFACTS.md §3). The board
 * only ever saw a pointer and a summary, which is what keeps a board with a
 * dozen sheets as cheap to open as one with none.
 */

import { useParams } from "react-router-dom";
import { WorkbookImpl } from "@b32nio/spindle-sheets-core";
import { WorkbookProvider, WorkbookCanvas } from "@b32nio/spindle-sheets-react";
import { useArtefactEditor } from "./useArtefactEditor";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";

/** Everything that changes the workbook. Selection is excluded on purpose. */
const EVENTS = [
  "cellChange", "sheetChange", "sheetAdd", "sheetDelete", "sheetRename", "workbookChange",
] as const;

export function SheetEditor() {
  const { nodeId = "" } = useParams();
  const ed = useArtefactEditor<WorkbookImpl>({
    nodeId,
    build: (id, name) => new WorkbookImpl(id, name),
    events: EVENTS,
  });

  return (
    <ArtefactFrame
      title={ed.title}
      onTitle={ed.setTitle}
      state={ed.state}
      placeholder="Untitled sheet"
      error={ed.error}
      loading={!ed.model}
      dirty={ed.dirty}
      onLeave={ed.flush}
      actions={<ShareMenu nodeId={nodeId} />}
    >
      {/* `WorkbookCanvas` is the whole editor: it renders the toolbar, formula
          bar, grid and sheet tabs, and owns the active cell. Rendering those
          components alongside it gives you two of each. */}
      {(size) => (
        <WorkbookProvider workbook={ed.model!}>
          <WorkbookCanvas width={size.w} height={size.h} />
        </WorkbookProvider>
      )}
    </ArtefactFrame>
  );
}

export default SheetEditor;
