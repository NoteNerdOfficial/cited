import { ItemView, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import { Citation, CitedAnswer, Claim } from "../model";
import { stripMarkdown } from "../util/stripMarkdown";
import type CitedPlugin from "../main";

export const CITED_VIEW_TYPE = "cited-results";

export class CitedView extends ItemView {
  // Persisted across re-renders (this view fully rebuilds its DOM on every
  // store "change", same as Terminus's PendingChangesView) so an unrelated
  // event -- a new turn, a staleness update from an unrelated file edit --
  // doesn't silently re-collapse a row the user had opened. Without this,
  // every store "change" would reset a per-row closure-local `expanded`
  // boolean back to false on rebuild.
  private expandedClaimIds = new Set<string>();
  private expandedCitationIds = new Set<string>();
  // Turn sections default open (matching Terminus's terminal groups), so
  // this tracks the exception -- turns the user explicitly collapsed --
  // rather than which ones are open.
  private collapsedTurnIds = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: CitedPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CITED_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Cited sources";
  }

  getIcon(): string {
    return "quote-glyph";
  }

  async onOpen(): Promise<void> {
    this.plugin.conversationStore.on("change", this.render);
    this.plugin.conversationStore.on("focus-claim", this.handleFocusClaim);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.conversationStore.off("change", this.render);
    this.plugin.conversationStore.off("focus-claim", this.handleFocusClaim);
  }

  private handleFocusClaim = (claimId: string): void => {
    this.expandedClaimIds.add(claimId);
    this.render();
    const row = this.contentEl.querySelector<HTMLElement>(`[data-claim-id="${CSS.escape(claimId)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  private render = (): void => {
    const container = this.contentEl;
    container.empty();
    container.addClass("cited-view");

    const conversation = this.plugin.conversationStore.getConversation();
    const turnsWithClaims = conversation.turns.filter((t) => t.claims.length > 0);

    if (turnsWithClaims.length === 0) {
      container.createDiv({ cls: "cited-status", text: "No grounded citations yet -- ask Cited a question." });
      return;
    }

    for (const turn of turnsWithClaims) {
      this.renderTurn(container, turn);
    }
  };

  /** Same collapsible-group idiom as Terminus's per-terminal groups in
   *  PendingChangesView (chevron + header + hidden list, default open) --
   *  one section per question, so a long-running conversation doesn't turn
   *  into one giant undifferentiated citation list. */
  private renderTurn(container: HTMLElement, turn: CitedAnswer): void {
    const collapsed = this.collapsedTurnIds.has(turn.turnId);

    const section = container.createDiv({ cls: "cited-turn-section" });
    const header = section.createDiv({ cls: "cited-turn-section-header" });
    const chevron = header.createEl("span", { cls: "cited-chevron", text: collapsed ? "▸" : "▾" });

    const headerText = header.createDiv({ cls: "cited-turn-section-text" });
    headerText.createDiv({ cls: "cited-turn-section-question", text: turn.question });

    const citationCount = turn.claims.reduce((sum, c) => sum + c.citations.length, 0);
    const fileCount = new Set(turn.claims.flatMap((c) => c.citations.map((cit) => cit.file))).size;
    const scopeSuffix = turn.scopePath ? ` · in ${turn.scopePath}` : "";
    headerText.createDiv({
      cls: "cited-turn-section-meta",
      text: `${citationCount} ${citationCount === 1 ? "reference" : "references"} · ${fileCount} ${fileCount === 1 ? "file" : "files"}${scopeSuffix}`,
    });

    const list = section.createDiv({ cls: "cited-claims-list" });
    list.toggle(!collapsed);
    for (const claim of turn.claims) {
      this.renderClaim(list, claim);
    }

    header.addEventListener("click", () => {
      const willBeCollapsed = !this.collapsedTurnIds.has(turn.turnId);
      if (willBeCollapsed) this.collapsedTurnIds.add(turn.turnId);
      else this.collapsedTurnIds.delete(turn.turnId);
      list.toggle(!willBeCollapsed);
      chevron.setText(willBeCollapsed ? "▸" : "▾");
    });
  }

  /** Same three-part collapsible idiom as Terminus's PendingChangesView
   *  (chevron + hidden body + toggle-on-click), reused here for a
   *  claim -> its contributing files, and again inside renderCitation for
   *  file -> its highlighted excerpt. */
  private renderClaim(list: HTMLElement, claim: Claim): void {
    const expanded = this.expandedClaimIds.has(claim.id);

    const row = list.createDiv({ cls: "cited-claim" });
    row.setAttribute("data-claim-id", claim.id);
    row.toggleClass("is-expanded", expanded);
    const summary = row.createDiv({ cls: "cited-claim-summary" });
    summary.toggleClass("is-expanded", expanded);
    const chevron = summary.createEl("span", { cls: "cited-chevron", text: expanded ? "▾" : "▸" });

    const info = summary.createDiv({ cls: "cited-claim-info" });
    info.createEl("div", { cls: "cited-claim-text", text: stripMarkdown(claim.text) });
    const fileCount = new Set(claim.citations.map((c) => c.file)).size;
    info.createEl("div", { cls: "cited-claim-meta", text: `${fileCount} ${fileCount === 1 ? "file" : "files"}` });

    const body = row.createDiv({ cls: "cited-claim-body" });
    body.toggle(expanded);
    for (const citation of claim.citations) {
      this.renderCitation(body, citation);
    }

    summary.addEventListener("click", () => {
      const next = !this.expandedClaimIds.has(claim.id);
      if (next) this.expandedClaimIds.add(claim.id);
      else this.expandedClaimIds.delete(claim.id);
      body.toggle(next);
      chevron.setText(next ? "▾" : "▸");
      row.toggleClass("is-expanded", next);
      summary.toggleClass("is-expanded", next);
    });
  }

  private renderCitation(container: HTMLElement, citation: Citation): void {
    const expanded = this.expandedCitationIds.has(citation.id);

    const row = container.createDiv({ cls: "cited-citation" });
    row.toggleClass("is-expanded", expanded);
    const summary = row.createDiv({ cls: "cited-citation-summary" });
    summary.toggleClass("is-expanded", expanded);
    const chevron = summary.createEl("span", { cls: "cited-chevron", text: expanded ? "▾" : "▸" });

    const info = summary.createDiv({ cls: "cited-citation-info" });
    info.createEl("span", { cls: "cited-citation-file", text: path.basename(citation.file) });
    info.createEl("span", {
      cls: `cited-badge cited-badge-${citation.type}`,
      text: citation.type === "quote" ? "quoted" : "inferred",
    });
    if (citation.stale) {
      info.createEl("span", { cls: "cited-badge cited-badge-stale", text: "⚠ source changed" });
    }

    const openBtn = summary.createEl("button", { text: "Open", cls: "cited-btn-solid" });
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.app.workspace.openLinkText(citation.file, "", false);
    });

    const body = row.createDiv({ cls: "cited-citation-body" });
    body.toggle(expanded);
    this.renderExcerpt(body, citation);

    summary.addEventListener("click", () => {
      const next = !this.expandedCitationIds.has(citation.id);
      if (next) this.expandedCitationIds.add(citation.id);
      else this.expandedCitationIds.delete(citation.id);
      body.toggle(next);
      chevron.setText(next ? "▾" : "▸");
      row.toggleClass("is-expanded", next);
      summary.toggleClass("is-expanded", next);
    });
  }

  /** Segment-highlight idiom ported from Terminus's diff/renderDiff.ts
   *  renderDiffLine (a list of plain/emphasized text spans rendered as
   *  span-or-textnode) -- reused here for "highlight this substring inside
   *  this captured excerpt" instead of a line diff. Falls back to plain,
   *  unhighlighted text when there's no verbatim match (inferred/unverified
   *  citations, whose `location` is null -- see parseAnswer.ts). */
  private renderExcerpt(container: HTMLElement, citation: Citation): void {
    const pre = container.createEl("pre", { cls: "cited-excerpt" });
    const code = pre.createEl("code");

    if (!citation.location) {
      code.setText(citation.excerpt);
      return;
    }

    const { from, to } = citation.location;
    const context = 80;
    const windowStart = Math.max(0, from - context);
    const windowEnd = Math.min(citation.sourceText.length, to + context);

    if (windowStart > 0) code.appendChild(activeDocument.createTextNode("…"));
    if (windowStart < from) {
      code.appendChild(activeDocument.createTextNode(citation.sourceText.slice(windowStart, from)));
    }
    code.createEl("span", { cls: "cited-excerpt-highlight", text: citation.sourceText.slice(from, to) });
    if (to < windowEnd) {
      code.appendChild(activeDocument.createTextNode(citation.sourceText.slice(to, windowEnd)));
    }
    if (windowEnd < citation.sourceText.length) code.appendChild(activeDocument.createTextNode("…"));
  }
}
