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
    if (tabs[0] && tabs[0].url && tabs[0].url.includes("/status/")) {
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
 */
async function handleSaveTweet(tab) {
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
    const saveResult = await saveTweetToObsidian(extractResult.data);

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

/**
 * Save tweet to Obsidian via Local REST API
 */
async function saveTweetToObsidian(tweetData) {
  const settings = await getSettings();

  if (!settings.apiKey || !settings.endpoint) {
    throw new Error("Please configure API settings first");
  }

  const { username, tweetId, text, sourceUrl, images, date } = tweetData;

  // Generate filename: {username}-{tweetId}.md
  const filename = `${username}-${tweetId}.md`;
  const filepath = `${settings.folderPath}/${filename}`;

  // Check if file already exists
  const exists = await checkFileExists(settings, filepath);
  if (exists) {
    return {
      success: false,
      error: "Tweet already saved",
      alreadyExists: true,
    };
  }

  // Generate markdown content
  const markdown = generateMarkdown(tweetData);

  // Save to Obsidian
  const response = await fetch(
    `${settings.endpoint}/vault/${encodeURIComponent(filepath)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "text/markdown",
      },
      body: markdown,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to save: ${response.status} ${errorText}`);
  }

  return { success: true, filepath };
}

/**
 * Check if file exists in Obsidian vault
 */
async function checkFileExists(settings, filepath) {
  try {
    const response = await fetch(
      `${settings.endpoint}/vault/${encodeURIComponent(filepath)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
        },
      }
    );
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Generate markdown content with frontmatter
 */
function generateMarkdown(tweetData) {
  const { username, text, sourceUrl, images, date, tweetId, hasVideo } =
    tweetData;

  let frontmatter = "---\n";
  frontmatter += `source: ${sourceUrl}\n`;
  frontmatter += `author: ${username}\n`;
  frontmatter += `text: ${escapeFrontmatterString(text)}\n`;
  frontmatter += `date: ${date}\n`;

  if (images && images.length > 0) {
    frontmatter += "images:\n";
    images.forEach((img) => {
      frontmatter += `  - ${img}\n`;
    });
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
      body += `![${username} - Tweet ${tweetId} - Photo ${
        index + 1
      }](${img})\n`;
    });
  }

  return frontmatter + body;
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
    endpoint: "https://127.0.0.1:27124",
    apiKey: "",
    folderPath: "Clippings/twitter",
    showNotifications: true,
  };

  const stored = await browser.storage.sync.get(defaultSettings);
  return stored;
}
