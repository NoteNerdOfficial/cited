import { AbstractInputSuggest, App, TFolder } from "obsidian";

/** Type-ahead folder picker for a plain text input, same idiom as Obsidian's
 *  own "Move file" dialog. Used by ChatView's per-question scope field --
 *  the input itself stays a plain vault-relative-path string, this just
 *  helps the user spell it correctly. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    const matches: TFolder[] = [];

    const visit = (folder: TFolder) => {
      if (folder.path !== "/" && folder.path.toLowerCase().includes(lowerQuery)) matches.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) visit(child);
      }
    };
    visit(this.app.vault.getRoot());

    return matches.slice(0, 20);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.inputEl.trigger("input");
    this.close();
  }
}
