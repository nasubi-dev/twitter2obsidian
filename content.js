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
 * Check if on bookmarks page and initialize button
 */
function checkAndInitBookmarksPage() {
  const bookmarkButton = document.getElementById("obsidian-bookmark-button");

  if (window.location.pathname === "/i/bookmarks") {
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
  // Check if we're on a tweet page
  const url = window.location.href;
  const tweetIdMatch = url.match(/\/status\/(\d+)/);

  if (!tweetIdMatch) {
    throw new Error("Not a tweet page. Please navigate to a specific tweet.");
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
 * Find the main tweet element (not retweets or replies in timeline)
 */
function findMainTweet() {
  // Multiple selector strategies for robustness
  const selectors = ['article[data-testid="tweet"]', 'article[role="article"]'];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      // Return the first tweet article (usually the main one on status page)
      return elements[0];
    }
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
  });

  // Add to page
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  // Remove after 3 seconds
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

/**
 * Initialize bookmarks page with save all button
 */
function initBookmarksPage() {
  // Wait for page to load
  setTimeout(() => {
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

    // Save each tweet
    for (let i = 0; i < tweetElements.length; i++) {
      const tweetElement = tweetElements[i];

      try {
        // Extract tweet data
        const tweetData = await extractTweetFromArticle(tweetElement);

        // Send to background script to save
        const result = await browser.runtime.sendMessage({
          action: "saveTweet",
          data: tweetData,
        });

        if (result.success) {
          saved++;
        } else if (result.alreadyExists) {
          skipped++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error("Error saving bookmark:", error);
        failed++;
      }

      // Update progress
      button.textContent = `💾 Saving ${i + 1}/${tweetElements.length}...`;

      // Small delay to avoid overwhelming the API
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Show final result
    button.textContent = originalText;

    const resultMessage = `✅ Complete! Saved: ${saved}, Skipped: ${skipped}, Failed: ${failed}`;
    showToast(resultMessage, saved > 0 ? "success" : "info");
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
  // Extract tweet URL to get ID
  const links = tweetElement.querySelectorAll('a[href*="/status/"]');
  let tweetId = null;
  let tweetUrl = null;

  for (const link of links) {
    const href = link.getAttribute("href");
    const match = href.match(/\/status\/(\d+)/);
    if (match) {
      tweetId = match[1];
      tweetUrl = "https://x.com" + href.split("?")[0];
      break;
    }
  }

  if (!tweetId) {
    throw new Error("Could not find tweet ID");
  }

  // Detect embedded quote tweet (one level deep) and extract it separately
  const quotedCard = findQuotedTweet(tweetElement);
  const quoted = quotedCard ? extractQuotedTweet(quotedCard) : null;

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
