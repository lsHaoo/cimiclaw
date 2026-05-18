import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

function readLayoutCss(): string {
  return readStyleSheet("ui/src/styles/chat/layout.css");
}

describe("chat layout styles", () => {
  it("styles queued-message steering controls and pending indicators", () => {
    const css = readLayoutCss();

    expect(css).toContain(".chat-queue__steer");
    expect(css).toContain(".chat-queue__actions");
    expect(css).toContain(".chat-queue__item--steered");
    expect(css).toContain(".chat-queue__badge");
  });

  it("includes assistant text avatar styles for configured IDENTITY avatars", () => {
    const css = readLayoutCss();

    expect(css).toContain(".agent-chat__avatar--text");
    expect(css).toContain("font-size: 20px;");
    expect(css).toContain("place-items: center;");
  });

  it("keeps embedded chat toggle buttons aligned with normal icon controls on hover", () => {
    const css = readLayoutCss();

    expect(css).toContain(".embed-chat-toggles .btn--icon {");
    expect(css).toContain("border-color: var(--border);");
    expect(css).toContain(".embed-chat-toggles .btn--icon:hover {");
    expect(css).toContain("background: var(--bg-hover);");
    expect(css).toContain("border-color: var(--border-strong);");
    expect(css).toContain(':root[data-theme-mode="light"] .embed-chat-toggles .btn--icon:hover {');
  });
});
