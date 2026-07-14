import { FileSystemAdapter, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import { resolveClaudeBin } from "./claude/claudeBin";
import { QueryProgress, runVaultQuery } from "./claude/queryVault";
import { buildVaultQuestionPrompt } from "./claude/parseAnswer";
import { ConversationStore } from "./state/ConversationStore";
import { CITED_VIEW_TYPE, CitedView } from "./views/CitedView";
import { CHAT_VIEW_TYPE, ChatView } from "./views/ChatView";
import { CitedSettings, CitedSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class CitedPlugin extends Plugin {
  conversationStore!: ConversationStore;
  settings: CitedSettings = DEFAULT_SETTINGS;
  private claudeBin: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CitedSettingTab(this.app, this));

    this.conversationStore = new ConversationStore(
      path.join(this.getPluginDir(), "conversations.json"),
      (question, resumeSessionId, scopePath, onProgress) => this.runQuery(question, resumeSessionId, scopePath, onProgress),
      (vaultRelativePath) => this.statMtime(vaultRelativePath)
    );
    await this.conversationStore.load();

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(CITED_VIEW_TYPE, (leaf) => new CitedView(leaf, this));

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.conversationStore.markFileStale(file.path);
      })
    );

    this.addRibbonIcon("quote-glyph", "Open Cited", () => void this.revealViews());

    this.addCommand({
      id: "ask",
      name: "Ask about your vault",
      callback: () => void this.revealViews(),
    });

    this.app.workspace.onLayoutReady(() => void this.revealViews({ onlyIfEnabled: true }));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Cited requires a desktop vault (FileSystemAdapter)");
    }
    return adapter.getBasePath();
  }

  getPluginDir(): string {
    return path.join(this.getVaultBasePath(), this.app.vault.configDir, "plugins", this.manifest.id);
  }

  async getClaudeBin(): Promise<string> {
    if (!this.claudeBin) this.claudeBin = await resolveClaudeBin();
    return this.claudeBin;
  }

  private async runQuery(
    question: string,
    resumeSessionId: string | null,
    scopePath: string | null,
    onProgress?: (progress: QueryProgress) => void
  ) {
    const claudeBin = await this.getClaudeBin();
    const prompt = buildVaultQuestionPrompt(question, scopePath);
    return runVaultQuery(claudeBin, this.getVaultBasePath(), prompt, this.settings.maxTurns, scopePath, resumeSessionId, onProgress);
  }

  private statMtime(vaultRelativePath: string): number | null {
    const file = this.app.vault.getAbstractFileByPath(vaultRelativePath);
    return file instanceof TFile ? file.stat.mtime : null;
  }

  /** Both panels live stacked in the right sidebar, as two sibling panes
   *  sharing one split rather than as tabs: CitedView ("Cited sources") on
   *  top, ChatView stacked directly below it via createLeafBySplit(...,
   *  "horizontal", false) off the sources leaf. Order matters -- the
   *  sources leaf has to exist first so the chat leaf has something to
   *  split off of. If sources is skipped (settings-disabled or already
   *  closed with no leaf to split from), chat falls back to its own fresh
   *  right-sidebar tab so it's never lost.
   *
   *  `onlyIfEnabled` gates each panel on its own "open on launch" setting
   *  -- used for the automatic onLayoutReady call so a user who only wants
   *  one panel auto-opened doesn't get both. The ribbon icon and command
   *  call this with no options, so manually asking Cited a question always
   *  reveals both regardless of the launch settings. */
  private async revealViews(options?: { onlyIfEnabled?: boolean }): Promise<void> {
    const { workspace } = this.app;
    const onlyIfEnabled = options?.onlyIfEnabled ?? false;

    let citedLeaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CITED_VIEW_TYPE)[0] ?? null;
    if (!citedLeaf && (!onlyIfEnabled || this.settings.openSourcesOnLaunch)) {
      citedLeaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await citedLeaf.setViewState({ type: CITED_VIEW_TYPE, active: false });
    }

    let chatLeaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
    if (!chatLeaf && (!onlyIfEnabled || this.settings.openChatOnLaunch)) {
      chatLeaf = citedLeaf
        ? workspace.createLeafBySplit(citedLeaf, "horizontal", false)
        : workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await chatLeaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }

    if (citedLeaf) workspace.revealLeaf(citedLeaf);
    if (chatLeaf) workspace.revealLeaf(chatLeaf);
  }
}
