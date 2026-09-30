import { JSDOM } from "jsdom";

// `pretendToBeVisual` supplies requestAnimationFrame. Without it framer-motion cannot tick, so
// an `AnimatePresence` exit never completes and the element it is retiring stays in the DOM
// forever — a test asserting something has gone away can never pass.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;

const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  self: window,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLFormElement: window.HTMLFormElement,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  FocusEvent: window.FocusEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  // jsdom lays nothing out and does not implement scrolling; the router restores scroll on navigation.
  scrollTo: () => undefined,
};

for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

// `AbortController` is Bun's, not jsdom's, so a listener registered on a jsdom node with
// `{ signal }` (react-resizable-panels does, for its resize handles) fails jsdom's type check.
// Bridge the signal instead: a jsdom signal that aborts when Bun's does.
const addEventListener = window.EventTarget.prototype.addEventListener;
window.EventTarget.prototype.addEventListener = function (type, listener, options) {
  // `options` is a boolean (capture) or an options object; only the object form carries a signal.
  const signal = options instanceof Object ? options.signal : undefined;
  if (signal === undefined || signal instanceof window.AbortSignal) {
    return addEventListener.call(this, type, listener, options);
  }
  const bridged = new window.AbortController();
  if (signal.aborted) bridged.abort();
  else signal.addEventListener("abort", () => bridged.abort(), { once: true });
  return addEventListener.call(this, type, listener, { ...options, signal: bridged.signal });
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
