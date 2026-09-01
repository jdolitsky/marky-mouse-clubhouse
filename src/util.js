/**
 * util.js — shared helpers for MD Docs Review.
 */

// eslint-disable-next-line no-var
var MDRUtil = (() => {
  "use strict";

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value;
      else if (key === "textContent") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else if (child instanceof Node) node.appendChild(child);
    }
    return node;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(probe, timeoutMs = 5000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let result = null;
      try { result = probe(); } catch { result = null; }
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  function debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement) || !node.isConnected) return false;
    return node.offsetParent !== null || node.getClientRects().length > 0;
  }

  function normalizeText(text) {
    return (text || "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isPRFilesPage() {
    return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)/.test(
      window.location.href
    );
  }

  /**
   * Strip active content (scripts, handlers, javascript: URLs) from a node's
   * subtree in place. Used for both our rendered markdown and any HTML lifted
   * from GitHub's pages.
   */
  function sanitizeInto(node) {
    qsa("script, style, iframe, object, embed, form, link, meta, video, audio", node)
      .forEach((n) => n.remove());
    for (const child of qsa("*", node)) {
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || /^\s*javascript:/i.test(String(attr.value || ""))) {
          child.removeAttribute(attr.name);
        }
      }
    }
    return node;
  }

  function formatTime(text) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      });
    }
    return text || "";
  }

  /** "just now", "31m ago", "4h ago", "4d ago", "3mo ago", "2y ago". */
  function relativeTime(text) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text || "";
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 45) return "just now";
    const units = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
    for (const [suffix, span] of units) {
      if (seconds >= span) return `${Math.floor(seconds / span)}${suffix} ago`;
    }
    return `${seconds}s ago`;
  }

  const logInfo = (...args) => console.log("[MD Docs Review]", ...args);
  const logWarn = (...args) => console.warn("[MD Docs Review]", ...args);

  /** Octicon "book" (16px), matching GitHub's own tab icons. */
  function bookIconSvg(className = "octicon octicon-book") {
    return `<svg aria-hidden="true" focusable="false" class="${className}" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="vertical-align: text-bottom;"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"></path></svg>`;
  }

  return {
    qs, qsa, el, sleep, waitFor, debounce, isVisible, normalizeText,
    isPRFilesPage, sanitizeInto, formatTime, relativeTime, bookIconSvg, logInfo, logWarn,
  };
})();
