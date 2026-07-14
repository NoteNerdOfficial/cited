import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import * as readline from "readline";
import * as path from "path";

export interface ToolCallRecord {
  toolUseId: string;
  toolName: string;
  /** Vault-relative path. Always set for Read. Always set for Grep too --
   *  see splitGrepResultByFile: a single vault-wide Grep call returns
   *  matches from many files in one tool_result, so it's split into one
   *  ToolCallRecord per file rather than kept as one blob. Null only for
   *  tool calls that carry no attributable file content (e.g. Glob, which
   *  returns paths but no file text). */
  file: string | null;
  resultText: string;
}

export interface QueryProgress {
  /** One-indexed count of assistant turns seen so far this query. Each
   *  assistant message is one turn against claude's own --max-turns cap, so
   *  this pairs with maxTurns to give a real "how close is it" signal. */
  turn: number;
  maxTurns: number;
  /** Short human-readable description of the tool call driving the current
   *  turn (e.g. "Reading note.md", "Searching for \"insurance\""), or a
   *  generic fallback if the turn's assistant message had no tool call
   *  (rare -- usually only the final answering turn). */
  label: string;
}

export interface QueryRunResult {
  /** Claude's final message, expected to be the structured JSON envelope
   *  described in the prompt -- parseAnswer.ts is responsible for actually
   *  parsing/validating it. Empty string if the run produced no result. */
  rawAnswer: string;
  toolCalls: ToolCallRecord[];
  /** From the `system` init event's `session_id` field (confirmed via
   *  manual testing). Pass this back in as `resumeSessionId` on the next
   *  call in the same conversation to carry context forward. Null if no
   *  system event was seen (e.g. a malformed/empty transcript). */
  sessionId: string | null;
}

const TIMEOUT_MS = 120_000;

interface PendingToolUse {
  toolUseId: string;
  toolName: string;
  file: string | null;
}

/** `cwd` is the actual working directory the `claude` process was spawned
 *  with (the vault root, or a scoped subfolder of it -- see runVaultQuery) --
 *  relative paths in tool inputs/results are relative to that, not
 *  necessarily the vault root, since that's how the OS/tools resolve them. */
function toVaultRelative(vaultBasePath: string, cwd: string, absOrRel: string): string {
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(cwd, absOrRel);
  return path.relative(vaultBasePath, abs);
}

/** Tool results arrive as either a plain string or an array of content
 *  blocks (text blocks, occasionally others) -- normalize to a single
 *  string either way. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

/** Read tool results come back with a "cat -n"-style line-number prefix on
 *  every line (e.g. "42\tsome text"). Strip it so excerpt-matching in
 *  parseAnswer.ts is comparing against the file's actual text, not against
 *  text that happens to have numbers glued to the front of it. */
function stripLineNumberPrefixes(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

/** A Grep call scoped to the whole vault returns matches from many files in
 *  a single tool_result, formatted one match per line as
 *  "<file>:<lineNumber>:<content>" (confirmed empirically -- see manual
 *  testing notes). Split that blob into per-file text so each file gets its
 *  own pool entry in parseAnswer.ts, instead of the whole multi-file result
 *  being attributed to nothing (or to the wrong single file). Lines that
 *  don't match the pattern -- a "Found N files" header, or bare filenames
 *  when Grep runs in files_with_matches mode -- carry no quotable content
 *  and are dropped, not attributed to any file. */
export function splitGrepResultByFile(resultText: string): Map<string, string> {
  const linesByFile = new Map<string, string[]>();
  for (const line of resultText.split("\n")) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const file = match[1]?.replace(/^\.\//, "");
    const content = match[3];
    if (file === undefined || content === undefined) continue;
    const lines = linesByFile.get(file) ?? [];
    lines.push(content);
    linesByFile.set(file, lines);
  }
  const byFile = new Map<string, string>();
  for (const [file, lines] of linesByFile) byFile.set(file, lines.join("\n"));
  return byFile;
}

/** Short label for the tool call driving one assistant turn, shown live in
 *  the chat panel while a query is running. Deliberately terse (basename
 *  only for Read, not the full vault-relative path) since this is a
 *  transient status line, not a citation -- the real path shows up later in
 *  the sources panel if it becomes one. */
function describeToolUse(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const input = (block.input ?? {}) as Record<string, unknown>;

  if (name === "Read" && typeof input.file_path === "string") return `Reading ${path.basename(input.file_path)}`;
  if (name === "Grep" && typeof input.pattern === "string") return `Searching for "${input.pattern}"`;
  if (name === "Glob" && typeof input.pattern === "string") return `Listing files matching "${input.pattern}"`;
  return `Running ${name}`;
}

/** Builds the live progress label for one already-parsed assistant event --
 *  separate from parseTranscript's full pass so that one stays a pure,
 *  unit-testable function against a complete captured log, while this is
 *  only ever used for the transient "what's it doing right now" status
 *  line. Caller is responsible for confirming event.type === "assistant"
 *  first (see runVaultQuery's rl.on("line") handler). */
function describeAssistantEvent(event: Record<string, unknown>, turn: number, maxTurns: number): QueryProgress {
  const message = event.message as { content?: unknown[] } | undefined;
  const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  const toolBlock = blocks.find((b) => b?.type === "tool_use");
  const label = toolBlock ? describeToolUse(toolBlock) : "Reviewing what it's found…";

  return { turn, maxTurns, label };
}

/**
 * Pure transcript parser, split out from the process-spawning I/O below so
 * it can be unit-tested directly against a captured stream-json log instead
 * of only ever being exercised end-to-end through a live `claude` process.
 */
export function parseTranscript(lines: string[], vaultBasePath: string, cwd: string): QueryRunResult {
  const pendingByToolUseId = new Map<string, PendingToolUse>();
  const toolCalls: ToolCallRecord[] = [];
  let rawAnswer = "";
  let sessionId: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // stray non-JSON output on stdout; ignore and keep going
    }

    const message = event.message as { content?: unknown[] } | undefined;

    if (event.type === "assistant" && Array.isArray(message?.content)) {
      for (const block of message!.content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const toolName = typeof block.name === "string" ? block.name : "unknown";
        // Only Read names a single file up front; Grep's `path` input is
        // usually a directory (or absent, meaning the whole vault), so its
        // per-file attribution instead comes from parsing the result text
        // itself -- see splitGrepResultByFile above.
        const file = toolName === "Read" && typeof input.file_path === "string" ? toVaultRelative(vaultBasePath, cwd, input.file_path) : null;
        pendingByToolUseId.set(block.id, { toolUseId: block.id, toolName, file });
      }
    } else if (event.type === "user" && Array.isArray(message?.content)) {
      for (const block of message!.content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const pending = pendingByToolUseId.get(block.tool_use_id);
        if (!pending) continue;
        const text = extractText(block.content);

        if (pending.toolName === "Grep") {
          // splitGrepResultByFile's keys are relative to cwd (ripgrep prints
          // paths relative to wherever it was run from) -- convert each to
          // vault-relative the same way Read's file_path is, so a scoped
          // query (cwd inside a subfolder) still produces citations keyed
          // the same way an unscoped one would.
          for (const [file, matchedText] of splitGrepResultByFile(text)) {
            const vaultRelFile = toVaultRelative(vaultBasePath, cwd, file);
            toolCalls.push({ toolUseId: pending.toolUseId, toolName: pending.toolName, file: vaultRelFile, resultText: matchedText });
          }
          continue;
        }

        if (pending.toolName !== "Read") continue; // Glob and anything else carries no quotable file content
        toolCalls.push({
          toolUseId: pending.toolUseId,
          toolName: pending.toolName,
          file: pending.file,
          resultText: stripLineNumberPrefixes(text),
        });
      }
    } else if (event.type === "result" && typeof event.result === "string") {
      rawAnswer = event.result;
    } else if (event.type === "system" && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }
  }

  return { rawAnswer, toolCalls, sessionId };
}

/**
 * Runs `claude -p <prompt>` as an agentic, read-only vault search: Claude is
 * given Read/Grep/Glob and searches the vault itself, and we capture every
 * tool call's exact input/output from the stream-json event log. That
 * transcript -- not Claude's own prose -- is the source of truth for which
 * files were actually opened and what they actually contained; parseAnswer.ts
 * cross-checks Claude's claimed citations against it before trusting any of
 * them. See /Users/elo2023/Documents/Second-Brain/citations-panel-design.md
 * for the full rationale.
 */
export async function runVaultQuery(
  claudeBin: string,
  vaultBasePath: string,
  prompt: string,
  maxTurns: number,
  scopePath: string | null,
  resumeSessionId?: string | null,
  onProgress?: (progress: QueryProgress) => void
): Promise<QueryRunResult> {
  // Real execution-level scoping, not just a prompt request: Glob/Grep both
  // default to searching their own cwd when Claude doesn't pass an explicit
  // path, so spawning inside the scoped folder means an unscoped Glob/Grep
  // call is *already* confined to it -- no tokens spent reading files
  // outside the requested folder just to discard their citations afterward.
  // Not a hard sandbox (Claude could still pass an absolute path elsewhere),
  // which is why parseAnswer.ts's isWithinScope filter stays as a backstop.
  const queryCwd = scopePath ? path.join(vaultBasePath, scopePath) : vaultBasePath;
  if (scopePath && (!existsSync(queryCwd) || !statSync(queryCwd).isDirectory())) {
    throw new Error(`Cited: scope folder "${scopePath}" doesn't exist in this vault.`);
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--allowedTools",
      "Read,Grep,Glob",
      // Belt-and-suspenders: observed --allowedTools alone still letting a
      // Bash tool_use through in manual testing (likely a quirk of testing
      // from a nested claude session, but cheap to guard against
      // regardless) -- this plugin's entire premise is read-only search,
      // so Bash is explicitly denied on top of only allow-listing the
      // read-only tools.
      "--disallowedTools",
      "Bash",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(maxTurns),
    ];
    // Carries prior turns' context forward within the same conversation
    // (confirmed working via manual testing: a second call with --resume
    // <id> correctly recalled something only mentioned in the first call).
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const child = spawn(claudeBin, args, { cwd: queryCwd });

    const rawLines: string[] = [];
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Cited: query to claude timed out"));
    }, TIMEOUT_MS);

    let turn = 0;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      rawLines.push(line);
      if (!onProgress || !line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return; // stray non-JSON output; parseTranscript already tolerates this too
      }
      // Every assistant event is a new turn against claude's own --max-turns
      // cap, whether or not it contains a tool call (a turn can be pure
      // reasoning/the final answer), so the counter increments regardless.
      if (event.type !== "assistant") return;
      turn++;
      onProgress(describeAssistantEvent(event, turn, maxTurns));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = parseTranscript(rawLines, vaultBasePath, queryCwd);
      if (code !== 0 && !result.rawAnswer) {
        reject(new Error(`Cited: claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 2000)}` : ""}`));
        return;
      }
      resolve(result);
    });
  });
}
