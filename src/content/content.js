(() => {
const CONTENT_RUNTIME_KEY = '__BTV_CONTENT_RUNTIME__';
const CONTENT_LOADER_KEY = '__BTV_CONTENT_LOADER__';

const existingRuntime = window[CONTENT_RUNTIME_KEY];
if (existingRuntime && existingRuntime.initialized) {
    existingRuntime.lastPingAt = Date.now();
    return;
}

const loaderState = window[CONTENT_LOADER_KEY] || {
    loading: false,
    loadedProfile: '',
    lastError: ''
};

window[CONTENT_LOADER_KEY] = loaderState;

if (loaderState.loading) {
    return;
}

const userAgent = navigator.userAgent || '';
const isEdgeBrowser = /\bEdg\//.test(userAgent);
const targetProfile = isEdgeBrowser ? 'edge' : 'chrome';
const targetFile = isEdgeBrowser
    ? 'src/content/content.edge.js'
    : 'src/content/content.chrome.js';

loaderState.loading = true;
loaderState.loadedProfile = targetProfile;
loaderState.lastError = '';

import(chrome.runtime.getURL(targetFile))
    .catch((error) => {
        loaderState.lastError = error instanceof Error ? error.message : String(error);
        console.error('[Translate Recall] Failed to load content script profile:', targetProfile, error);
    })
    .finally(() => {
        loaderState.loading = false;
    });
})();
