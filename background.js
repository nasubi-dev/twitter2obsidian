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

  // The page only renders the first few photos of a post (X allows up to 20),
  // so take the full media list from the fxtwitter API and keep the DOM
  // list as the fallback when the lookup fails.
  const fxTweet = await lookupTweet(tweetId);
  const allImages = mergeImages(images, fxTweet?.media);
  // A video past the rendered grid has no player in the DOM, so trust the API too.
  const hasVideo =
    tweetData.hasVideo || (fxTweet?.media?.videos?.length || 0) > 0;
  const quoted = tweetData.quoted
    ? {
        ...tweetData.quoted,
        images: mergeImages(tweetData.quoted.images, fxTweet?.quote?.media),
        hasVideo:
          tweetData.quoted.hasVideo ||
          (fxTweet?.quote?.media?.videos?.length || 0) > 0,
      }
    : tweetData.quoted;

  // Copy images into the vault first, so the note survives the post being
  // deleted. Images that fail keep their pbs.twimg.com URL.
  const localImages = await saveImagesToVault(settings, [
    ...allImages,
    ...(quoted?.images || []),
  ]);

  // Same for videos (mp4 via the fxtwitter API). Failures keep the X link only.
  const { videos: localVideos, quotedVideos: localQuotedVideos } =
    hasVideo || quoted?.hasVideo
      ? await saveVideosToVault(settings, fxTweet)
      : { videos: [], quotedVideos: [] };

  // Generate markdown content
  const markdown = generateMarkdown({
    ...tweetData,
    hasVideo,
    images: allImages,
    quoted,
    localImages,
    localVideos,
    localQuotedVideos,
  });

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

// Videos: highest variant at or below this height, skipped above MAX_VIDEO_BYTES.
// X's mp4 is already small (35 s at 720p is about 2.3 MB); re-encoding to webm
// made it larger, so the mp4 is saved as is. See docs/notes/動画のローカル保存.md
const MAX_VIDEO_HEIGHT = 720;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

/** Height of a video.twimg.com variant from its "/<w>x<h>/" path part, or null */
function variantHeight(url) {
  const m = url.match(/\/(\d+)x(\d+)\//);
  return m ? Number(m[2]) : null;
}

/**
 * Pick the mp4 variant to save from an fxtwitter video object:
 * the tallest at or below MAX_VIDEO_HEIGHT, else the shortest.
 * Variants without a size in the URL (GIFs) rank by bitrate.
 */
function pickVideoVariant(video) {
  const mp4s = (video?.variants || []).filter(
    (v) => v.content_type === "video/mp4" && v.url
  );
  if (mp4s.length === 0) return video?.url || null;
  const sized = mp4s.map((v) => ({ ...v, h: variantHeight(v.url) }));
  const known = sized.filter((v) => v.h !== null);
  if (known.length === 0) {
    return sized.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0].url;
  }
  const fits = known.filter((v) => v.h <= MAX_VIDEO_HEIGHT);
  if (fits.length > 0) {
    return fits.sort((a, b) => b.h - a.h || (b.bitrate || 0) - (a.bitrate || 0))[0].url;
  }
  return known.sort((a, b) => a.h - b.h)[0].url;
}

/**
 * Media id of a video.twimg.com URL:
 * ext_tw_video/<id>/..., amplify_video/<id>/..., tweet_video/<name>.mp4
 */
function videoMediaId(url) {
  const path = url.split("?")[0];
  const m = path.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//);
  if (m) return m[1];
  const t = path.match(/\/tweet_video\/([^/]+)\.mp4$/);
  return t ? t[1] : null;
}

/** Vault path for a video: assets/twitter/<media id>.mp4 */
function videoVaultPath(url) {
  const id = videoMediaId(url);
  return id ? `${IMAGE_FOLDER}/${id}.mp4` : null;
}

/** Download one mp4 and PUT it into the vault. Returns the vault path or null. */
async function saveVideoToVault(settings, url) {
  const filepath = videoVaultPath(url);
  if (!filepath) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") || 0);
    if (length > MAX_VIDEO_BYTES) {
      res.body?.cancel();
      return null;
    }
    const blob = await res.blob();
    if (blob.size > MAX_VIDEO_BYTES) return null;
    const put = await fetch(buildVaultUrl(settings, filepath), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "video/mp4",
      },
      body: blob,
    });
    return put.ok ? filepath : null;
  } catch (error) {
    console.warn("Could not save video", url, error);
    return null;
  }
}

/**
 * The tweet object from the fxtwitter API (media.all lists every photo and
 * video in order, quote holds the quoted tweet), or null on any failure.
 */
async function lookupTweet(tweetId) {
  if (!tweetId) return null;
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()).tweet || null;
  } catch (error) {
    console.warn("Could not look up tweet", tweetId, error);
    return null;
  }
}

/**
 * Every image of a post in display order: photos and video/GIF thumbnails
 * from fxtwitter media.all, then any DOM-only image the API did not list.
 * URLs use the same "<base>?format=jpg&name=large" form as content.js.
 */
function mergeImages(domImages, media) {
  const dom = domImages || [];
  const fromApi = (media?.all || [])
    .map((m) => (m.type === "photo" ? m.url : m.thumbnail_url))
    .filter((u) => u && u.startsWith("https://pbs.twimg.com/"))
    .map((u) => `${imageBase(u)}?format=jpg&name=large`);
  const out = [];
  const seen = new Set();
  for (const url of [...fromApi, ...dom]) {
    const key = imageBase(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * Save the videos of an fxtwitter tweet object (and its quoted tweet's) into
 * the vault. Returns the vault paths that were saved.
 * Never throws: on any failure the note just keeps the link to X.
 */
async function saveVideosToVault(settings, tweet) {
  const result = { videos: [], quotedVideos: [] };
  if (!tweet) return result;
  const save = async (videos) => {
    const paths = [];
    for (const video of videos || []) {
      const url = pickVideoVariant(video);
      const path = url && (await saveVideoToVault(settings, url));
      if (path && !paths.includes(path)) paths.push(path);
    }
    return paths;
  };
  result.videos = await save(tweet?.media?.videos);
  result.quotedVideos = await save(tweet?.quote?.media?.videos);
  return result;
}

/** Frontmatter list of saved videos as "[[assets/twitter/<id>.mp4]]" */
function videoListFrontmatter(key, paths) {
  if (!paths || paths.length === 0) return "";
  return `${key}:\n` + paths.map((p) => `  - "[[${p}]]"\n`).join("");
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
  const localVideos = tweetData.localVideos || [];
  const localQuotedVideos = tweetData.localQuotedVideos || [];

  let frontmatter = "---\n";
  frontmatter += `source: ${sourceUrl}\n`;
  frontmatter += `author: ${username}\n`;
  frontmatter += `text: ${escapeFrontmatterString(text)}\n`;
  frontmatter += `date: ${date}\n`;

  if (images && images.length > 0) {
    frontmatter += imageListFrontmatter("images", "image_urls", images, localImages);
  }
  frontmatter += videoListFrontmatter("videos", localVideos);

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
    frontmatter += videoListFrontmatter("quoted_videos", localQuotedVideos);
  }

  frontmatter += "---\n\n";

  // Add tweet text as body
  let body = text;

  // Add video link and embed if video exists
  if (hasVideo) {
    body += "\n\n";
    body += `🎥 [Watch Video on X](${sourceUrl})\n\n`;
    if (localVideos.length > 0) {
      // The vault copy plays in Obsidian even after the post is gone
      localVideos.forEach((p) => {
        body += `![[${p}]]\n`;
      });
    } else {
      body += `<iframe src="${sourceUrl}" width="550" height="700" frameborder="0" allowfullscreen></iframe>\n`;
    }
    // Photos posted alongside the video (the thumbnails are not repeated)
    (images || []).filter((img) => !isVideoThumb(img)).forEach((img, index) => {
      body += imageEmbed(
        `${username} - Tweet ${tweetId} - Photo ${index + 1}`,
        img,
        localImages
      );
    });
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
    body += generateQuotedSection(quoted, localImages, localQuotedVideos);
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

/** Video/GIF poster (ext_tw_video_thumb, amplify_video_thumb, tweet_video_thumb) */
function isVideoThumb(url) {
  return /_video_thumb\//.test(url);
}

/** Embed an image: the vault copy if saved, otherwise the remote URL */
function imageEmbed(alt, img, localImages) {
  const local = localImages.get(img);
  return local ? `![[${local}]]\n` : `![${alt}](${img})\n`;
}

/**
 * Render a quoted tweet as a markdown blockquote section
 */
function generateQuotedSection(quoted, localImages = new Map(), localVideos = []) {
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
    localVideos.forEach((p) => {
      section += `![[${p}]]\n`;
    });
    (quoted.images || []).filter((img) => !isVideoThumb(img)).forEach((img, index) => {
      section += imageEmbed(
        `${quoted.username} - Quoted Photo ${index + 1}`,
        img,
        localImages
      );
    });
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
