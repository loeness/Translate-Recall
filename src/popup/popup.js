const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';
const browserUserAgent = navigator.userAgent || '';
const IS_EDGE_BROWSER = /\bEdg\//.test(browserUserAgent);
const PING_RETRY_INTERVAL_MS = IS_EDGE_BROWSER ? 45 : 60;
const PING_RETRY_ATTEMPTS_BEFORE_INJECT = IS_EDGE_BROWSER ? 2 : 3;
const PING_RETRY_ATTEMPTS_AFTER_INJECT = IS_EDGE_BROWSER ? 8 : 12;

const pendingEnsureByTabId = new Map();

const preprocessButton = document.getElementById('preprocess-btn');
const toggleButton = document.getElementById('toggle-feature-btn');
const statusEl = document.getElementById('status');

function t(key, fallback = '') {
  const message = chrome.i18n?.getMessage(key);
  return message || fallback;
}

function localizeStaticText() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((element) => {
    const key = element.getAttribute('data-i18n');
    if (!key) return;

    const message = t(key, element.textContent || '');
    element.textContent = message;
  });
}

function isHttpOrHttpsTab(tab) {
  return typeof tab?.url === 'string' && /^https?:\/\//i.test(tab.url);
}

function ensureSupportedTab(tab) {
  if (!isHttpOrHttpsTab(tab)) {
    throw new Error(t('popupErrorUnsupportedPage', 'This page is not supported. Please open an HTTP/HTTPS page.'));
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#334155';
}

function renderToggleButton(enabled) {
  if (enabled) {
    toggleButton.textContent = t('popupToggleDisable', 'Disable Original Text');
    toggleButton.classList.remove('is-disabled');
  } else {
    toggleButton.textContent = t('popupToggleEnable', 'Enable Original Text');
    toggleButton.classList.add('is-disabled');
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new Error(t('popupErrorNoActiveTab', 'Unable to get the active tab.'));
  }
  return tab;
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'BTV_PING' });
    return Boolean(response && response.ok === true);
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContentScript(tabId, attempts, intervalMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingContentScript(tabId)) {
      return true;
    }

    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}

async function ensureContentScriptReady(tab) {
  const tabId = tab?.id;
  ensureSupportedTab(tab);

  if (typeof tabId !== 'number') {
    throw new Error(t('popupErrorNoActiveTab', 'Unable to get the active tab.'));
  }

  if (pendingEnsureByTabId.has(tabId)) {
    return pendingEnsureByTabId.get(tabId);
  }

  const ensurePromise = (async () => {
    if (await pingContentScript(tabId)) {
      return;
    }

    // Give content script a short warm-up window before reinjecting.
    if (await waitForContentScript(tabId, PING_RETRY_ATTEMPTS_BEFORE_INJECT, PING_RETRY_INTERVAL_MS)) {
      return;
    }

    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['assets/styles/content.css']
      });
    } catch (_error) {
      // Ignore duplicate/temporary CSS injection failures and continue script init.
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js']
    });

    const ready = await waitForContentScript(
      tabId,
      PING_RETRY_ATTEMPTS_AFTER_INJECT,
      PING_RETRY_INTERVAL_MS
    );

    if (!ready) {
      throw new Error(t('popupErrorContentScriptNotReady', 'Content script failed to initialize.'));
    }
  })().finally(() => {
    pendingEnsureByTabId.delete(tabId);
  });

  pendingEnsureByTabId.set(tabId, ensurePromise);
  return ensurePromise;
}

async function sendMessageWithReconnect(tab, payload, allowReconnect = true) {
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const shouldReconnect = errMsg.includes('Receiving end does not exist')
      || errMsg.includes('Could not establish connection');

    if (!allowReconnect || !shouldReconnect) {
      throw err;
    }

    await ensureContentScriptReady(tab);
    return await chrome.tabs.sendMessage(tab.id, payload);
  }
}

async function getFeatureEnabledState() {
  const result = await chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY);
  return result[FEATURE_ENABLED_STORAGE_KEY] === true;
}

async function setFeatureEnabledState(enabled) {
  await chrome.storage.local.set({ [FEATURE_ENABLED_STORAGE_KEY]: enabled });
}

async function triggerPreprocess() {
  preprocessButton.disabled = true;
  setStatus(t('popupStatusPreprocessRunning', 'Preprocessing current page...'));

  try {
    const tab = await getActiveTab();
    await ensureContentScriptReady(tab);
    const response = await sendMessageWithReconnect(tab, {
      type: 'BTV_PREPROCESS_NOW'
    }, false);

    if (!response || !response.ok) {
      throw new Error(t('popupErrorPreprocessNoAck', 'Content script did not acknowledge preprocess.'));
    }

    setStatus(t('popupStatusPreprocessDone', 'Preprocess complete. You can now translate the page.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`${t('popupStatusPreprocessFailedPrefix', 'Preprocess failed: ')}${message}`, true);
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
    await ensureContentScriptReady(tab);

    try {
      const response = await sendMessageWithReconnect(tab, {
        type: 'BTV_SET_ENABLED',
        enabled: nextEnabled
      }, true);

      if (!response || response.ok !== true) {
        throw new Error(t('popupErrorToggleNoAck', 'Page did not confirm feature switch update.'));
      }
    } catch (syncError) {
      const syncMessage = syncError instanceof Error ? syncError.message : String(syncError);
      setStatus(`${t('popupStatusToggleFailedPrefix', 'Switch failed: ')}${syncMessage}`, true);
      return;
    }

    await setFeatureEnabledState(nextEnabled);
    renderToggleButton(nextEnabled);

    setStatus(nextEnabled
      ? t('popupStatusEnabled', 'Original text display is enabled.')
      : t('popupStatusDisabled', 'Original text display is disabled.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`${t('popupStatusToggleFailedPrefix', 'Switch failed: ')}${message}`, true);
  } finally {
    toggleButton.disabled = false;
  }
}

async function initializePopup() {
  localizeStaticText();

  try {
    const enabled = await getFeatureEnabledState();
    renderToggleButton(enabled);
    setStatus(enabled
      ? t('popupStatusEnabled', 'Original text display is enabled.')
      : t('popupStatusDisabled', 'Original text display is disabled.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`${t('popupStatusInitFailedPrefix', 'Initialization failed: ')}${message}`, true);
  }
}

preprocessButton.addEventListener('click', triggerPreprocess);
toggleButton.addEventListener('click', toggleFeatureEnabled);

initializePopup();
