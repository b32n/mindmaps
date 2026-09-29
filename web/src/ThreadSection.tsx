import { useEffect, useRef, useState } from "react";
import { api, type BoardNode } from "./api";

/**
 * The card's Claude thread, living at the bottom of the card detail panel
 * rather than in a surface of its own.
 *
 * One session per card, resumed forever — sessions are event-sourced server
 * side, so continuing is just another user message. Collapsed by default so
 * the document stays the focus.
 */
export function ThreadSection({ node }: { node: BoardNode }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(node.thread ?? null);
  const [text, setText] = useState("");
  const [outputs, setOutputs] = useState<{ id: string; filename: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setText("");
    setOutputs([]);
    setError(null);
    setStatus(node.thread ?? null);
    setOpen(false);
  }, [node.id]);

  useEffect(() => {
    if (!open) return;
    api
      .researchStatus(node.id)
      .then((s) => {
        setStatus(s.session?.status ?? null);
        setText(s.text);
        setOutputs(s.outputs ?? []);
      })
      .catch((e) => setError(e.message));
  }, [open, node.id]);

  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    [],
  );

  async function send() {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.research(node.id, draft);
      setDraft("");
      setStatus("running");
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const s = await api.researchStatus(node.id).catch(() => null);
        if (!s) return;
        setStatus(s.session?.status ?? null);
        if (s.text) setText(s.text);
        if (s.session?.status === "idle" || s.session?.status === "terminated") {
          setOutputs(s.outputs ?? []);
          if (poll.current) clearInterval(poll.current);
          setBusy(false);
        }
      }, 3000);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className={`thread-sec ${open ? "open" : ""}`}>
      <button className="thread-toggle" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"} Research thread</span>
        {status && <span className={`chip thread ${status}`}>{status}</span>}
      </button>

      {open && (
        <div className="thread-inner">
          {text ? (
            <div className="thread-text">{text}</div>
          ) : (
            <p className="thread-empty">
              Runs in a remote Claude session with this workstream's repos
              mounted read&#8209;only. It is durable: every later question resumes
              the same session.
            </p>
          )}

          {outputs.length > 0 && (
            <div className="thread-files">
              {outputs.map((f) => (
                <div key={f.id} className="thread-file">
                  {f.filename}
                </div>
              ))}
            </div>
          )}

          {error && <div className="thread-error">{error}</div>}

          <div className="thread-compose">
            <textarea
              value={draft}
              placeholder="Ask Claude to trace, compare, summarise…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <button onClick={send} disabled={busy || !draft.trim()}>
              {busy ? "Running…" : text ? "Continue ⌘⏎" : "Start thread ⌘⏎"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
