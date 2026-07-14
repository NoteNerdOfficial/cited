import { App, normalizePath } from "obsidian";
import { CitedAnswer } from "../model";
import { buildFootnotedMarkdown, findClaimSpans } from "../citations/markers";

function sanitizeForFilename(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60);
}

/** Builds a new note from one turn's question/answer/citations -- the
 *  answer body with each claim followed by a real Obsidian footnote marker
 *  and a trailing "## Sources" section, then opens it. Always creates a new
 *  note rather than inserting into whatever's currently focused: Cited is a
 *  standalone panel, not tied to an active-note context the way a
 *  command-palette action might be. `folder` is the user's configured
 *  citations-export folder (settings.ts) -- created automatically if it
 *  doesn't exist yet; empty string means the vault root. */
export async function exportAnswerToNote(app: App, answer: CitedAnswer, folder: string): Promise<void> {
  const spans = findClaimSpans(answer.answer, answer.claims);
  const body = buildFootnotedMarkdown(answer.answer, spans);
  const date = new Date(answer.createdAt).toISOString().slice(0, 10);
  const titleFragment = sanitizeForFilename(answer.question) || "Untitled question";
  const content = `# ${answer.question}\n\n${body}`;

  const folderPath = normalizePath(folder.trim());
  if (folderPath && folderPath !== "." && !app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
  const basePath = folderPath && folderPath !== "." ? `${folderPath}/Cited - ${titleFragment} - ${date}` : `Cited - ${titleFragment} - ${date}`;

  // Two turns can produce the same title+date (same question asked twice
  // in a day, or two questions that sanitize to the same fragment) -- try
  // increasing suffixes rather than letting vault.create throw on a
  // filename collision.
  let file;
  for (let suffix = 0; ; suffix++) {
    const path = normalizePath(`${basePath}${suffix > 0 ? ` (${suffix})` : ""}.md`);
    if (app.vault.getAbstractFileByPath(path)) continue;
    file = await app.vault.create(path, content);
    break;
  }
  await app.workspace.getLeaf(true).openFile(file);
}
