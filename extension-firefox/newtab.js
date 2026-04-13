/**
 * newtab.js — PostMessage Bridge (Firefox build)
 *
 * This script is the middleman between the dashboard (running inside the iframe
 * at localhost:3456) and the browser's tabs API.
 *
 * Why do we need a bridge? Browser extensions can call chrome.tabs.query(),
 * chrome.tabs.remove(), etc. — but a plain webpage (even one running locally)
 * cannot. The dashboard is a webpage, so it has to ask the extension to do
 * those privileged operations on its behalf. It does this via postMessage, and
 * this script listens for those messages, performs the API calls, and posts
 * the results back.
 *
 * Firefox notes: the WebExtensions API is largely compatible with Chrome's
 * `chrome.*` namespace, so the same code works in both browsers. The only
 * differences vs the Chrome build are:
 *   - extension URLs use the `moz-extension://` scheme (we use
 *     chrome.runtime.getURL() so we don't have to hardcode either scheme)
 *   - Firefox's blank new tab is `about:newtab` / `about:home`, not
 *     `chrome://newtab/`
 */

// ─── Element references ───────────────────────────────────────────────────────
const frame    = document.getElementById('dashboard-frame');
const fallback = document.getElementById('fallback');

// ─── 1. Check whether the server is reachable ────────────────────────────────
// We use 'no-cors' mode so the fetch doesn't fail due to CORS headers. We don't
// need to read the response — we just need to know *something* answered.
fetch('http://localhost:3456', { mode: 'no-cors' })
  .then(() => {
    // Server is up — keep the iframe visible (it's already loading)
  })
  .catch(() => {
    // Server is down — hide the iframe and reveal the human-readable fallback
    showFallback();
  });

// ─── 2. Iframe load-error handler ────────────────────────────────────────────
// This catches cases where the fetch succeeded but the iframe itself errors
// (e.g. the server starts then immediately crashes).
frame.addEventListener('error', showFallback);

function showFallback() {
  frame.classList.add('hidden');
  fallback.classList.remove('hidden');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// URLs the browser may report for our own new-tab page. We use
// chrome.runtime.getURL so this works in both Chrome (chrome-extension://...)
// and Firefox (moz-extension://...).
const NEWTAB_URL = chrome.runtime.getURL('newtab.html');
const BLANK_NEWTAB_URLS = new Set([
  'chrome://newtab/',  // Chrome (kept for parity, harmless in Firefox)
  'about:newtab',      // Firefox default
  'about:home',        // Firefox home
]);

function isTabOutUrl(url) {
  if (!url) return false;
  return url === NEWTAB_URL || BLANK_NEWTAB_URLS.has(url);
}

// ─── 3. PostMessage listener ─────────────────────────────────────────────────
// The dashboard posts a message like:
//   { messageId: 'abc123', action: 'getTabs', payload: { ... } }
// We handle the action, then reply with the same messageId so the dashboard
// can match the response to the original request.
window.addEventListener('message', async (event) => {
  // Security: only accept messages from our dashboard origin
  if (event.origin !== 'http://localhost:3456') return;

  const msg = event.data || {};
  const { messageId, action } = msg;
  if (!messageId || !action) return; // Ignore malformed messages

  let response;

  try {
    if (action === 'getTabs') {
      response = await handleGetTabs();

    } else if (action === 'closeTabs') {
      // Dashboard sends urls flat: { action, messageId, urls: [...] }
      // If exact: true, match by exact URL instead of hostname
      response = msg.exact
        ? await handleCloseTabsExact(msg.urls)
        : await handleCloseTabs({ urls: msg.urls });

    } else if (action === 'focusTabs') {
      // Dashboard sends urls as an array; we focus the first match
      response = await handleFocusTabs({ urls: msg.urls });

    } else if (action === 'focusTab') {
      // Focus a single specific tab by exact URL match
      response = await handleFocusSingleTab(msg.url);

    } else if (action === 'closeDuplicates') {
      // Close duplicate tabs — either all copies or keep one of each
      response = await handleCloseDuplicates(msg.urls, msg.keepOne);

    } else if (action === 'closeTabOutDupes') {
      // Close extra Tab Out new-tab pages, keeping only the current one
      response = await handleCloseTabOutDupes();

    } else {
      response = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    response = { error: err.message };
  }

  // Always include success flag — the dashboard checks for it
  if (!response.error) {
    response.success = true;
  }

  // Send the response back to the dashboard inside the iframe
  frame.contentWindow.postMessage(
    { messageId, ...response },
    'http://localhost:3456'
  );
});

// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * getTabs — Returns a trimmed list of all open browser tabs.
 * We only send the fields the dashboard actually needs; the full Tab object
 * has many noisy fields we don't want to expose.
 */
async function handleGetTabs() {
  const tabs = await chrome.tabs.query({});

  const simpleTabs = tabs.map(tab => ({
    id:       tab.id,
    url:      tab.url,
    title:    tab.title,
    windowId: tab.windowId,
    active:   tab.active,
    // Flag Tab Out's own new-tab pages so the dashboard can detect them.
    // The browser may report the URL as the extension URL or as a generic
    // blank-newtab URL — checking both ensures we catch them regardless.
    isTabOut: isTabOutUrl(tab.url),
  }));
  return { tabs: simpleTabs };
}

/**
 * closeTabs — Closes all tabs whose hostname matches any of the given URLs.
 *
 * Why match by hostname rather than exact URL? If the user wants to close
 * "twitter.com" tabs, we should close all of them regardless of which tweet
 * they're on. Matching by hostname (e.g. "twitter.com") is more intuitive
 * than requiring an exact URL match.
 *
 * @param {Object} payload - { urls: string[] }  — list of URLs to match
 */
async function handleCloseTabs({ urls = [] } = {}) {
  // Split URLs into two groups: file:// URLs (match by exact URL since they
  // have no hostname) and regular URLs (match by hostname as before).
  const targetHostnames = [];
  const targetExactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      targetExactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable URLs */ }
    }
  }

  const allTabs = await chrome.tabs.query({});

  // Find tabs that match either by hostname or exact URL
  const matchingTabIds = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      // Exact match for file:// URLs
      if (tabUrl.startsWith('file://') && targetExactUrls.has(tabUrl)) return true;
      // Hostname match for regular URLs
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch {
        return false;
      }
    })
    .map(tab => tab.id);

  if (matchingTabIds.length > 0) {
    await chrome.tabs.remove(matchingTabIds);
  }

  return { closedCount: matchingTabIds.length };
}

/**
 * focusTabs — Switches the browser's view to the first tab matching the given URL.
 *
 * "Focusing" means: make that tab the active tab in its window, and bring
 * that window to the front.
 *
 * @param {Object} payload - { url: string }
 */
async function handleFocusTabs({ urls = [] } = {}) {
  if (!urls || urls.length === 0) return { error: 'No URLs provided' };

  // Extract hostnames from all URLs we want to match
  const targetHostnames = urls.map(u => {
    try { return new URL(u).hostname; }
    catch { return null; }
  }).filter(Boolean);

  if (targetHostnames.length === 0) return { error: 'No valid URLs' };

  const allTabs = await chrome.tabs.query({});

  // Find the first tab whose hostname matches any target
  const matchingTab = allTabs.find(tab => {
    try { return targetHostnames.includes(new URL(tab.url).hostname); }
    catch { return false; }
  });

  if (!matchingTab) {
    return { error: 'No matching tab found' };
  }

  // Make the tab active within its window
  await chrome.tabs.update(matchingTab.id, { active: true });

  // Bring the window itself into focus (puts it on top of other windows)
  await chrome.windows.update(matchingTab.windowId, { focused: true });

  return { focusedTabId: matchingTab.id };
}

/**
 * focusSingleTab — Switches to a specific tab by exact URL match.
 * Used when the user clicks a page chip to jump to that exact tab.
 */
async function handleFocusSingleTab(url) {
  if (!url) return { error: 'No URL provided' };

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first, then fall back to hostname match.
  // Prefer tabs in OTHER windows — if the user is clicking a chip, they
  // probably want to jump to that tab, not the one already behind this page.
  let matches = allTabs.filter(t => t.url === url);
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return { error: 'Tab not found' };

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];

  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
  return { focusedTabId: match.id };
}

/**
 * closeDuplicates — Closes duplicate tabs for the given URLs.
 *
 * @param {string[]} urls  — URLs that have duplicates
 * @param {boolean} keepOne — if true, keep one copy of each; if false, close all copies
 */
async function handleCloseDuplicates(urls = [], keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const tabIdsToClose = [];

  for (const url of urls) {
    // Find all tabs with this exact URL
    const matching = allTabs.filter(t => t.url === url);

    if (keepOne) {
      // Keep the first one (or the active one if any), close the rest
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) tabIdsToClose.push(tab.id);
      }
    } else {
      // Close all copies
      for (const tab of matching) tabIdsToClose.push(tab.id);
    }
  }

  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  return { closedCount: tabIdsToClose.length };
}

/**
 * closeTabOutDupes — Closes all duplicate Tab Out new-tab pages except the
 * one the user is currently looking at.
 */
async function handleCloseTabOutDupes() {
  const allTabs = await chrome.tabs.query({});

  const tabOutTabs = allTabs.filter(t => isTabOutUrl(t.url));

  if (tabOutTabs.length <= 1) {
    return { closedCount: 0 };
  }

  // Keep the active one in the focused window; if none is active, keep the first
  const keep = tabOutTabs.find(t => t.active) || tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);

  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose);
  }

  return { closedCount: toClose.length };
}

/**
 * closeTabsExact — Closes tabs matching exact URLs (not by hostname).
 * Used for landing pages so closing "Gmail inbox" doesn't also close
 * individual email threads on the same domain.
 */
async function handleCloseTabsExact(urls = []) {
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const matchingIds = allTabs
    .filter(tab => urlSet.has(tab.url))
    .map(tab => tab.id);

  if (matchingIds.length > 0) {
    await chrome.tabs.remove(matchingIds);
  }
  return { closedCount: matchingIds.length };
}
