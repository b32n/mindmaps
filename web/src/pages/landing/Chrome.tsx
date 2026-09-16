/**
 * Shared furniture for the public pages.
 *
 * Kept apart from the app's chrome deliberately: `tokens.css` is tuned to
 * recede behind a board's contents, and a landing page needs the opposite.
 * Everything here is scoped under `.lp`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../AuthContext";

/** The mark: two cards and the link between them, which is the whole product. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="lp-brand-mark"
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <rect x="0.75" y="2.75" width="6.5" height="5" rx="1.75" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.75" y="10.25" width="6.5" height="5" rx="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.25 6.4h3.1a1.9 1.9 0 0 1 1.9 1.9v1.95" stroke="var(--lp-accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function LandingNav() {
  const { user } = useAuth();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`lp-nav${stuck ? " stuck" : ""}`}>
      <div className="lp-nav-inner">
        <Link className="lp-brand" to="/">
          <BrandMark />
          mindmaps
        </Link>
        <div className="lp-nav-links">
          {/* Dropped on narrow screens: the hero carries its own link to the
              brain page, so this is the one item that can go. Sign in has no
              such duplicate and stays. */}
          <Link className="lp-nav-secondary" to="/brain">
            The brain
          </Link>
          {user ? (
            <Link className="lp-btn lp-btn-primary" to="/app">
              Open
            </Link>
          ) : (
            <>
              <Link to="/login">Sign in</Link>
              <Link className="lp-btn lp-btn-primary" to="/register">
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function LandingFooter() {
  return (
    <footer className="lp-foot">
      <span>mindmaps · a memory you and your agents share</span>
      <nav>
        <Link to="/brain">The brain</Link>
        <a href="https://github.com/anthropics/claude-code" target="_blank" rel="noreferrer noopener">
          MCP
        </a>
        <Link to="/register">Get started</Link>
      </nav>
    </footer>
  );
}

interface CodeTab {
  label: string;
  /** The file or place this goes, shown above the body. */
  where: string;
  /** Prefix the body with a shell prompt. */
  shell?: boolean;
  body: string;
}

/**
 * A tabbed code block with a copy button.
 *
 * Shared by the connect instructions and the memory snippet, because both
 * answer the same question in four dialects and a reader should not have to
 * learn two layouts to get through setup.
 */
function CodeTabs({ tabs, note }: { tabs: CodeTab[]; note?: string }) {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = tabs[tab];

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // A copy confirmation left over from the previous tab would be a lie about
  // this one.
  useEffect(() => setCopied(false), [tab]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(active.body);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embeds. The
      // text is selectable either way, so failing quietly is honest. A "copy
      // failed" toast would be noise about something already possible.
    }
  };

  return (
    <div className="lp-term">
      <div className="lp-term-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            role="tab"
            type="button"
            aria-selected={i === tab}
            className={`lp-term-tab${i === tab ? " on" : ""}`}
            onClick={() => setTab(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="lp-term-bar">
        <span className="lp-term-label">{active.where}</span>
        <button className={`lp-term-copy${copied ? " done" : ""}`} onClick={copy} type="button">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="lp-term-body">
        <pre>
          {active.shell && <span className="p">$ </span>}
          <span className="c">{active.body}</span>
        </pre>
        {note && <span className="lp-term-note">{note}</span>}
      </div>
    </div>
  );
}

/**
 * Connect instructions, one tab per harness.
 *
 * Four tabs rather than one command, because the same account can hold tokens
 * for several harnesses at once and sharing one brain between them is the
 * point. Anyone arriving from a tool that is not Claude Code should not have to
 * translate.
 *
 * All four are the same endpoint with no API key, since auth is OAuth. The
 * server is plain streamable HTTP MCP, so the last tab is a real answer rather
 * than a shrug.
 */
export function ConnectPanel({ note }: { note?: string }) {
  // Read at render rather than hardcoded, so a local or preview deploy shows
  // the endpoint that actually works there.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/mcp`;

  return (
    <CodeTabs
      note={note}
      tabs={[
        {
          label: "Claude Code",
          where: "your terminal",
          shell: true,
          body: `claude mcp add --transport http mindmaps ${url}`,
        },
        {
          label: "Codex",
          where: "your terminal",
          shell: true,
          body: `codex mcp add mindmaps --url ${url}`,
        },
        {
          label: "Cursor",
          where: "~/.cursor/mcp.json",
          body: `{\n  "mcpServers": {\n    "mindmaps": { "url": "${url}" }\n  }\n}`,
        },
        { label: "Anything else", where: "streamable HTTP MCP endpoint", body: url },
      ]}
    />
  );
}

/**
 * The habit, as a snippet for whichever instruction file a harness reads.
 *
 * Connecting the server only makes the tools available. It does not make an
 * agent reach for them, and the `instructions` the server sends on initialize
 * are advisory: harnesses differ on whether they inject them and models differ
 * on whether they act. A line in the user's own instruction file outranks all
 * of that, so this is the part that turns "it can remember" into "it does".
 *
 * Same text every tab. Only the destination changes, which is the whole reason
 * the tabs exist: nobody should have to work out where their tool keeps this.
 */
const MEMORY_SNIPPET = `## Memory

You have a persistent memory called mindmaps, connected over MCP. It outlives this session.

- Before starting anything non-trivial, call \`recall\` with what you are about to work on. Do it before reading files.
- When you finish something that took real digging, write it down with \`add_to_mindmap\` or \`add_card\`, and pass a stable \`key\` so running it again updates what is there instead of leaving a duplicate.
- Put it somewhere sensible. \`recall\` tells you which mindmap each match came from, so extend that one. If nothing matched, check \`list_mindmaps\` for a home before making a new one.
- Only use \`create_mindmap\` for a genuinely new subject, not for every new fact. A mindmap is something you will come back to over weeks. A card is one thing you learned. When unsure, add a card to a mindmap that already exists.
- Link what you write to whatever \`recall\` returned, using \`link_cards\` and a verb: blocks, explains, supersedes. Links can cross mindmaps.`;

export function MemorySnippet({ note }: { note?: string }) {
  return (
    <CodeTabs
      note={note}
      tabs={[
        { label: "Claude Code", where: "~/.claude/CLAUDE.md", body: MEMORY_SNIPPET },
        { label: "Codex", where: "~/.codex/AGENTS.md", body: MEMORY_SNIPPET },
        { label: "Cursor", where: "Settings → Rules → User Rules", body: MEMORY_SNIPPET },
        { label: "Anything else", where: "AGENTS.md, in your repo root", body: MEMORY_SNIPPET },
      ]}
    />
  );
}

/**
 * Fade a section in once, when it first reaches the viewport.
 *
 * `once` matters: re-animating on every scroll past is the thing that makes
 * scroll effects feel cheap. Reduced-motion users get no transition at all —
 * the CSS only hides `.lp-reveal` inside a no-preference query, so if the
 * observer never runs the content is still visible.
 */
export function Reveal({
  children,
  delay = 0,
  as = "div",
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  /** Deliberately two tags, not `keyof JSX.IntrinsicElements`: the open union
   *  produces a props type large enough that TypeScript gives up on it
   *  (TS2590). These are the only two this page needs. */
  as?: "div" | "section";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // `armed` is only set once we know we can observe, so the default render is
  // fully visible. `seen` then fades it in.
  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    // Already on screen at mount — the hero and whatever sits under it. Fading
    // those in means a visible flash on first paint for no benefit.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.88) return;

    setArmed(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);

    // Belt and braces: if the observer somehow never fires, show it anyway.
    // Content that stays hidden is a far worse bug than a missing animation.
    const failsafe = setTimeout(() => setSeen(true), 3000);
    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);

  const props = {
    ref,
    className: `lp-reveal${armed ? " armed" : ""}${seen ? " in" : ""}${className ? ` ${className}` : ""}`,
    style: { transitionDelay: `${delay}ms` },
  };
  return as === "section" ? <section {...props}>{children}</section> : <div {...props}>{children}</div>;
}
