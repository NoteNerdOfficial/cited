import { App, Modal, setIcon } from "obsidian";
import { Conversation } from "../model";
import { ConfirmModal } from "./ConfirmModal";

/** Lists archived conversations (same shape as Terminus's ActionLogModal)
 *  and lets one be reopened as the live conversation via `onSelect`, or
 *  permanently removed via `onDelete`. Keeps its own mutable copy of
 *  `conversations` so a delete can update the list in place without closing
 *  and reopening the whole modal. */
export class ConversationHistoryModal extends Modal {
  private conversations: Conversation[];
  private list!: HTMLElement;
  private searchQuery = "";

  constructor(
    app: App,
    conversations: Conversation[],
    private onSelect: (id: string) => void,
    private onDelete: (id: string) => Promise<void>
  ) {
    super(app);
    this.conversations = [...conversations];
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("cited-history-modal");
    contentEl.createEl("h3", { text: "Conversation history" });

    const searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search past questions…",
      cls: "cited-history-search",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.render();
    });

    this.list = contentEl.createDiv({ cls: "cited-history-list" });
    searchInput.focus();
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.list.empty();
    const query = this.searchQuery.trim().toLowerCase();
    const filtered = query
      ? this.conversations.filter((c) => c.turns.some((t) => t.question.toLowerCase().includes(query)))
      : this.conversations;

    if (filtered.length === 0) {
      this.list.createDiv({ cls: "cited-status", text: this.conversations.length === 0 ? "No conversation history yet" : "No matching conversations" });
      return;
    }
    for (const conversation of filtered) {
      this.renderRow(this.list, conversation);
    }
  }

  private renderRow(list: HTMLElement, conversation: Conversation): void {
    const firstQuestion = conversation.turns[0]?.question ?? "(empty conversation)";
    const row = list.createDiv({ cls: "cited-history-row" });

    const info = row.createDiv({ cls: "cited-history-row-info" });
    info.createEl("div", { cls: "cited-history-row-question", text: firstQuestion });

    const meta = info.createDiv({ cls: "cited-history-row-meta" });
    meta.createEl("span", {
      text: `${conversation.turns.length} ${conversation.turns.length === 1 ? "turn" : "turns"}`,
    });
    meta.createEl("span", { text: new Date(conversation.createdAt).toLocaleString() });

    const deleteBtn = row.createEl("button", { cls: "cited-history-delete", attr: { "aria-label": "Delete conversation" } });
    setIcon(deleteBtn, "trash-2");
    deleteBtn.addEventListener("click", (e) => {
      // Don't let the delete click also bubble into the row's own
      // click-to-reopen handler below.
      e.stopPropagation();
      void this.confirmAndDelete(conversation);
    });

    row.addEventListener("click", () => {
      this.onSelect(conversation.id);
      this.close();
    });
  }

  private async confirmAndDelete(conversation: Conversation): Promise<void> {
    const label = conversation.turns[0]?.question ?? "this conversation";
    const confirmed = await ConfirmModal.confirm(
      this.app,
      "Delete conversation?",
      `This permanently deletes "${label}" (${conversation.turns.length} ${conversation.turns.length === 1 ? "turn" : "turns"}). This can't be undone.`,
      "Delete"
    );
    if (!confirmed) return;

    await this.onDelete(conversation.id);
    this.conversations = this.conversations.filter((c) => c.id !== conversation.id);
    this.render();
  }
}
