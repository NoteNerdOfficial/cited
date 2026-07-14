export type CitationType = "quote" | "inferred";

export interface Citation {
  id: string;
  /** Vault-relative path. */
  file: string;
  type: CitationType;
  /** The excerpt text as Claude cited it. */
  excerpt: string;
  /** The raw tool-result text this excerpt was checked against (a Read/Grep
   *  chunk, not necessarily the whole file) -- offsets in `location` are
   *  relative to this string, not to the live file on disk. */
  sourceText: string;
  /** Set only when `excerpt` was found verbatim inside `sourceText`. Null
   *  for inferred/paraphrased citations, or when a claimed quote couldn't
   *  actually be located -- the panel falls back to showing the excerpt
   *  unhighlighted in that case. */
  location: { from: number; to: number } | null;
  /** True if `excerpt` verbatim-matched inside `sourceText`. A citation
   *  whose `file` was never actually opened via Read/Grep is dropped
   *  entirely before it reaches this type -- see parseAnswer.ts. */
  verified: boolean;
  /** `file`'s mtime (ms) at the moment this citation was captured, or null
   *  if the file couldn't be stat'd through the vault API at that point.
   *  Compared against the live file on every vault "modify" event to
   *  decide whether to flip `stale`. */
  capturedMtime: number | null;
  /** Set once `file` is modified after this citation was captured. The
   *  panel keeps showing the originally-captured excerpt/highlight but
   *  flags it -- no attempt to re-locate the text in the changed file. */
  stale: boolean;
}

export interface Claim {
  id: string;
  text: string;
  citations: Citation[];
}

export interface CitedAnswer {
  turnId: string;
  question: string;
  answer: string;
  claims: Claim[];
  createdAt: number;
  /** Vault-relative folder this question was scoped to (set from ChatView's
   *  per-question scope field), or null for the whole vault. Recorded on
   *  the turn itself (not just used transiently at query time) so history
   *  shows what a past answer was actually scoped to. */
  scopePath: string | null;
}

export interface Conversation {
  id: string;
  /** claude's own session id, captured from the first turn's `system`
   *  event and passed as --resume on every subsequent turn so follow-up
   *  questions carry real context. Null until the first turn resolves. */
  sessionId: string | null;
  turns: CitedAnswer[];
  createdAt: number;
}
