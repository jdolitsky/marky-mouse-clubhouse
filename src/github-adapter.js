/**
 * github-adapter.js — the ONLY module that touches GitHub's DOM or endpoints.
 *
 * Everything GitHub-shaped lives here: payload mining, raw file fetching,
 * and the drivers that operate GitHub's native review UI (post, reply,
 * resolve, thread scraping). When GitHub redeploys and something breaks,
 * this is the only file to fix.
 *
 * All write actions round-trip through the file's source-diff view. The
 * review panel is a full overlay, so these trips are invisible to the user.
 */

// eslint-disable-next-line no-var
var MDRAdapter = (() => {
  "use strict";

  const { qs, qsa, sleep, waitFor, isVisible, normalizeText, logInfo, logWarn, sanitizeInto } = MDRUtil;

  /* ---------------- Embedded payload ---------------- */

  function _payload() {
    const scriptEl = document.querySelector('script[data-target="react-app.embeddedData"]');
    if (!scriptEl) return null;
    try { return JSON.parse(scriptEl.textContent); } catch { return null; }
  }

  function _route() {
    const payload = _payload();
    return payload?.payload?.pullRequestsChangesRoute ||
           payload?.payload?.pullRequestsFilesRoute || null;
  }

  function _diffSummaries() {
    return _route()?.diffSummaries || [];
  }

  function _isOid(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
  }

  function _headOid() {
    const route = _route();
    const candidates = [
      route?.comparison?.fullDiff?.headOid,
      route?.comparison?.headOid,
      route?.comparison?.headRefOid,
      route?.comparison?.headRef?.target?.oid,
      route?.pullRequest?.headRefOid,
      _payload()?.payload?.pullRequest?.headRefOid,
    ];
    return candidates.find(_isOid) || "";
  }

  function _baseOid() {
    const route = _route();
    const candidates = [
      route?.comparison?.fullDiff?.baseOid,
      route?.comparison?.baseOid,
      route?.comparison?.baseRefOid,
      route?.comparison?.baseRef?.target?.oid,
      route?.pullRequest?.baseRefOid,
      _payload()?.payload?.pullRequest?.baseRefOid,
    ];
    return candidates.find(_isOid) || "";
  }

  function _repoInfo() {
    const repo = _route()?.repository || {};
    return { owner: repo.ownerLogin || "", name: repo.name || "" };
  }

  function _headRepoInfo() {
    const route = _route();
    const headRepo =
      route?.comparison?.fullDiff?.headRepository ||
      route?.comparison?.headRepository ||
      route?.comparison?.headRef?.repository || null;
    if (headRepo) {
      return { owner: headRepo.ownerLogin || headRepo.owner?.login || "", name: headRepo.name || "" };
    }
    return _repoInfo();
  }

  /* ---------------- File discovery ---------------- */

  function _normalizePath(path) {
    return (path || "").trim().replace(/^\/+/, "");
  }

  function _containerFilePath(container) {
    const candidates = [
      container.getAttribute("data-tagsearch-path"),
      container.getAttribute("data-path"),
      qs(".file-header a[title]", container)?.getAttribute("title"),
      qs(".file-info a[title]", container)?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = _normalizePath(candidate);
      if (normalized) return normalized;
    }
    for (const link of qsa(".file-header a, .file-info a", container)) {
      const title = _normalizePath(link.getAttribute("title") || "");
      if (title) return title;
      const text = _normalizePath(link.textContent || "");
      if (text && (text.includes("/") || /\.[a-z0-9]+$/i.test(text))) return text;
    }
    return "";
  }

  /**
   * All markdown files on the current PR "Files changed" page.
   * Returns [{container, digest, path, markersMap}].
   */
  function files() {
    const summaryByDigest = new Map();
    for (const summary of _diffSummaries()) {
      const digest = String(summary?.pathDigest || "");
      if (digest) summaryByDigest.set(digest, summary);
    }

    const results = [];
    const seenDigests = new Set();
    for (const container of qsa("div[id^='diff-']")) {
      const digest = String((container.id || "").replace(/^diff-/, ""));
      if (!/^[0-9a-f]{10,}$/i.test(digest)) continue;
      // GitHub's progressive render can briefly duplicate containers
      if (seenDigests.has(digest)) continue;

      const summary = summaryByDigest.get(digest) || {};
      const path = _normalizePath(summary.path || _containerFilePath(container));
      if (!/\.md$/i.test(path)) continue;

      seenDigests.add(digest);
      results.push({ container, digest, path, markersMap: summary.markersMap || {} });
    }
    return results;
  }

  /**
   * Count of changed markdown files from the payload's diffSummaries —
   * stable from first render, unlike the DOM container count.
   */
  function mdFileCount() {
    const summaries = _diffSummaries();
    if (summaries.length > 0) {
      return summaries.filter((s) => /\.md$/i.test(String(s?.path || ""))).length;
    }
    return files().length;
  }

  /** Like mdFileCount, but null while the payload hasn't loaded yet —
   * lets callers distinguish "zero md files" from "don't know yet". */
  function mdFileCountKnown() {
    const summaries = _diffSummaries();
    if (summaries.length === 0) return null;
    return summaries.filter((s) => /\.md$/i.test(String(s?.path || ""))).length;
  }

  /**
   * Markdown file count when we're NOT on the diff view (e.g. the
   * Conversation tab): fetch the changes page in the background and read
   * its embedded payload. Cached per PR for 5 minutes, single-flight.
   */
  const _remoteCountPromises = new Map();

  function fetchMdFileCountRemote() {
    const m = window.location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/);
    if (!m) return Promise.resolve(null);
    const key = `mdr-count:${m[1]}`;

    try {
      const cached = sessionStorage.getItem(key);
      if (cached !== null) {
        const { count, at } = JSON.parse(cached);
        if (Date.now() - at < 5 * 60 * 1000) return Promise.resolve(count);
      }
    } catch { /* ignore */ }

    if (_remoteCountPromises.has(key)) return _remoteCountPromises.get(key);

    const promise = (async () => {
      try {
        const resp = await fetch(m[1] + "/changes", {
          credentials: "same-origin",
          headers: { accept: "text/html" },
        });
        if (!resp.ok) return null;
        const html = await resp.text();
        const scriptMatch = html.match(
          /<script[^>]*data-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/
        );
        if (!scriptMatch) return null;

        const payload = JSON.parse(scriptMatch[1]);
        const route = payload?.payload?.pullRequestsChangesRoute ||
          payload?.payload?.pullRequestsFilesRoute;
        const summaries = route?.diffSummaries || [];
        const count = summaries.filter((s) => /\.md$/i.test(String(s?.path || ""))).length;

        try { sessionStorage.setItem(key, JSON.stringify({ count, at: Date.now() })); } catch { /* ignore */ }
        return count;
      } catch (e) {
        logWarn("Remote md count failed", e);
        return null;
      } finally {
        _remoteCountPromises.delete(key);
      }
    })();

    _remoteCountPromises.set(key, promise);
    return promise;
  }

  function headerRowFor(container) {
    const headerWrapper = qs("[class*='Diff-module__diffHeaderWrapper__']", container);
    if (!headerWrapper) return null;
    return (
      qs("[class*='DiffFileHeader-module__diff-file-header__']", headerWrapper) ||
      headerWrapper
    );
  }

  /* ---------------- Raw file content ---------------- */

  const _rawCache = new Map();

  function _looksLikeHtml(text) {
    const sample = (text || "").slice(0, 300).toLowerCase();
    return sample.includes("<!doctype html") || sample.includes("<html");
  }

  async function _fetchRawByOid(path, oid) {
    if (!_isOid(oid) || !path) return null;

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const repos = [_headRepoInfo(), _repoInfo()];
    const urls = [];
    for (const repo of repos) {
      if (repo.owner && repo.name) {
        urls.push(`https://github.com/${repo.owner}/${repo.name}/raw/${oid}/${encodedPath}`);
      }
    }

    for (const url of [...new Set(urls)]) {
      if (_rawCache.has(url)) return _rawCache.get(url);
      try {
        const resp = await fetch(url, { credentials: "same-origin" });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (_looksLikeHtml(text)) continue;
        _rawCache.set(url, text);
        return text;
      } catch (e) {
        logWarn("Raw fetch failed", url, e);
      }
    }
    return null;
  }

  function fetchHeadFile(path) {
    return _fetchRawByOid(path, _headOid());
  }

  function fetchBaseFile(path) {
    return _fetchRawByOid(path, _baseOid());
  }

  /* ---------------- Comment stats from markers ---------------- */

  function _threadResolved(thread) {
    if (!thread || typeof thread !== "object") return false;
    if (typeof thread.isResolved === "boolean") return thread.isResolved;
    if (typeof thread.resolved === "boolean") return thread.resolved;
    const state = String(thread.state || thread.resolutionState || thread.viewerThreadStatus || "").toLowerCase();
    return state === "resolved";
  }

  /**
   * Map of lineNum -> {total, resolved} from the payload's markersMap.
   * These counts exist even when comment bodies aren't available.
   */
  function commentStats(markersMap) {
    const stats = new Map();
    for (const [lineKey, markerData] of Object.entries(markersMap || {})) {
      const m = lineKey.match(/^[A-Z]?(\d+)$/i);
      if (!m) continue;
      const lineNum = parseInt(m[1], 10);
      if (!lineNum) continue;

      const threads = Array.isArray(markerData?.threads) ? markerData.threads : [];
      if (threads.length === 0) continue;
      stats.set(lineNum, {
        total: threads.length,
        resolved: threads.filter(_threadResolved).length,
      });
    }
    return stats;
  }

  /* ---------------- Source view helpers ---------------- */

  function _isSourceVisible(container) {
    return Boolean(
      qs("td[data-line-number]", container) ||
      qs("a[data-line-number]", container) ||
      qs(".blob-code", container)
    );
  }

  function _isRichVisible(container) {
    const article = qs("article", container);
    if (!article || article.children.length === 0) return false;
    const style = window.getComputedStyle(article);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function _controlLabel(node) {
    return normalizeText(`${node?.textContent || ""} ${node?.getAttribute?.("aria-label") || ""}`);
  }

  function _viewControls(container) {
    const roots = qsa('ul[aria-label="File view"], [role="tablist"][aria-label*="File view" i]', container);
    const controls = [];
    for (const root of roots) controls.push(...qsa("button, [role='tab'], a", root));
    if (controls.length > 0) return controls;
    return qsa('button[aria-label], [role="tab"][aria-label]', container);
  }

  function _sourceButton(container) {
    const byAria = qs('button[aria-label*="Source" i]', container);
    if (byAria) return byAria;
    return _viewControls(container).find((node) => {
      const label = _controlLabel(node);
      if (!label || label.includes("rich") || label.includes("render")) return false;
      return label.includes("source") || label === "code";
    }) || null;
  }

  function _richButton(container) {
    const byAria = qs('button[aria-label*="Rich" i], [role="tab"][aria-label*="Rich" i]', container);
    if (byAria) return byAria;
    return _viewControls(container).find((node) => {
      const label = _controlLabel(node);
      return label.includes("rich") || label.includes("rendered");
    }) || null;
  }

  async function _ensureSourceView(container) {
    if (_isSourceVisible(container)) return true;
    const btn = _sourceButton(container);
    if (btn) btn.click();
    return Boolean(await waitFor(() => _isSourceVisible(container), 6000, 150));
  }

  function _restoreRichView(container) {
    if (_isRichVisible(container)) return;
    const btn = _richButton(container);
    if (btn) btn.click();
  }

  function _findLineTarget(container, digest, lineNum) {
    const byId = container.querySelector(`[id="diff-${digest}R${lineNum}"]`);
    if (byId) return byId;
    const selectors = [
      `[data-line-anchor="diff-${digest}R${lineNum}"]`,
      `td[data-line-number="${lineNum}"][data-diff-side="RIGHT"]`,
      `td[data-line-number="${lineNum}"][data-diff-side="right"]`,
      `td[data-line-number="${lineNum}"]`,
      `a[data-line-number="${lineNum}"]`,
    ];
    for (const sel of selectors) {
      const hit = qs(sel, container);
      if (hit) return hit;
    }
    return null;
  }

  function _expandCollapsedSections(container) {
    const tokens = ["load diff", "load more", "show more", "expand", "unfold"];
    const buttons = qsa("button", container).filter((btn) => {
      if (!btn || btn.disabled) return false;
      const label = _controlLabel(btn);
      if (!label || label.includes("collapse")) return false;
      return tokens.some((t) => label.includes(t));
    });
    for (const btn of buttons.slice(0, 6)) btn.click();
    return buttons.length > 0;
  }

  /* ---------------- Synthetic input helpers ---------------- */

  function _dispatchPointerAndMouse(node, types) {
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
    const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
    for (const type of types) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ctor(type, {
        bubbles: !type.endsWith("enter") && !type.endsWith("leave"),
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        detail: 1,
        clientX,
        clientY,
      }));
    }
  }

  function _pressKey(node, key) {
    const code = key === " " ? "Space" : key;
    for (const type of ["keydown", "keypress", "keyup"]) {
      node.dispatchEvent(new KeyboardEvent(type, {
        key, code, bubbles: true, cancelable: true,
      }));
    }
  }

  // Blocks anchor default-navigation while we dispatch synthetic clicks —
  // preventDefault only, so React's own handlers still receive the event.
  function _navGuard(e) {
    if (e.target?.closest?.("a[href]")) e.preventDefault();
  }

  function _activate(node) {
    try { node.focus?.(); } catch { /* ignore */ }
    document.addEventListener("click", _navGuard, true);
    try {
      _fullClick(node);
    } finally {
      document.removeEventListener("click", _navGuard, true);
    }
    // NOTE: deliberately no synthetic Enter here — on toggle buttons a
    // click+Enter pair expands and immediately re-collapses.
  }

  /**
   * Only these are safe to click while hunting for a thread expander:
   * never anchors (they navigate), never avatar images, never controls
   * inside an already-expanded thread, never destructive/menu buttons.
   */
  function _safeExpansionCandidate(node) {
    if (!node) return false;
    if (node.tagName === "IMG" || node.tagName === "A") return false;
    if (node.closest("a[href]")) return false;
    if (node.closest("[data-testid='review-thread'], [data-testid='unified-comment-actions']")) return false;
    const label = _controlLabel(node);
    if (/collapse|actions|react|resolve|reply|profile|more|delete|edit|copy/.test(label)) return false;
    return true;
  }

  function _coaxHover(row) {
    for (const target of [row, ...qsa("td, th", row)]) {
      _dispatchPointerAndMouse(target, [
        "pointerover", "pointerenter", "pointermove",
        "mouseover", "mouseenter", "mousemove",
      ]);
    }
  }

  function _fullClick(node) {
    _dispatchPointerAndMouse(node, [
      "pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup",
    ]);
    node.click();
  }

  // Our own UI roots. IMPORTANT: never use a `[class*='mdr-']` ancestor
  // match for this — the overlay puts `mdr-no-scroll` on <html>, which
  // would make every element on the page match.
  const OUR_UI_SELECTOR = ".mdr-overlay, .mdr-toolbar, .mdr-open-slot, .mdr-open-btn";

  function _findEditors(scope) {
    return qsa("textarea, [contenteditable='true']", scope)
      .filter((node) =>
        !node.closest(OUR_UI_SELECTOR) &&
        isVisible(node) && !node.disabled && !node.readOnly
      );
  }

  function _freshEditor(beforeSet, scope) {
    return _findEditors(scope).find((node) => !beforeSet.has(node)) || null;
  }

  function _setEditorText(editor, text) {
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    editor.focus();
    try {
      window.getSelection().selectAllChildren(editor);
      document.execCommand("insertText", false, text);
    } catch { /* fall through */ }
    if ((editor.textContent || "").trim() !== text.trim()) {
      editor.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText", data: text, bubbles: true, cancelable: true,
      }));
    }
  }

  function _editorText(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : (editor.textContent || "");
  }

  /* ---------------- Native form location ---------------- */

  // Thread UI regions inside a row — never valid add-comment targets
  // (they contain buttons like "Resolve …'s comment" and "Actions for …'s
  // comment" that would match a naive [aria-label*='comment'] catch-all).
  const _THREAD_UI_SELECTOR =
    "[data-inline-markers], [data-testid='review-thread'], [data-testid='unified-comment-actions'], [data-marker-id]";

  function _addCommentButtons(row) {
    const usable = (btn) => !btn.disabled && !btn.closest(_THREAD_UI_SELECTOR);

    const selectors = [
      "button.js-add-line-comment",
      "button[data-testid*='add' i][data-testid*='comment' i]",
      "button[aria-label*='add line comment' i]",
      "button[aria-label*='add a comment' i]",
      "button[aria-label*='add comment' i]",
      "button[aria-label*='start conversation' i]",
      "button[aria-label*='comment on line' i]",
    ];
    const seen = new Set();
    const buttons = [];
    for (const sel of selectors) {
      for (const btn of qsa(sel, row)) {
        if (!usable(btn) || seen.has(btn)) continue;
        seen.add(btn);
        buttons.push(btn);
      }
    }

    // Guarded catch-all: label must look like "create a comment", never like
    // resolve/actions/collapse/reactions.
    for (const btn of qsa("button[aria-label*='comment' i]", row)) {
      if (!usable(btn) || seen.has(btn)) continue;
      const label = _controlLabel(btn);
      if (/resolve|unresolve|actions|collapse|expand|hide|delete|edit|react|reply/.test(label)) continue;
      if (!/add|start|write|create|new/.test(label)) continue;
      seen.add(btn);
      buttons.push(btn);
    }

    return buttons;
  }

  function _submitButton(formRoot, mode, labeledOnly = false) {
    const buttons = qsa("button", formRoot).filter((b) =>
      !b.closest(OUR_UI_SELECTOR) && isVisible(b) && !b.disabled
    );
    const labelOf = (b) => _controlLabel(b);

    const preferences = mode === "single"
      ? ["add single comment", "add comment now", "comment now"]
      : mode === "reply"
        ? ["add review comment", "add single comment", "comment now"]
        : ["add review comment", "start a review", "start review", "add to review"];

    for (const pref of preferences) {
      const hit = buttons.find((b) => labelOf(b).includes(pref));
      if (hit) return hit;
    }
    if (mode === "single" || mode === "reply") {
      const exact = buttons.find((b) => ["comment", "reply"].includes(labelOf(b)));
      if (exact) return exact;
    }

    // Cross-mode fallback: the form may only offer the OTHER mode's button
    // (e.g. with a review pending, the dialog composer offers only "Add
    // review comment" — no single-comment option exists). Posting through
    // whatever comment-submit exists beats failing.
    const anyKnown = ["add review comment", "add single comment", "start a review",
      "start review", "add to review", "add comment now", "comment now"];
    for (const pref of anyKnown) {
      const hit = buttons.find((b) => labelOf(b).includes(pref));
      if (hit) return hit;
    }

    if (labeledOnly) return null;
    return buttons.find((b) => {
      if ((b.getAttribute("type") || "").toLowerCase() !== "submit") return false;
      const label = labelOf(b);
      return label && !label.includes("cancel") && !label.includes("close");
    }) || null;
  }

  /* ---------------- Threads from the embedded payload ---------------- */

  function _looksLikePayloadComment(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const body = o.bodyHTML || o.bodyHtml || o.body || o.bodyText;
    if (typeof body !== "string" || !body.trim()) return false;
    return Boolean(o.author || o.user || o.authorLogin);
  }

  function _payloadCommentToModel(c) {
    const author = c.author || c.user || {};
    const bodyHTML = typeof (c.bodyHTML || c.bodyHtml) === "string" ? (c.bodyHTML || c.bodyHtml) : "";
    const bodyMarkdown = typeof c.body === "string" ? c.body
      : (typeof c.bodyText === "string" ? c.bodyText : "");
    const db = c.databaseId ||
      (String(c.currentDiffResourcePath || c.url || "").match(/#r(\d+)/) || [])[1] || "";
    return {
      author: c.authorLogin || author.login || author.name || "",
      avatarUrl: author.avatarUrl || author.avatar_url || "",
      timeText: c.createdAt || c.created_at || c.updatedAt || "",
      bodyHTML,
      bodyMarkdown,
      domId: db ? `r${db}` : "",
      // Own comments only: viewerCanDelete alone is also true for other
      // people's comments when the viewer has repo write access.
      canDelete: c.viewerCanDelete === true && c.viewerDidAuthor === true,
      pending: String(c.state || "").toUpperCase() === "PENDING",
    };
  }

  function _payloadThreadLine(obj, comments) {
    const sources = [obj, ...(comments || [])];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of ["line", "endLine", "originalLine", "startLine", "position"]) {
        const raw = source[key];
        const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
    return null;
  }

  /**
   * Comments carry a `currentDiffResourcePath` like
   * ".../changes#diff-<digest>R<line>" — parse digest + line out of it
   * (also tried against `url` and `reference` as fallbacks).
   */
  function _refFromComment(c) {
    for (const raw of [c?.currentDiffResourcePath, c?.url, c?.reference]) {
      if (typeof raw !== "string") continue;
      const m = raw.match(/diff-([0-9a-f]{10,})[LR](\d+)\b/i);
      if (m) return { digest: m[1].toLowerCase(), line: parseInt(m[2], 10) };
    }
    return null;
  }

  /**
   * Threads for a file read straight from the page's embedded JSON
   * (pullRequestsChangesRoute.markers) — zero DOM interaction.
   * Returns Map<lineNum, thread[]>.
   */
  function payloadThreads(fileCtx) {
    const byLine = new Map();
    const route = _route();
    if (!route) return byLine;

    // Primary path: JOIN the two payload halves. The file's markersMap maps
    // line keys ("R5") to thread references; route.markers.threads maps
    // thread ids to the actual comment bodies.
    const threadStore = route.markers?.threads;
    if (threadStore && typeof threadStore === "object") {
      let refKeysLogged = false;
      for (const [lineKey, markerData] of Object.entries(fileCtx.markersMap || {})) {
        const m = lineKey.match(/^[A-Z]?(\d+)$/i);
        if (!m) continue;
        const lineNum = parseInt(m[1], 10);
        const refs = Array.isArray(markerData?.threads) ? markerData.threads : [];

        for (const ref of refs) {
          if (!refKeysLogged && ref && typeof ref === "object") {
            refKeysLogged = true;
            logInfo("markersMap thread ref keys:", Object.keys(ref).join(","));
          }
          const threadId = String(
            (typeof ref === "string" || typeof ref === "number") ? ref
              : ref?.id ?? ref?.threadId ?? ref?.markerId ?? ref?.databaseId ?? ""
          );
          const stored = threadId && threadStore[threadId] ? threadStore[threadId] : null;
          const rawComments =
            (Array.isArray(stored?.commentsData?.comments) && stored.commentsData.comments) ||
            (Array.isArray(stored?.comments) && stored.comments) || null;
          if (!rawComments) continue;

          const comments = rawComments.filter(_looksLikePayloadComment).map(_payloadCommentToModel);
          if (comments.length === 0) continue;

          const list = byLine.get(lineNum) || [];
          list.push({
            resolved: _threadResolved(stored) || _threadResolved(ref),
            hasResolutionInfo: true,
            markerId: threadId,
            comments,
          });
          byLine.set(lineNum, list);
        }
      }

      if (byLine.size > 0) {
        logInfo("Payload threads for", fileCtx.path, "->", byLine.size,
          "lines (joined via markersMap)");
        return byLine;
      }
    }

    const digest = String(fileCtx.digest || "").toLowerCase();
    let threadArraysSeen = 0;
    let shapeLogged = false;

    const belongsToFile = (obj, comments, keyPath) => {
      const path = obj.path || obj.filePath ||
        (comments || []).map((c) => c?.path).find(Boolean) || "";
      if (path) return _normalizePath(path) === fileCtx.path;
      const objDigest = String(obj.pathDigest || "").toLowerCase();
      if (objDigest) return objDigest === digest;
      return digest && keyPath.toLowerCase().includes(digest);
    };

    const visit = (obj, depth, keyPath) => {
      if (!obj || typeof obj !== "object" || depth > 10) return;
      if (Array.isArray(obj)) {
        for (const item of obj) visit(item, depth + 1, keyPath);
        return;
      }

      const rawComments =
        (Array.isArray(obj.commentsData?.comments) && obj.commentsData.comments) ||
        (Array.isArray(obj.comments) && obj.comments) ||
        (Array.isArray(obj.comments?.nodes) && obj.comments.nodes) ||
        (Array.isArray(obj.comments?.edges) &&
          obj.comments.edges.map((e) => e?.node).filter(Boolean)) ||
        null;

      if (rawComments && rawComments.some(_looksLikePayloadComment)) {
        threadArraysSeen++;
        const comments = rawComments.filter(_looksLikePayloadComment).map(_payloadCommentToModel);
        if (comments.length > 0) {
          if (!shapeLogged) {
            shapeLogged = true;
            logInfo("Payload thread shape — thread keys:", Object.keys(obj).join(","),
              "| comment keys:", Object.keys(rawComments[0]).join(","));
          }
          const ref = rawComments.map(_refFromComment).find(Boolean) || null;
          found.push({
            lineNum: _payloadThreadLine(obj, rawComments) || ref?.line || null,
            belongs: belongsToFile(obj, rawComments, keyPath) ||
              (ref ? ref.digest === digest : false),
            resolved: _threadResolved(obj),
            hasResolutionInfo:
              typeof obj.isResolved === "boolean" || typeof obj.resolved === "boolean",
            markerId: String(obj.id || obj.threadId || obj.databaseId || "") || null,
            comments,
          });
        }
        return; // don't descend into individual comments
      }

      for (const [key, value] of Object.entries(obj)) {
        visit(value, depth + 1, `${keyPath}.${key}`);
      }
    };

    const found = [];
    visit(route.markers ?? route, 0, "route.markers");

    let usable = found.filter((f) => f.lineNum && f.belongs);
    if (usable.length === 0 && found.length > 0) {
      // No path/digest on the thread objects — fall back to matching
      // against the lines this file's own markersMap says are commented.
      const statLines = new Set(commentStats(fileCtx.markersMap).keys());
      usable = found.filter((f) => f.lineNum && statLines.has(f.lineNum));
      if (usable.length > 0) logInfo("Payload threads matched by line-number fallback");
    }

    for (const f of usable) {
      const list = byLine.get(f.lineNum) || [];
      list.push({
        resolved: f.resolved,
        hasResolutionInfo: f.hasResolutionInfo,
        markerId: f.markerId,
        comments: f.comments,
      });
      byLine.set(f.lineNum, list);
    }

    // Threads whose payload shape carried no resolution state fall back to
    // the file's markersMap stats (resolved count per line).
    const stats = commentStats(fileCtx.markersMap);
    for (const [line, list] of byLine) {
      const resolvedCount = stats.get(line)?.resolved || 0;
      list.forEach((thread, i) => {
        if (!thread.hasResolutionInfo) {
          thread.resolved = thread.resolved || i < resolvedCount;
        }
      });
    }

    logInfo("Payload threads for", fileCtx.path, "->", byLine.size, "lines",
      `(thread arrays seen: ${threadArraysSeen})`);
    return byLine;
  }

  /* ---------------- Round-trip harness ---------------- */

  /**
   * Re-resolve the live diff container by digest. Captured container
   * references go stale — GitHub re-renders/replaces them while the
   * overlay is open, and driving a detached tree fails in confusing ways
   * (hover controls never render, forms never submit).
   */
  function _freshCtx(fileCtx) {
    const live = document.getElementById(`diff-${fileCtx.digest}`);
    return live ? { ...fileCtx, container: live } : fileCtx;
  }

  let _busy = false;

  async function _roundTrip(container, taskFn) {
    if (_busy) return { ok: false, error: "Another GitHub action is in progress — try again in a moment." };
    _busy = true;
    const wasRich = _isRichVisible(container);
    try {
      if (!(await _ensureSourceView(container))) {
        return { ok: false, error: "Couldn't open this file's source diff." };
      }
      return await taskFn();
    } catch (e) {
      logWarn("Round trip failed", e);
      return { ok: false, error: "Unexpected error while driving GitHub's UI." };
    } finally {
      if (wasRich) _restoreRichView(container);
      _busy = false;
    }
  }

  /* ---------------- Thread scraping ---------------- */

  function _authorFrom(scope) {
    if (!scope) return "";
    for (const img of qsa("img[alt^='@']", scope)) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (/^@[\w-]+$/.test(alt)) return alt.slice(1);
    }
    for (const node of qsa("[data-hovercard-url]", scope)) {
      const m = (node.getAttribute("data-hovercard-url") || "").match(/^\/users\/([^/]+)\//);
      if (m) return m[1];
    }
    const classic = qs("a.author, a[data-hovercard-type='user']", scope);
    if (classic) {
      const text = (classic.textContent || "").trim();
      if (text) return text.replace(/^@/, "");
    }
    for (const a of qsa("a[href]", scope)) {
      const m = (a.getAttribute("href") || "").match(/^\/([\w-]+)\/?$/);
      if (!m) continue;
      const text = (a.textContent || "").trim();
      if (text === m[1] || text === `@${m[1]}`) return m[1];
      if (!text && qs("img", a)) return m[1];
    }
    return "";
  }

  function _commentMeta(bodyEl, boundary) {
    let node = bodyEl.parentElement;
    let hops = 0;
    while (node && hops < 8) {
      const author = _authorFrom(node);
      const timeEl = qs("relative-time", node);
      if (author || timeEl) {
        return {
          author,
          timeText: (timeEl?.getAttribute("datetime") || timeEl?.textContent || "").trim(),
        };
      }
      if (node === boundary) break;
      node = node.parentElement;
      hops++;
    }
    return { author: "", timeText: "" };
  }

  function _sanitizedClone(node) {
    const wrapper = document.createElement("div");
    const clone = node.cloneNode(true);
    sanitizeInto(clone);
    while (clone.firstChild) wrapper.appendChild(clone.firstChild);
    return wrapper;
  }

  // A real comment body lives inside one of these thread wrappers. The
  // rendered markdown of the file itself (.markdown-body inside <article>)
  // does not — this is what keeps the file content out of the scrape.
  const _THREAD_CONTEXT_SELECTOR = [
    "[data-marker-id]",
    "[data-inline-markers]",
    "[data-testid='review-thread']",
    ".review-comment",
    ".review-thread-component",
    ".js-comment-container",
    ".js-resolvable-timeline-thread-container",
  ].join(", ");

  function _collectThreadBodies(container) {
    let bodies = qsa(".comment-body, .markdown-body", container)
      .filter((node) => !node.closest(OUR_UI_SELECTOR))
      .filter((node) => node.closest(_THREAD_CONTEXT_SELECTOR))
      .filter((node) => (node.textContent || "").trim().length > 0);

    // Drop bodies nested inside other matched bodies
    const bodySet = new Set(bodies);
    bodies = bodies.filter((b) => {
      let p = b.parentElement;
      while (p && p !== container) {
        if (bodySet.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
    return bodies;
  }

  /**
   * Comment bodies in the source diff, grouped by host row, each mapped to
   * the line the thread hangs under. Document order.
   */
  function _threadRowGroups(container) {
    const bodies = _collectThreadBodies(container);

    // Group by per-thread marker container ([data-marker-id]) when present —
    // a line can host several threads inside the same <tr>. Fall back to the
    // row itself for older/other layouts.
    const byScope = new Map();
    for (const body of bodies) {
      const scope = body.closest("[data-marker-id]") || body.closest("tr") || body.parentElement;
      if (!scope) continue;
      let list = byScope.get(scope);
      if (!list) { list = []; byScope.set(scope, list); }
      list.push(body);
    }

    const groups = [];
    for (const [scope, scopeBodies] of byScope) {
      const row = scope.closest("tr") || scope;
      const lineNum = _lineForRow(row, container);
      if (!lineNum) continue;
      groups.push({ scope, row, bodies: scopeBodies, lineNum });
    }
    return groups;
  }

  function _lineForRow(startRow, container) {
    let row = startRow;
    let hops = 0;
    while (row && container.contains(row) && hops < 8) {
      const lineNode = qs("[data-line-number]", row);
      if (lineNode) {
        const parsed = parseInt(lineNode.getAttribute("data-line-number") || "", 10);
        if (parsed) return parsed;
      }
      row = row.previousElementSibling;
      hops++;
    }
    return null;
  }

  function _viewerLogin() {
    return document.querySelector('meta[name="user-login"]')?.getAttribute("content") || "";
  }

  function _scrapeThreadsNow(container) {
    const byLine = new Map();
    const viewerLogin = _viewerLogin();

    for (const group of _threadRowGroups(container)) {
      const scopeButtonText = normalizeText(
        qsa("button", group.scope)
          .map((b) => `${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`)
          .join(" ")
      );
      const resolved = scopeButtonText.includes("unresolve");

      const comments = group.bodies.map((body) => {
        const meta = _commentMeta(body, group.scope);

        // The comment container carries the "r<databaseId>" anchor id —
        // needed so just-posted comments are immediately deletable.
        let domId = "";
        let commentEl = null;
        let node = body;
        while (node && node !== container) {
          if (/^r\d+$/.test(node.id || "")) { domId = node.id; commentEl = node; break; }
          node = node.parentElement;
        }

        return {
          author: meta.author,
          avatarUrl: (commentEl && qs("img[alt^='@']", commentEl)?.getAttribute("src")) || "",
          timeText: meta.timeText,
          bodyNode: _sanitizedClone(body),
          domId,
          canDelete: Boolean(viewerLogin && meta.author === viewerLogin),
          pending: Boolean(commentEl && qs("[data-testid='pending-badge']", commentEl)),
        };
      });

      const list = byLine.get(group.lineNum) || [];
      list.push({
        resolved,
        markerId: group.scope.getAttribute?.("data-marker-id") || null,
        comments,
      });
      byLine.set(group.lineNum, list);
    }
    return byLine;
  }

  /**
   * Inline thread markers are collapsed avatar chips by default — the
   * comment bodies aren't in the DOM until the marker is expanded into
   * its "Comment view" dialog. Activate every marker that isn't showing
   * a body yet.
   */
  function _expandThreadMarkers(container) {
    let acted = 0;

    for (const marker of qsa("[data-inline-markers]", container).slice(0, 20)) {
      if (qs(".comment-body, .markdown-body", marker)) continue; // already expanded

      marker.scrollIntoView?.({ block: "center" });

      // Enter the cell's dialog mode first — collapsed markers are inert
      // (aria-hidden, tabindex=-1) until then.
      const row = marker.closest("tr");
      const cell = row ? qs("td.diff-text-cell", row) : null;
      if (cell) {
        try { cell.focus(); } catch { /* ignore */ }
        _pressKey(cell, "Enter");
        acted++;
      }

      const toggle = qsa("button[data-is-first-collapse-button]", marker)
        .find((b) => b.getAttribute("aria-hidden") !== "true" && b.tabIndex !== -1);
      if (toggle) {
        _activate(toggle);
        acted++;
      }
    }
    if (acted > 0) return true;

    // Older layouts: "N conversations" chips
    const buttons = qsa("button, summary", container).filter((node) => {
      if (node.closest(OUR_UI_SELECTOR)) return false;
      const label = _controlLabel(node);
      if (!label || label.includes("add") || label.includes("resolve")) return false;
      return (label.includes("conversation") || label.includes("comment")) && /\d/.test(label);
    });
    for (const btn of buttons.slice(0, 12)) _activate(btn);
    return buttons.length > 0;
  }

  /**
   * Targeted expansion: we know from the payload exactly which line has
   * comments — find that line's row and try every plausible activation,
   * verifying after each whether a comment body appeared. Candidates, in
   * order: buttons/clickables inside the marker containers, the marker
   * containers themselves, and finally the diff text cell + Enter (the
   * ARIA-grid "enter cell dialog mode" pattern GitHub's view uses).
   */
  async function _expandMarkersForLine(container, digest, lineNum) {
    const target = _findLineTarget(container, digest, lineNum);
    if (!target) {
      logWarn("No source row found for line", lineNum);
      return false;
    }
    const row = target.closest("tr") || target;
    row.scrollIntoView({ block: "center" });

    // Re-resolve freshly on every poll — React may replace the row when it
    // expands, so checking containment against a stale node lies to us.
    const bodyVisible = () =>
      _threadRowGroups(container).some((g) => g.lineNum === lineNum) || null;
    if (bodyVisible()) return true;

    const freshRow = () => {
      const t = _findLineTarget(container, digest, lineNum);
      return t ? (t.closest("tr") || t) : row;
    };

    // Step 1 — enter the cell's dialog mode (ARIA grid pattern). Collapsed
    // markers are aria-hidden/inert until the cell is entered, so clicking
    // them directly is a no-op; focus + Enter on the cell is what GitHub
    // actually listens for.
    const textCell =
      qs("td.diff-text-cell", freshRow()) ||
      (target.matches && target.matches("td") ? target : null);
    if (textCell) {
      try { textCell.focus(); } catch { /* ignore */ }
      _pressKey(textCell, "Enter");
      if (await waitFor(bodyVisible, 1200, 150)) return true;
    }

    // Step 2 — dialog may be active with the comment itself still collapsed:
    // click the expand toggle, but only once it's interactive.
    const interactiveToggle = () => qsa("button[data-is-first-collapse-button]", freshRow())
      .find((b) => b.getAttribute("aria-hidden") !== "true" && b.tabIndex !== -1) || null;
    const expandBtn = await waitFor(interactiveToggle, 1500, 150);
    if (expandBtn) {
      _activate(expandBtn);
      if (await waitFor(bodyVisible, 1500, 150)) return true;
    }

    // Step 3 — fall back to activating marker containers directly.
    const candidates = [];
    const push = (node) => {
      if (node && !candidates.includes(node) && _safeExpansionCandidate(node)) {
        candidates.push(node);
      }
    };
    const scanRow = freshRow();
    qsa("[data-marker-id] button, [data-inline-markers] button", scanRow).forEach(push);
    qsa("[data-marker-id] [role='button'], [data-marker-id] [tabindex]", scanRow).forEach(push);
    qsa("[data-marker-id], [data-inline-markers]", scanRow).forEach(push);

    for (const candidate of candidates.slice(0, 5)) {
      _activate(candidate);
      if (await waitFor(bodyVisible, 1200, 150)) return true;
    }

    const markerEl = qs("[data-inline-markers]", row) || qs("[data-marker-id]", row);
    logWarn(
      "Couldn't expand thread marker on line", lineNum,
      "| tried", Math.min(candidates.length, 8), "candidates | marker HTML:\n",
      markerEl
        ? (markerEl.outerHTML || "").slice(0, 1500)
        : `(no marker element in row; row snippet: ${(row.outerHTML || "").slice(0, 800)})`
    );
    return false;
  }

  /* One-time diagnostic: does the embedded payload carry comment bodies
     anywhere? If yes, we can render threads with zero DOM interaction. */
  let _payloadProbeDone = false;
  function _logPayloadCommentProbe() {
    if (_payloadProbeDone) return;
    _payloadProbeDone = true;
    try {
      let count = 0;
      const samples = [];
      const visit = (obj, path, depth) => {
        if (!obj || typeof obj !== "object" || depth > 8 || count >= 8) return;
        if (Array.isArray(obj)) {
          obj.slice(0, 25).forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
          return;
        }
        const body = obj.bodyHTML || obj.bodyHtml || obj.body || obj.bodyText;
        if (typeof body === "string" && body.trim().length > 3) {
          count++;
          samples.push(`${path} keys=[${Object.keys(obj).slice(0, 14).join(",")}]`);
          return;
        }
        for (const [key, value] of Object.entries(obj)) visit(value, `${path}.${key}`, depth + 1);
      };
      visit(_payload(), "payload", 0);
      logInfo("Payload probe — comment-like objects found:", count, samples);
    } catch (e) {
      logWarn("Payload probe failed", e);
    }
  }

  /** Close any "Comment view" dialogs we opened while scraping. */
  function _collapseThreadDialogs(container) {
    qsa("button[data-exit-dialog-mode-button]", container).forEach((btn) => {
      try { btn.click(); } catch { /* ignore */ }
    });
  }

  /**
   * Fetch threads for a file: {ok, threads: Map<lineNum, thread[]>}.
   */
  async function scrapeThreads(fileCtx) {
    fileCtx = _freshCtx(fileCtx);
    return _roundTrip(fileCtx.container, async () => {
      const container = fileCtx.container;
      await sleep(500);

      // Targeted pass first: expand the marker on every line the payload
      // says has comments.
      for (const lineNum of commentStats(fileCtx.markersMap).keys()) {
        await _expandMarkersForLine(container, fileCtx.digest, lineNum);
      }

      let byLine = _scrapeThreadsNow(container);
      const deadline = Date.now() + 7000;
      while (byLine.size === 0 && Date.now() < deadline) {
        const expanded = _expandThreadMarkers(container);
        if (!expanded) _expandCollapsedSections(container);
        await sleep(expanded ? 800 : 500);
        byLine = _scrapeThreadsNow(container);
      }

      logInfo(
        "Scraped", byLine.size, "commented lines for", fileCtx.path,
        "| markers:", qsa("[data-inline-markers]", container).length,
        "markerIds:", qsa("[data-marker-id]", container).length,
        "rawBodies:", qsa(".comment-body, .markdown-body", container).length,
        "threadBodies:", _collectThreadBodies(container).length
      );
      if (byLine.size === 0) _logPayloadCommentProbe();

      _collapseThreadDialogs(container);
      return { ok: true, threads: byLine };
    });
  }

  /* ---------------- Write actions ---------------- */

  async function _openInlineForm(container, digest, lineNum) {
    let target = await waitFor(() => _findLineTarget(container, digest, lineNum), 2000, 200);
    if (!target) {
      const deadline = Date.now() + 8000;
      while (!target && Date.now() < deadline) {
        _expandCollapsedSections(container);
        await sleep(400);
        target = _findLineTarget(container, digest, lineNum);
      }
    }
    if (!target) return { error: `Couldn't locate line ${lineNum} in the source diff.` };

    const row = target.closest("tr") || target;
    row.scrollIntoView({ block: "center" });

    const beforeVisible = new Set(_findEditors(document));
    const textCell = qs("td.diff-text-cell", row) ||
      (target.matches && target.matches("td") ? target : null);
    const hasThread = Boolean(qs("[data-marker-id]", row));

    // Strategy A — ARIA-grid dialog mode: focus the text cell + Enter opens
    // GitHub's "Add a comment on line RN" composer. Needs no buttons at all
    // (the hover "+" often never renders). On lines that already carry a
    // thread, Enter opens the thread dialog whose composer would REPLY —
    // so for those, try the add-comment button first.
    const dialogStrategy = async () => {
      if (!textCell) return null;
      try { textCell.focus(); } catch { /* ignore */ }
      _pressKey(textCell, "Enter");
      return waitFor(() => _freshEditor(beforeVisible, container), 2500, 150);
    };

    // Strategy B — hover-rendered add-comment button
    const buttonStrategy = async () => {
      _coaxHover(row);
      await sleep(150);
      let candidates = _addCommentButtons(row);
      if (candidates.length === 0) {
        await waitFor(() => _addCommentButtons(row).length > 0, 1500, 200);
        candidates = _addCommentButtons(row);
      }
      for (const btn of candidates.slice(0, 4)) {
        _fullClick(btn);
        const editor = await waitFor(() => _freshEditor(beforeVisible, container), 2000, 150);
        if (editor) return editor;
      }
      return null;
    };

    const strategies = hasThread
      ? [buttonStrategy, dialogStrategy]
      : [dialogStrategy, buttonStrategy];

    for (const strategy of strategies) {
      const editor = await strategy();
      if (editor) return { editor };
    }

    const editor = await waitFor(() => _freshEditor(beforeVisible, document), 2000, 150);
    if (editor) return { editor };

    logWarn("Comment form didn't open on line", lineNum,
      "| container connected:", container.isConnected,
      "| hasThread:", hasThread,
      "| cell role:", textCell?.getAttribute("role"),
      "| row buttons:", qsa("button", row).map((b) => _controlLabel(b).slice(0, 30)));
    return { error: "GitHub's comment form didn't open." };
  }

  async function _fillAndSubmit(container, editor, text, mode) {
    _setEditorText(editor, text);
    editor.focus();
    if (!_editorText(editor).trim()) {
      return { ok: false, error: "Couldn't fill GitHub's comment box." };
    }

    const findSubmit = () => {
      // The editor may be remounted by a re-render mid-flow — re-locate it
      // (and re-fill if the remount dropped our text) on every probe.
      if (!editor.isConnected) {
        const liveEditor = _findEditors(container)
          .find((n) => _editorText(n).trim() === text.trim() || !_editorText(n).trim());
        if (liveEditor) {
          editor = liveEditor;
          if (!_editorText(editor).trim()) _setEditorText(editor, text);
        }
      }
      const root = editor.closest("form") || editor.closest("tr") || container;
      return _submitButton(root, mode) ||
        _submitButton(container, mode) ||
        _submitButton(document, mode, true);
    };

    let submitBtn = await waitFor(findSubmit, 4000, 200);

    if (!submitBtn) {
      // React may have ignored the programmatic fill (button stays disabled)
      // — retype through execCommand, which React always accepts.
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        try {
          editor.select();
          document.execCommand("insertText", false, text);
        } catch { /* ignore */ }
      }
      submitBtn = await waitFor(findSubmit, 3000, 200);
    }

    if (!submitBtn) {
      const describe = (b) =>
        `${_controlLabel(b).slice(0, 30)}[${b.disabled ? "disabled" : "enabled"},${isVisible(b) ? "vis" : "hidden"}]`;
      const formRoot = editor.closest("form") || editor.closest("tr") || container;
      logWarn("No submit button | mode:", mode,
        "| editor connected:", editor.isConnected,
        "| editor text length:", _editorText(editor).length,
        "| formRoot buttons:", qsa("button", formRoot).map(describe));
      return { ok: false, error: "Couldn't find the submit button." };
    }

    const usedLabel = _controlLabel(submitBtn);
    _fullClick(submitBtn);

    const settled = await waitFor(
      () => !editor.isConnected || !isVisible(editor) || _editorText(editor).trim() === "",
      12000, 250
    );
    if (!settled) return { ok: false, error: "The comment didn't seem to post." };
    return { ok: true, usedLabel };
  }

  /**
   * Post a new comment (mode: "review" | "single") on a head line.
   * Returns {ok, error?, threads?} — threads is a fresh scrape on success.
   */
  async function postComment(fileCtx, lineNum, text, mode) {
    fileCtx = _freshCtx(fileCtx);
    return _roundTrip(fileCtx.container, async () => {
      const opened = await _openInlineForm(fileCtx.container, fileCtx.digest, lineNum);
      if (opened.error) return { ok: false, error: opened.error };

      const result = await _fillAndSubmit(fileCtx.container, opened.editor, text, mode);
      if (!result.ok) return result;

      await sleep(600);
      const threads = _scrapeThreadsNow(fileCtx.container);
      _collapseThreadDialogs(fileCtx.container);
      return { ok: true, threads, usedLabel: result.usedLabel };
    });
  }

  async function _threadGroup(fileCtx, lineNum, threadIndex, markerId) {
    const container = fileCtx.container;
    const findGroups = () =>
      _threadRowGroups(container).filter((g) => g.lineNum === lineNum);

    let groups = findGroups();
    if (groups.length === 0) {
      // One careful, targeted expansion (dialog-mode entry + toggle) —
      // NOT a re-click on every poll, which just toggle-thrashes.
      await _expandMarkersForLine(container, fileCtx.digest, lineNum);
      groups = await waitFor(() => {
        const hits = findGroups();
        return hits.length > 0 ? hits : null;
      }, 3000, 250) || [];
    }
    if (groups.length === 0) return null;

    // Exact thread match via data-marker-id when known, else by index
    let group = null;
    if (markerId) {
      group = groups.find((g) => {
        const scopeId = g.scope.getAttribute?.("data-marker-id") ||
          g.scope.closest?.("[data-marker-id]")?.getAttribute("data-marker-id") || "";
        return String(scopeId) === String(markerId);
      }) || null;
    }
    group = group || groups[threadIndex] || groups[0];
    group.row.scrollIntoView({ block: "center" });
    return group;
  }

  /**
   * Reply within an existing thread. Returns {ok, error?, threads?}.
   */
  async function replyToThread(fileCtx, lineNum, threadIndex, text, markerId) {
    fileCtx = _freshCtx(fileCtx);
    return _roundTrip(fileCtx.container, async () => {
      const group = await _threadGroup(fileCtx, lineNum, threadIndex, markerId);
      if (!group) return { ok: false, error: `Couldn't find the thread on line ${lineNum}.` };
      const scope = group.scope;

      let editor = qsa("textarea", scope)
        .find((n) => isVisible(n) && !n.disabled && !n.readOnly) || null;

      if (!editor) {
        const beforeVisible = new Set(_findEditors(document));
        // Exact affordance first ("Write a reply" compact composer), then
        // label heuristics.
        const trigger =
          qs("[data-marker-navigation-thread-reply] button, #react-issue-comment-composer button", scope) ||
          qsa("button, summary, [role='button']", scope)
            .find((n) => _controlLabel(n).includes("reply")) ||
          qsa("input[placeholder], textarea[placeholder]", scope)
            .find((n) => normalizeText(n.getAttribute("placeholder") || "").includes("reply"));
        if (trigger) {
          _fullClick(trigger);
          editor = await waitFor(() =>
            qsa("textarea", scope).find((n) => isVisible(n) && !n.disabled && !n.readOnly) ||
            _freshEditor(beforeVisible, fileCtx.container),
          4000, 150);
        }
      }
      if (!editor) return { ok: false, error: "Couldn't open the reply box for this thread." };

      const result = await _fillAndSubmit(scope, editor, text, "reply");
      if (!result.ok) return result;

      await sleep(600);
      const threads = _scrapeThreadsNow(fileCtx.container);
      _collapseThreadDialogs(fileCtx.container);
      return { ok: true, threads };
    });
  }

  /**
   * Resolve or unresolve a thread. Returns {ok, error?, threads?}.
   */
  async function setThreadResolved(fileCtx, lineNum, threadIndex, resolve, markerId) {
    fileCtx = _freshCtx(fileCtx);
    return _roundTrip(fileCtx.container, async () => {
      const group = await _threadGroup(fileCtx, lineNum, threadIndex, markerId);
      if (!group) return { ok: false, error: `Couldn't find the thread on line ${lineNum}.` };

      // Exact control first, then label heuristic
      const exact = resolve
        ? qs("button[data-testid='unified-comment-resolve-button']", group.scope)
        : qs("button[data-testid='unified-comment-unresolve-button']", group.scope);
      const btn = exact || qsa("button", group.scope).find((b) => {
        const label = _controlLabel(b);
        if (resolve) return label.includes("resolve") && !label.includes("unresolve");
        return label.includes("unresolve");
      });
      if (!btn) {
        return { ok: false, error: `Couldn't find the ${resolve ? "resolve" : "unresolve"} control.` };
      }

      _fullClick(btn);
      await sleep(900);
      const threads = _scrapeThreadsNow(fileCtx.container);
      _collapseThreadDialogs(fileCtx.container);
      return { ok: true, threads };
    });
  }

  /**
   * Delete one of the viewer's own comments: kebab menu → "Delete"
   * menuitem → "Delete comment?" alertdialog confirm. Flow verified
   * against the live DOM.
   */
  async function deleteComment(fileCtx, lineNum, threadIndex, markerId, commentDomId) {
    fileCtx = _freshCtx(fileCtx);
    return _roundTrip(fileCtx.container, async () => {
      const group = await _threadGroup(fileCtx, lineNum, threadIndex, markerId);
      if (!group) return { ok: false, error: `Couldn't find the thread on line ${lineNum}.` };

      const comment = commentDomId ? document.getElementById(commentDomId) : null;
      if (!comment) return { ok: false, error: "Couldn't locate that comment in the thread." };

      const kebab = comment.querySelector("button[data-testid='comment-header-hamburger']") ||
        qsa("button", comment).find((b) => _controlLabel(b).includes("actions"));
      if (!kebab) return { ok: false, error: "Couldn't find the comment's actions menu." };
      _fullClick(kebab);

      const deleteItem = await waitFor(() =>
        qsa("[role='menuitem']").find((el) =>
          (el.textContent || "").trim().toLowerCase() === "delete") || null,
      3000, 150);
      if (!deleteItem) {
        return { ok: false, error: "No Delete option — you may not have permission." };
      }
      _fullClick(deleteItem);

      const confirmBtn = await waitFor(() => {
        const dialog = qsa("[role='alertdialog']").find((d) =>
          /delete/i.test(qs("h1,h2,h3", d)?.textContent || ""));
        if (!dialog) return null;
        return qsa("button", dialog).find((b) =>
          (b.textContent || "").trim().toLowerCase() === "delete") || null;
      }, 3000, 150);
      if (!confirmBtn) return { ok: false, error: "The delete confirmation didn't appear." };
      _fullClick(confirmBtn);

      const gone = await waitFor(
        () => (commentDomId && !document.getElementById(commentDomId)) || null, 6000, 250
      );
      if (!gone) return { ok: false, error: "The comment didn't seem to delete." };

      _collapseThreadDialogs(fileCtx.container);
      return { ok: true };
    });
  }

  return {
    files, mdFileCount, mdFileCountKnown, fetchMdFileCountRemote, headerRowFor,
    fetchHeadFile, fetchBaseFile,
    commentStats, payloadThreads,
    scrapeThreads, postComment, replyToThread, setThreadResolved, deleteComment,
  };
})();
