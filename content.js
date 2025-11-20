/**
 * Content script for Twitter/X pages
 * Extracts tweet information from the current page
 */

console.log("Twitter to Obsidian: Content script loaded");

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

  // Extract tweet information
  const text = extractTweetText(tweetElement);
  const username = extractUsername(tweetElement);
  const images = extractImages(tweetElement);
  const timestamp = extractTimestamp(tweetElement);
  const hasVideo = checkHasVideo(tweetElement);

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
 */
function extractTweetText(tweetElement) {
  // Try multiple selectors
  const selectors = [
    '[data-testid="tweetText"]',
    "[lang] > span", // Fallback for text spans
  ];

  for (const selector of selectors) {
    const textElement = tweetElement.querySelector(selector);
    if (textElement && textElement.textContent.trim()) {
      return textElement.textContent.trim();
    }
  }

  return "";
}

/**
 * Extract username (display name, not @handle)
 */
function extractUsername(tweetElement) {
  // Try to find display name (not @handle)
  const selectors = [
    '[data-testid="User-Name"] > div > div > span',
    '[data-testid="User-Name"] span',
  ];

  for (const selector of selectors) {
    const nameElements = tweetElement.querySelectorAll(selector);
    for (const elem of nameElements) {
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
 * Extract image URLs from tweet (including video thumbnails)
 */
function extractImages(tweetElement) {
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
  if (videoContainer) {
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
 */
function checkHasVideo(tweetElement) {
  return !!tweetElement.querySelector('[data-testid="videoPlayer"]');
}

/**
 * Extract tweet timestamp (ISO format)
 */
function extractTimestamp(tweetElement) {
  // Try to find time element
  const timeElement = tweetElement.querySelector("time");

  if (timeElement) {
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
