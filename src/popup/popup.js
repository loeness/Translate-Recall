const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';

const preprocessButton = document.getElementById('preprocess-btn');
const toggleButton = document.getElementById('toggle-feature-btn');
const statusEl = document.getElementById('status');

// Apply i18n strings to elements with a data-i18n attribute.
document.querySelectorAll('[data-i18n]').forEach((el) => {
  const key = el.getAttribute('data-i18n');
  const msg = chrome.i18n.getMessage(key);
  if (msg) el.textContent = msg;
});

// Set the page language and title via i18n.
document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
document.title = chrome.i18n.getMessage('extName') || 'Bilingual Text Viewer';

function i18n(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#334155';
}

function renderToggleButton(enabled) {
  if (enabled) {
    toggleButton.textContent = i18n('toggleEnableBtn');
    toggleButton.classList.remove('is-disabled');
  } else {
    toggleButton.textContent = i18n('toggleDisableBtn');
    toggleButton.classList.add('is-disabled');
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error(i18n('errorNoTab'));
  }
  return tab;
}

async function ensureContentScriptReady(tabId) {
  // Ping the existing content script first; only inject if it does not respond.
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'BTV_PING' });
    if (pong && pong.ok) return;
  } catch {
    // Content script not yet present – fall through to injection.
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['assets/styles/content.css']
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/content.js']
  });

  // Wait until content script initialized.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function sendMessageWithReconnect(tabId, payload, allowReconnect = true) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const shouldReconnect = errMsg.includes('Receiving end does not exist')
      || errMsg.includes('Could not establish connection');

    if (!allowReconnect || !shouldReconnect) {
      throw err;
    }

    await ensureContentScriptReady(tabId);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function getFeatureEnabledState() {
  const result = await chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY);
  return result[FEATURE_ENABLED_STORAGE_KEY] !== false;
}

async function setFeatureEnabledState(enabled) {
  await chrome.storage.local.set({ [FEATURE_ENABLED_STORAGE_KEY]: enabled });
}

async function triggerPreprocess() {
  preprocessButton.disabled = true;
  setStatus(i18n('statusPreprocessing'));

  try {
    const tab = await getActiveTab();
    const response = await sendMessageWithReconnect(tab.id, {
      type: 'BTV_PREPROCESS_NOW'
    }, true);

    if (!response || !response.ok) {
      throw new Error(i18n('errorNoConfirm'));
    }

    setStatus(i18n('statusPreprocessDone'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(i18n('statusPreprocessFail', [message]), true);
  } finally {
    preprocessButton.disabled = false;
  }
}

async function toggleFeatureEnabled() {
  toggleButton.disabled = true;

  try {
    const previousEnabled = await getFeatureEnabledState();
    const nextEnabled = !previousEnabled;

    const tab = await getActiveTab();
    try {
      let response = await sendMessageWithReconnect(tab.id, {
        type: 'BTV_SET_ENABLED',
        enabled: nextEnabled
      }, true);

      if (!response || response.ok !== true) {
        await ensureContentScriptReady(tab.id);
        response = await sendMessageWithReconnect(tab.id, {
          type: 'BTV_SET_ENABLED',
          enabled: nextEnabled
        }, false);
      }

      if (!response || response.ok !== true) {
        throw new Error(i18n('errorNoConfirm'));
      }
    } catch (syncError) {
      const syncMessage = syncError instanceof Error ? syncError.message : String(syncError);
      setStatus(i18n('statusToggleFail', [syncMessage]), true);
      return;
    }

    await setFeatureEnabledState(nextEnabled);
    renderToggleButton(nextEnabled);

    setStatus(nextEnabled ? i18n('statusToggleEnabled') : i18n('statusToggleDisabled'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(i18n('statusToggleFail', [message]), true);
  } finally {
    toggleButton.disabled = false;
  }
}

async function initializePopup() {
  try {
    const enabled = await getFeatureEnabledState();
    renderToggleButton(enabled);
    setStatus(enabled ? i18n('statusEnabled') : i18n('statusDisabled'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(i18n('statusInitFail', [message]), true);
  }
}

preprocessButton.addEventListener('click', triggerPreprocess);
toggleButton.addEventListener('click', toggleFeatureEnabled);

initializePopup();
