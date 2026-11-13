/**
 * Background script for Twitter to Obsidian extension
 * Handles communication between content script and Obsidian Local REST API
 */

// Handle keyboard shortcut command
browser.commands.onCommand.addListener(async (command) => {
  if (command === "save-tweet") {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    // Any X page: content.js saves the tweet focused with J/K, or the
    // tweet of a /status/ page when nothing is focused.
    if (tabs[0] && /^https:\/\/(x|twitter)\.com\//.test(tabs[0].url || "")) {
      handleSaveTweet(tabs[0]);
    }
  }
});

// Show page action icon only on tweet pages
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    if (tab.url.includes("/status/")) {
      browser.pageAction.show(tabId);
    } else {
      browser.pageAction.hide(tabId);
    }
  }
});

// Handle page action click (URLバーのアイコンクリック)
browser.pageAction.onClicked.addListener(async (tab) => {
  await handleSaveTweet(tab);
});

/**
 * Handle save tweet action (from icon click or keyboard shortcut)
 * slot: 1〜3（Cmd+O のあとに押した番号）。省略すると 1 番のフォルダ
 */
async function handleSaveTweet(tab, slot = 1) {
  try {
    // Show loading toast
    await browser.tabs.sendMessage(tab.id, {
      action: "showToast",
      text: "⏳ Saving tweet...",
      type: "info",
    });

    // Extract tweet from content script
    const extractResult = await browser.tabs.sendMessage(tab.id, {
      action: "extractTweet",
    });

    if (!extractResult.success) {
      await browser.tabs.sendMessage(tab.id, {
        action: "showToast",
        text: "❌ " + extractResult.error,
        type: "error",
      });
      showNotification("Error", extractResult.error, "error");
      return;
    }

    // Save tweet
    const saveResult = await saveTweetToObsidian(extractResult.data, slot);

    if (saveResult.success || saveResult.alreadyExists) {
      browser.tabs
        .sendMessage(tab.id, {
          action: "markSaved",
          tweetId: extractResult.data.tweetId,
        })
        .catch(() => {});
    }

    if (saveResult.success) {
      await browser.tabs.sendMessage(tab.id, {
        action: "showToast",
        text: "✅ Tweet saved successfully!",
        type: "success",
      });
      showNotification(
        "Tweet Saved",
        `Saved to ${saveResult.filepath}`,
        "success"
      );
    } else if (saveResult.alreadyExists) {
      await browser.tabs.sendMessage(tab.id, {
        action: "showToast",
        text: "ℹ️ This tweet is already saved",
        type: "info",
      });
      showNotification("Already Saved", "This tweet is already saved", "info");
    } else {
      await browser.tabs.sendMessage(tab.id, {
        action: "showToast",
        text: "❌ " + (saveResult.error || "Failed to save tweet"),
        type: "error",
      });
      showNotification(
        "Error",
        saveResult.error || "Failed to save tweet",
        "error"
      );
    }
  } catch (error) {
    console.error("Error handling save tweet:", error);
    try {
      await browser.tabs.sendMessage(tab.id, {
        action: "showToast",
        text: "❌ " + error.message,
        type: "error",
      });
    } catch (e) {
      // Ignore if can't send message to tab
    }
    showNotification("Error", error.message, "error");
  }
}

// Listen for messages from content script
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "saveShortcut") {
    // Plain "o" pressed on an X page (content.js listens for it, because
    // manifest commands can't bind a key without a modifier).
    // Cmd+O → 1/2/3 also arrives here with message.slot set.
    if (sender.tab) handleSaveTweet(sender.tab, message.slot || 1);
    return;
  }

  if (message.action === "getFolderSlots") {
    // content.js shows these in the Cmd+O picker toast.
    const settings = await getSettings();
    return { folders: folderSlots(settings) };
  }

  if (message.action === "checkSaved") {
    // Drives the chip next to the bookmark button. Any failure (no API key,
    // Obsidian closed) just reads as "not saved".
    try {
      const settings = await getSettings();
      if (!settings.apiKey || !settings.endpoint) return { saved: false };
      // Saved in any of the 1〜3 folders counts as saved.
      for (const folder of folderSlots(settings)) {
        if (folder && (await checkFileExists(settings, tweetFilepath(folder, message.data)))) {
          return { saved: true };
        }
      }
      return { saved: false };
    } catch (error) {
      return { saved: false };
    }
  }

  if (message.action === "saveTweet") {
    try {
      const result = await saveTweetToObsidian(message.data);
      return Promise.resolve(result);
    } catch (error) {
      console.error("Error saving tweet:", error);
      return Promise.resolve({ success: false, error: error.message });
    }
  }
});

/** Vault path of a tweet's note: {folder}/{username}-{tweetId}.md */
function tweetFilepath(folder, { username, tweetId }) {
  return `${folder}/${username}-${tweetId}.md`;
}

/** Folders for slots 1〜3 (index 0〜2). An empty string means the slot is unused. */
function folderSlots(settings) {
  return [settings.folderPath, settings.folderPath2, settings.folderPath3];
}

/**
 * Save tweet to Obsidian via Local REST API
 * slot: 1〜3。空のフォルダの番号を選んだときはエラーにする
 */
async function saveTweetToObsidian(tweetData, slot = 1) {
  const settings = await getSettings();

  if (!settings.apiKey || !settings.endpoint) {
    throw new Error("Please configure API settings first");
  }

  const folder = folderSlots(settings)[slot - 1];
  if (!folder) {
    throw new Error(`Folder Path（${slot}）が設定されていません`);
  }

  const { username, tweetId, text, sourceUrl, images, date } = tweetData;

  const filepath = tweetFilepath(folder, tweetData);

  // Check if file already exists
  const exists = await checkFileExists(settings, filepath);
  if (exists) {
    return {
      success: false,
      error: "Tweet already saved",
      alreadyExists: true,
    };
  }

  // Copy images into the vault first, so the note survives the post being
  // deleted. Images that fail keep their pbs.twimg.com URL.
  const localImages = await saveImagesToVault(settings, [
    ...(images || []),
    ...(tweetData.quoted?.images || []),
  ]);

  // Generate markdown content
  const markdown = generateMarkdown({ ...tweetData, localImages });

  // Save to Obsidian
  let response;
  try {
    response = await fetch(buildVaultUrl(settings, filepath), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "text/markdown",
      },
      body: markdown,
    });
  } catch (error) {
    // fetch only rejects on transport-level problems, so the endpoint is
    // unreachable rather than the request being refused by the plugin.
    throw new Error(
      `Cannot reach Obsidian at ${settings.endpoint} (${error.message}). ` +
        `Check that Obsidian is running with the Local REST API plugin enabled, ` +
        `and that the self-signed certificate for the https:// port has been ` +
        `accepted in this browser (open ${settings.endpoint} in a tab once).`
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Rejected by Obsidian (${response.status}): the API key is wrong or missing.`
      );
    }
    throw new Error(`Failed to save: ${response.status} ${errorText}`);
  }

  return { success: true, filepath };
}

// Vault folder for downloaded images. Keep in sync with scripts/localize-images.mjs
// (the vault's .gitignore excludes this folder).
const IMAGE_FOLDER = "assets/twitter";

/** Image URL without query and extension, e.g. https://pbs.twimg.com/media/<id> */
function imageBase(url) {
  return url.split("?")[0].replace(/\.(?:jpe?g|png|webp|gif)$/i, "");
}

/** Vault path for an image: assets/twitter/<media id>.webp */
function imageVaultPath(url) {
  return `${IMAGE_FOLDER}/${imageBase(url).split("/").pop()}.webp`;
}

/**
 * Download pbs.twimg.com images (webp, large) and write them into the vault.
 * Returns a Map of original URL -> vault path for the ones that were saved.
 * A failure never blocks saving the note; that image just stays a URL.
 */
async function saveImagesToVault(settings, urls) {
  const saved = new Map();
  for (const url of new Set(urls)) {
    if (!url.startsWith("https://pbs.twimg.com/")) continue;
    try {
      const res = await fetch(`${imageBase(url)}?format=webp&name=large`);
      if (!res.ok) continue;
      const blob = await res.blob();
      const filepath = imageVaultPath(url);
      const put = await fetch(buildVaultUrl(settings, filepath), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "image/webp",
        },
        body: blob,
      });
      if (put.ok) saved.set(url, filepath);
    } catch (error) {
      console.warn("Could not save image", url, error);
    }
  }
  return saved;
}

/**
 * Build the /vault/ URL for a vault-relative path.
 *
 * The path separators must stay real slashes - the REST API routes on them to
 * reach nested folders. Encoding the whole path with encodeURIComponent turns
 * "Clippings/twitter/foo.md" into a single "Clippings%2Ftwitter%2Ffoo.md"
 * segment, which the API answers with 404 (errorCode 40400). So encode each
 * segment on its own and rejoin with "/".
 */
function buildVaultUrl(settings, filepath) {
  const encodedPath = filepath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${settings.endpoint}/vault/${encodedPath}`;
}

/**
 * Check if file exists in Obsidian vault
 */
async function checkFileExists(settings, filepath) {
  try {
    const response = await fetch(buildVaultUrl(settings, filepath), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Generate markdown content with frontmatter
 */
function generateMarkdown(tweetData) {
  const { username, text, sourceUrl, images, date, tweetId, hasVideo, quoted } =
    tweetData;
  const localImages = tweetData.localImages || new Map();

  let frontmatter = "---\n";
  frontmatter += `source: ${sourceUrl}\n`;
  frontmatter += `author: ${username}\n`;
  frontmatter += `text: ${escapeFrontmatterString(text)}\n`;
  frontmatter += `date: ${date}\n`;

  if (images && images.length > 0) {
    frontmatter += imageListFrontmatter("images", "image_urls", images, localImages);
  }

  // Add quoted tweet info to frontmatter (one level deep)
  if (quoted) {
    if (quoted.username) {
      frontmatter += `quoted_author: ${quoted.username}\n`;
    }
    if (quoted.text) {
      frontmatter += `quoted_text: ${escapeFrontmatterString(quoted.text)}\n`;
    }
    if (quoted.sourceUrl) {
      frontmatter += `quoted_source: ${quoted.sourceUrl}\n`;
    }
    if (quoted.images && quoted.images.length > 0) {
      frontmatter += imageListFrontmatter(
        "quoted_images",
        "quoted_image_urls",
        quoted.images,
        localImages
      );
    }
  }

  frontmatter += "---\n\n";

  // Add tweet text as body
  let body = text;

  // Add video link and embed if video exists
  if (hasVideo) {
    body += "\n\n";
    body += `🎥 [Watch Video on X](${sourceUrl})\n\n`;
    body += `<iframe src="${sourceUrl}" width="550" height="700" frameborder="0" allowfullscreen></iframe>`;
  } else if (images && images.length > 0) {
    // Add images in markdown format only if no video
    body += "\n\n";
    images.forEach((img, index) => {
      body += imageEmbed(
        `${username} - Tweet ${tweetId} - Photo ${index + 1}`,
        img,
        localImages
      );
    });
  }

  // Append quoted tweet as a blockquote (one level deep)
  if (quoted) {
    body += generateQuotedSection(quoted, localImages);
  }

  return frontmatter + body;
}

/**
 * Frontmatter list for images. Saved images become "[[assets/twitter/...]]"
 * links and their original URLs go under urlKey (same shape as
 * scripts/localize-images.mjs writes).
 */
function imageListFrontmatter(key, urlKey, images, localImages) {
  let out = `${key}:\n`;
  images.forEach((img) => {
    const local = localImages.get(img);
    out += local ? `  - "[[${local}]]"\n` : `  - ${img}\n`;
  });
  const moved = images.filter((img) => localImages.has(img));
  if (moved.length > 0) {
    out += `${urlKey}:\n`;
    moved.forEach((img) => {
      out += `  - ${img}\n`;
    });
  }
  return out;
}

/** Embed an image: the vault copy if saved, otherwise the remote URL */
function imageEmbed(alt, img, localImages) {
  const local = localImages.get(img);
  return local ? `![[${local}]]\n` : `![${alt}](${img})\n`;
}

/**
 * Render a quoted tweet as a markdown blockquote section
 */
function generateQuotedSection(quoted, localImages = new Map()) {
  const author = quoted.handle
    ? `${quoted.username} (${quoted.handle})`
    : quoted.username;

  let section = "\n\n---\n\n";
  section += "引用元:";
  if (author) {
    section += ` ${author}`;
  }
  if (quoted.sourceUrl) {
    section += ` - [${quoted.sourceUrl}](${quoted.sourceUrl})`;
  }
  section += "\n\n";

  // Quoted text as blockquote
  if (quoted.text) {
    const quotedLines = quoted.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    section += quotedLines + "\n";
  }

  // Quoted video link / images
  if (quoted.hasVideo && quoted.sourceUrl) {
    section += `\n🎥 [Watch Video on X](${quoted.sourceUrl})\n`;
  } else if (quoted.images && quoted.images.length > 0) {
    section += "\n";
    quoted.images.forEach((img, index) => {
      section += imageEmbed(
        `${quoted.username} - Quoted Photo ${index + 1}`,
        img,
        localImages
      );
    });
  }

  return section;
}

/**
 * Escape special characters in frontmatter strings
 */
function escapeFrontmatterString(str) {
  if (!str) return "";
  // If contains special characters, wrap in quotes and escape quotes
  if (str.includes(":") || str.includes("\n") || str.includes('"')) {
    return '"' + str.replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
  }
  return str;
}

/**
 * Show notification to user
 */
function showNotification(title, message, type = "success") {
  const settings = getSettings();

  // Only show if notifications are enabled
  settings.then((s) => {
    if (s.showNotifications) {
      browser.notifications.create({
        type: "basic",
        iconUrl: "icons/favicon.ico",
        title: title,
        message: message,
      });
    }
  });
}

/**
 * Get extension settings from storage
 */
async function getSettings() {
  const defaultSettings = {
    endpoint: "http://127.0.0.1:27123",
    apiKey: "",
    folderPath: "Clippings/twitter",
    folderPath2: "Clippings/tech",
    folderPath3: "Clippings/knowledge",
    showNotifications: true,
  };

  const stored = await browser.storage.sync.get(defaultSettings);
  stored.apiKey = normalizeApiKey(stored.apiKey);
  stored.endpoint = normalizeEndpoint(stored.endpoint);
  stored.folderPath = normalizeFolderPath(stored.folderPath);
  stored.folderPath2 = normalizeFolderPath(stored.folderPath2);
  stored.folderPath3 = normalizeFolderPath(stored.folderPath3);
  return stored;
}

/**
 * Strip trailing slashes so `${endpoint}/vault/...` never becomes `//vault/...`,
 * which the Local REST API answers with a redirect/404 instead of the file.
 */
function normalizeEndpoint(endpoint) {
  return (endpoint || "").trim().replace(/\/+$/, "");
}

/**
 * Strip surrounding slashes so the vault path has exactly one separator.
 */
function normalizeFolderPath(folderPath) {
  return (folderPath || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Strip a leading "Bearer " prefix so the API key can be pasted as-is,
 * whether or not the REST API plugin includes it.
 */
function normalizeApiKey(apiKey) {
  // Remove any "Bearer" tokens and all whitespace so the key can be pasted
  // as-is (the REST API plugin shows it as "Bearer <key>"). A lowercase hex
  // key never contains the substring "Bearer", so global removal is safe.
  return (apiKey || "").replace(/Bearer/gi, "").replace(/\s+/g, "");
}
