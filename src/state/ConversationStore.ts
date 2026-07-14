import * as fs from "fs/promises";
import * as path from "path";
import { Conversation } from "../model";
import { QueryProgress, QueryRunResult } from "../claude/queryVault";
import { parseVaultAnswer } from "../claude/parseAnswer";
import { TypedEmitter } from "../util/emitter";
import { errorMessage, isEnoent } from "../util/errors";

export type QueryRunner = (
  question: string,
  resumeSessionId: string | null,
  scopePath: string | null,
  onProgress: (progress: QueryProgress) => void
) => Promise<QueryRunResult>;
export type MtimeLookup = (vaultRelativePath: string) => number | null;

// A conversation left running indefinitely is bounded by the user starting
// a new one (see startNewConversation); this instead bounds how many past
// conversations stick around on disk once archived, same shape as
// Terminus's ActionLog.
const MAX_ARCHIVED_CONVERSATIONS = 50;

/**
 * Holds the single live conversation and notifies ChatView/CitedView.
 * Deliberately takes its Claude-querying and file-mtime lookups as injected
 * callbacks rather than depending on Obsidian's App directly, same
 * separation Terminus's PendingChangesStore keeps for testability.
 */
type ConversationStoreEvents = {
  change: [];
  "focus-claim": [string];
};

export class ConversationStore extends TypedEmitter<ConversationStoreEvents> {
  private current: Conversation;
  private archived: Conversation[] = [];
  private loading = false;
  private error: string | null = null;
  private loaded = false;
  private turnCounter = 0;
  private progress: QueryProgress | null = null;

  constructor(private logFilePath: string, private runQuery: QueryRunner, private statMtime: MtimeLookup) {
    super();
    this.current = this.newConversation();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.logFilePath, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : null;
      if (parsed?.archived && Array.isArray(parsed.archived)) this.archived = parsed.archived;
      if (parsed?.current) this.current = parsed.current;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    this.loaded = true;
    this.emit("change");
  }

  getConversation(): Conversation {
    return this.current;
  }

  isLoading(): boolean {
    return this.loading;
  }

  getError(): string | null {
    return this.error;
  }

  getProgress(): QueryProgress | null {
    return this.progress;
  }

  async askQuestion(question: string, scopePath: string | null = null): Promise<void> {
    this.loading = true;
    this.error = null;
    this.progress = null;
    this.emit("change");

    const turnId = `turn${++this.turnCounter}`;
    try {
      const result = await this.runQuery(question, this.current.sessionId, scopePath, (progress) => {
        this.progress = progress;
        this.emit("change");
      });
      const answer = parseVaultAnswer(question, turnId, result.rawAnswer, result.toolCalls, scopePath);
      for (const claim of answer.claims) {
        for (const citation of claim.citations) {
          citation.capturedMtime = this.statMtime(citation.file);
        }
      }
      this.current.turns.push(answer);
      if (result.sessionId) this.current.sessionId = result.sessionId;
      this.loading = false;
      this.progress = null;
      await this.persist();
    } catch (err) {
      this.loading = false;
      this.progress = null;
      this.error = errorMessage(err);
    }
    this.emit("change");
  }

  async startNewConversation(): Promise<void> {
    this.archiveCurrent();
    this.current = this.newConversation();
    this.error = null;
    await this.persist();
    this.emit("change");
  }

  listArchived(): Conversation[] {
    return [...this.archived];
  }

  /** Removes one archived conversation permanently -- there's no undo path
   *  for this (unlike Terminus's "Recently resolved" list backing its bulk
   *  actions), so callers are expected to confirm with the user first. A
   *  no-op if `id` isn't found (e.g. a stale reference from an already
   *  re-rendered history list). */
  async deleteConversation(id: string): Promise<void> {
    const index = this.archived.findIndex((c) => c.id === id);
    if (index === -1) return;
    this.archived.splice(index, 1);
    await this.persist();
    this.emit("change");
  }

  /** Wipes every archived conversation. Same no-undo caveat as
   *  deleteConversation. Deliberately leaves the current live conversation
   *  untouched -- "clear history" means past conversations, not whatever
   *  you're actively in the middle of. */
  async clearHistory(): Promise<void> {
    if (this.archived.length === 0) return;
    this.archived = [];
    await this.persist();
    this.emit("change");
  }

  /** Swaps an archived conversation back in as the live one -- e.g. from a
   *  history picker -- so the user can keep chatting in it: askQuestion
   *  resumes using its own stored sessionId, same as any other turn (this
   *  works even for sessions well older than the immediately-preceding
   *  one -- verified manually before building this). Whatever was active
   *  gets archived first if it has any turns, same as starting fresh. */
  openConversation(id: string): void {
    const index = this.archived.findIndex((c) => c.id === id);
    if (index === -1) return;
    const [reopened] = this.archived.splice(index, 1);
    if (!reopened) return;
    this.archiveCurrent();
    this.current = reopened;
    this.error = null;
    void this.persist();
    this.emit("change");
  }

  /** ChatView calls this when an inline marker is clicked; CitedView
   *  listens for it to scroll to and expand the matching claim. */
  focusClaim(claimId: string): void {
    this.emit("focus-claim", claimId);
  }

  /** Called from main.ts's vault "modify" listener. Flags every citation
   *  across the current conversation pointing at `filePath` as stale -- see
   *  model.ts's Citation.stale doc for what that does (and doesn't) do. */
  markFileStale(filePath: string): void {
    let changed = false;
    for (const turn of this.current.turns) {
      for (const claim of turn.claims) {
        for (const citation of claim.citations) {
          if (citation.file === filePath && !citation.stale) {
            citation.stale = true;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      void this.persist();
      this.emit("change");
    }
  }

  private archiveCurrent(): void {
    if (this.current.turns.length === 0) return;
    this.archived.unshift(this.current);
    if (this.archived.length > MAX_ARCHIVED_CONVERSATIONS) this.archived.length = MAX_ARCHIVED_CONVERSATIONS;
  }

  private newConversation(): Conversation {
    return { id: `conv${Date.now()}`, sessionId: null, turns: [], createdAt: Date.now() };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
    const payload = { current: this.current, archived: this.archived };
    await fs.writeFile(this.logFilePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
