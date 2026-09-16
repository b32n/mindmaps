/**
 * /brain: how the memory actually works.
 *
 * Written for someone who has built retrieval before and wants to know whether
 * this one is serious. Every constant on this page is the constant in the
 * worker; every claim maps to code. Where something is missing or unproven it
 * says so, because a page like this is only worth reading if the weaknesses are
 * on it too. Anyone evaluating it seriously finds them in ten minutes anyway.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ConnectPanel, LandingFooter, LandingNav, MemorySnippet, Reveal } from "./landing/Chrome";
import "../styles/landing.css";

const sections = [
  { id: "visible", label: "Nothing is hidden" },
  { id: "store", label: "What is stored" },
  { id: "pipeline", label: "Retrieval" },
  { id: "fusion", label: "Why rank fusion" },
  { id: "chunking", label: "Chunking" },
  { id: "freshness", label: "Write visibility" },
  { id: "graph", label: "The graph" },
  { id: "decay", label: "Supersession" },
  { id: "converge", label: "Convergence" },
  { id: "compare", label: "Versus" },
  { id: "gaps", label: "What's missing" },
  { id: "tools", label: "Tool surface" },
  { id: "harnesses", label: "Every harness" },
  { id: "trust", label: "Isolation" },
];

/** Every label padded to 28 columns so the connectors form one vertical line. */
const PIPELINE = `strict keyword (every term) ─┐
loose keyword (any term)    ─┤
meaning (passage vectors)   ─┼─▶  fuse by rank  ─▶  rerank  ─▶  answer
graph adjacency             ─┤
recency                     ─┘`;

const retrievalSpec: Array<[string, string]> = [
  ["Lexical index", "SQLite FTS5, porter + unicode61"],
  ["Lexical scoring", "bm25, title weighted 6.0 : body 1.0"],
  ["Embedding model", "@cf/baai/bge-m3, 1024-dim"],
  ["Vector metric", "cosine"],
  ["Vector unit", "passage, not document"],
  ["Fusion", "RRF, k = 60"],
  ["List weights", "strict 1.0 · loose 0.5 · dense 1.0 · graph 0.5 · recency 0.25"],
  ["Supersession", "× 0.3 on the fused score"],
  ["Reranker", "@cf/baai/bge-reranker-base, cross-encoder"],
  ["Rerank depth", "24 candidates → 8 returned"],
];

const chunkSpec: Array<[string, string]> = [
  ["Target passage", "900 characters"],
  ["Hard ceiling", "1,400 characters"],
  ["Seam overlap", "150 characters"],
  ["Minimum passage", "250 characters (merged upward)"],
  ["Split order", "paragraph → sentence → line → offset"],
  ["Per-card cap", "64 passages"],
  ["Vector id", "<node_id>#<ord>"],
];

const tools: Array<[string, string]> = [
  ["recall", "Hybrid retrieval, graph expansion and a ranked briefing in one call."],
  ["search", "Lexical search across every mindmap, bm25-ranked."],
  ["get_context", "Breadth-first walk outward from a card, depth 0–2, across mindmaps."],
  ["list_mindmaps", "Names, card counts, ids."],
  ["get_mindmap", "A whole map as markdown, with ids and checklist state."],
  ["get_card", "One card's full document."],
  ["create_mindmap", "A graph of cards and labelled links. Layout is worked out for you."],
  ["add_to_mindmap", "Extend a map. New cards land below what is already there."],
  ["add_card", "One card, with an optional stable key."],
  ["update_card", "Replace title and/or document."],
  ["append_to_card", "Append without discarding the existing document."],
  ["link_cards", "Directed labelled edge, within or across mindmaps."],
  ["update_link", "Change a label or which handles an edge attaches to."],
  ["unlink_cards", "Remove an edge by id or by the pair it joins."],
  ["relayout_mindmap", "Re-run layout right or down, re-attaching every edge."],
];

const COLUMNS = ["Vector memory", "Extracted graph", "Notes + search", "This"] as const;

/** Rows are [dimension, ...one cell per COLUMNS entry]. */
const comparison: Array<[string, string, string, string, string]> = [
  [
    "Retrieval",
    "Dense top-k only. Misses anything related to your question but worded differently.",
    "Dense over LLM-written community summaries.",
    "Lexical search, sometimes with embeddings bolted on.",
    "Five signals fused by rank, then a cross-encoder re-reads the finalists.",
  ],
  [
    "Graph",
    "None. Chunks are independent.",
    "An LLM guesses it at index time. Costly, and it drifts from what you meant.",
    "Backlinks, unlabelled and unranked.",
    "Authored by you and your agent. Labelled, directed, and used as a ranking signal.",
  ],
  [
    "Inspectable",
    "No. Vectors are not readable.",
    "Partly. You can read the summaries, not the extraction.",
    "Yes, but nothing is writing to it for you.",
    "Fully. The graph is the interface. Vectors are built from it and disposable.",
  ],
  [
    "Repeat writes",
    "Near-duplicates pile up. Every re-run makes recall worse.",
    "Re-index the corpus.",
    "Manual dedup.",
    "Give it a stable key and the second write updates the first.",
  ],
  [
    "Stale knowledge",
    "No concept of it.",
    "No concept of it.",
    "Archive or delete.",
    "Superseded cards are demoted and marked, never deleted.",
  ],
  [
    "Failure honesty",
    "Empty result, no reason.",
    "Empty result, no reason.",
    "Empty result.",
    "Tells you whether nothing matched or it couldn't reach the index.",
  ],
  [
    "Inference cost",
    "Embeddings.",
    "An LLM summarises the whole corpus at index time.",
    "None to some.",
    "Embeddings plus a 100M-parameter reranker. No LLM in the loop.",
  ],
];

/** Highlight the rail entry for whichever section is currently in view. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        // First visible in document order, so scrolling up and down agree.
        const first = ids.find((id) => seen.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-88px 0px -55% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function Spec({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="lp-spec">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function S({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Reveal as="section">
      <div id={id} style={{ scrollMarginTop: 92 }}>
        {children}
      </div>
    </Reveal>
  );
}

export function BrainPage() {
  const active = useActiveSection(sections.map((s) => s.id));

  return (
    <div className="lp">
      <LandingNav />

      <section className="lp-hero" style={{ paddingBottom: 24 }}>
        <div className="lp-wrap">
          <span className="lp-eyebrow">
            <span className="lp-eyebrow-dot" />
            The brain
          </span>
          <h1 className="lp-h1" style={{ maxWidth: "20ch" }}>
            A memory <em>both of you</em> can read.
          </h1>
          <p className="lp-lede">
            Storing text is easy. The hard part is handing back the right passage a month
            later, when you've forgotten the words you used. Being able to see what got
            stored is how you know it worked. Here's the whole design, including the parts
            that aren't finished.
          </p>
        </div>
      </section>

      <section className="lp-section" style={{ paddingTop: 40 }}>
        <div className="lp-wrap lp-split">
          <nav className="lp-rail">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className={active === s.id ? "on" : ""}>
                {s.label}
              </a>
            ))}
          </nav>

          <div className="lp-prose">
            <S id="visible">
              <h2>Nothing is stored where you can't look</h2>
              <p>
                Ask most agent memory what it knows and you get an answer, not a view. What
                it actually holds is embeddings: a machine can fetch them, a person can't read
                them. That works fine while it's right. The moment it's wrong there's nothing
                to open and nowhere to make the correction.
              </p>
              <p>
                Here there's nothing behind the curtain. The cards and links in SQLite are
                the record. The search index and the vectors are{" "}
                <strong>built from them</strong>, rebuilt whenever a card changes, and safe to
                throw away. Delete the vector index and you lose ranking quality. You don't
                lose anything you wrote.
              </p>
              <p>
                Which flips the usual trust problem. You don't have to take a retrieval score
                on faith. You open the board and read it.
              </p>
            </S>

            <S id="store">
              <h2>What is stored</h2>
              <p>
                A card is one row: a title, a BlockNote document, a position, and a markdown
                copy rebuilt on every write. Blocks are the real version. Markdown loses
                nesting, colour and image settings, so saving through it would chip away at a
                document every time. But blocks are useless to anything that isn't the editor,
                which is what the markdown copy is for. It feeds search, the MCP replies, the
                card preview and the embedding input, and it's your export if you ever leave.
              </p>
              <p>
                Links are rows too, with a label, a direction, and which side of each card
                they attach to. Both ends cascade on delete, so removing a card can't leave a
                link pointing at nothing. That holds even for links that cross to another
                mindmap.
              </p>
            </S>

            <S id="pipeline">
              <h2>Retrieval: five signals, then a cross-encoder</h2>
              <p>
                One <code>recall</code> call runs all of this. Five retrievers each hand back
                a ranked list, the lists get merged by position, and a cross-encoder reads the
                finalists against your question before you see anything.
              </p>
              <pre className="lp-pipe">{PIPELINE}</pre>
              <Spec rows={retrievalSpec} />
              <p>
                Keyword search runs twice, not once. One pass wants every term, the other
                wants any of them, and they stay separate lists. Matching all five words you
                typed means something different from matching two, and merging the passes
                would throw that away. Title counts six times as much as body, because a card
                whose <em>title</em> is your question is nearly always the one you wanted.
              </p>
              <p>
                Links and recency are lists too, not bonuses bolted on at the end. A card
                sitting next to another match is a clue. A card nobody has touched in three
                months is a weak one. Making both of them rankings means they get weighed the
                same way as everything else, instead of through numbers somebody picked by
                hand.
              </p>
              <p>
                The reranker goes last because it's the slow one. Everything before it judges
                your question and a card without ever looking at the two side by side. Keyword
                search counts words. Vector search compares two numbers that were worked out
                separately, neither knowing the other existed. A cross-encoder actually reads
                the question and the passage together. That's a much better judgement and far
                too slow to run over everything you own. Over 24 candidates it's one call.
              </p>
            </S>

            <S id="fusion">
              <h2>Why rank fusion, not weighted scores</h2>
              <p>
                Keyword scores have no upper limit and shift as the corpus grows. Vector
                scores sit between 0 and 1. To add them you need multipliers, and the only
                thing backing those numbers is that the results looked fine on whichever
                queries somebody tried. They quietly stop being right when you add cards.
                Changing the embedding model breaks them outright.
              </p>
              <p>
                Reciprocal Rank Fusion uses only each retriever's ordering:
              </p>
              <pre className="lp-pipe">{`score(card) = Σ  weight_i / (60 + rank_i)`}</pre>
              <p>
                Now the units don't matter, only the order. A card that three retrievers all
                put in the middle beats one that a single retriever loves. That's what you
                want when each retriever is wrong in its own way.
              </p>
              <p>
                Superseded cards get <strong>multiplied</strong> down rather than having
                points taken off, for the same reason. Merged scores all land between about
                0.02 and 0.05. Subtract a fixed amount and it either does nothing or wipes the
                card out, depending on how many retrievers happened to agree.
              </p>
            </S>

            <S id="chunking">
              <h2>Chunking on structure, not offsets</h2>
              <p>
                A long card isn't about one thing, so it doesn't get one vector. Cards get
                split along their own structure, and every passage is embedded with the card's
                title stuck on the front. That way <code>it caches for 15 minutes</code> still
                knows it belongs to <code>Token refresh</code>.
              </p>
              <Spec rows={chunkSpec} />
              <p>
                The minimum size matters more than it looks. A heading followed by a long
                block used to come out as its own ten-character passage, which is a vector
                that says almost nothing while still taking up a result slot. Anything that
                small now gets folded into its neighbour.
              </p>
              <p>
                Search scores passages but hands back cards, using each card's{" "}
                <strong>best</strong> passage rather than adding them up. Adding them up just
                rewards long cards for having more chances to match. You're shown the passage
                that won, so a running log stays findable by its latest entry instead of
                whatever it opened with a year ago.
              </p>
            </S>

            <S id="freshness">
              <h2>A write is visible immediately</h2>
              <p>
                The vector index doesn't update instantly. Writes queue up first, and
                Cloudflare quotes a median under 30 seconds with a worst case near two
                minutes. There's no way to make it wait. For a memory that's a real problem,
                because the way people use this is: write down what you just learned, keep
                working, then ask what you know. That all happens inside one session, minutes
                apart, right in the window where the index still has the old answer.
              </p>
              <p>
                So recent writes don't go through it at all. Every passage vector is also
                kept next to its card, and a query runs two passes at once: the approximate
                search over everything, plus an exact scan of anything written in the last ten
                minutes. Same measure, same scale, so they merge with no fiddling. When both
                have an opinion the fresh one wins, because the index is still describing what
                the passage used to say.
              </p>
              <p>
                Scanning everything is the right call here only because the ten-minute window
                keeps it tiny. Clever indexes pay off across a whole library, not across the
                handful of things you wrote since lunch. It also means losing the vector index
                only costs you ranking quality on older cards. The vectors can be pushed back
                in from SQLite without paying for the embeddings again.
              </p>
            </S>

            <S id="graph">
              <h2>Edges are claims</h2>
              <p>
                <code>blocks</code> isn't <code>related to</code>, and it doesn't mean the
                same thing backwards. Links carry a verb and a direction, they can run between
                two different mindmaps, and <code>recall</code> follows them. Matches come back
                with what they connect to and how, including boards you'd never have thought to
                check.
              </p>
              <p>
                This is where it splits from knowledge graphs an LLM builds for you. Those
                get guessed at index time, cost a model call per document, and slide away from
                what the author actually meant. These get written. By you, when you drag a
                link. By your agent, when it records something it just worked out. Nothing
                invents structure that nobody claimed.
              </p>
            </S>

            <S id="decay">
              <h2>Knowledge gets old, and the ranking knows</h2>
              <p>
                Supersede a card and it doesn't disappear. It drops down the results and
                carries a <code>⊘ superseded</code> mark wherever it shows up. The thinking
                that led somewhere wrong is usually what you came back for. A memory that
                deletes its own history can't tell you why you changed your mind.
              </p>
              <p>
                That demotion gets applied again <em>after</em> reranking. The cross-encoder
                only judges whether a passage answers your question. It has no idea the card
                was replaced, so a superseded card that answers perfectly would otherwise walk
                straight back to the top.
              </p>
            </S>

            <S id="converge">
              <h2>Writing the same thing twice converges</h2>
              <p>
                This is the failure that quietly kills agent memory. Run “summarise what we
                learned” three times and most systems end up holding three overlapping copies,
                each one making search a little worse. Using the thing as intended is what
                breaks it.
              </p>
              <p>
                Cards and mindmaps can carry a stable key, unique per account for maps and
                per board for cards. Write again with the same key and it updates what's there.
                Positions you arranged by hand survive. Cards the later run left out are kept,
                not deleted. Keys are optional, and any number of cards can go without one and
                behave exactly as they did before.
              </p>
            </S>

            <S id="compare">
              <h2>How this differs</h2>
              <p>
                Against the three shapes most memory takes today: a vector store full of
                chunks, a knowledge graph an LLM extracted for you, and a notes app with
                search bolted on.
              </p>
              <div className="lp-table-wrap">
                <table className="lp-compare">
                  <thead>
                    <tr>
                      <th />
                      {COLUMNS.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.map(([dim, ...cells]) => (
                      <tr key={dim}>
                        <th scope="row">{dim}</th>
                        {cells.map((cell, i) => (
                          // data-label carries the column header into the
                          // stacked mobile layout, where <thead> is hidden.
                          <td key={COLUMNS[i]} data-label={COLUMNS[i]}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ marginTop: 18 }}>
                Honestly, the search half is standard. Keyword plus vectors, merged by rank,
                reranked by a cross-encoder. Assembled with care, not invented here. What's
                unusual is everything around it: a graph you wrote yourself that feeds
                ranking, writes that converge instead of piling up, knowledge that can be
                marked old, and a store you can just open and read. Each one is rare on its
                own. We haven't found them together anywhere else.
              </p>
            </S>

            <S id="gaps">
              <h2>What is missing</h2>
              <p>
                A page like this is worth nothing if it only lists the good parts. Here are
                the real gaps, roughly in the order they matter.
              </p>

              <div className="lp-note">
                <h4>No evaluation harness yet</h4>
                <p>
                  There's no labelled set of test questions, so no recall@k or MRR to show
                  you. Every ranking decision above is argued, not measured. Queries are being
                  logged so the set can be built from real questions instead of made-up ones.
                  Until then, treat the tuning as reasoned rather than proven.
                </p>
              </div>

              <div className="lp-note">
                <h4>The reranker is unvalidated</h4>
                <p>
                  Cross-encoder reranking is a known win in the research, but nobody has
                  measured it on this data. It fails open on purpose: if the model isn't
                  available you get the merged order instead, which was the whole answer
                  before the reranker existed.
                </p>
              </div>

              <div className="lp-note">
                <h4>One vector per passage</h4>
                <p>
                  No late-interaction retrieval, no query expansion, no HyDE. Any of them
                  would probably help. None of them are in.
                </p>
              </div>

              <div className="lp-note">
                <h4>Chunking is structural, not semantic</h4>
                <p>
                  Passages split on paragraphs and sentences, not on where the subject
                  actually changes. Cheap and predictable, and sometimes it cuts in the wrong
                  place.
                </p>
              </div>
            </S>

            <S id="tools">
              <h2>The tool surface</h2>
              <p>
                Fifteen tools over MCP. They're the same operations the browser does, because
                there's no separate agent-shaped copy of your data.
              </p>
              <div className="lp-table-wrap">
                <table className="lp-table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map(([name, what]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </S>

            <S id="harnesses">
              <h2>One brain, every harness</h2>
              <p>
                There is no Claude Code integration here, or a Cursor one. There is an MCP
                server that speaks streamable HTTP and authenticates with OAuth, which is
                what all of them already know how to talk to. Anything that implements the
                spec works, including whatever ships next year.
              </p>
              <p>
                That matters more than it sounds, because harnesses are not interchangeable
                and most people use several. Claude Code in a terminal, Codex on a laptop,
                Cursor when you want an editor around the work. Normally each one keeps
                whatever it learns to itself. Here they all sign in to the same account and
                write to the same boards, so a trace one of them ran on Tuesday is there for
                a different tool on Friday.
              </p>
              <p>
                Tokens are issued per client, not per account, and Settings lists every
                harness holding one. Revoke a laptop that went missing and the others keep
                working. Nothing is stored about which tool wrote a card, because by the time
                it is on the board it is just a card.
              </p>
              <ConnectPanel note="Same endpoint every time. The account is what the boards belong to, not the tool." />

              <h3>Getting it to use the memory on its own</h3>
              <p>
                Connecting the server makes the tools available. It does not make an agent
                reach for them, and that gap is where most memory products quietly fail. The
                server sends <code>instructions</code> when a harness connects, which most of
                them put in the system prompt, and the tool descriptions push the same way.
                Both are advisory. Harnesses differ on whether they inject them and models
                differ on whether they act.
              </p>
              <p>
                What actually works is a few lines in the instruction file you already keep.
                That text is yours, it outranks anything the server suggests, and it turns
                “it can remember” into “it does”. Paste this once per machine:
              </p>
              <MemorySnippet note="Same text in all four. Only the destination changes." />
              <p>
                Note the second line. Recall has an obvious trigger, because a question shows
                up and the agent goes looking. Writing has none, which is why it needs to be
                tied to finishing a task rather than left to judgement.
              </p>
            </S>

            <S id="trust">
              <h2>Isolation, and no agents of ours</h2>
              <p>
                Every query filters on who owns the board. Ownership lives on the board
                rather than the card, so there's exactly one place it can go wrong. Vectors are
                split by account too, but that's for result quality rather than security: a
                vector hit you don't own just fails to find a card when it goes to read one
                back. A row that doesn't exist and a row that isn't yours give you the same
                answer.
              </p>
              <p>
                No model on this side answers for you. Your harness is the agent, whether
                that's Claude Code, Cursor, or anything else that speaks MCP, and it runs on
                your own subscription. This side stores, indexes and ranks. The only models it
                runs are the one that embeds your cards and the one that reorders your own
                results.
              </p>
              <ConnectPanel note="No API key. The first call comes back with a challenge, your harness opens a browser, and you can revoke the token it gets from Settings." />
            </S>
          </div>
        </div>
      </section>

      <section className="lp-cta">
        <h2>Give it something to remember.</h2>
        <p>Free to start. Your next session can read it.</p>
        <div className="lp-actions">
          <Link className="lp-btn lp-btn-primary lp-btn-lg" to="/register">
            Start a mindmap
          </Link>
          <Link className="lp-btn lp-btn-ghost lp-btn-lg" to="/">
            Back to the overview
          </Link>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
