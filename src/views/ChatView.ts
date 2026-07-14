import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import { CitedAnswer } from "../model";
import { insertDomMarkers } from "../citations/markers";
import { exportAnswerToNote } from "../export/exportToNote";
import { ConversationHistoryModal } from "../modals/ConversationHistoryModal";
import { FolderSuggest } from "../ui/FolderSuggest";
import { errorMessage } from "../util/errors";
import type CitedPlugin from "../main";

export const CHAT_VIEW_TYPE = "cited-chat";

export class ChatView extends ItemView {
  private inputEl: HTMLTextAreaElement | null = null;
  // Preserved across re-renders (full rebuild on every store "change", same
  // as PendingChangesView) so an external event -- e.g. markFileStale
  // firing because the user edited an unrelated note in another pane --
  // doesn't wipe out a question they're mid-typing here.
  private draftText = "";
  // Per-question, not per-conversation: the user can narrow or widen scope
  // freely between questions in the same conversation. Empty string means
  // the whole vault. Preserved across re-renders for the same reason as
  // draftText above.
  private draftScopePath = "";

  constructor(leaf: WorkspaceLeaf, private plugin: CitedPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Cited";
  }

  getIcon(): string {
    return "quote-glyph";
  }

  async onOpen(): Promise<void> {
    this.plugin.conversationStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.conversationStore.off("change", this.render);
  }

  private render = (): void => {
    const container = this.contentEl;
    container.empty();
    container.addClass("cited-chat-view");

    const header = container.createDiv({ cls: "cited-chat-header" });
    header.createEl("span", { text: "Cited", cls: "cited-chat-title" });

    const headerActions = header.createDiv({ cls: "cited-chat-header-actions" });
    headerActions
      .createEl("button", { text: "History", cls: "cited-btn-outline" })
      .addEventListener("click", () => this.openHistory());
    headerActions
      .createEl("button", { text: "New conversation", cls: "cited-btn-solid" })
      .addEventListener("click", () => void this.plugin.conversationStore.startNewConversation());

    const history = container.createDiv({ cls: "cited-chat-history" });
    const conversation = this.plugin.conversationStore.getConversation();
    const loading = this.plugin.conversationStore.isLoading();

    if (conversation.turns.length === 0 && !loading) {
      history.createDiv({ cls: "cited-status", text: "Ask a question about your vault to get started." });
    }

    for (const turn of conversation.turns) {
      this.renderTurn(history, turn);
    }

    const error = this.plugin.conversationStore.getError();
    if (error) history.createDiv({ cls: "cited-status cited-status-error", text: `Error: ${error}` });
    if (loading) this.renderProgress(history);

    // Keep the latest turn in view after every re-render, not just after
    // submitting a question -- a stale-badge update should still surface a
    // freshly-appended turn if the user scrolled up in the meantime.
    history.scrollTop = history.scrollHeight;

    this.renderInputRow(container, loading);
  };

  /** Live "how far along is it" status while a query is running, built from
   *  ConversationStore's progress state (populated turn-by-turn as the
   *  stream-json log arrives -- see queryVault.ts's runVaultQuery). Falls
   *  back to a generic message before the first assistant turn has streamed
   *  in yet (there's always a brief gap while claude starts up). */
  private renderProgress(container: HTMLElement): void {
    const progress = this.plugin.conversationStore.getProgress();
    const wrapper = container.createDiv({ cls: "cited-status cited-progress" });

    if (!progress) {
      wrapper.createDiv({ cls: "cited-progress-label", text: "Starting search…" });
      return;
    }

    // Claude's own turn accounting doesn't map 1:1 to one stream-json
    // "assistant" event per turn (a single turn can involve several), so the
    // raw turn count can run past maxTurns while the query is still
    // genuinely in progress. A percentage that's clamped at 100% for that
    // whole remaining stretch reads as frozen/stuck even though it isn't --
    // instead, once we're past the point our own count stops being a
    // reliable fraction, drop the percentage entirely and lean on the tool
    // description (which keeps changing turn-by-turn regardless) as the
    // "still actively working" signal instead of a stalled number.
    const overBudget = progress.turn > progress.maxTurns;
    const percent = Math.min(99, Math.round((progress.turn / progress.maxTurns) * 100));
    const bar = wrapper.createDiv({ cls: "cited-progress-bar" });
    const fill = bar.createDiv({ cls: "cited-progress-bar-fill" });
    fill.style.width = `${percent}%`;
    fill.toggleClass("is-wrapping-up", overBudget);
    wrapper.createDiv({
      cls: "cited-progress-label",
      text: overBudget ? `Wrapping up — ${progress.label}` : `${percent}% — ${progress.label}`,
    });
  }

  private renderTurn(container: HTMLElement, turn: CitedAnswer): void {
    const turnEl = container.createDiv({ cls: "cited-turn" });
    if (turn.scopePath) {
      turnEl.createDiv({ cls: "cited-badge cited-badge-scope", text: `in ${turn.scopePath}` });
    }
    turnEl.createDiv({ cls: "cited-turn-question", text: turn.question });

    const answerEl = turnEl.createDiv({ cls: "cited-turn-answer" });
    void MarkdownRenderer.render(this.app, turn.answer, answerEl, "", this).then(() => {
      insertDomMarkers(answerEl, turn.claims, (claimId) => this.plugin.conversationStore.focusClaim(claimId));
    });

    if (turn.claims.length > 0) {
      const actions = turnEl.createDiv({ cls: "cited-turn-actions" });
      actions
        .createEl("button", { text: "Export to note", cls: "cited-btn-accent" })
        .addEventListener("click", () => {
          void exportAnswerToNote(this.app, turn, this.plugin.settings.citationsFolder).catch((err: unknown) => {
            new Notice(`Cited: export failed: ${errorMessage(err)}`);
          });
        });
    }
  }

  private renderInputRow(container: HTMLElement, loading: boolean): void {
    const scopeRow = container.createDiv({ cls: "cited-chat-scope-row" });
    scopeRow.createSpan({ cls: "cited-chat-scope-label", text: "Search in" });
    const scopeInput = scopeRow.createEl("input", {
      cls: "cited-chat-scope-input",
      attr: { type: "text", placeholder: "Entire vault" },
    });
    scopeInput.value = this.draftScopePath;
    scopeInput.disabled = loading;
    scopeInput.addEventListener("input", () => {
      this.draftScopePath = scopeInput.value;
    });
    new FolderSuggest(this.app, scopeInput);

    const row = container.createDiv({ cls: "cited-chat-input-row" });
    const input = row.createEl("textarea", {
      cls: "cited-chat-input",
      attr: { rows: "2", placeholder: "Ask a question about your vault…" },
    });
    input.value = this.draftText;
    input.disabled = loading;
    input.addEventListener("input", () => {
      this.draftText = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.inputEl = input;

    const askBtn = row.createEl("button", { text: "Ask", cls: "cited-btn-solid" });
    askBtn.disabled = loading;
    askBtn.addEventListener("click", () => this.submit());
  }

  private submit(): void {
    if (this.plugin.conversationStore.isLoading()) return;
    const question = (this.inputEl?.value ?? "").trim();
    if (!question) return;
    const scopePath = this.draftScopePath.trim().replace(/^\/+|\/+$/g, "");
    this.draftText = "";
    void this.plugin.conversationStore.askQuestion(question, scopePath || null);
  }

  private openHistory(): void {
    const archived = this.plugin.conversationStore.listArchived();
    new ConversationHistoryModal(
      this.app,
      archived,
      (id) => this.plugin.conversationStore.openConversation(id),
      (id) => this.plugin.conversationStore.deleteConversation(id)
    ).open();
  }
}
