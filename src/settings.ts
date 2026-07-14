import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ConfirmModal } from "./modals/ConfirmModal";
import type CitedPlugin from "./main";

export interface CitedSettings {
  /** Passed straight through as claude's own --max-turns -- bounds how many
   *  agentic search/read round trips a single query can take, since an
   *  unbounded Glob/Grep sweep over a large vault is the main cost/latency
   *  risk called out in the design doc. */
  maxTurns: number;
  /** Vault-relative folder "Export to note" creates notes in. Created on
   *  first export if it doesn't exist yet. Empty string means the vault
   *  root. */
  citationsFolder: string;
  /** Whether the chat panel auto-opens on Obsidian launch (onLayoutReady).
   *  Independent of openSourcesOnLaunch -- the ribbon icon/command always
   *  open both regardless of these. */
  openChatOnLaunch: boolean;
  /** Same as openChatOnLaunch, for the citations ("sources") panel. */
  openSourcesOnLaunch: boolean;
}

export const DEFAULT_SETTINGS: CitedSettings = {
  maxTurns: 8,
  citationsFolder: "Citations",
  openChatOnLaunch: true,
  openSourcesOnLaunch: true,
};

export const MIN_MAX_TURNS = 1;
export const MAX_MAX_TURNS = 30;

export class CitedSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CitedPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Max search turns per question")
      .setDesc(
        `How many agentic search/read round trips (claude's own --max-turns) a single question is allowed before it has to answer with whatever it's found so far (${MIN_MAX_TURNS}-${MAX_MAX_TURNS}). Higher allows more thorough searches of a large vault at the cost of slower, more expensive queries.`
      )
      .addSlider((slider) =>
        slider
          .setLimits(MIN_MAX_TURNS, MAX_MAX_TURNS, 1)
          .setValue(this.plugin.settings.maxTurns)
          .onChange(async (value) => {
            this.plugin.settings.maxTurns = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Citations export folder")
      .setDesc('Vault folder "Export to note" saves into (created automatically if it doesn\'t exist yet). Leave blank for the vault root.')
      .addText((text) =>
        text
          .setPlaceholder("e.g. Citations")
          .setValue(this.plugin.settings.citationsFolder)
          .onChange(async (value) => {
            this.plugin.settings.citationsFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Open on launch").setHeading();

    new Setting(containerEl)
      .setName("Open chat panel on launch")
      .setDesc("Automatically open the Cited chat panel when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openChatOnLaunch).onChange(async (value) => {
          this.plugin.settings.openChatOnLaunch = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open sources panel on launch")
      .setDesc("Automatically open the Cited sources (citations) panel when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openSourcesOnLaunch).onChange(async (value) => {
          this.plugin.settings.openSourcesOnLaunch = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("History").setHeading();

    new Setting(containerEl)
      .setName("Clear conversation history")
      .setDesc(
        "Permanently deletes every archived conversation (up to 50 are kept). Your current, active conversation is not affected. This can't be undone -- individual conversations can also be deleted one at a time from the History picker in the chat panel."
      )
      .addButton((button) =>
        button
          .setButtonText("Clear history")
          .setWarning()
          .onClick(async () => {
            const confirmed = await ConfirmModal.confirm(
              this.app,
              "Clear conversation history?",
              "This permanently deletes every archived conversation. This can't be undone.",
              "Clear history"
            );
            if (!confirmed) return;
            await this.plugin.conversationStore.clearHistory();
            new Notice("Cited: conversation history cleared.");
          })
      );
  }
}
