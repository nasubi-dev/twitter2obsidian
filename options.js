/**
 * Options page script for Twitter to Obsidian extension
 */

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
      endpoint: document.getElementById("endpoint").value.trim(),
      apiKey: document.getElementById("apiKey").value.trim(),
      folderPath: document.getElementById("folderPath").value.trim(),
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
      endpoint: document.getElementById("endpoint").value.trim(),
      apiKey: document.getElementById("apiKey").value.trim(),
    };

    if (!settings.endpoint || !settings.apiKey) {
      showStatus("⚠️ Endpoint and API Key are required", "error");
      return;
    }

    // Test connection
    const response = await fetch(`${settings.endpoint}/vault/`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });

    if (response.ok) {
      showStatus("✅ Connection successful!", "success");
    } else {
      const errorText = await response.text();
      showStatus(
        `❌ Connection failed: ${response.status} ${errorText}`,
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
