import { App, Modal } from "obsidian";

/** Generic yes/no confirmation, ported from Terminus's modals/ConfirmModal.ts
 *  (same idiom, own copy since plugins don't share code at runtime). Used
 *  ahead of destructive history actions -- clearing all history or deleting
 *  one conversation -- since neither has an undo path the way Terminus's
 *  "Recently resolved" list backs its own bulk actions. Resolves `false` for
 *  any dismissal path (Cancel, Escape, clicking outside), not just an
 *  explicit Cancel click. */
export class ConfirmModal extends Modal {
  private resolvePromise: ((value: boolean) => void) | null = null;

  private constructor(app: App, private title: string, private message: string, private confirmText: string) {
    super(app);
  }

  static confirm(app: App, title: string, message: string, confirmText = "Confirm"): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(app, title, message, confirmText);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: "cited-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.resolve(false));
    buttonRow.createEl("button", { text: this.confirmText, cls: "mod-cta" }).addEventListener("click", () =>
      this.resolve(true)
    );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(false);
  }

  private resolve(value: boolean): void {
    if (!this.resolvePromise) return;
    const resolvePromise = this.resolvePromise;
    this.resolvePromise = null;
    resolvePromise(value);
    this.close();
  }
}
