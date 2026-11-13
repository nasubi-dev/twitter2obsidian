/**
 * Content script for Twitter/X pages
 * Extracts tweet information from the current page
 */

console.log("Twitter to Obsidian: Content script loaded");

// Initialize bookmark button if on bookmarks page
checkAndInitBookmarksPage();

// Monitor URL changes for SPA navigation
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    checkAndInitBookmarksPage();
  }
}).observe(document, { subtree: true, childList: true });

/**
 * Check whether the current URL shows the bookmarks timeline.
 *
 * X moved bookmarks under the "History" page: /i/bookmarks now redirects to
 * /i/history, where bookmarks is the default tab and likes live at
 * /i/history/likes. The old paths are still accepted so the button keeps
 * working if X routes back to them (or on twitter.com).
 */
function isBookmarksPage() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  // Legacy routes, including bookmark folders (/i/bookmarks/<folderId>)
  if (path === "/i/bookmarks" || path.startsWith("/i/bookmarks/")) {
    return true;
  }

  // Current route: bookmarks is the default tab of the History page.
  // /i/history/likes is a different timeline, so it is deliberately excluded.
  return path === "/i/history";
}

/**
 * Check if on bookmarks page and initialize button
 */
function checkAndInitBookmarksPage() {
  const bookmarkButton = document.getElementById("obsidian-bookmark-button");

  if (isBookmarksPage()) {
    // On bookmarks page - show button
    if (!bookmarkButton) {
      initBookmarksPage();
    }
  } else {
    // Not on bookmarks page - remove button
    if (bookmarkButton) {
      bookmarkButton.remove();
    }
  }
}

// Plain "o" saves the selected tweet, like X's own single-key shortcuts.
// Captured on window so it runs before X's handler ("o" = expand photo).
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "o" || event.repeat) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.isComposing) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") ||
        target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    browser.runtime.sendMessage({ action: "saveShortcut" });
  },
  true
);

// Cmd+O, then 1/2/3 picks the folder (Folder Path 1〜3 in the settings).
// Esc or 4 seconds without a number cancels. Cmd+O would otherwise open
// Firefox's "Open File" dialog, so it is swallowed on X pages.
const PICK_TIMEOUT_MS = 4000;
let folderPick = null; // { folders, timer } while waiting for 1/2/3

function isTypingTarget(target) {
  return (
    target instanceof Element &&
    (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") ||
      target.isContentEditable)
  );
}

function endFolderPick(message) {
  if (!folderPick) return;
  clearTimeout(folderPick.timer);
  folderPick = null;
  if (message) showToast(message, "default");
}

window.addEventListener(
  "keydown",
  async (event) => {
    if (event.isComposing || event.repeat) return;

    // Waiting for 1/2/3 after Cmd+O
    if (folderPick) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        endFolderPick("保存をやめました");
        return;
      }
      const slot = ["1", "2", "3"].indexOf(event.key) + 1;
      if (slot > 0 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const folder = folderPick.folders[slot - 1];
        if (!folder) {
          showToast(`${slot} は設定されていません（設定の Folder Path（${slot}））`, "error");
          return; // keep waiting for another number
        }
        endFolderPick();
        browser.runtime.sendMessage({ action: "saveShortcut", slot });
      }
      return;
    }

    const isCmdO =
      (event.key === "o" || event.key === "O") &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey;
    if (!isCmdO || isTypingTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    let folders = [];
    try {
      ({ folders } = await browser.runtime.sendMessage({ action: "getFolderSlots" }));
    } catch (error) {
      showToast("❌ 設定を読めませんでした", "error");
      return;
    }
    const choices = folders
      .map((folder, i) => (folder ? `${i + 1}: ${folder}` : null))
      .filter(Boolean)
      .join("  /  ");
    showToast(`保存先を選ぶ → ${choices}（Esc でやめる）`, "info");
    folderPick = {
      folders,
      timer: setTimeout(() => endFolderPick("保存をやめました（時間切れ）"), PICK_TIMEOUT_MS),
    };
  },
  true
);

// Listen for messages from popup or background
browser.runtime.onMessage.addListener(async (message) => {
  if (message.action === "extractTweet") {
    try {
      const tweetData = await extractCurrentTweet();
      return Promise.resolve({ success: true, data: tweetData });
    } catch (error) {
      console.error("Error extracting tweet:", error);
      return Promise.resolve({ success: false, error: error.message });
    }
  }

  if (message.action === "markSaved") {
    markTweetSaved(message.tweetId);
    return Promise.resolve({ success: true });
  }

  if (message.action === "showToast") {
    showToast(message.text, message.type);
    return Promise.resolve({ success: true });
  }

  if (message.action === "extractTweetFromElement") {
    try {
      const tweetData = await extractTweetFromElement(message.tweetElement);
      return Promise.resolve({ success: true, data: tweetData });
    } catch (error) {
      console.error("Error extracting tweet from element:", error);
      return Promise.resolve({ success: false, error: error.message });
    }
  }
});

/**
 * Extract tweet information from current page
 */
async function extractCurrentTweet() {
  // A tweet selected with X's J/K shortcuts (or otherwise focused) wins, so
  // the shortcut works on timelines, bookmarks, search and replies alike.
  const focused = findFocusedTweet();
  if (focused) {
    return extractTweetFromArticle(focused);
  }

  // Check if we're on a tweet page
  const url = window.location.href;
  const tweetIdMatch = url.match(/\/status\/(\d+)/);

  if (!tweetIdMatch) {
    throw new Error(
      "No tweet selected. Press J/K to select a tweet, or open a tweet page."
    );
  }

  const tweetId = tweetIdMatch[1];

  // Wait for tweet to load
  await waitForElement('[data-testid="tweet"]', 5000);

  // Find the main tweet element
  const tweetElement = findMainTweet();

  if (!tweetElement) {
    throw new Error(
      "Could not find tweet element. Please try refreshing the page."
    );
  }

  // Detect embedded quote tweet (one level deep) and extract it separately
  const quotedCard = findQuotedTweet(tweetElement);
  const quoted = quotedCard ? extractQuotedTweet(quotedCard) : null;

  // Extract main tweet information (excluding the quoted card's content)
  const text = extractTweetText(tweetElement, quotedCard);
  let username = extractUsername(tweetElement, quotedCard);
  const images = extractImages(tweetElement, quotedCard);
  const timestamp = extractTimestamp(tweetElement, quotedCard);
  const hasVideo = checkHasVideo(tweetElement, quotedCard);

  // Replace invalid filename characters with -
  username = username.replace(/[#\[\]|^:"'\\\/]/g, "-");

  // Convert ISO timestamp to YYYY-MM-DD format
  const date = timestamp.split("T")[0];

  return {
    tweetId,
    username,
    text,
    sourceUrl: url.split("?")[0], // Remove query parameters
    images,
    date,
    hasVideo,
    quoted,
  };
}

/**
 * The tweet article that currently has keyboard focus.
 *
 * X's J/K shortcuts move focus onto the tweet's <article> (it has
 * tabindex="0"), so document.activeElement is the article itself. Focus can
 * also sit on something inside it (e.g. after clicking a button), hence
 * closest(). Returns null when nothing in a tweet is focused.
 */
function findFocusedTweet() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  const article = active.closest('article[data-testid="tweet"]');
  // closest() on a quoted card's inner node still lands on the outer article
  return article && document.contains(article) ? article : null;
}

/**
 * Find the main tweet element (not retweets or replies in timeline)
 */
function findMainTweet() {
  // Multiple selector strategies for robustness
  const selectors = ['article[data-testid="tweet"]', 'article[role="article"]'];

  // The status page also renders ancestors (when the tweet is a reply) and
  // replies, so prefer the article whose own permalink matches the URL.
  const idMatch = window.location.pathname.match(/\/status\/(\d+)/);
  const tweetId = idMatch ? idMatch[1] : null;

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) {
      continue;
    }

    if (tweetId) {
      for (const element of elements) {
        const links = element.querySelectorAll('a[href*="/status/"]');
        for (const link of links) {
          const href = link.getAttribute("href");
          if (href && href.match(/\/status\/(\d+)/)?.[1] === tweetId) {
            return element;
          }
        }
      }
    }

    // Fallback: first tweet article (usually the main one on status page)
    return elements[0];
  }

  return null;
}

/**
 * Extract tweet text content
 * @param {Element} tweetElement Tweet container
 * @param {Element} [excludeElement] Subtree to ignore (e.g. quoted tweet card)
 */
function extractTweetText(tweetElement, excludeElement) {
  // Try multiple selectors
  const selectors = [
    '[data-testid="tweetText"]',
    "[lang] > span", // Fallback for text spans
  ];

  for (const selector of selectors) {
    const textElements = tweetElement.querySelectorAll(selector);
    for (const textElement of textElements) {
      // Skip text that belongs to the quoted tweet card
      if (excludeElement && excludeElement.contains(textElement)) {
        continue;
      }
      if (textElement.textContent.trim()) {
        return textElement.textContent.trim();
      }
    }
  }

  return "";
}

/**
 * Extract username (display name, not @handle)
 * @param {Element} tweetElement Tweet container
 * @param {Element} [excludeElement] Subtree to ignore (e.g. quoted tweet card)
 */
function extractUsername(tweetElement, excludeElement) {
  // Try to find display name (not @handle)
  const selectors = [
    '[data-testid="User-Name"] > div > div > span',
    '[data-testid="User-Name"] span',
  ];

  for (const selector of selectors) {
    const nameElements = tweetElement.querySelectorAll(selector);
    for (const elem of nameElements) {
      // Skip names that belong to the quoted tweet card
      if (excludeElement && excludeElement.contains(elem)) {
        continue;
      }
      const text = elem.textContent.trim();
      // Skip if it looks like @handle or timestamp
      if (text && !text.startsWith("@") && !text.match(/^\d+[smhd]$/)) {
        return text;
      }
    }
  }

  // Fallback: use @handle from URL
  const urlMatch = window.location.pathname.match(/^\/([^/]+)\//);
  if (urlMatch) {
    return urlMatch[1];
  }

  return "unknown";
}

/**
 * Extract the @handle (with leading @) from a tweet/card element
 */
function extractHandle(element) {
  const spans = element.querySelectorAll('[data-testid="User-Name"] span');
  for (const span of spans) {
    const text = span.textContent.trim();
    if (text.startsWith("@")) {
      return text;
    }
  }
  return "";
}

/**
 * Extract image URLs from tweet (including video thumbnails)
 * @param {Element} tweetElement Tweet container
 * @param {Element} [excludeElement] Subtree to ignore (e.g. quoted tweet card)
 */
function extractImages(tweetElement, excludeElement) {
  const images = [];

  // Find all image elements in tweet
  const imgSelectors = [
    'div[data-testid="tweetPhoto"] img',
    'a[href*="/photo/"] img',
    'img[src*="pbs.twimg.com/media"]',
  ];

  imgSelectors.forEach((selector) => {
    const imgElements = tweetElement.querySelectorAll(selector);
    imgElements.forEach((img) => {
      // Skip images that belong to the quoted tweet card
      if (excludeElement && excludeElement.contains(img)) {
        return;
      }
      let src = img.getAttribute("src");

      // Convert to high quality version
      if (src && src.includes("pbs.twimg.com")) {
        // Remove size parameters and set to large
        src = src.split("?")[0] + "?format=jpg&name=large";

        if (!images.includes(src)) {
          images.push(src);
        }
      }
    });
  });

  // Extract video thumbnail
  const videoContainer = tweetElement.querySelector(
    '[data-testid="videoPlayer"]'
  );
  if (videoContainer && !(excludeElement && excludeElement.contains(videoContainer))) {
    // Try to find video element or poster image
    const videoElement = videoContainer.querySelector("video");
    if (videoElement) {
      const poster = videoElement.getAttribute("poster");
      if (poster && poster.includes("pbs.twimg.com")) {
        const posterUrl = poster.split("?")[0] + "?format=jpg&name=large";
        if (!images.includes(posterUrl)) {
          images.push(posterUrl);
        }
      }
    }

    // Fallback: find img in video container
    const videoImg = videoContainer.querySelector('img[src*="pbs.twimg.com"]');
    if (videoImg) {
      let src = videoImg.getAttribute("src");
      src = src.split("?")[0] + "?format=jpg&name=large";
      if (!images.includes(src)) {
        images.push(src);
      }
    }
  }

  return images;
}

/**
 * Check if tweet contains video
 * @param {Element} tweetElement Tweet container
 * @param {Element} [excludeElement] Subtree to ignore (e.g. quoted tweet card)
 */
function checkHasVideo(tweetElement, excludeElement) {
  const player = tweetElement.querySelector('[data-testid="videoPlayer"]');
  if (!player) return false;
  if (excludeElement && excludeElement.contains(player)) return false;
  return true;
}

/**
 * Find the embedded quote tweet card inside a tweet (one level deep).
 * The quoted tweet is rendered as a clickable card (role="link") that
 * contains its own author name and text/photo.
 * @returns {Element|null}
 */
function findQuotedTweet(tweetElement) {
  const candidates = tweetElement.querySelectorAll('div[role="link"]');

  for (const card of candidates) {
    // A quote card has an author name AND either text or a photo
    const hasAuthor = card.querySelector('[data-testid="User-Name"]');
    const hasContent =
      card.querySelector('[data-testid="tweetText"]') ||
      card.querySelector('[data-testid="tweetPhoto"]');

    if (hasAuthor && hasContent) {
      return card;
    }
  }

  return null;
}

/**
 * Extract data from the quoted tweet card.
 * @param {Element} card Element returned by findQuotedTweet
 */
function extractQuotedTweet(card) {
  let username = extractUsername(card);
  const handle = extractHandle(card);
  const text = extractTweetText(card);
  const images = extractImages(card);
  const timestamp = extractTimestamp(card);
  const hasVideo = checkHasVideo(card);

  // Find the quoted status URL. The card itself has no href, but its photo
  // links (e.g. /user/status/123/photo/1) contain the status path we need.
  let sourceUrl = "";
  const statusLink = card.querySelector('a[href*="/status/"]');
  if (statusLink) {
    const href = statusLink.getAttribute("href");
    // Capture only "/<user>/status/<id>", stripping any /photo/N suffix
    const match = href.match(/\/[^/]+\/status\/\d+/);
    if (match) {
      sourceUrl = "https://x.com" + match[0];
    }
  }

  // Replace invalid filename characters with - (kept consistent with main tweet)
  username = username.replace(/[#\[\]|^:"'\\\/]/g, "-");

  const date = timestamp.split("T")[0];

  return {
    username,
    handle,
    text,
    images,
    date,
    hasVideo,
    sourceUrl,
  };
}

/**
 * Extract tweet timestamp (ISO format)
 * @param {Element} tweetElement Tweet container
 * @param {Element} [excludeElement] Subtree to ignore (e.g. quoted tweet card)
 */
function extractTimestamp(tweetElement, excludeElement) {
  // Find the first time element that does not belong to the quoted card.
  // On a status page the main tweet's time sits in the footer, which can
  // appear after the quoted card's time in the DOM.
  const timeElements = tweetElement.querySelectorAll("time");

  for (const timeElement of timeElements) {
    if (excludeElement && excludeElement.contains(timeElement)) {
      continue;
    }
    const datetime = timeElement.getAttribute("datetime");
    if (datetime) {
      return datetime;
    }
  }

  // Fallback to current time
  return new Date().toISOString();
}

/**
 * Wait for element to appear in DOM
 */
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timeout waiting for element: " + selector));
    }, timeout);
  });
}

/**
 * Show toast notification on the page
 */
function showToast(text, type = "success") {
  // Remove existing toast if any
  const existingToast = document.getElementById("twitter-obsidian-toast");
  if (existingToast) {
    existingToast.remove();
  }

  // Create toast element
  const toast = document.createElement("div");
  toast.id = "twitter-obsidian-toast";
  toast.textContent = text;

  // Set colors based on type
  let backgroundColor, textColor;
  switch (type) {
    case "success":
      backgroundColor = "#10b981";
      textColor = "#ffffff";
      break;
    case "error":
      backgroundColor = "#ef4444";
      textColor = "#ffffff";
      break;
    case "info":
      backgroundColor = "#3b82f6";
      textColor = "#ffffff";
      break;
    default:
      backgroundColor = "#6b7280";
      textColor = "#ffffff";
  }

  // Style the toast
  Object.assign(toast.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    backgroundColor: backgroundColor,
    color: textColor,
    padding: "16px 24px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    boxShadow:
      "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
    zIndex: "10000",
    opacity: "0",
    transform: "translateY(-10px)",
    transition: "opacity 0.3s ease, transform 0.3s ease",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    // Error details are multi-line and can be long
    whiteSpace: "pre-line",
    maxWidth: "420px",
  });

  // Add to page
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  // Errors carry details worth reading, so keep them up longer
  const visibleFor = type === "error" ? 15000 : 3000;

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, visibleFor);
}

/**
 * Initialize bookmarks page with save all button
 */
function initBookmarksPage() {
  // Wait for page to load
  setTimeout(() => {
    // The user may have switched tabs/pages while we were waiting
    if (!isBookmarksPage()) {
      return;
    }
    createBookmarkSaveButton();
  }, 2000);
}

/**
 * Create floating button for saving all bookmarks
 */
function createBookmarkSaveButton() {
  // Check if button already exists
  if (document.getElementById("obsidian-bookmark-button")) {
    return;
  }

  const button = document.createElement("button");
  button.id = "obsidian-bookmark-button";
  button.textContent = "📚 Save All Bookmarks to Obsidian";

  // Style button
  Object.assign(button.style, {
    position: "fixed",
    bottom: "30px",
    right: "30px",
    backgroundColor: "#8b5cf6",
    color: "white",
    padding: "16px 24px",
    borderRadius: "12px",
    fontSize: "16px",
    fontWeight: "700",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 10px 25px -5px rgba(139, 92, 246, 0.5)",
    zIndex: "10000",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    transition: "all 0.3s ease",
  });

  // Hover effect
  button.addEventListener("mouseenter", () => {
    button.style.backgroundColor = "#7c3aed";
    button.style.transform = "translateY(-2px)";
    button.style.boxShadow = "0 15px 30px -5px rgba(139, 92, 246, 0.6)";
  });

  button.addEventListener("mouseleave", () => {
    button.style.backgroundColor = "#8b5cf6";
    button.style.transform = "translateY(0)";
    button.style.boxShadow = "0 10px 25px -5px rgba(139, 92, 246, 0.5)";
  });

  // Click handler
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.style.opacity = "0.6";
    button.style.cursor = "not-allowed";

    await saveAllBookmarks(button);

    button.disabled = false;
    button.style.opacity = "1";
    button.style.cursor = "pointer";
  });

  document.body.appendChild(button);
}

/**
 * Save all bookmarks to Obsidian
 */
async function saveAllBookmarks(button) {
  const originalText = button.textContent;

  try {
    showToast("🔍 Collecting bookmarks...", "info");
    button.textContent = "🔍 Collecting bookmarks...";

    // Collect all tweets by scrolling
    const tweetElements = await collectAllBookmarks(button);

    showToast(
      `📊 Found ${tweetElements.length} bookmarks. Starting save...`,
      "info"
    );
    button.textContent = `💾 Saving 0/${tweetElements.length}...`;

    let saved = 0;
    let skipped = 0;
    let failed = 0;
    // Keep the distinct reasons so a run that fails is diagnosable instead of
    // collapsing into a bare "Failed: N" count.
    const errorCounts = new Map();

    const recordError = (tweetId, reason) => {
      failed++;
      console.error(`[t2o] Failed to save ${tweetId || "(unknown id)"}:`, reason);
      errorCounts.set(reason, (errorCounts.get(reason) || 0) + 1);
    };

    // Save each tweet
    for (let i = 0; i < tweetElements.length; i++) {
      const tweetElement = tweetElements[i];
      let tweetId = null;

      try {
        // Extract tweet data
        const tweetData = await extractTweetFromArticle(tweetElement);
        tweetId = tweetData.tweetId;

        // Send to background script to save
        const result = await browser.runtime.sendMessage({
          action: "saveTweet",
          data: tweetData,
        });

        if (!result) {
          // No response at all - the background script never answered
          recordError(tweetId, "No response from background script");
        } else if (result.success) {
          saved++;
        } else if (result.alreadyExists) {
          skipped++;
        } else {
          recordError(tweetId, result.error || "Unknown error");
        }
      } catch (error) {
        recordError(tweetId, error.message || String(error));
      }

      // Update progress
      button.textContent = `💾 Saving ${i + 1}/${tweetElements.length}...`;

      // Small delay to avoid overwhelming the API
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Show final result
    button.textContent = originalText;

    let resultMessage = `✅ Complete! Saved: ${saved}, Skipped: ${skipped}, Failed: ${failed}`;

    if (failed > 0) {
      // Surface the most common reasons directly in the toast
      const topReasons = [...errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([reason, count]) => `${reason} (x${count})`);
      resultMessage += `\n\n${topReasons.join("\n")}`;
      console.error("[t2o] Failure reasons:", Object.fromEntries(errorCounts));
    }

    showToast(resultMessage, saved > 0 ? "success" : failed > 0 ? "error" : "info");
  } catch (error) {
    console.error("Error saving bookmarks:", error);
    button.textContent = originalText;
    showToast("❌ Error: " + error.message, "error");
  }
}

/**
 * Collect all bookmark tweets by scrolling
 */
async function collectAllBookmarks(button) {
  const tweets = new Set();
  let lastCount = 0;
  let noChangeCount = 0;
  const maxNoChange = 5; // Stop after 5 scrolls with no new tweets

  button.textContent = `🔍 Collecting... (${tweets.size} found)`;

  while (noChangeCount < maxNoChange) {
    // Get all tweet articles currently in DOM
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    // Add new tweets to set
    articles.forEach((article) => {
      tweets.add(article);
    });

    // Update button
    button.textContent = `🔍 Collecting... (${tweets.size} found)`;

    // Check if we got new tweets
    if (tweets.size === lastCount) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
      lastCount = tweets.size;
    }

    // Scroll to bottom
    window.scrollTo(0, document.body.scrollHeight);

    // Wait for new content to load
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return Array.from(tweets);
}

/**
 * Extract tweet data from article element
 */
async function extractTweetFromArticle(tweetElement) {
  // Detect embedded quote tweet (one level deep) and extract it separately
  const quotedCard = findQuotedTweet(tweetElement);
  const quoted = quotedCard ? extractQuotedTweet(quotedCard) : null;

  const permalink = findPermalink(tweetElement, quotedCard);
  if (!permalink) {
    throw new Error("Could not find tweet ID");
  }
  const tweetId = permalink.match(/\/status\/(\d+)/)[1];
  const tweetUrl = "https://x.com" + permalink;

  // Extract other data (excluding the quoted card's content)
  const text = extractTweetText(tweetElement, quotedCard);
  let username = extractUsername(tweetElement, quotedCard);
  const images = extractImages(tweetElement, quotedCard);
  const timestamp = extractTimestamp(tweetElement, quotedCard);
  const hasVideo = checkHasVideo(tweetElement, quotedCard);

  // Replace invalid filename characters with -
  username = username.replace(/[#\[\]|^:"'\\\/]/g, "-");

  const date = timestamp.split("T")[0];

  return {
    tweetId,
    username,
    text,
    sourceUrl: tweetUrl,
    images,
    date,
    hasVideo,
    quoted,
  };
}

/**
 * "/<user>/status/<id>" of the tweet itself, ignoring the quoted card.
 *
 * The timestamp link is the tweet's permalink. Taking the first status link
 * instead can pick up the quoted card's photo link, because on a status page
 * the main tweet's timestamp sits in the footer, after the quoted card.
 */
function findPermalink(tweetElement, quotedCard) {
  const outside = (el) => !(quotedCard && quotedCard.contains(el));
  const toPath = (href) => href?.match(/\/[^/?#]+\/status\/\d+/)?.[0] || null;

  for (const time of tweetElement.querySelectorAll("time")) {
    if (!outside(time)) continue;
    const path = toPath(time.closest("a")?.getAttribute("href"));
    if (path) return path;
  }

  // Fallback: first status link outside the quoted card
  for (const link of tweetElement.querySelectorAll('a[href*="/status/"]')) {
    if (!outside(link)) continue;
    const path = toPath(link.getAttribute("href"));
    if (path) return path;
  }
  return null;
}

/* ------------------------------------------------------------------------
 * "Saved" indicator
 *
 * Tweets already in the vault get a small purple dot. It is display-only
 * (saving is O or Alt+O) and never takes up layout space, so nothing on the page
 * moves when it appears:
 * - timeline: absolutely positioned just left of the bookmark icon
 * - status page's main tweet: appended to the end of the timestamp row
 *   ("3:03 PM · Oct 31, 2026 · 3.3M Views · ● Saved")
 * --------------------------------------------------------------------- */

const INDICATOR_CLASS = "t2o-saved";
const SAVED_COLOR = "#a882ff"; // Obsidian purple

/** tweetId -> true (saved) | false (not saved) | "pending" (asking) */
const savedState = new Map();
let indicatorScanQueued = false;

injectIndicatorStyles();
scheduleIndicatorScan();
new MutationObserver(scheduleIndicatorScan).observe(document.body, {
  childList: true,
  subtree: true,
});

function scheduleIndicatorScan() {
  if (indicatorScanQueued) return;
  indicatorScanQueued = true;
  requestAnimationFrame(() => {
    indicatorScanQueued = false;
    document
      .querySelectorAll('article[data-testid="tweet"]')
      .forEach(updateIndicator);
  });
}

function injectIndicatorStyles() {
  if (document.getElementById("t2o-saved-style")) return;
  const style = document.createElement("style");
  style.id = "t2o-saved-style";
  style.textContent = `
    .${INDICATOR_CLASS}-dot {
      position: absolute; top: 50%; right: 100%; margin-right: 6px;
      width: 6px; height: 6px; border-radius: 9999px;
      transform: translateY(-50%); background: ${SAVED_COLOR};
      pointer-events: none;
    }
    .${INDICATOR_CLASS}-row {
      color: rgb(113, 118, 123); white-space: nowrap; pointer-events: none;
    }
    .${INDICATOR_CLASS}-label::before {
      content: ""; display: inline-block; width: 6px; height: 6px;
      margin: 0 4px 0 0; border-radius: 9999px; vertical-align: middle;
      background: ${SAVED_COLOR};
    }
  `;
  document.head.appendChild(style);
}

function articleTweetId(article) {
  const path = findPermalink(article, findQuotedTweet(article));
  return path ? path.match(/\/status\/(\d+)/)[1] : null;
}

function updateIndicator(article) {
  const tweetId = articleTweetId(article);
  if (!tweetId) return;

  const state = savedState.get(tweetId);
  if (state === undefined) {
    savedState.set(tweetId, "pending");
    askSaved(article, tweetId);
    return;
  }
  if (state === true && !article.querySelector(`.${INDICATOR_CLASS}`)) {
    placeIndicator(article, tweetId);
  }
}

async function askSaved(article, tweetId) {
  let saved = false;
  try {
    const data = await extractTweetFromArticle(article);
    const result = await browser.runtime.sendMessage({ action: "checkSaved", data });
    saved = !!result?.saved;
  } catch (e) {
    // Treat as not saved
  }
  // A save may have landed while we were asking
  if (savedState.get(tweetId) !== true) savedState.set(tweetId, saved);
  scheduleIndicatorScan();
}

function placeIndicator(article, tweetId) {
  const onStatusPage =
    window.location.pathname.match(/\/status\/(\d+)/)?.[1] === tweetId;

  if (onStatusPage) {
    // Main tweet: the timestamp link sits in a row with "· N Views"
    const time = [...article.querySelectorAll("time")].find((t) =>
      t.closest("a")?.getAttribute("href")?.includes(`/status/${tweetId}`)
    );
    const row = time?.closest("a")?.parentElement?.parentElement;
    if (row) {
      const label = document.createElement("span");
      label.className = `${INDICATOR_CLASS} ${INDICATOR_CLASS}-row`;
      label.textContent = " · ";
      const text = document.createElement("span");
      text.className = `${INDICATOR_CLASS}-label`;
      text.textContent = "Saved";
      label.appendChild(text);
      row.appendChild(label);
      return;
    }
  }

  const bar = findActionBar(article);
  const bookmark = bar?.querySelector(
    '[data-testid="bookmark"], [data-testid="removeBookmark"]'
  );
  if (!bookmark) return; // not rendered yet; the next scan retries
  const dot = document.createElement("span");
  dot.className = `${INDICATOR_CLASS} ${INDICATOR_CLASS}-dot`;
  dot.title = "Saved in Obsidian";
  // The button is position: relative with overflow visible, so the dot can
  // hang off its left edge without affecting the row's layout.
  bookmark.appendChild(dot);
}

/** The tweet's own action bar (reply/repost/like/.../bookmark/share). */
function findActionBar(article) {
  const quotedCard = findQuotedTweet(article);
  for (const group of article.querySelectorAll('[role="group"]')) {
    if (quotedCard && quotedCard.contains(group)) continue;
    if (group.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]')) {
      return group;
    }
  }
  return null;
}

/** Called after a save (O, Alt+O or page action) succeeds or finds the note. */
function markTweetSaved(tweetId) {
  savedState.set(tweetId, true);
  scheduleIndicatorScan();
}
