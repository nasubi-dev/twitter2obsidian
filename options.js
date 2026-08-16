/**
 * Options page script for Twitter to Obsidian extension
 */

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

// Load saved settings when page loads
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  // Set up event listeners
  document
    .getElementById("settingsForm")
    .addEventListener("submit", handleSaveSettings);
  document
    .getElementById("testBtn")
    .addEventListener("click", handleTestConnection);
});

/**
 * Load settings from storage and populate form
 */
async function loadSettings() {
  const defaultSettings = {
    endpoint: "https://127.0.0.1:27124",
    apiKey: "",
    folderPath: "Clippings/twitter",
    showNotifications: true,
  };

  const settings = await browser.storage.sync.get(defaultSettings);

  document.getElementById("endpoint").value = settings.endpoint;
  document.getElementById("apiKey").value = settings.apiKey;
  document.getElementById("folderPath").value = settings.folderPath;
  document.getElementById("showNotifications").checked =
    settings.showNotifications;
}

/**
 * Handle save settings form submission
 */
async function handleSaveSettings(event) {
  event.preventDefault();

  const submitBtn = event.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  submitBtn.disabled = true;
  submitBtn.textContent = "⏳ Saving...";

  try {
    const settings = {
      endpoint: normalizeEndpoint(document.getElementById("endpoint").value),
      apiKey: normalizeApiKey(document.getElementById("apiKey").value),
      folderPath: normalizeFolderPath(
        document.getElementById("folderPath").value
      ),
      showNotifications: document.getElementById("showNotifications").checked,
    };

    // Validate
    if (!settings.endpoint || !settings.apiKey || !settings.folderPath) {
      showStatus("All fields are required", "error");
      return;
    }

    // Save to storage
    await browser.storage.sync.set(settings);

    showStatus("✅ Settings saved successfully!", "success");
  } catch (error) {
    console.error("Error saving settings:", error);
    showStatus("❌ Error: " + error.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

/**
 * Handle test connection button click
 */
async function handleTestConnection() {
  const testBtn = document.getElementById("testBtn");
  const originalText = testBtn.textContent;

  testBtn.disabled = true;
  testBtn.textContent = "⏳ Testing...";

  try {
    // Get current form values
    const settings = {
      endpoint: normalizeEndpoint(document.getElementById("endpoint").value),
      apiKey: normalizeApiKey(document.getElementById("apiKey").value),
    };

    if (!settings.endpoint || !settings.apiKey) {
      showStatus("⚠️ Endpoint and API Key are required", "error");
      return;
    }

    // Test connection
    const url = `${settings.endpoint}/vault/`;

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
        },
      });
    } catch (error) {
      // Transport-level failure: the endpoint could not be reached at all
      showStatus(
        `❌ Cannot reach ${settings.endpoint} (${error.message}). ` +
          `Check that Obsidian is running with the Local REST API plugin enabled. ` +
          `For an https:// endpoint, open ${url} in a tab once and accept the ` +
          `self-signed certificate, then test again.`,
        "error"
      );
      return;
    }

    if (response.ok) {
      showStatus("✅ Connection successful!", "success");
    } else if (response.status === 401 || response.status === 403) {
      showStatus(
        `❌ Rejected by Obsidian (${response.status}): the API key is wrong. ` +
          `Copy it again from the Local REST API plugin settings.`,
        "error"
      );
    } else {
      const errorText = await response.text();
      showStatus(
        `❌ Connection failed: ${response.status} ${errorText} (${url})`,
        "error"
      );
    }
  } catch (error) {
    console.error("Error testing connection:", error);
    showStatus("❌ Connection failed: " + error.message, "error");
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = originalText;
  }
}

/**
 * Show status message
 */
function showStatus(message, type = "success") {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;

  // Auto-hide after 5 seconds
  setTimeout(() => {
    statusEl.className = "status";
  }, 5000);
}
