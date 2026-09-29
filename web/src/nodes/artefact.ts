/**
 * Where an artefact opens.
 *
 * Artefacts always open in a new tab, never in place. A sheet, a document or a
 * deck is a thing you work in for a while, and the board is the thing you came
 * from and will want back: replacing the board with a spreadsheet throws away
 * the canvas position, the open card and the scroll you had, and "back" is a
 * poor substitute for the tab still being there.
 *
 * One helper so the rule is stated once rather than re-decided per node type.
 */

/** Node types that open on their own route. */
export type ArtefactKind = "sheet" | "doc" | "deck" | "html" | "file" | "folder";

const ROUTE: Record<ArtefactKind, string> = {
  sheet: "sheet",
  doc: "doc",
  deck: "deck",
  html: "page",
  // Both kinds open the same view. A folder is a list of files and a file is a
  // list of one, and splitting that into two pages would mean two upload
  // paths, two download paths and two places to fix anything.
  file: "file",
  folder: "file",
};

export const isArtefactKind = (t: string): t is ArtefactKind => t in ROUTE;

/**
 * Every artefact kind, derived rather than restated.
 *
 * The board's `nodeTypes` map is built from this. Listing the kinds there by
 * hand is how `html` shipped as an unstyled default React Flow node: the route,
 * the icon and the dock button were all wired up, and the one place that maps a
 * node type to a component was missed. An unknown type does not throw, it
 * silently renders an empty box.
 */
export const ARTEFACT_KINDS = Object.keys(ROUTE) as ArtefactKind[];

/**
 * How each kind presents itself on the board.
 *
 * The summary line reads from `nodes.data`, whose counts differ by kind: a
 * sheet counts cells, a document counts words, a deck counts slides. Each is
 * the number a person would actually use to recognise the thing.
 */
export const KIND_LABEL: Record<ArtefactKind, string> = {
  sheet: "Sheet",
  doc: "Doc",
  deck: "Deck",
  html: "Page",
  file: "File",
  folder: "Folder",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function artefactSummary(kind: ArtefactKind, data: Record<string, unknown>): string {
  const n = (k: string) => Number(data?.[k] ?? 0);
  if (kind === "doc") return plural(n("words"), "word");
  if (kind === "deck") return plural(n("slides"), "slide");
  if (kind === "file" || kind === "folder") {
    const bytes = n("bytes");
    const size =
      bytes >= 1_000_000
        ? `${(bytes / 1_000_000).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1000))} kB`;
    // A single file is recognised by its name, a folder by how much is in it.
    // Showing "1 file" for something called `q3-model.xlsx` is the least
    // useful true thing we could say.
    if (kind === "file")
      return data?.name ? `${String(data.name)} · ${size}` : "Empty";
    const count = n("files");
    return count ? `${plural(count, "file")} · ${size}` : "Empty";
  }
  if (kind === "html") {
    const kb = Math.max(1, Math.round(n("bytes") / 1000));
    // Whether it runs code is worth knowing before you open it, in a way that
    // "3 kB" on its own is not.
    return data?.scripted ? `${kb} kB · interactive` : `${kb} kB`;
  }
  return `${plural(n("sheets"), "sheet")} · ${plural(n("cells"), "cell")}`;
}

export const artefactHref = (kind: ArtefactKind, nodeId: string, boardId: string) =>
  `/${ROUTE[kind]}/${nodeId}?from=${boardId}`;

/**
 * Open from a handler rather than a click on the link itself.
 *
 * `noopener` because the new tab has no business reaching back into this one,
 * and leaving it off hands it a live `window.opener` reference.
 */
export const openArtefact = (kind: ArtefactKind, nodeId: string, boardId: string) => {
  window.open(artefactHref(kind, nodeId, boardId), "_blank", "noopener");
};
