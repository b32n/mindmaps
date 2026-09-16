/**
 * Semantic recall: finding cards by meaning rather than wording.
 *
 * ## Why this does not violate the founding constraint
 *
 * MCP.md §2 rejected four designs for one shared reason: they billed *agent
 * inference* to us rather than to the user's own subscription. That constraint
 * is intact. Embedding our own cards on save is a different category — it is
 * infrastructure, the same kind of thing as D1 and R2, at a fraction of a cent
 * per card and with no model ever called on the user's behalf. The reranker is
 * the same category again: a 100M-parameter classifier over our own rows.
 *
 * The lever it buys is large: "who owns this" will never match a card that says
 * "nobody has picked it up", and keyword search is the ceiling on how good the
 * read side of a brain can be.
 *
 * ## What is indexed
 *
 * Passages, not cards (0017). A card's prose is chunked, each chunk is embedded
 * with the card's title prepended, and the chunk id — `<node_id>#<ord>` — is
 * the Vectorize id. A vector hit maps back to its card by string split, and the
 * winning chunk is what `recall` shows as the excerpt.
 *
 * ## Degradation is deliberate
 *
 * Both bindings are optional. Without them every function here is a no-op and
 * `recall` falls back to keyword-only, which keeps local development working
 * without a Vectorize index and means a fresh deploy is never broken, only less
 * good. That is why nothing calls these without checking.
 */

import { chunksFor, embeddableChunk, MAX_CHUNKS } from "./chunk";

export interface SemanticEnv {
  DB: D1Database;
  AI?: Ai;
  VECTORS?: VectorizeIndex;
}

/**
 * 1024 dimensions, matching the index named in wrangler.toml.
 *
 * bge-m3 replaced bge-base-en-v1.5, which was English-only and 768-dim. The
 * dimension change is why this needed a *new* Vectorize index rather than a
 * reindex of the old one: dimensions are fixed at index creation.
 */
const MODEL = "@cf/baai/bge-m3";

/**
 * Cross-encoder for reranking.
 *
 * Different in kind from the embedding model, and that difference is the point.
 * An embedding compares two vectors computed in ignorance of each other; a
 * cross-encoder reads the query and the passage *together* and scores the pair.
 * It is far too slow to run over a corpus, which is why it runs last, over the
 * handful of candidates retrieval has already narrowed to.
 */
const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/**
 * How far back the exact-cosine pass reaches.
 *
 * Covers the Vectorize write-ahead lag with a wide margin: Cloudflare quotes
 * median under 30s and p99 under 2 minutes since 2026-07-01. Ten minutes is
 * deliberately several times p99 — the cost of overshooting is scanning a few
 * more rows, and the cost of undershooting is the bug this exists to fix.
 */
const FRESH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Ceiling on chunks the exact pass will scan, newest first.
 *
 * A bulk `create_mindmap` can put 20+ cards — and several times that in chunks
 * — inside the window at once. This bounds the work rather than letting one
 * enthusiastic import make every later query slow.
 */
const FRESH_SCAN_LIMIT = 400;

export const semanticReady = (env: SemanticEnv): boolean => !!env.AI && !!env.VECTORS;

/** A chunk id is `<node_id>#<ord>`; an id without `#` is its own card. */
export const cardIdOf = (chunkId: string): string => chunkId.split("#")[0];

// --- vector <-> blob --------------------------------------------------------

/**
 * Little-endian float32, which is what both x86 and ARM workers already are.
 *
 * Exported alongside `unpackVector` because the stored copy is also the
 * rebuild path: re-populating a fresh Vectorize index reads these back rather
 * than re-running inference over every card.
 */
export const packVector = (values: number[]): ArrayBuffer => Float32Array.from(values).buffer;

/**
 * Unpack a stored embedding.
 *
 * D1 returns BLOBs as `number[]` — verified, not assumed, because the other
 * plausible reading (`ArrayBuffer`) fails as "the fresh pass silently returns
 * nothing", which is the hardest kind of bug to notice in a ranking system.
 * Both are handled in case that ever changes under us.
 */
export function unpackVector(blob: unknown): Float32Array | null {
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  if (ArrayBuffer.isView(blob))
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  if (Array.isArray(blob)) return new Float32Array(Uint8Array.from(blob).buffer);
  return null;
}

/**
 * Cosine similarity, matching `--metric=cosine` on the Vectorize index.
 *
 * Normalisation is computed rather than assumed: bge-m3 returns near-unit
 * vectors, but "near" would put the two scoring paths on subtly different
 * scales, and the whole point of this pass is that its scores merge with
 * Vectorize's.
 */
function cosine(a: Float32Array, b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- inference --------------------------------------------------------------

/**
 * Most texts bge-m3 will embed in one call. Its schema caps `text` at 100 items
 * and `MAX_CHUNKS` is 64, so one card always fits — this guards the query path
 * and any future caller, not the indexer.
 */
const EMBED_BATCH = 100;

/**
 * Embed one or more texts in a single call. Returns `null` on any failure.
 *
 * **bge-m3 returns `response`, not `data`.** The previous model
 * (bge-base-en-v1.5) used `data`, and the difference is invisible at the type
 * level because both are `number[][]` — reading the wrong key yields
 * `undefined`, which this function would report as "embedding failed" and the
 * indexer would treat as "skip this card". Silently, forever. Both keys are
 * read so the swap cannot fail that way in either direction.
 *
 * `truncate_inputs` because erroring out on an over-long input would mean one
 * oversized card stops being indexed at all; a truncated vector is worse than a
 * whole one and enormously better than none.
 */
async function embedAll(env: SemanticEnv, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || !texts.length || texts.length > EMBED_BATCH) return null;
  try {
    const res = (await env.AI.run(MODEL as never, {
      text: texts,
      truncate_inputs: true,
    } as never)) as { response?: number[][]; data?: number[][] };
    const out = res?.response ?? res?.data;
    return Array.isArray(out) && out.length === texts.length ? out : null;
  } catch (err) {
    // An embedding failure must never fail the write that triggered it: the
    // card is the thing that matters, the index is an accelerator.
    console.error("embed failed", err);
    return null;
  }
}

async function embed(env: SemanticEnv, text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  const out = await embedAll(env, [text]);
  return out?.[0] ?? null;
}

/**
 * Reorder candidates by reading each against the query.
 *
 * Returns scores aligned to the input order, or `null` if the model is
 * unavailable or misbehaves — in which case the caller keeps the fusion order,
 * which is a perfectly good answer and was the whole answer until now. A
 * reranker is an improvement on a ranking, never a precondition for having one.
 */
export async function rerankScores(
  env: SemanticEnv,
  query: string,
  passages: string[],
): Promise<number[] | null> {
  if (!env.AI || !passages.length) return null;
  try {
    const res = (await env.AI.run(RERANK_MODEL as never, {
      query,
      contexts: passages.map((text) => ({ text })),
      top_k: passages.length,
    } as never)) as { response?: Array<{ id?: number; index?: number; score: number }> };

    // Results come back best-first, each carrying its position in the *input*
    // array — so response order is not input order, and that position is the
    // only thing tying a score to its candidate. The schema calls the field
    // `id`; the docs page says `index`. Both are read, because betting on the
    // wrong one scores every candidate identically and silently disables the
    // reranker rather than failing.
    const rows = res?.response;
    if (!Array.isArray(rows) || !rows.length) return null;

    const scores = new Array<number>(passages.length).fill(Number.NEGATIVE_INFINITY);
    let placed = 0;
    for (const r of rows) {
      const i = typeof r?.index === "number" ? r.index : r?.id;
      if (typeof i === "number" && i >= 0 && i < passages.length) {
        scores[i] = r.score;
        placed += 1;
      }
    }
    return placed ? scores : null;
  } catch (err) {
    console.error("rerank failed", err);
    return null;
  }
}

// --- indexing ---------------------------------------------------------------

/**
 * Index one card, as passages.
 *
 * Safe to call repeatedly: chunk ids are positional, so re-indexing an edited
 * card overwrites `#0..#n` and explicitly removes any `#n+1..` the old version
 * had. Without that last step a card that got shorter would keep answering
 * queries from passages it no longer contains.
 *
 * Chunk rows are written to D1 *before* the Vectorize upsert, and that order is
 * the whole point: the D1 copy is what makes the card findable by meaning
 * immediately, while the upsert is still working through the write-ahead log.
 */
export async function indexCard(
  env: SemanticEnv,
  card: { id: string; title: string; body: string; userId: string; boardId: string },
): Promise<void> {
  if (!semanticReady(env)) return;

  // Title included, because most cards *are* their title — see `chunksFor`.
  const chunks = chunksFor(card.title, card.body);
  if (!chunks.length) {
    // A card with neither title nor prose is not an empty vector — it is
    // nothing to index. Clear anything a previous version left behind.
    await dropChunks(env, card.id, 0);
    return;
  }

  const vectors = await embedAll(
    env,
    chunks.map((c) => embeddableChunk(card.title, c)),
  );
  if (!vectors) return;

  const at = Date.now();
  const rows = chunks.map((text, ord) => ({
    id: `${card.id}#${ord}`,
    ord,
    text,
    values: vectors[ord],
  }));

  try {
    await env.DB.batch([
      ...rows.map((r) =>
        env.DB.prepare(
          `INSERT INTO node_chunks (id,node_id,ord,text,embedding,embedded_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             embedding = excluded.embedding,
             embedded_at = excluded.embedded_at`,
        ).bind(r.id, card.id, r.ord, r.text, packVector(r.values), at),
      ),
      env.DB.prepare(`DELETE FROM node_chunks WHERE node_id = ? AND ord >= ?`).bind(
        card.id,
        rows.length,
      ),
    ]);
  } catch (err) {
    console.error("chunk write failed", err);
  }

  try {
    await env.VECTORS!.upsert(
      rows.map((r) => ({
        id: r.id,
        values: r.values,
        namespace: card.userId,
        metadata: { user: card.userId, board: card.boardId, card: card.id },
      })),
    );
  } catch (err) {
    console.error("vector upsert failed", err);
  }

  await dropChunks(env, card.id, rows.length);
}

/** Remove vectors for chunk ordinals at or above `from`, up to the cap. */
async function dropChunks(env: SemanticEnv, cardId: string, from: number): Promise<void> {
  if (!env.VECTORS || from >= MAX_CHUNKS) return;
  const ids: string[] = [];
  for (let i = from; i < MAX_CHUNKS; i += 1) ids.push(`${cardId}#${i}`);
  try {
    await env.VECTORS.deleteByIds(ids);
  } catch (err) {
    console.error("vector cleanup failed", err);
  }
}

/**
 * Forget cards entirely.
 *
 * Deletes the whole ordinal range rather than the chunk ids that actually
 * existed, because by the time this runs the D1 rows are usually gone by
 * cascade and there is nothing left to enumerate. `deleteByIds` tolerates ids
 * that were never there, so over-asking is free and under-asking would leave
 * vectors pointing at a deleted card.
 */
export async function removeCards(env: SemanticEnv, ids: string[]): Promise<void> {
  if (!semanticReady(env) || !ids.length) return;
  const all: string[] = [];
  for (const id of ids) for (let i = 0; i < MAX_CHUNKS; i += 1) all.push(`${id}#${i}`);
  try {
    // Plus the pre-0017 whole-card ids, for anything indexed before chunking.
    await env.VECTORS!.deleteByIds([...ids, ...all]);
  } catch (err) {
    console.error("vector delete failed", err);
  }
}

// --- retrieval --------------------------------------------------------------

export interface ChunkHit {
  /** The card this passage belongs to. */
  cardId: string;
  chunkId: string;
  score: number;
}

export interface SimilarResult {
  hits: ChunkHit[];
  /**
   * Why there are no hits, when that is not simply "nothing matched".
   *
   * Surfaced rather than swallowed: an agent that gets nothing back should know
   * whether the brain has no memory of a topic or merely could not look, since
   * those call for opposite next moves.
   */
  degraded?: string;
}

/**
 * Exact cosine over chunks embedded inside the fresh window.
 *
 * This is a linear scan, and that is the right algorithm here precisely because
 * the window bounds it: the set is "passages this user saved in the last ten
 * minutes", which is single digits in normal use and capped either way. An
 * approximate index earns its keep over a whole corpus, not over a tail this
 * short — and the tail is the only part Vectorize cannot answer for yet.
 */
async function freshHits(
  env: SemanticEnv,
  userId: string,
  values: number[],
): Promise<ChunkHit[]> {
  const since = Date.now() - FRESH_WINDOW_MS;
  // Ownership is an EXISTS rather than a JOIN so the planner drives off
  // idx_node_chunks_fresh. Written as a join it did the opposite — walked every
  // chunk belonging to the user and sorted them in a temp b-tree, which is the
  // cost this window exists to avoid.
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.node_id, c.embedding
       FROM node_chunks c
      WHERE c.embedded_at > ?
        AND c.embedding IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM nodes n JOIN boards b ON b.id = n.board_id
           WHERE n.id = c.node_id AND b.user_id = ?
        )
      ORDER BY c.embedded_at DESC
      LIMIT ?`,
  )
    .bind(since, userId, FRESH_SCAN_LIMIT)
    .all<{ id: string; node_id: string; embedding: unknown }>();

  const hits: ChunkHit[] = [];
  for (const row of results ?? []) {
    const vec = unpackVector(row.embedding);
    if (vec) hits.push({ cardId: row.node_id, chunkId: row.id, score: cosine(vec, values) });
  }
  return hits;
}

/**
 * Passages most similar in meaning to a query, best first.
 *
 * Returns ids only. The caller reads the cards from D1, which is what actually
 * enforces ownership — a vector hit for a card you do not own simply does not
 * survive that join.
 */
export async function similarChunks(
  env: SemanticEnv,
  userId: string,
  query: string,
  topK: number,
): Promise<SimilarResult> {
  if (!semanticReady(env)) return { hits: [], degraded: "semantic index not configured" };
  const values = await embed(env, query);
  if (!values) return { hits: [], degraded: "could not embed the query" };

  const want = Math.min(100, Math.max(1, topK));

  // Both passes run against the same query vector, so their scores are the same
  // cosine on the same scale and merge without any reconciliation.
  const [vectorised, fresh] = await Promise.all([
    (async () => {
      try {
        const res = await env.VECTORS!.query(values, {
          topK: want,
          namespace: userId,
          returnMetadata: "none",
        } as never);
        return {
          hits: (res?.matches ?? []).map((m: { id: string; score: number }) => ({
            cardId: cardIdOf(m.id),
            chunkId: m.id,
            score: m.score,
          })),
        };
      } catch (err) {
        const detail = String((err as Error)?.message ?? err).slice(0, 200);
        console.error("vector query failed", detail);
        return { hits: [] as ChunkHit[], degraded: `semantic lookup failed: ${detail}` };
      }
    })(),
    freshHits(env, userId, values).catch((err) => {
      // The fresh pass is an improvement on Vectorize, never a precondition for
      // it. If D1 fails here, the query still returns whatever is indexed.
      console.error("fresh chunk scan failed", err);
      return [] as ChunkHit[];
    }),
  ]);

  // The fresh score wins every collision. A passage edited inside the window
  // has a vector in Vectorize describing what it used to say; the D1 copy
  // describes what it says now, which is the only one worth ranking on.
  const merged = new Map<string, ChunkHit>();
  for (const h of vectorised.hits) merged.set(h.chunkId, h);
  for (const h of fresh) merged.set(h.chunkId, h);

  return {
    hits: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, want),
    // Only degraded if the *indexed* pass failed. The fresh pass covering
    // minutes is not a substitute for an index covering everything.
    degraded: vectorised.degraded,
  };
}
