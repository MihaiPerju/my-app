import "../../../test/setup.js";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatMessage } from "../use-chat";

// jsdom has no layout engine, so the thread's scroll affordances are no-ops here.
globalThis.HTMLElement.prototype.scrollIntoView = () => {};

const { ChatThread } = await import("./chat-thread");
const { ChatMarkdownLinkProvider } = await import("../chat-markdown-link");

const ANSWER = [
  "## Evaluation modes",
  "",
  "- Offline, against a fixture set",
  "- Online, sampled from live traffic",
  "",
  "| Mode | Cost |",
  "| --- | --- |",
  "| Offline | low |",
  "",
  "See the [handbook](https://example.com/handbook) for the full matrix.",
].join("\n");

function renderAnswer(content: string): HTMLElement {
  const message: ChatMessage = { id: "a-1", role: "assistant", content };
  const screen = render(<ChatThread messages={[message]} />);
  return screen.container;
}

afterEach(cleanup);

describe("an assistant answer written in markdown", () => {
  test("renders block structure, not literal markdown characters", () => {
    const container = renderAnswer(ANSWER);

    expect(container.querySelector("h2")?.textContent).toBe("Evaluation modes");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("table th")?.textContent).toBe("Mode");
    expect(container.querySelector("table tbody td")?.textContent).toBe("Offline");
    expect(container.textContent).not.toContain("- Offline, against a fixture set");
  });

  test("opens links in a new tab without handing the opener over", () => {
    const anchor = renderAnswer(ANSWER).querySelector("a");

    expect(anchor?.getAttribute("href")).toBe("https://example.com/handbook");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  // `sanitizeMarkdownUrl`, which we must not switch off: model output is untrusted, and a
  // `javascript:` href is a click away from running in the user's session. It returns `undefined`,
  // coerced to `""`, so the attribute is emitted empty rather than omitted (which would be `null`).
  test("drops a javascript: href from model output", () => {
    const anchor = renderAnswer("[click](javascript:alert(1))").querySelector("a");

    expect(anchor?.getAttribute("href")).toBe("");
  });

  // No shiki: a fence is plain, styled markup and nothing more.
  test("renders a fenced code block as a plain pre/code", () => {
    const container = renderAnswer("```py\nprint(1)\n```");

    expect(container.querySelector("pre > code")?.textContent).toBe("print(1)\n");
  });

  test("renders GFM strikethrough as a del element", () => {
    const container = renderAnswer("This is ~~struck~~ text.");

    expect(container.querySelector("del")?.textContent).toBe("struck");
  });

  // A bare URL is a GFM autolink literal: it arrives as an ordinary link node and must get the
  // same sanitized, new-tab treatment as an explicit link.
  test("turns a bare URL into a sanitized new-tab link", () => {
    const anchor = renderAnswer("See https://example.com/docs for more.").querySelector("a");

    expect(anchor?.getAttribute("href")).toBe("https://example.com/docs");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  // An in-page anchor (a citation such as `#node=42`) has nothing to open in a new tab: following
  // it there loads a second copy of the app instead of focusing what it points at.
  test("keeps an in-page anchor on the page", () => {
    const anchor = renderAnswer("See [Kessel](#node=42).").querySelector("a");

    expect(anchor?.getAttribute("href")).toBe("#node=42");
    expect(anchor?.hasAttribute("target")).toBe(false);
  });

  test("renders links through the app's link renderer when one is provided", () => {
    const message: ChatMessage = {
      id: "a-1",
      role: "assistant",
      content: "Cites [Kessel](#node=42) and [docs](javascript:alert(1)).",
    };
    const seen: string[] = [];
    const screen = render(
      <ChatMarkdownLinkProvider
        renderLink={({ href, children }) => {
          seen.push(href);
          return (
            <button type="button" data-href={href}>
              {children}
            </button>
          );
        }}
      >
        <ChatThread messages={[message]} />
      </ChatMarkdownLinkProvider>,
    );

    const buttons = screen.container.querySelectorAll("button[data-href]");
    expect(buttons[0]?.textContent).toBe("Kessel");
    // The renderer receives the sanitized url, never the raw `javascript:` one.
    expect(seen).toEqual(["#node=42", ""]);
  });

  test("renders a GFM task-list item with a disabled checkbox", () => {
    const container = renderAnswer("- [x] done\n- [ ] todo");
    const checkboxes = container.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]');

    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.checked).toBe(true);
    expect(checkboxes[1]?.checked).toBe(false);
    expect(checkboxes[0]?.disabled).toBe(true);
  });

  // Raw HTML from the model is untrusted: it is rendered as inert, escaped text, never as live
  // markup, so an `onerror` payload has no element to fire on.
  test("renders raw HTML inert, with no live element or event handler", () => {
    const container = renderAnswer('<img src=x onerror="alert(1)">');

    expect(container.querySelector("img")).toBeNull();
    // The markup was escaped, not emitted as a live tag, so no element carries the `onerror`
    // handler; the raw string only survives as inert text.
    expect(container.innerHTML).not.toContain("<img");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  // The renderer runs on the server first, and a markdown stack that needs a DOM would take the
  // whole /chat route down rather than degrade — which is why shiki's wasm was disqualified.
  test("server-renders the same structure with no DOM", () => {
    const html = renderToStaticMarkup(
      <ChatThread messages={[{ id: "a-1", role: "assistant", content: ANSWER }]} />,
    );

    expect(html).toContain("markdown-container-style");
    expect(html).toContain("<h2>Evaluation modes</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
