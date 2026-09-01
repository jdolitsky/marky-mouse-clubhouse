/**
 * main.js — bootstrap: injects a "Docs review" tab into the PR tab bar
 * (Conversation / Commits / Checks / Files changed / Docs review) on every
 * pull request page, with a floating pill as fallback if the tab bar
 * can't be found. Clicking from a non-diff page navigates to the changes
 * view and auto-opens the panel.
 */

(() => {
  "use strict";

  const { qs, qsa, el, debounce, isPRFilesPage, waitFor, logInfo } = MDRUtil;

  const TAB_CLASS = "mdr-tab";
  const GLOBAL_BTN_CLASS = "mdr-global-btn";
  const OPEN_FLAG = "mdr-open-on-load";
  const OPEN_HASH = "#mdr-open";

  // Octicon "book" — matches the octicons GitHub uses on the sibling tabs
  const BOOK_ICON =
    '<svg aria-hidden="true" focusable="false" class="octicon octicon-book fg-muted mr-2 d-none d-sm-inline-block" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="vertical-align: text-bottom;"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"></path></svg>';

  function isPRPage() {
    return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(window.location.href);
  }

  /** Arm auto-open with a timestamp (stale flags expire after 30s). */
  function markAutoOpen() {
    try { sessionStorage.setItem(OPEN_FLAG, String(Date.now())); } catch { /* ignore */ }
  }

  function prBasePath() {
    return (window.location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/) || [])[1] || "";
  }

  let _openedForPr = "";

  function openNow(files) {
    _openedForPr = prBasePath();
    MDRPanel.open(null, files);
  }

  function openPanel() {
    if (isPRFilesPage()) {
      openNow(MDRAdapter.files());
      return;
    }
    // Not on the diff view — go there and auto-open on arrival
    const m = window.location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/);
    if (m) {
      markAutoOpen();
      window.location.href = m[1] + "/changes";
    }
  }

  /**
   * Inject a "Docs review" tab into the PR tab bar. Styling is inherited
   * by cloning a sibling tab's (hashed) classes at runtime, so it always
   * matches GitHub's current look.
   */
  function ensureTab() {
    if (!isPRPage()) return false;
    const nav = qs('nav[aria-label="Pull request navigation"]');
    if (!nav) return false;

    let tab = qs(`.${TAB_CLASS}`, nav);

    if (!tab) {
      const siblings = qsa("a", nav);
      const template =
        siblings.find((a) => /files changed/i.test(a.textContent || "")) ||
        siblings[siblings.length - 1];
      if (!template) return false;

      // A real href with our marker hash — even if GitHub's SPA router
      // swallows our click handler, the anchor navigates to the changes
      // view carrying #mdr-open, which we detect on arrival (SPA route or
      // full load alike) and auto-open the panel.
      const prBase = (window.location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/) || [])[1] || "";
      tab = el("a", { href: prBase ? `${prBase}/changes${OPEN_HASH}` : "#" });
      tab.className =
        [...template.classList].filter((c) => !/selected/i.test(c)).join(" ") +
        ` ${TAB_CLASS}`;
      tab.removeAttribute("aria-current");
      tab.innerHTML = BOOK_ICON;
      tab.appendChild(document.createTextNode("Docs review"));

      const counterTemplate = template.querySelector("[data-component='CounterLabel']");
      const counter = el("span", {
        className: (counterTemplate ? counterTemplate.className : "ml-2") + " mdr-tab__count",
        "aria-hidden": "true",
      });
      tab.appendChild(counter);

      // pointerdown fires before any click interception — arm auto-open
      tab.addEventListener("pointerdown", () => {
        if (!isPRFilesPage()) markAutoOpen();
      });
      tab.addEventListener("click", (e) => {
        if (isPRFilesPage()) {
          e.preventDefault();
          e.stopPropagation();
          openNow(MDRAdapter.files());
          return;
        }
        // Keyboard activation skips pointerdown — arm here too, then let
        // the anchor navigate naturally (full load or SPA route; both
        // trigger auto-open on the changes page).
        markAutoOpen();
      });

      (template.parentElement || nav).appendChild(tab);
    }

    // Counter from the payload's diffSummaries — stable from first render,
    // unlike counting DOM containers (which blink during progressive render)
    const counter = qs(".mdr-tab__count", tab);
    if (counter) {
      if (isPRFilesPage()) {
        counter.style.display = "";
        counter.textContent = String(MDRAdapter.mdFileCount());
      } else if (counter.textContent === "") {
        // Other PR tabs don't embed the diff data — fetch it in the
        // background (cached per PR) so the count shows without a click
        MDRAdapter.fetchMdFileCountRemote().then((count) => {
          if (count === null || !tab.isConnected) return;
          const c = qs(".mdr-tab__count", tab);
          if (c) {
            c.style.display = "";
            c.textContent = String(count);
          }
        });
      }
    }
    return true;
  }

  /** Floating pill — fallback only, when the tab bar couldn't be found. */
  function ensureGlobalButton(tabInjected) {
    let btn = qs(`.${GLOBAL_BTN_CLASS}`);
    const files = isPRFilesPage() ? MDRAdapter.files() : [];

    if (tabInjected || files.length === 0) {
      if (btn) btn.remove();
      return;
    }

    if (!btn) {
      btn = el("button", {
        className: GLOBAL_BTN_CLASS,
        type: "button",
        title: "Review the Markdown files in this PR — Docs style",
      });
      btn.addEventListener("click", openPanel);
      document.body.appendChild(btn);
    }
    btn.textContent = `📝 Docs review · ${files.length} .md`;
  }

  function ensureUI() {
    const tabInjected = ensureTab();
    ensureGlobalButton(tabInjected);
    // SPA route changes fire no navigation events we can rely on — the
    // mutation observer drives this check instead.
    maybeAutoOpen();
  }

  function _autoOpenRequested() {
    if (window.location.hash === OPEN_HASH) return true;
    const armedAt = parseInt(sessionStorage.getItem(OPEN_FLAG) || "0", 10);
    return Boolean(armedAt && Date.now() - armedAt <= 60000);
  }

  let _opening = false;

  async function maybeAutoOpen() {
    if (_opening || MDRPanel.isOpen() || !isPRFilesPage()) return;
    if (!_autoOpenRequested()) return;
    _opening = true;

    // Strip the hash marker (GitHub's router clears it anyway) but KEEP
    // the sessionStorage flag armed — GitHub often hard-refreshes the
    // changes page right after routing to it, and a flag consumed before
    // the panel opened would be lost to that reload. The flag is only
    // consumed below, after the panel is actually open.
    if (window.location.hash === OPEN_HASH) {
      markAutoOpen();
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch { /* ignore */ }
    }

    try {
      // Claim the PR path NOW — the loading overlay counts as "open", and
      // the late turbo:load would otherwise close it as foreign.
      _openedForPr = prBasePath();

      // Cover the Files changed page immediately — the user asked for the
      // doc view, not the diff view.
      MDRPanel.showLoading();

      const files = await waitFor(() => {
        const f = MDRAdapter.files();
        if (f.length > 0) return f;
        // The payload knows the md count before any containers render —
        // zero means don't stall waiting for files that will never come.
        if (MDRAdapter.mdFileCountKnown() === 0) return [];
        return null;
      }, 15000, 300) || [];
      openNow(files);

      // Success — consume the request
      sessionStorage.removeItem(OPEN_FLAG);
    } finally {
      _opening = false;
    }
  }

  const debouncedEnsure = debounce(ensureUI, 800);

  function boot() {
    ensureUI();
    maybeAutoOpen();
  }

  // Auto-open runs immediately (not after the boot delay) so the loading
  // overlay covers the diff page as early as possible.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      maybeAutoOpen();
      setTimeout(boot, 1500);
    });
  } else {
    maybeAutoOpen();
    setTimeout(boot, 1500);
  }

  // GitHub fires turbo:load LATE on a fresh page load — after our panel may
  // already be open. Closing unconditionally here was killing the panel
  // seconds after auto-open. Only close when actually leaving the PR's
  // diff view.
  function onNavigate(kind) {
    logInfo("navigation event:", kind, window.location.pathname);
    if (MDRPanel.isOpen() && (prBasePath() !== _openedForPr || !isPRFilesPage())) {
      logInfo("closing panel — left the PR diff view");
      MDRPanel.close();
    }
    maybeAutoOpen();
    setTimeout(boot, 1500);
  }
  document.addEventListener("turbo:load", () => onNavigate("turbo:load"));
  document.addEventListener("pjax:end", () => onNavigate("pjax:end"));
  window.addEventListener("hashchange", () => maybeAutoOpen());
  window.addEventListener("popstate", () => setTimeout(maybeAutoOpen, 300));

  new MutationObserver(() => {
    if (!MDRPanel.isOpen()) debouncedEnsure();
  }).observe(document.body, { childList: true, subtree: true });

  logInfo("loaded", "v0.1.0");
})();
