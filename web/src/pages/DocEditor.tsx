/**
 * The document editor, on its own route.
 *
 * Same shape as the sheet editor and for the same reason: a paginated document
 * wants the window, and the route is what puts ProseMirror and the layout
 * engine behind a lazy boundary so a board with no documents never loads them.
 */

import { useParams } from "react-router-dom";
import { DocumentImpl } from "@b32nio/spindle-docs-core";
import { DocumentProvider, DocumentEditor as SpindleDocEditor } from "@b32nio/spindle-docs-react";
import { useArtefactEditor } from "./useArtefactEditor";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";

/** Content changes only. `selectionChange` fires on every caret move. */
const EVENTS = [
  "documentChange", "blockChange", "blockAdd", "blockDelete", "pageConfigChange",
] as const;

export function DocEditor() {
  const { nodeId = "" } = useParams();
  const ed = useArtefactEditor<DocumentImpl>({
    nodeId,
    build: (id, name) => new DocumentImpl(id, name),
    events: EVENTS,
  });

  return (
    <ArtefactFrame
      title={ed.title}
      onTitle={ed.setTitle}
      state={ed.state}
      placeholder="Untitled document"
      error={ed.error}
      loading={!ed.model}
      dirty={ed.dirty}
      onLeave={ed.flush}
      actions={<ShareMenu nodeId={nodeId} />}
    >
      {(size) => (
        <DocumentProvider document={ed.model!}>
          <SpindleDocEditor width={size.w} height={size.h} showToolbar showRuler />
        </DocumentProvider>
      )}
    </ArtefactFrame>
  );
}

export default DocEditor;
