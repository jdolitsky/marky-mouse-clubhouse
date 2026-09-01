/**
 * review-panel.js — the Google-Docs-style review overlay.
 *
 * All changed markdown files render stacked in ONE continuous scroll, each
 * as a section: rendered document (≤900px, centered) + a comment rail on
 * the right. The sticky header always shows the file currently under the
 * top bar — scrolling into the next file "takes over" the header. Threads
 * for every file are loaded up front from the page payload.
 */

// eslint-disable-next-line no-var
var MDRPanel = (() => {
  "use strict";

  const { qs, qsa, el, formatTime, relativeTime, bookIconSvg, logWarn } = MDRUtil;

  let _active = null;
  const _draftsByDigest = new Map();

  /* ---------------- Overlay lifecycle ---------------- */

  async function open(fileCtx, allFiles = null) {
    close();

    const files = (allFiles && allFiles.length ? allFiles : null) || MDRAdapter.files();

    const overlay = el("div", { className: "mdr-overlay" });
    const header = el("div", { className: "mdr-header" });

    const icon = el("span", { className: "mdr-header__icon" });
    icon.innerHTML = bookIconSvg("octicon octicon-book");
    header.appendChild(icon);

    const prevBtn = el("button", {
      className: "mdr-btn", type: "button", textContent: "‹ Prev", title: "Previous file",
    });
    const headerPos = el("span", { className: "mdr-header__filepos" });
    const nextBtn = el("button", {
      className: "mdr-btn", type: "button", textContent: "Next ›", title: "Next file",
    });
    if (files.length > 0) {
      header.appendChild(prevBtn);
      header.appendChild(headerPos);
      header.appendChild(nextBtn);
    }

    const headerPath = el("span", {
      className: "mdr-header__path",
      textContent: files.length > 0 ? files[0].path : "Docs review",
    });
    header.appendChild(headerPath);

    const headerStatus = el("span", { className: "mdr-header__status" });
    header.appendChild(headerStatus);
    header.appendChild(el("span", { className: "mdr-header__spacer" }));

    const refreshBtn = el("button", {
      className: "mdr-btn", type: "button", textContent: "↻ Refresh threads",
      title: "Re-read comment threads from GitHub",
    });
    const closeBtn = el("button", {
      className: "mdr-btn mdr-btn--quiet", type: "button", textContent: "✕ Close",
    });
    if (files.length > 0) header.appendChild(refreshBtn);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    // No markdown files in this changeset — say so and stop.
    if (files.length === 0) {
      overlay.appendChild(el("div", {
        className: "mdr-empty",
        textContent: "No Markdown files are changed in this pull request.",
      }));
      document.body.appendChild(overlay);
      document.documentElement.classList.add("mdr-no-scroll");
      _active = { overlay, sections: [] };
      _active.escHandler = (e) => {
        if (e.key === "Escape" && !e.defaultPrevented) close();
      };
      document.addEventListener("keydown", _active.escHandler);
      closeBtn.addEventListener("click", close);
      return;
    }

    const scroll = el("div", { className: "mdr-scroll" });
    const content = el("div", { className: "mdr-content" });
    scroll.appendChild(content);
    overlay.appendChild(scroll);

    const toolbar = _buildToolbar();
    overlay.appendChild(toolbar);

    document.body.appendChild(overlay);
    document.documentElement.classList.add("mdr-no-scroll");

    _active = {
      overlay, headerPath, headerStatus, headerPos, prevBtn, nextBtn,
      scroll, content, toolbar,
      sections: [],
    };

    closeBtn.addEventListener("click", close);
    prevBtn.addEventListener("click", () => _goToSection(-1));
    nextBtn.addEventListener("click", () => _goToSection(1));
    refreshBtn.addEventListener("click", () => {
      const current = _currentSection();
      for (const section of _active.sections) {
        _refreshThreads(section, section === current);
      }
    });

    _active.escHandler = (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    document.addEventListener("keydown", _active.escHandler);

    // Build all section skeletons in order, then load them in parallel.
    for (const file of files) {
      const section = _buildSection(file);
      content.appendChild(section.sectionEl);
      _active.sections.push(section);
    }

    _wireOverlay();

    const state = _active;
    await Promise.all(state.sections.map((section) =>
      _loadSection(section).catch((e) => {
        logWarn("Failed to load", section.fileCtx.path, e);
        if (!_isCurrent(state)) return;
        section.docCol.textContent = "";
        section.docCol.appendChild(el("div", {
          className: "mdr-error",
          textContent: "Couldn't load this file's content.",
        }));
      })
    ));
    if (!_isCurrent(state)) return;

    _positionAllCards();
    _updateStickyPath();

    // Opened for a specific file — jump to its section
    if (fileCtx) {
      const target = state.sections.find((s) => s.fileCtx.digest === fileCtx.digest);
      if (target) target.sectionEl.scrollIntoView({ block: "start" });
    }
  }

  /**
   * Cover the page immediately with a loading overlay — used while
   * navigating to the diff view so the user never "sees" Files changed.
   */
  function showLoading() {
    close();
    const overlay = el("div", { className: "mdr-overlay" });
    const header = el("div", { className: "mdr-header" });
    const icon = el("span", { className: "mdr-header__icon" });
    icon.innerHTML = bookIconSvg("octicon octicon-book");
    header.appendChild(icon);
    header.appendChild(el("span", { className: "mdr-header__path", textContent: "Docs review" }));
    header.appendChild(el("span", { className: "mdr-header__spacer" }));
    const closeBtn = el("button", {
      className: "mdr-btn mdr-btn--quiet", type: "button", textContent: "✕ Close",
    });
    header.appendChild(closeBtn);
    overlay.appendChild(header);
    overlay.appendChild(el("div", {
      className: "mdr-empty",
      textContent: "Loading Markdown documents…",
    }));

    document.body.appendChild(overlay);
    document.documentElement.classList.add("mdr-no-scroll");
    _active = { overlay, sections: [] };
    _active.escHandler = (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    document.addEventListener("keydown", _active.escHandler);
    closeBtn.addEventListener("click", close);
  }

  function close() {
    if (_active) {
      for (const section of _active.sections || []) _stashDraft(section);
      if (_active.escHandler) document.removeEventListener("keydown", _active.escHandler);
      _active.overlay.remove();
      _active = null;
    }
    document.documentElement.classList.remove("mdr-no-scroll");
  }

  function isOpen() {
    return Boolean(_active);
  }

  function _isCurrent(state) {
    return _active === state;
  }

  /* ---------------- Sections ---------------- */

  function _buildSection(fileCtx) {
    const sectionEl = el("section", { className: "mdr-file-section" });

    const heading = el("div", { className: "mdr-file-heading" });
    const headingIcon = el("span", { className: "mdr-file-heading__icon" });
    headingIcon.innerHTML = bookIconSvg("octicon octicon-book");
    heading.appendChild(headingIcon);
    heading.appendChild(el("span", {
      className: "mdr-file-heading__path",
      textContent: fileCtx.path,
    }));

    const stats = MDRAdapter.commentStats(fileCtx.markersMap);
    let total = 0;
    for (const s of stats.values()) total += s.total;
    if (total > 0) {
      heading.appendChild(el("span", {
        className: "mdr-file-heading__count",
        textContent: `💬 ${total}`,
      }));
    }
    sectionEl.appendChild(heading);

    const bodyEl = el("div", { className: "mdr-section-body" });
    const docCol = el("div", { className: "mdr-doc-col" });
    docCol.appendChild(el("div", { className: "mdr-loading", textContent: "Loading…" }));
    const rail = el("div", { className: "mdr-rail" });
    bodyEl.appendChild(docCol);
    bodyEl.appendChild(rail);
    sectionEl.appendChild(bodyEl);

    return {
      fileCtx, sectionEl, bodyEl, docCol, rail,
      docHost: null, headText: "", headLines: [],
      threads: new Map(), stats,
      composerLine: null,
    };
  }

  async function _loadSection(section) {
    const state = _active;
    const [headText, baseText] = await Promise.all([
      MDRAdapter.fetchHeadFile(section.fileCtx.path),
      MDRAdapter.fetchBaseFile(section.fileCtx.path).catch(() => null),
    ]);
    if (!_isCurrent(state)) return;
    if (typeof headText !== "string") throw new Error("no head content");

    section.headText = headText;
    section.headLines = headText.split("\n");

    const docHost = MDRRenderer.render(headText);
    section.docHost = docHost;
    section.docCol.textContent = "";
    section.docCol.appendChild(docHost);

    if (typeof baseText === "string") {
      const changed = MDRRenderer.changedLines(baseText, headText);
      for (const block of qsa("[data-mdr-line]", docHost)) {
        const start = parseInt(block.getAttribute("data-mdr-line"), 10);
        const end = parseInt(block.getAttribute("data-mdr-line-end") || start, 10);
        for (let line = start; line <= end; line++) {
          if (changed.has(line)) {
            block.classList.add("mdr-changed");
            break;
          }
        }
      }
    }

    _wireDocHost(section);
    _refreshThreads(section, false);

    const saved = _draftsByDigest.get(section.fileCtx.digest);
    if (saved && saved.line) {
      _draftsByDigest.delete(section.fileCtx.digest);
      _openComposer(section, { start: saved.line, end: saved.line }, { draft: saved.text, scroll: false });
    }
  }

  /** The section currently under the sticky header. */
  function _currentSection() {
    const state = _active;
    if (!state || state.sections.length === 0) return null;
    const scrollRect = state.scroll.getBoundingClientRect();
    let current = state.sections[0];
    for (const section of state.sections) {
      if (section.sectionEl.getBoundingClientRect().top - scrollRect.top <= 16) {
        current = section;
      }
    }
    return current;
  }

  function _updateStickyPath() {
    const state = _active;
    if (!state || !state.headerPath) return;
    const current = _currentSection();
    if (!current) return;

    if (state.headerPath.textContent !== current.fileCtx.path) {
      state.headerPath.textContent = current.fileCtx.path;
    }

    const idx = state.sections.indexOf(current);
    if (state.headerPos) {
      state.headerPos.textContent = `${idx + 1}/${state.sections.length}`;
      state.prevBtn.disabled = idx <= 0;
      state.nextBtn.disabled = idx >= state.sections.length - 1;
    }
  }

  function _goToSection(delta) {
    const state = _active;
    if (!state || state.sections.length === 0) return;
    const current = _currentSection();
    const idx = Math.max(0, Math.min(
      state.sections.length - 1,
      state.sections.indexOf(current) + delta
    ));
    state.sections[idx].sectionEl.scrollIntoView({ behavior: "instant", block: "start" });
  }

  /* ---------------- Threads ---------------- */

  async function _refreshThreads(section, force) {
    const state = _active;
    if (!state) return;

    let payloadHit = false;
    try {
      const fromPayload = MDRAdapter.payloadThreads(section.fileCtx);
      if (fromPayload.size > 0) {
        section.threads = fromPayload;
        payloadHit = true;
        _renderRail(section);
      }
    } catch (e) {
      logWarn("Payload thread read failed", e);
    }

    // Scrape only when forced, or when the payload came up empty for a file
    // that the markers say has comments.
    if (!force && (payloadHit || section.stats.size === 0)) return;

    state.headerStatus.textContent = `Syncing ${section.fileCtx.path.split("/").pop()}…`;
    try {
      const result = await MDRAdapter.scrapeThreads(section.fileCtx);
      if (!_isCurrent(state)) return;
      if (result.ok && result.threads && result.threads.size > 0) {
        const merged = new Map(section.threads);
        for (const [line, list] of result.threads) merged.set(line, list);
        section.threads = merged;
      } else if (result.error) {
        state.headerStatus.textContent = result.error;
        setTimeout(() => { if (_isCurrent(state)) state.headerStatus.textContent = ""; }, 4000);
        return;
      }
    } catch (e) {
      logWarn("Thread refresh failed", e);
    }
    if (!_isCurrent(state)) return;
    state.headerStatus.textContent = "";
    _renderRail(section);
  }

  function _applyThreadUpdate(section, threads) {
    if (!_active) return;
    // Post-action scrapes can be partial — merge per line
    if (threads) {
      const merged = new Map(section.threads);
      for (const [line, list] of threads) merged.set(line, list);
      section.threads = merged;
    }
    _renderRail(section);
  }

  /* ---------------- Rail rendering ---------------- */

  function _railLines(section) {
    const lines = new Set([...section.threads.keys()]);
    for (const line of section.stats.keys()) lines.add(line);
    return [...lines].sort((a, b) => a - b);
  }

  function _renderRail(section) {
    if (!_active || !section.docHost) return;

    const openComposerLine = section.composerLine;
    const draft = qs(".mdr-composer textarea", section.rail)?.value || "";

    section.rail.textContent = "";
    qsa(".mdr-has-threads", section.docHost).forEach((n) => n.classList.remove("mdr-has-threads"));

    for (const lineNum of _railLines(section)) {
      const threads = section.threads.get(lineNum) || [];
      const stats = section.stats.get(lineNum) || null;
      const card = _buildThreadCard(section, lineNum, threads, stats);
      section.rail.appendChild(card);

      const block = MDRRenderer.blockForLine(section.docHost, lineNum);
      if (block) block.classList.add("mdr-has-threads");
    }

    if (openComposerLine) {
      _openComposer(section, { start: openComposerLine, end: openComposerLine }, { draft, scroll: false });
    }

    _positionCards(section);
    requestAnimationFrame(() => _positionCards(section));
  }

  function _positionCards(section) {
    if (!_active || !section.docHost) return;

    const bodyRect = section.bodyEl.getBoundingClientRect();
    const cards = qsa(".mdr-card", section.rail)
      .sort((a, b) => parseInt(a.getAttribute("data-line"), 10) - parseInt(b.getAttribute("data-line"), 10));

    let cursor = 0;
    let maxBottom = 0;
    for (const card of cards) {
      const lineNum = parseInt(card.getAttribute("data-line"), 10);
      const block = MDRRenderer.blockForLine(section.docHost, lineNum);
      let top = cursor;
      if (block) {
        const blockTop = block.getBoundingClientRect().top - bodyRect.top;
        top = Math.max(blockTop, cursor);
      }
      card.style.top = `${top}px`;
      cursor = top + card.offsetHeight + 12;
      maxBottom = Math.max(maxBottom, cursor);
    }
    section.rail.style.minHeight = `${maxBottom}px`;
  }

  function _positionAllCards() {
    if (!_active) return;
    for (const section of _active.sections) _positionCards(section);
  }

  /* ---------------- Thread cards ---------------- */

  function _buildThreadCard(section, lineNum, threads, stats) {
    const state = _active;
    const card = el("div", { className: "mdr-card", "data-line": String(lineNum) });

    const chip = el("button", {
      className: "mdr-card__chip", type: "button",
      textContent: `Line ${lineNum}`,
      title: "Scroll to this line",
    });
    chip.addEventListener("click", () => _scrollToLine(section, lineNum));
    card.appendChild(chip);

    if (threads.length === 0 && stats) {
      const note = el("div", { className: "mdr-card__fallback" });
      note.appendChild(el("span", {
        textContent: `${stats.total} comment${stats.total > 1 ? "s" : ""} here — `,
      }));
      const loadBtn = el("button", { className: "mdr-btn", type: "button", textContent: "Load" });
      loadBtn.addEventListener("click", () => _refreshThreads(section, true));
      note.appendChild(loadBtn);
      card.appendChild(note);
    }

    threads.forEach((thread, threadIndex) => {
      const threadEl = el("details", {
        className: `mdr-thread${thread.resolved ? " mdr-thread--resolved" : ""}`,
      });
      if (!thread.resolved) threadEl.setAttribute("open", "");
      threadEl.addEventListener("toggle", () => _positionCards(section));

      const first = thread.comments[0] || {};
      const summary = el("summary", { className: "mdr-thread__summary" });
      if (first.avatarUrl) {
        summary.appendChild(el("img", {
          className: "mdr-avatar", src: first.avatarUrl, alt: "",
          width: "16", height: "16", loading: "lazy",
        }));
      }
      summary.appendChild(el("span", {
        className: "mdr-thread__author", textContent: first.author || "Thread",
      }));
      summary.appendChild(el("span", {
        className: "mdr-thread__meta",
        textContent: `${thread.comments.length}${thread.resolved ? " · Resolved" : ""}`,
      }));
      threadEl.appendChild(summary);

      const status = el("span", { className: "mdr-thread__status" });

      for (const comment of thread.comments) {
        const item = el("div", { className: "mdr-comment" });
        const head = el("div", { className: "mdr-comment__head" });
        if (comment.avatarUrl) {
          head.appendChild(el("img", {
            className: "mdr-avatar", src: comment.avatarUrl, alt: "",
            width: "20", height: "20", loading: "lazy",
          }));
        }
        head.appendChild(el("span", {
          className: "mdr-comment__author", textContent: comment.author || "Comment",
        }));
        if (comment.timeText) {
          head.appendChild(el("span", {
            className: "mdr-comment__time",
            textContent: relativeTime(comment.timeText),
            title: formatTime(comment.timeText),
          }));
        }

        if (comment.pending) {
          const badge = el("span", {
            className: "mdr-pending-badge",
            title: "This review comment is pending — submit your review to publish it",
          });
          badge.innerHTML =
            '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="vertical-align: text-bottom;"><path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"></path></svg>Pending';
          head.appendChild(badge);
        }

        if (comment.canDelete && comment.domId) {
          const delBtn = el("button", {
            className: "mdr-btn mdr-btn--quiet mdr-comment__delete",
            type: "button",
            textContent: "Delete",
            title: "Delete your comment",
          });
          delBtn.addEventListener("click", async () => {
            if (delBtn.dataset.confirming !== "true") {
              delBtn.dataset.confirming = "true";
              delBtn.textContent = "Confirm delete?";
              setTimeout(() => {
                delBtn.dataset.confirming = "";
                delBtn.textContent = "Delete";
              }, 4000);
              return;
            }

            delBtn.disabled = true;
            status.textContent = "Deleting…";
            const result = await MDRAdapter.deleteComment(
              section.fileCtx, lineNum, threadIndex, thread.markerId, comment.domId
            );
            if (!_isCurrent(state)) return;

            if (result.ok) {
              status.textContent = "";
              const cIdx = thread.comments.indexOf(comment);
              if (cIdx >= 0) thread.comments.splice(cIdx, 1);
              if (thread.comments.length === 0) {
                const list = section.threads.get(lineNum) || [];
                const tIdx = list.indexOf(thread);
                if (tIdx >= 0) list.splice(tIdx, 1);
                if (list.length === 0) {
                  section.threads.delete(lineNum);
                  section.stats.delete(lineNum);
                }
              }
              _renderRail(section);
            } else {
              delBtn.disabled = false;
              delBtn.dataset.confirming = "";
              delBtn.textContent = "Delete";
              status.textContent = result.error || "Couldn't delete.";
            }
          });
          head.appendChild(delBtn);
        }

        item.appendChild(head);

        let body;
        if (comment.bodyNode) {
          body = comment.bodyNode.cloneNode(true);
        } else if (comment.bodyHTML) {
          body = el("div");
          body.innerHTML = comment.bodyHTML;
          MDRUtil.sanitizeInto(body);
        } else if (comment.bodyMarkdown) {
          body = MDRRenderer.render(comment.bodyMarkdown);
        } else {
          body = el("div", { textContent: comment.bodyText || "" });
        }
        body.className = "markdown-body mdr-comment__body";
        item.appendChild(body);
        threadEl.appendChild(item);
      }

      const footer = el("div", { className: "mdr-thread__footer" });

      const replyBtn = el("button", { className: "mdr-btn", type: "button", textContent: "Reply" });
      replyBtn.addEventListener("click", () => {
        if (qs(".mdr-reply-form", threadEl)) return;
        const form = _buildReplyForm(section, lineNum, threadIndex, status, thread.markerId, footer);
        threadEl.insertBefore(form, footer);
        _positionCards(section);
        qs("textarea", form)?.focus();
      });

      const resolveBtn = el("button", {
        className: "mdr-btn mdr-btn--quiet", type: "button",
        textContent: thread.resolved ? "Unresolve" : "Resolve",
      });
      resolveBtn.addEventListener("click", async () => {
        resolveBtn.disabled = true;
        status.textContent = thread.resolved ? "Reopening…" : "Resolving…";
        const result = await MDRAdapter.setThreadResolved(
          section.fileCtx, lineNum, threadIndex, !thread.resolved, thread.markerId
        );
        if (!_isCurrent(state)) return;
        if (result.ok) {
          status.textContent = "";
          // Resolving collapses the thread out of the DOM, so the post-action
          // scrape can't see it — update the state optimistically.
          thread.resolved = !thread.resolved;
          _applyThreadUpdate(section, result.threads);
        } else {
          resolveBtn.disabled = false;
          status.textContent = result.error || "Failed.";
        }
      });

      footer.appendChild(replyBtn);
      footer.appendChild(resolveBtn);
      footer.appendChild(status);
      threadEl.appendChild(footer);
      card.appendChild(threadEl);
    });

    const addBtn = el("button", {
      className: "mdr-btn mdr-card__add", type: "button", textContent: "+ New thread",
    });
    addBtn.addEventListener("click", () => _openComposer(section, { start: lineNum, end: lineNum }, {}));
    card.appendChild(addBtn);

    card.addEventListener("mouseenter", () => _highlightLine(section, lineNum, true));
    card.addEventListener("mouseleave", () => _highlightLine(section, lineNum, false));

    return card;
  }

  function _buildReplyForm(section, lineNum, threadIndex, status, markerId) {
    const state = _active;
    const form = el("div", { className: "mdr-reply-form" });
    const input = el("textarea", {
      className: "mdr-input", rows: "3", placeholder: "Write a reply (Markdown supported)",
    });
    const send = el("button", { className: "mdr-btn mdr-btn--primary", type: "button", textContent: "Send reply" });
    const cancel = el("button", { className: "mdr-btn mdr-btn--quiet", type: "button", textContent: "Cancel" });

    send.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) { status.textContent = "Write a reply first."; input.focus(); return; }
      input.disabled = true; send.disabled = true; cancel.disabled = true;
      status.textContent = "Posting reply…";

      const result = await MDRAdapter.replyToThread(
        section.fileCtx, lineNum, threadIndex, text, markerId
      );
      if (!_isCurrent(state)) return;
      if (result.ok) {
        status.textContent = "";
        _applyThreadUpdate(section, result.threads);
      } else {
        input.disabled = false; send.disabled = false; cancel.disabled = false;
        status.textContent = result.error || "Couldn't post the reply.";
      }
    });
    cancel.addEventListener("click", () => { form.remove(); _positionCards(section); });
    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send.click(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); form.remove(); _positionCards(section); }
    });

    const actions = el("div", { className: "mdr-actions" });
    actions.appendChild(send);
    actions.appendChild(cancel);
    form.appendChild(input);
    form.appendChild(actions);
    return form;
  }

  /* ---------------- Composer ---------------- */

  /** Any pending comment anywhere means the viewer has an open review. */
  function _hasPendingReview() {
    if (!_active) return false;
    for (const section of _active.sections) {
      for (const threads of section.threads.values()) {
        for (const thread of threads) {
          if (thread.comments.some((c) => c.pending)) return true;
        }
      }
    }
    return false;
  }

  /** Save an unsent composer draft so it survives close/reopen. */
  function _stashDraft(section) {
    if (!section || !section.rail) return;
    const textarea = qs(".mdr-composer textarea", section.rail);
    if (textarea && textarea.value.trim() && section.composerLine) {
      _draftsByDigest.set(section.fileCtx.digest, {
        line: section.composerLine,
        text: textarea.value,
      });
    }
  }

  /**
   * Shrink a line range to the lines that actually have content — block
   * source maps often include the trailing blank line (a bullet on line 16
   * maps as 16–17), and nobody wants to comment on an empty line.
   */
  function _clampRangeToContent(section, range) {
    const lines = section.headLines || [];
    let { start, end } = range;
    while (end > start && !(lines[end - 1] || "").trim()) end--;
    while (start < end && !(lines[start - 1] || "").trim()) start++;
    return { start, end };
  }

  function _openComposer(section, range, { suggest = false, draft = "", scroll = true } = {}) {
    const state = _active;
    if (!state) return;
    range = _clampRangeToContent(section, range);

    qsa(".mdr-composer", section.rail).forEach((n) => n.remove());
    const anchorLine = range.end;
    section.composerLine = anchorLine;

    const card = el("div", {
      className: "mdr-card mdr-composer", "data-line": String(anchorLine),
    });
    card.appendChild(el("div", {
      className: "mdr-composer__title",
      textContent: range.start === range.end
        ? `New comment · line ${anchorLine}`
        : `New comment · lines ${range.start}–${range.end} (anchored at ${anchorLine})`,
    }));

    const input = el("textarea", {
      className: "mdr-input", rows: "4", placeholder: "Leave a comment (Markdown supported)",
    });
    input.value = draft;
    card.appendChild(input);

    const status = el("div", { className: "mdr-composer__status" });
    card.appendChild(status);

    const actions = el("div", { className: "mdr-actions" });
    const reviewBtn = el("button", { className: "mdr-btn mdr-btn--primary", type: "button", textContent: "Add review comment" });
    const singleBtn = el("button", { className: "mdr-btn", type: "button", textContent: "Add single comment" });
    const suggestBtn = el("button", {
      className: "mdr-btn", type: "button", textContent: "Insert suggestion",
      title: "Insert a GitHub suggestion block the author can apply with one click",
    });
    const cancelBtn = el("button", { className: "mdr-btn mdr-btn--quiet", type: "button", textContent: "Cancel" });
    actions.appendChild(reviewBtn);
    actions.appendChild(singleBtn);
    actions.appendChild(suggestBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    // While a review is pending, GitHub forces every new comment into it —
    // an immediate single comment isn't possible until the review is
    // submitted or discarded.
    if (_hasPendingReview()) {
      singleBtn.disabled = true;
      singleBtn.title =
        "You have a pending review — GitHub adds all new comments to it until you submit the review.";
    }

    const setBusy = (busy) => {
      [input, reviewBtn, singleBtn, suggestBtn, cancelBtn].forEach((n) => { n.disabled = busy; });
    };

    const insertSuggestion = () => {
      if (range.start !== range.end) {
        status.textContent = "Suggestions can target one source line — select within a single line.";
        return;
      }
      const original = section.headLines[anchorLine - 1] ?? "";
      const block = "```suggestion\n" + original + "\n```\n";
      input.value = input.value ? input.value.replace(/\s*$/, "\n") + block : block;
      input.focus();
      const blockStart = input.value.lastIndexOf("```suggestion");
      const lineStart = input.value.indexOf("\n", blockStart) + 1;
      input.setSelectionRange(lineStart, lineStart + original.length);
      status.textContent = "Edit the line inside the block — the author gets one-click Apply.";
    };
    suggestBtn.addEventListener("click", insertSuggestion);
    if (suggest) insertSuggestion();

    async function submit(mode) {
      const text = input.value.trim();
      if (!text) { status.textContent = "Write a comment first."; input.focus(); return; }
      setBusy(true);
      status.textContent = "Posting via GitHub…";

      const result = await MDRAdapter.postComment(section.fileCtx, anchorLine, text, mode);
      if (!_isCurrent(state)) return;

      if (result.ok) {
        section.composerLine = null;
        card.remove();
        if (!section.stats.has(anchorLine)) section.stats.set(anchorLine, { total: 1, resolved: 0 });
        _applyThreadUpdate(section, result.threads);

        // Asked for a single comment but GitHub only offered the review path
        if (mode === "single" && /review/.test(result.usedLabel || "")) {
          state.headerStatus.textContent =
            "Added to your pending review — submit the review on GitHub to publish it.";
          setTimeout(() => {
            if (_isCurrent(state)) state.headerStatus.textContent = "";
          }, 7000);
        }
      } else {
        setBusy(false);
        status.textContent = result.error || "Couldn't post the comment.";
      }
    }

    reviewBtn.addEventListener("click", () => submit("review"));
    singleBtn.addEventListener("click", () => submit("single"));
    cancelBtn.addEventListener("click", () => {
      section.composerLine = null;
      card.remove();
      _positionCards(section);
    });
    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit("review"); }
      else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        section.composerLine = null;
        card.remove();
        _positionCards(section);
      }
    });

    section.rail.appendChild(card);
    _positionCards(section);
    if (scroll) _scrollToLine(section, anchorLine);
    setTimeout(() => input.focus(), 0);
  }

  /* ---------------- Document interactions ---------------- */

  function _highlightLine(section, lineNum, on) {
    if (!section.docHost) return;
    const block = MDRRenderer.blockForLine(section.docHost, lineNum);
    if (block) block.classList.toggle("mdr-highlight", on);
  }

  function _scrollToLine(section, lineNum) {
    const block = MDRRenderer.blockForLine(section.docHost, lineNum);
    if (block) block.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function _buildToolbar() {
    const toolbar = el("div", { className: "mdr-toolbar", style: "display:none" });
    const commentBtn = el("button", { className: "mdr-btn mdr-btn--primary", type: "button", textContent: "💬 Comment" });
    const suggestBtn = el("button", { className: "mdr-btn", type: "button", textContent: "✏️ Suggest" });
    toolbar.appendChild(commentBtn);
    toolbar.appendChild(suggestBtn);
    return toolbar;
  }

  function _hideToolbar() {
    if (_active) _active.toolbar.style.display = "none";
  }

  /** One-time overlay-level listeners (scroll, resize, sticky header). */
  function _wireOverlay() {
    const state = _active;
    let ticking = false;
    state.scroll.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (_active === state) _updateStickyPath();
      });
    });
    state.scroll.addEventListener("scroll", MDRUtil.debounce(_hideToolbar, 50));
    state.scroll.addEventListener("scroll", MDRUtil.debounce(_positionAllCards, 200));
    window.addEventListener("resize", MDRUtil.debounce(() => {
      if (_active) _positionAllCards();
    }, 150));
  }

  /** Per-document listeners — attached to each section's rendered docHost. */
  function _wireDocHost(section) {
    const state = _active;
    const docHost = section.docHost;
    const toolbar = state.toolbar;

    // Click a block (no selection) → composer for that block
    docHost.addEventListener("click", (e) => {
      if (e.target.closest("a[href]")) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const range = MDRRenderer.lineRangeForNode(docHost, e.target);
      if (!range) return;
      _openComposer(section, range, {});
    });

    // Selection → floating toolbar
    const maybeShowToolbar = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) { _hideToolbar(); return; }
      if (!docHost.contains(selection.anchorNode) || !docHost.contains(selection.focusNode)) {
        _hideToolbar();
        return;
      }

      const a = MDRRenderer.lineRangeForNode(docHost, selection.anchorNode);
      const f = MDRRenderer.lineRangeForNode(docHost, selection.focusNode);
      if (!a || !f) { _hideToolbar(); return; }

      const range = _clampRangeToContent(section, {
        start: Math.min(a.start, f.start),
        end: Math.max(a.end, f.end),
      });
      const rect = selection.getRangeAt(0).getBoundingClientRect();

      toolbar.style.display = "flex";
      toolbar.style.left = `${Math.max(8, rect.left + rect.width / 2 - 90)}px`;
      toolbar.style.top = `${Math.max(8, rect.top - 44)}px`;

      const [commentBtn, suggestBtn] = qsa("button", toolbar);
      suggestBtn.style.display = range.start === range.end ? "" : "none";

      commentBtn.onclick = () => {
        _hideToolbar();
        window.getSelection()?.removeAllRanges();
        _openComposer(section, range, {});
      };
      suggestBtn.onclick = () => {
        _hideToolbar();
        window.getSelection()?.removeAllRanges();
        _openComposer(section, range, { suggest: true });
      };
    };

    docHost.addEventListener("mouseup", () => setTimeout(maybeShowToolbar, 0));
  }

  return { open, close, isOpen, showLoading };
})();
