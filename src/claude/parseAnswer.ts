import { Citation, CitationType, CitedAnswer, Claim } from "../model";
import { ToolCallRecord } from "./queryVault";

export function buildVaultQuestionPrompt(question: string, scopePath: string | null): string {
  // Real scoping is enforced by spawning claude with its cwd set to
  // scopePath (see queryVault.ts's runVaultQuery) -- Glob/Grep with no path
  // argument already only search there, so this is just orientation for
  // Claude's own answer, not the restriction mechanism. Telling it to pass
  // scopePath as a Glob/Grep argument again would double it up against the
  // already-scoped cwd (e.g. "Projects/Work/Projects/Work").
  const scopeInstruction = scopePath
    ? `\n\nYour search is already restricted to the "${scopePath}" folder -- that's your current working directory, so Glob/Grep with no path argument only look inside it. Don't pass an absolute path or ".." to search outside it.`
    : "";

  return `You are answering a question about the user's Obsidian vault (the current working directory). Use the Read, Grep, and Glob tools to search the vault and find the actual notes that answer the question -- don't answer from general knowledge alone if the vault has relevant notes; search first.${scopeInstruction}

Question: ${question}

Once you're confident in your answer, respond with ONLY a raw JSON object, no markdown fences, no explanation outside the JSON, in exactly this shape:
{
  "answer": "<your answer, plain text or simple markdown>",
  "claims": [
    {
      "text": "<a specific claim or sentence, copied verbatim/word-for-word from your answer above -- must be an exact substring of \"answer\", not a paraphrase of it>",
      "citations": [
        { "file": "<vault-relative path you actually opened with Read or matched with Grep>", "excerpt": "<the specific text from that file supporting this claim>", "type": "quote" or "inferred" }
      ]
    }
  ]
}

"quote" means the excerpt is copied verbatim from the file. "inferred" means you synthesized or paraphrased across the passage rather than quoting it -- the excerpt should still be the specific passage you drew on, just not necessarily an exact substring. Each claim's own "text" field must always be an exact substring of "answer" though, regardless of the citation type -- this is what lets the app link a claim back to the right spot in your answer, so never summarize or reword it there.

Every "file" must be a file you actually opened with Read or matched with Grep during this turn -- never cite a file you didn't look at. If part of your answer isn't backed by a specific vault file, just omit citations for that claim (or omit the claim from the list entirely) rather than inventing one. If nothing in the vault is relevant, return an empty claims array.`;
}

interface RawCitation {
  file?: unknown;
  excerpt?: unknown;
  type?: unknown;
}

interface RawClaim {
  text?: unknown;
  citations?: unknown;
}

interface RawAnswer {
  answer?: unknown;
  claims?: unknown;
}

/** Same progressive-repair idea as Terminus's headlessAssist.ts
 *  parseSuggestion(): exact parse first, then fall back to extracting a
 *  {...} object out of surrounding prose, since instruction-following on
 *  "respond with ONLY raw JSON" occasionally slips (e.g. a stray sentence
 *  before/after the object) even when the instruction is unambiguous. */
function parseJsonLoose(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to extraction
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // fall through to null
    }
  }
  return null;
}

/** True if `file` (a vault-relative path) is inside `scopePath` (also
 *  vault-relative) or is `scopePath` itself. Segment-aware -- "Projects"
 *  must not match "Projects2/note.md". */
function isWithinScope(file: string, scopePath: string): boolean {
  const normalizedScope = scopePath.replace(/\/+$/, "");
  return file === normalizedScope || file.startsWith(`${normalizedScope}/`);
}

/**
 * Turns Claude's raw final message plus the captured tool-call transcript
 * into a CitedAnswer, validating every claimed citation against what was
 * actually read/grepped. Two outcomes for a claimed citation:
 *  - the file itself was never opened -> dropped entirely (hallucinated
 *    source access, not just a paraphrase issue)
 *  - the file was opened but the excerpt isn't a verbatim substring of what
 *    was returned -> kept, but demoted to type "inferred" with no
 *    highlight location, since we can't point at an exact span that isn't
 *    actually there.
 *
 * `scopePath`, if set, is enforced here too, not just as a prompt
 * instruction: tool calls against files outside it are dropped from the
 * citation pool before matching, the same way an unopened file is dropped
 * above -- so a citation can't sneak through even if Claude's search
 * wandered outside the requested folder.
 */
export function parseVaultAnswer(
  question: string,
  turnId: string,
  rawAnswer: string,
  toolCalls: ToolCallRecord[],
  scopePath: string | null
): CitedAnswer {
  const parsed = parseJsonLoose(rawAnswer) as RawAnswer | null;

  if (!parsed || typeof parsed.answer !== "string") {
    return {
      turnId,
      question,
      answer: rawAnswer.trim() || "(no response)",
      claims: [],
      createdAt: Date.now(),
      scopePath,
    };
  }

  const poolByFile = new Map<string, string>();
  for (const call of toolCalls) {
    if (!call.file) continue;
    if (scopePath && !isWithinScope(call.file, scopePath)) continue;
    const existing = poolByFile.get(call.file);
    poolByFile.set(call.file, existing ? `${existing}\n${call.resultText}` : call.resultText);
  }

  // Claude is told the scope folder *is* its cwd (see buildVaultQuestionPrompt's
  // scopeInstruction), so it's just as likely to cite files relative to that
  // cwd as relative to the vault root the prompt actually asks for -- e.g.
  // "note.md" instead of "Projects/Work/note.md". Rather than relying on
  // prompt-following alone to get this right, alias every vault-relative
  // entry above under its scope-relative form too, so a citation matches
  // regardless of which one Claude reports.
  if (scopePath) {
    const prefix = `${scopePath.replace(/\/+$/, "")}/`;
    for (const [file, text] of [...poolByFile]) {
      if (!file.startsWith(prefix)) continue;
      const scopeRelative = file.slice(prefix.length);
      if (scopeRelative && !poolByFile.has(scopeRelative)) poolByFile.set(scopeRelative, text);
    }
  }

  const rawClaims = Array.isArray(parsed.claims) ? (parsed.claims as RawClaim[]) : [];
  const claims: Claim[] = [];
  let claimCounter = 0;
  let citationCounter = 0;

  for (const rawClaim of rawClaims) {
    if (typeof rawClaim.text !== "string") continue;
    const rawCitations = Array.isArray(rawClaim.citations) ? (rawClaim.citations as RawCitation[]) : [];
    const citations: Citation[] = [];

    for (const rawCitation of rawCitations) {
      if (typeof rawCitation.file !== "string" || typeof rawCitation.excerpt !== "string") continue;
      const sourceText = poolByFile.get(rawCitation.file);
      if (sourceText === undefined) continue;

      const excerpt = rawCitation.excerpt.trim();
      if (!excerpt) continue;
      const matchIndex = sourceText.indexOf(excerpt);
      const verified = matchIndex !== -1;
      const requestedType: CitationType = rawCitation.type === "inferred" ? "inferred" : "quote";

      citations.push({
        id: `c${++citationCounter}`,
        file: rawCitation.file,
        type: verified ? requestedType : "inferred",
        excerpt,
        sourceText,
        location: verified ? { from: matchIndex, to: matchIndex + excerpt.length } : null,
        verified,
        // Stamped in by ConversationStore right after this CitedAnswer is
        // built, using the Obsidian vault API -- this module has no
        // Obsidian dependency and stays that way.
        capturedMtime: null,
        stale: false,
      });
    }

    if (citations.length === 0) continue;
    claims.push({ id: `claim${++claimCounter}`, text: rawClaim.text, citations });
  }

  return {
    turnId,
    question,
    answer: parsed.answer,
    claims,
    createdAt: Date.now(),
    scopePath,
  };
}
