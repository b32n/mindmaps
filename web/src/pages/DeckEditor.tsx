/**
 * The deck editor, on its own route.
 *
 * `SlidesEditor` brings its own header, toolbar, filmstrip and present mode,
 * and it sizes itself from its container rather than from pixel props — so
 * unlike the other two it is handed a style rather than numbers.
 */

import { useParams } from "react-router-dom";
import { DeckImpl } from "@b32nio/spindle-slides-core";
import { DeckProvider, SlidesEditor } from "@b32nio/spindle-slides-react";
import { useArtefactEditor } from "./useArtefactEditor";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";

/** Everything structural. Selection and active-slide are view state, not edits. */
const EVENTS = [
  "deckChange", "themeChange", "slideAdd", "slideDelete", "slideMove", "slideChange",
  "elementAdd", "elementDelete", "elementChange",
] as const;

export function DeckEditor() {
  const { nodeId = "" } = useParams();
  const ed = useArtefactEditor<DeckImpl>({
    nodeId,
    build: (id, name) => new DeckImpl(id, name),
    events: EVENTS,
  });

  return (
    <ArtefactFrame
      title={ed.title}
      onTitle={ed.setTitle}
      state={ed.state}
      placeholder="Untitled deck"
      error={ed.error}
      loading={!ed.model}
      dirty={ed.dirty}
      onLeave={ed.flush}
      actions={<ShareMenu nodeId={nodeId} />}
    >
      {(size) => (
        <DeckProvider deck={ed.model!}>
          <SlidesEditor style={{ width: size.w, height: size.h }} />
        </DeckProvider>
      )}
    </ArtefactFrame>
  );
}

export default DeckEditor;
