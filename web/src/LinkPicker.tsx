import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Board as BoardT } from "./api";

export interface LinkTarget {
  nodeId: string;
  boardId: string;
}

/**
 * What to do with a connection dropped on empty canvas.
 *
 * Dropping a link in open space is unambiguous about intent — you want to
 * connect this card to *something* — and ambiguous only about what. So the
 * popover asks exactly that, and offers the two answers worth having: a card
 * that already exists somewhere, or a new one right here.
 *
 * The existing-card path drills board → card rather than searching. With a
 * handful of mindmaps browsing is faster than recalling a title, and it shows
 * you what is there — which matters when the whole point is finding
 * connections between topics you had not put together.
 */
export function LinkPicker({
  origin,
  sourceTitle,
  currentBoardId,
  linkedIds,
  onPick,
  onCreate,
  onClose,
}: {
  /** where on screen the connection was released */
  origin: { x: number; y: number };
  sourceTitle: string;
  currentBoardId: string;
  /** cards already linked to the source, so we don't offer a duplicate */
  linkedIds: Set<string>;
  onPick: (target: LinkTarget, incoming: boolean) => void;
  onCreate: (incoming: boolean) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"root" | "boards" | "cards">("root");
  const [boards, setBoards] = useState<BoardT[] | null>(null);
  const [board, setBoard] = useState<BoardT | null>(null);
  const [cards, setCards] = useState<Array<{ id: string; title: string; type: string }> | null>(null);
  const [filter, setFilter] = useState("");
  /** false = this card points at the other one; true = the other points here */
  const [incoming, setIncoming] = useState(false);

  const wrap = useRef<HTMLDivElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as HTMLElement)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      // Escape steps back through the drill-down before closing, so a wrong
      // turn costs one key rather than restarting the whole gesture.
      if (step === "cards") setStep("boards");
      else if (step === "boards") setStep("root");
      else onClose();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose, step]);

  useEffect(() => {
    setFilter("");
    if (step !== "root") setTimeout(() => filterBox.current?.focus(), 30);
  }, [step]);

  async function openBoards() {
    setStep("boards");
    if (!boards) setBoards(await api.listBoards().catch(() => []));
  }

  async function openBoard(b: BoardT) {
    setBoard(b);
    setStep("cards");
    setCards(null);
    setCards(await api.boardCards(b.id).catch(() => []));
  }

  const shownBoards = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (boards ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [boards, filter]);

  const shownCards = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (cards ?? []).filter((c) => !q || (c.title || "").toLowerCase().includes(q));
  }, [cards, filter]);

  // Clamped so the popover never opens off the edge of the window.
  const style = {
    left: Math.min(Math.max(origin.x, 12), window.innerWidth - 300),
    top: Math.min(Math.max(origin.y, 12), window.innerHeight - 340),
  };

  return (
    <div className="link-picker" style={style} ref={wrap} role="dialog" aria-label="Link this card">
      <header className="lp-head">
        {step !== "root" && (
          <button
            className="lp-back"
            onClick={() => setStep(step === "cards" ? "boards" : "root")}
            aria-label="Back"
          >
            ‹
          </button>
        )}
        <span className="lp-title">
          {step === "root" && `Link “${sourceTitle || "this card"}”`}
          {step === "boards" && "Choose a mindmap"}
          {step === "cards" && (board?.name ?? "Choose a card")}
        </span>
      </header>

      {/* Direction is set before the target, because it changes what the
          sentence you are building means, not just its arrow. */}
      <div className="lp-dir" role="group" aria-label="Link direction">
        <button
          className={!incoming ? "on" : ""}
          onClick={() => setIncoming(false)}
          title={`${sourceTitle || "This card"} → the other card`}
        >
          → points to
        </button>
        <button
          className={incoming ? "on" : ""}
          onClick={() => setIncoming(true)}
          title={`The other card → ${sourceTitle || "this card"}`}
        >
          ← points here
        </button>
      </div>

      {step === "root" && (
        <div className="lp-list">
          <button className="lp-row" onClick={openBoards}>
            <span className="lp-row-main">Select from a mindmap</span>
            <span className="lp-row-hint">›</span>
          </button>
          <button className="lp-row" onClick={() => onCreate(incoming)}>
            <span className="lp-row-main">Create a card here</span>
            <span className="lp-row-hint">+</span>
          </button>
        </div>
      )}

      {step !== "root" && (
        <input
          ref={filterBox}
          className="lp-filter"
          value={filter}
          placeholder={step === "boards" ? "Filter mindmaps…" : "Filter cards…"}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}

      {step === "boards" && (
        <div className="lp-list">
          {boards === null && <p className="lp-empty">Loading…</p>}
          {boards !== null && !shownBoards.length && <p className="lp-empty">No mindmaps match.</p>}
          {shownBoards.map((b) => (
            <button className="lp-row" key={b.id} onClick={() => void openBoard(b)}>
              <span className="lp-row-main">{b.name}</span>
              {b.id === currentBoardId && <span className="lp-tag">this one</span>}
              <span className="lp-row-hint">›</span>
            </button>
          ))}
        </div>
      )}

      {step === "cards" && (
        <div className="lp-list">
          {cards === null && <p className="lp-empty">Loading…</p>}
          {cards !== null && !shownCards.length && <p className="lp-empty">Nothing on this mindmap.</p>}
          {shownCards.map((c) => {
            const already = linkedIds.has(c.id);
            return (
              <button
                className="lp-row"
                key={c.id}
                disabled={already}
                title={already ? "Already linked" : undefined}
                onClick={() => onPick({ nodeId: c.id, boardId: board!.id }, incoming)}
              >
                <span className="lp-row-main">{c.title || "(untitled)"}</span>
                {already && <span className="lp-tag">linked</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
