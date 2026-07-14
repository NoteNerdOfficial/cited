import { Claim } from "../model";

export interface ClaimSpan {
  claim: Claim;
  /** Offsets into the plain text (not markdown source) that `text` was
   *  searched against -- see findClaimSpans. */
  start: number;
  end: number;
}

/**
 * Locates each claim's `text` inside `text` (the answer, in narrative
 * order), used by both insertDomMarkers (rendered DOM) and
 * buildFootnotedMarkdown (raw markdown export). The prompt in
 * parseAnswer.ts instructs Claude to make every claim's `text` an exact
 * substring of `answer`, so this is expected to succeed for well-formed
 * responses -- a claim whose text can't be found (a prompt-following slip)
 * is simply skipped, not treated as an error: it still shows up in the
 * citations panel, it just doesn't get an inline marker.
 */
export function findClaimSpans(text: string, claims: Claim[]): ClaimSpan[] {
  const spans: ClaimSpan[] = [];
  let searchFrom = 0;
  for (const claim of claims) {
    const needle = claim.text.trim();
    if (!needle) continue;
    const index = text.indexOf(needle, searchFrom);
    if (index === -1) continue;
    spans.push({ claim, start: index, end: index + needle.length });
    searchFrom = index + needle.length;
  }
  return spans;
}

interface TextNodeRange {
  node: Text;
  start: number;
  end: number;
}

/** Flat list of every text node in `container` with its offset range in the
 *  concatenated plain text -- computed once, before any mutation, so later
 *  DOM edits (splitting nodes to insert markers) never invalidate offsets
 *  still to be processed. */
function collectTextNodes(container: HTMLElement): TextNodeRange[] {
  const ranges: TextNodeRange[] = [];
  const walker = activeDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const length = text.data.length;
    ranges.push({ node: text, start: offset, end: offset + length });
    offset += length;
    node = walker.nextNode();
  }
  return ranges;
}

/**
 * Inserts a clickable <sup class="cited-marker"> immediately after each
 * claim's span end position in the already-rendered DOM (e.g. after
 * MarkdownRenderer.render has populated `container`). Spans are computed
 * here, against this same container's own rendered plain text -- not passed
 * in pre-computed -- specifically so they can never end up computed against
 * a different text (e.g. the raw markdown source, which shifts out of
 * alignment with rendered offsets by however many markdown syntax
 * characters -- **, [[, etc. -- precede a given claim, landing a marker
 * mid-word instead of at the claim's real end).
 */
export function insertDomMarkers(container: HTMLElement, claims: Claim[], onClick: (claimId: string) => void): void {
  const ranges = collectTextNodes(container);
  const renderedText = ranges.map((r) => r.node.data).join("");
  const spans = findClaimSpans(renderedText, claims);
  // Latest-ending spans first: splitting a text node for one marker must
  // never invalidate the (node, offset) still needed for a marker whose
  // span ends earlier in that same original node.
  const ordered = [...spans].sort((a, b) => b.end - a.end);

  for (const span of ordered) {
    const range = ranges.find((r) => span.end > r.start && span.end <= r.end);
    if (!range) continue; // span's end landed on a node boundary we don't have a clean split point for -- skip rather than guess

    const marker = activeDocument.createElement("sup");
    marker.className = "cited-marker";
    marker.textContent = "●";
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-label", "Show citation");
    marker.addEventListener("click", (e) => {
      e.preventDefault();
      onClick(span.claim.id);
    });

    const localOffset = span.end - range.start;
    if (localOffset < range.node.data.length) range.node.splitText(localOffset);
    range.node.after(marker);
  }
}

/**
 * Builds a markdown string with each claim's span followed by a real
 * Obsidian footnote marker ([^1], [^2], ...) in narrative order, plus a
 * trailing "## Sources" section with one footnote definition per citation.
 * Used by exportToNote.ts.
 */
export function buildFootnotedMarkdown(answer: string, spans: ClaimSpan[]): string {
  const numberByClaimId = new Map<string, number>();
  spans.forEach((span, i) => numberByClaimId.set(span.claim.id, i + 1));

  let body = answer;
  const orderedByEndDescending = [...spans].sort((a, b) => b.end - a.end);
  for (const span of orderedByEndDescending) {
    const n = numberByClaimId.get(span.claim.id);
    body = `${body.slice(0, span.end)}[^${n}]${body.slice(span.end)}`;
  }

  const footnoteLines = spans.map((span) => {
    const n = numberByClaimId.get(span.claim.id);
    const parts = span.claim.citations.map(
      (c) => `[[${c.file}]] — "${c.excerpt.replace(/\s+/g, " ").trim()}" (${c.type})`
    );
    return `[^${n}]: ${parts.join("; ")}`;
  });

  return footnoteLines.length > 0 ? `${body}\n\n## Sources\n\n${footnoteLines.join("\n")}\n` : body;
}
