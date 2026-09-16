/**
 * The landing page.
 *
 * Two framings were wrong before this one. "A canvas of cards that hold real
 * documents" described a whiteboard, which every whiteboard also says. "Memory
 * for your agent" was closer but still half the product, because it implies the
 * memory is infrastructure, something that works whether or not you ever look
 * at it.
 *
 * The actual reason this exists: agent memory is normally a black box.
 * Embeddings in a store, queryable by the machine and invisible to you. You
 * cannot check what it knows, correct it, or think with it. A mindmap is
 * legible to both, so the memory takes the shape of how a person already
 * thinks, and that is the headline.
 */

import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { ConnectPanel, LandingFooter, LandingNav, MemorySnippet, Reveal } from "./landing/Chrome";
import { HeroBoard } from "./landing/HeroBoard";
import "../styles/landing.css";

const beats = [
  {
    n: "01",
    h: "The session ends",
    p: "Your agent traced four services and found the race. Then the context window closed and took all of it with it.",
  },
  {
    n: "02",
    h: "So you bolt on memory",
    p: "Now it's embeddings in a database. The machine can query them. You can't read them. When it remembers something wrong, there's nothing to open and no way to fix it.",
  },
  {
    n: "03",
    h: "Give it a shape instead",
    p: "Your agent writes cards and links over MCP. You open the board and see what it knows. Drag things around until the map matches how you actually think about the problem.",
  },
];

const features = [
  {
    icon: "eye",
    h: "You can see all of it",
    p: "Everything your agent writes lands on a canvas you can open, drag, edit or throw away. A card stays one line until you click it. Then it's a full document with its own board underneath.",
  },
  {
    icon: "search",
    h: "Recall, not search",
    p: "Ask the way you'd ask a colleague. “Who owns this?” finds the card that says nobody has picked it up, because it ranks wording, meaning and the links between cards together.",
  },
  {
    icon: "link",
    h: "Links carry a verb",
    p: "blocks, supersedes, explains. Which way the arrow points is part of what you're saying. And a card connected to another match ranks higher, because being next to the answer is a clue.",
  },
  {
    icon: "clock",
    h: "Old thinking sinks",
    p: "Supersede a card and it drops down the results with a mark on it. Nothing gets deleted. How you got to a wrong answer is usually why you came back.",
  },
  {
    icon: "check",
    h: "Re-runs converge",
    p: "Write the same thing twice and the second one updates the first. Memory that gets worse every time you add to it isn't memory.",
  },
  {
    icon: "share",
    h: "Every harness, one brain",
    p: "Claude Code at work, Codex on the laptop, Cursor when you want an editor. They all sign in to the same account and read the same boards. What one of them figures out, the next one already knows.",
  },
  {
    icon: "lock",
    h: "We run no agents",
    p: "Your harness is the agent and it bills to your own subscription. This side only stores, indexes and ranks. Revoke any harness from Settings without touching the others.",
  },
];

const icons: Record<string, React.ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  link: (
    <>
      <rect x="1.5" y="2.6" width="6" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.5" y="8.8" width="6" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 5.6h2.4a1.6 1.6 0 0 1 1.6 1.6v1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path d="M1.4 8s2.5-4.2 6.6-4.2S14.6 8 14.6 8s-2.5 4.2-6.6 4.2S1.4 8 1.4 8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="m5.4 8.2 1.9 1.9 3.5-3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  lock: (
    <>
      <rect x="2.8" y="7" width="10.4" height="7" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // Three nodes converging on one, which is the multi-harness point exactly.
  share: (
    <>
      <circle cx="3.4" cy="3.4" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="3.4" cy="12.6" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.6" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.1 4.4 10.9 7m-5.8 4.6L10.9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
};

export function HomePage() {
  const { user } = useAuth();

  return (
    <div className="lp">
      <LandingNav />

      <section className="lp-hero">
        <div className="lp-wrap lp-hero-grid">
          <div>
            <span className="lp-eyebrow">
              <span className="lp-eyebrow-dot" />
              One brain for you and every harness you use
            </span>
            <h1 className="lp-h1">
              Memory for your agent. <em>And for you.</em>
            </h1>
            <p className="lp-lede">
              Most agent memory is a vector store. The machine can query it, you can't read
              it. This is a mindmap instead: cards that hold real documents, joined by links
              you label yourself. Every harness you use reads and writes the same one over
              MCP. So do you.
            </p>
            <div className="lp-actions">
              <Link className="lp-btn lp-btn-primary lp-btn-lg" to={user ? "/app" : "/register"}>
                {user ? "Open your boards" : "Start a mindmap"}
              </Link>
              <Link className="lp-btn lp-btn-ghost lp-btn-lg" to="/brain">
                How the brain works
              </Link>
            </div>
            <ConnectPanel note="No API key. Every harness signs in to the same account and shares the same boards." />
          </div>
          <HeroBoard />
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <Reveal className="lp-section-head">
            <p className="lp-kicker">The problem</p>
            <h2 className="lp-h2">Memory you can't look at isn't yours.</h2>
            <p className="lp-sub">
              Agents are good at working something out and bad at keeping it. The usual fix
              hides what they kept. If you can't see what your agent believes, you can't
              correct it, trust it, or build on it.
            </p>
          </Reveal>
          <Reveal delay={80}>
            <div className="lp-beats">
              {beats.map((b) => (
                <div className="lp-beat" key={b.n}>
                  <span className="lp-beat-n">{b.n}</span>
                  <h3>{b.h}</h3>
                  <p>{b.p}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <Reveal className="lp-section-head">
            <p className="lp-kicker">What you get</p>
            <h2 className="lp-h2">A memory with a shape.</h2>
            <p className="lp-sub">
              One surface. A person can read it, a machine can query it.{" "}
              <Link to="/brain" style={{ color: "var(--lp-accent)" }}>See how the brain works →</Link>
            </p>
          </Reveal>
          <div className="lp-cards">
            {features.map((f, i) => (
              <Reveal key={f.h} delay={i * 60} className="lp-card">
                <div className="lp-card-icon">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    {icons[f.icon]}
                  </svg>
                </div>
                <h3>{f.h}</h3>
                <p>{f.p}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <Reveal className="lp-section-head">
            <p className="lp-kicker">Make it a habit</p>
            <h2 className="lp-h2">Two minutes, then you stop thinking about it.</h2>
            <p className="lp-sub">
              Connecting the server gives your agent the tools. It doesn't make it reach for
              them. Paste this into the instructions file your harness already reads and it
              starts checking what it knows before it works, and writing things down when it
              finishes.
            </p>
          </Reveal>
          <Reveal delay={80}>
            <div style={{ maxWidth: 720 }}>
              <MemorySnippet note="Same text everywhere. Only the file changes." />
            </div>
          </Reveal>
        </div>
      </section>

      <section className="lp-cta">
        <h2>See what your agent knows.</h2>
        <p>Free to start. One command to connect your harness.</p>
        <div className="lp-actions">
          <Link className="lp-btn lp-btn-primary lp-btn-lg" to={user ? "/app" : "/register"}>
            {user ? "Open your boards" : "Start a mindmap"}
          </Link>
          <Link className="lp-btn lp-btn-ghost lp-btn-lg" to="/brain">
            The brain
          </Link>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
