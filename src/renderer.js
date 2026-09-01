/**
 * renderer.js — renders the markdown ourselves with markdown-it, tagging
 * every block element with its exact source line range (data-mdr-line /
 * data-mdr-line-end, both 1-based inclusive). No fuzzy text matching:
 * every anchor is precise.
 */

// eslint-disable-next-line no-var
var MDRRenderer = (() => {
  "use strict";

  const { qsa, el, sanitizeInto } = MDRUtil;

  function _createMd() {
    const md = window.markdownit({
      html: true,
      linkify: true,
      breaks: false,
    });

    md.core.ruler.push("mdr_source_lines", (state) => {
      for (const token of state.tokens) {
        if (!token.map) continue;
        const isOpen = token.type.endsWith("_open");
        const isLeaf = ["fence", "code_block", "hr", "table_open"].includes(token.type);
        if (!isOpen && !isLeaf) continue;
        token.attrSet("data-mdr-line", String(token.map[0] + 1));
        token.attrSet("data-mdr-line-end", String(token.map[1]));
      }
    });

    return md;
  }

  /**
   * Render markdown text into a sanitized .markdown-body host element.
   */
  function render(markdownText) {
    const md = _createMd();
    const host = el("div", { className: "markdown-body mdr-doc" });
    host.innerHTML = md.render(markdownText || "");
    sanitizeInto(host);
    return host;
  }

  function _rangeOf(node) {
    const start = parseInt(node.getAttribute("data-mdr-line"), 10);
    const end = parseInt(node.getAttribute("data-mdr-line-end") || node.getAttribute("data-mdr-line"), 10);
    return { start, end: Math.max(start, end) };
  }

  /**
   * The tightest block containing a given source line.
   */
  function blockForLine(host, lineNum) {
    let best = null;
    let bestSpan = Infinity;
    for (const node of qsa("[data-mdr-line]", host)) {
      const { start, end } = _rangeOf(node);
      if (lineNum < start || lineNum > end) continue;
      const span = end - start;
      if (span < bestSpan) {
        best = node;
        bestSpan = span;
      }
    }
    return best;
  }

  /**
   * Source line range for an arbitrary DOM node inside the rendered doc.
   */
  function lineRangeForNode(host, node) {
    let current = node instanceof Element ? node : node?.parentElement;
    while (current && current !== host) {
      if (current.hasAttribute && current.hasAttribute("data-mdr-line")) {
        return { ..._rangeOf(current), el: current };
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * Head lines that don't appear in the base file (added/modified) —
   * a cheap multiset diff used purely as a visual cue.
   */
  function changedLines(baseText, headText) {
    const changed = new Set();
    if (!baseText || !headText) return changed;

    const baseCount = new Map();
    for (const line of baseText.split("\n")) {
      baseCount.set(line, (baseCount.get(line) || 0) + 1);
    }
    headText.split("\n").forEach((line, i) => {
      const count = baseCount.get(line) || 0;
      if (count > 0) baseCount.set(line, count - 1);
      else changed.add(i + 1);
    });
    return changed;
  }

  return { render, blockForLine, lineRangeForNode, changedLines };
})();
