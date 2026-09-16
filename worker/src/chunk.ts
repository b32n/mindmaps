/**
 * Splitting a card's prose into passages worth embedding one at a time.
 *
 * The unit that matters is a passage a reader would accept as an answer, which
 * is why this splits on structure rather than at fixed offsets. A chunk that
 * begins mid-sentence embeds badly and reads worse when `recall` shows it as
 * the excerpt — and the excerpt is now the winning chunk, so chunk boundaries
 * are user-visible, not just an indexing detail.
 */

/**
 * Target passage size, in characters.
 *
 * Roughly 200 tokens. Small enough that one topic dominates the vector — the
 * whole reason for chunking — and large enough to stand alone as an answer.
 * bge-m3 would accept far more; that is not the constraint. Dilution is: a
 * vector averaged over three topics is close to none of them.
 */
const TARGET = 900;

/** Hard ceiling. A passage over this is split even mid-sentence. */
const MAX = 1400;

/**
 * Characters of the previous passage carried into the next.
 *
 * Protects the seam. Without it, a statement split across a boundary is in
 * neither vector properly, and that is exactly where the answer tends to sit —
 * a heading in one chunk and the sentence it introduces in the next.
 */
const OVERLAP = 150;

/**
 * Most passages one card can produce.
 *
 * Also the contract `removeCards` relies on: deleting a card removes
 * `<id>#0` .. `<id>#63` from Vectorize without needing to know how many chunks
 * it actually had, which matters because the D1 rows are already gone by
 * cascade at that point. Raising this without revisiting that is a way to
 * leave orphan vectors behind.
 */
export const MAX_CHUNKS = 64;

/** Paragraph-ish boundaries, in descending order of how clean a break they are. */
const splitOn = (text: string, pattern: RegExp): string[] =>
  text.split(pattern).filter((p) => p.trim().length > 0);

/** Last resort: fixed slices, so a wall of text still gets indexed. */
function hardSlice(text: string, out: string[]): void {
  for (let i = 0; i < text.length; i += TARGET - OVERLAP) {
    const piece = text.slice(i, i + TARGET).trim();
    if (piece) out.push(piece);
    if (i + TARGET >= text.length) break;
  }
}

/** Pack pieces into passages of at most TARGET, joined by `sep`. */
function pack(pieces: string[], sep: string, out: string[]): void {
  let buf = "";
  for (const p of pieces) {
    if (buf && buf.length + p.length + sep.length > TARGET) {
      out.push(buf.trim());
      buf = "";
    }
    buf += (buf ? sep : "") + p;
  }
  if (buf.trim()) out.push(buf.trim());
}

/**
 * Break one oversized block down, cleanest boundary first: sentences, then
 * lines, then raw offsets.
 *
 * The threshold is TARGET, not MAX. Splitting only above MAX left a 1,260-char
 * checklist — sixty items — as a single vector, which is precisely the
 * dilution chunking exists to prevent. MAX still matters as the tolerance for
 * a block with no internal structure to split on: a long unbroken paragraph is
 * better kept whole than sliced mid-sentence.
 */
function breakUp(block: string, out: string[]): void {
  if (block.length <= TARGET) {
    out.push(block.trim());
    return;
  }

  // Sentence ends, keeping the terminator with the sentence it closes.
  const sentences = splitOn(block, /(?<=[.!?])\s+/);
  if (sentences.length > 1) return pack(sentences, " ", out);

  // A single unbroken sentence — a table, a list, pasted output.
  const lines = splitOn(block, /\n/);
  if (lines.length > 1) return pack(lines, "\n", out);

  // Nothing to split on. Tolerate up to MAX rather than cutting mid-word.
  if (block.length <= MAX) {
    out.push(block.trim());
    return;
  }
  hardSlice(block, out);
}

/**
 * Minimum size for a passage to stand on its own.
 *
 * A heading followed by a long block used to come out as its own 10-character
 * chunk — a vector carrying almost no signal, occupying a result slot and an
 * embedding. Anything shorter than this is merged into a neighbour instead.
 */
const MIN_CHUNK = 250;

/** Fold undersized passages into a neighbour, preferring the one that follows. */
function mergeRunts(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  const out: string[] = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (prev.length < MIN_CHUNK || c.length < MIN_CHUNK)) {
      const joined = `${prev}\n\n${c}`;
      // Never merge past the hard ceiling — a runt is a smaller problem than
      // an oversized vector.
      if (joined.length <= MAX) {
        out[out.length - 1] = joined;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * A card's prose as passages.
 *
 * Returns `[]` for an empty card, which is the signal not to index it at all
 * rather than to store an empty vector.
 */
export function chunkBody(body: string): string[] {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  // Paragraphs are the natural unit of a document and the author already chose
  // them. Merge small ones up to TARGET rather than embedding a one-line
  // paragraph on its own, which would be a vector with almost no signal.
  const paragraphs = splitOn(text, /\n{2,}/);
  const out: string[] = [];
  let buf = "";

  for (const p of paragraphs) {
    if (p.length > TARGET) {
      if (buf.trim()) {
        out.push(buf.trim());
        buf = "";
      }
      breakUp(p, out);
      continue;
    }
    if (buf && buf.length + p.length + 2 > TARGET) {
      out.push(buf.trim());
      // Carry the tail across the seam, trimmed to a word boundary so the
      // overlap does not start mid-word.
      const tail = buf.slice(-OVERLAP);
      buf = tail.slice(tail.search(/\s/) + 1);
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  if (buf.trim()) out.push(buf.trim());

  return mergeRunts(out.filter((c) => c.trim().length > 0)).slice(0, MAX_CHUNKS);
}

/**
 * A card's passages, falling back to its title.
 *
 * The fallback is not an edge case here: a card is one line of text until you
 * open it, and a note keeps its whole content in `title` with an empty body.
 * On this database that is 132 of 230 cards. Indexing only `body` would have
 * made the majority of the corpus unfindable by meaning — a regression
 * invisible in any test written against a card that happens to have prose.
 */
export function chunksFor(title: string, body: string): string[] {
  const chunks = chunkBody(body);
  if (chunks.length) return chunks;
  const t = String(title ?? "").trim();
  return t ? [t] : [];
}

/**
 * What actually gets embedded for a passage.
 *
 * The title rides along on every chunk so a passage keeps its topic in vector
 * space — "it caches for 15 minutes" means little on its own and a lot under
 * "Token refresh — two implementations". Stored chunk text stays clean, since
 * that is what `recall` prints.
 *
 * Skipped when the passage already opens with the title, which is both the
 * title-only case above and any card whose body repeats its heading — doubling
 * the same words would skew the vector toward them.
 */
export function embeddableChunk(title: string, chunk: string): string {
  const t = String(title ?? "").trim();
  if (!t || chunk.trimStart().toLowerCase().startsWith(t.toLowerCase())) return chunk.trim();
  return `${t}\n\n${chunk}`.trim();
}
