/**
 * Every artefact, in one list. Its own view, at /artefacts.
 *
 * A place rather than a dialog, for the same reason a mindmap is: it is
 * somewhere you browse and come back to, so it gets an address, survives a
 * reload, and can be linked to. A modal would have made it a detour from
 * wherever you happened to be.
 *
 * Flat and sorted by when it last changed, rather than grouped by board: the
 * mindmap an artefact sits on is usually the part you have forgotten, which is
 * the whole reason to want this list.
 *
 * It costs no R2 reads — the counts come from `nodes.data`, the same pointer
 * the board renders from.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ArtefactEntry } from "./api";
import { KIND_LABEL, artefactHref, artefactSummary, type ArtefactKind } from "./nodes/artefact";
import { KindIcon } from "./nodes/KindIcon";

const FILTERS: Array<{ key: "all" | ArtefactKind; label: string }> = [
  { key: "all", label: "All" },
  { key: "sheet", label: "Sheets" },
  { key: "doc", label: "Docs" },
  { key: "deck", label: "Decks" },
  { key: "html", label: "Pages" },
  { key: "file", label: "Files" },
  { key: "folder", label: "Folders" },
];

function whenChanged(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ArtefactsView({
  onJump,
}: {
  /** Go to the mindmap an artefact lives on. */
  onJump: (boardId: string) => void;
}) {
  const [items, setItems] = useState<ArtefactEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | ArtefactKind>("all");
  const [query, setQuery] = useState("");
  /** Which column orders the list, and which way. Modified-descending first. */
  const [sort, setSort] = useState<{ by: "name" | "board" | "when"; desc: boolean }>({
    by: "when",
    desc: true,
  });

  const load = useCallback(() => {
    setError(null);
    api
      .artefacts()
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Filtered by title and mindmap name only.
   *
   * This is a jump list, not search. `recall` already reads artefact contents
   * and ranks them properly; duplicating a worse version of that here would
   * teach people to reach for the weaker tool.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (items ?? []).filter(
      (a) =>
        (kind === "all" || a.type === kind) &&
        (!q ||
          (a.title || "").toLowerCase().includes(q) ||
          a.board_name.toLowerCase().includes(q)),
    );

    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((x, y) => {
      if (sort.by === "when") return (x.updated_at - y.updated_at) * dir;
      const a = sort.by === "name" ? x.title || "Untitled" : x.board_name;
      const b = sort.by === "name" ? y.title || "Untitled" : y.board_name;
      // Locale compare so "Éclair" sorts where a reader expects, not by code point.
      return a.localeCompare(b, undefined, { sensitivity: "base" }) * dir;
    });
  }, [items, kind, query, sort]);

  /** Clicking the active column flips it; a new column starts in its natural order. */
  const orderBy = (by: "name" | "board" | "when") =>
    setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === "when" }));

  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of items ?? []) by.set(a.type, (by.get(a.type) ?? 0) + 1);
    return by;
  }, [items]);

  return (
    <div className="arte-view">
      <header className="arte-head">
        <h1>Artefacts</h1>
        <p>Sheets, documents, decks, pages and files across every mindmap.</p>
      </header>

      {error && <p className="trash-error">{error}</p>}

      {items !== null && items.length > 0 && (
        <div className="arte-controls">
          <div className="arte-filters">
            {FILTERS.map((f) => {
              const n = f.key === "all" ? items.length : (counts.get(f.key) ?? 0);
              return (
                <button
                  key={f.key}
                  className={`arte-filter${kind === f.key ? " on" : ""}`}
                  onClick={() => setKind(f.key)}
                  disabled={f.key !== "all" && n === 0}
                >
                  {f.label}
                  <span className="arte-count">{n}</span>
                </button>
              );
            })}
          </div>
          <input
            className="arte-search"
            value={query}
            placeholder="Filter by name or mindmap"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {items === null && <p className="trash-msg">Loading…</p>}

      {items?.length === 0 && (
        <p className="trash-msg">
          No artefacts yet. Add one from the dock on any mindmap, or ask an agent for a
          sheet, a document, a deck or a page.
        </p>
      )}

      {items !== null && items.length > 0 && shown.length === 0 && (
        <p className="trash-msg">Nothing matches that.</p>
      )}

      <div className="arte-table">
        <div className="arte-head-row">
          {([
            ["name", "Name"],
            ["board", "Mindmap"],
            ["when", "Modified"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={`arte-col${sort.by === key ? " on" : ""}`}
              onClick={() => orderBy(key)}
            >
              {label}
              <span className="arte-caret">{sort.by === key ? (sort.desc ? "▾" : "▴") : ""}</span>
            </button>
          ))}
          {/* Not sortable: a cell count and a word count are different units, so
              ordering across kinds would compare things that are not comparable. */}
          <span className="arte-col static">Details</span>
        </div>

        <ul className="arte-rows">
          {shown.map((a) => (
            /* The row is the link, but the mindmap cell inside it is its own
               control. A <button> cannot live inside an <a>, so the anchor
               stretches over the row with ::after and the button sits above. */
            <li key={a.id} className={`arte-tr ${a.type}`}>
              <a
                className="arte-name"
                href={artefactHref(a.type, a.id, a.board_id)}
                target="_blank"
                rel="noopener"
              >
                <span className="arte-icon">
                  <KindIcon kind={a.type} size={16} />
                </span>
                <span className="arte-label">{a.title || "Untitled"}</span>
              </a>
              <button
                className="arte-where"
                onClick={() => onJump(a.board_id)}
                title={`Go to ${a.board_name}`}
              >
                {a.board_name}
              </button>
              <span className="arte-when">{whenChanged(a.updated_at)}</span>
              <span className="arte-detail">{artefactSummary(a.type, a.data)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
