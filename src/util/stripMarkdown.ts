/** Strips common inline markdown syntax for display contexts that render
 *  plain text rather than going through MarkdownRenderer (e.g. CitedView's
 *  claim-text label, which is a verbatim substring of a markdown answer and
 *  would otherwise show raw "**"/"[[...]]" characters as literal text). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
