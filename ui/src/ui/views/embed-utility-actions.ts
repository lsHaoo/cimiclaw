import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { Tab } from "../navigation.ts";

type EmbedUtilityActionTab = Extract<Tab, "skills" | "usage">;

export function renderEmbedUtilityActions(params: {
  activeTab?: EmbedUtilityActionTab | null;
  onNavigate: (tab: EmbedUtilityActionTab) => void;
}) {
  return html`
    <div class="embed-utility-bar__actions">
      <button
        type="button"
        class=${params.activeTab === "skills" ? "button--active" : ""}
        @click=${() => params.onNavigate("skills")}
      >
        ${t("tabs.skills")}
      </button>
      <button
        type="button"
        class=${params.activeTab === "usage" ? "button--active" : ""}
        @click=${() => params.onNavigate("usage")}
      >
        ${t("tabs.usage")}
      </button>
    </div>
  `;
}
