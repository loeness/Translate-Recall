(() => {
const CONTENT_RUNTIME_KEY = '__BTV_CONTENT_RUNTIME__';
const existingRuntime = window[CONTENT_RUNTIME_KEY];

if (existingRuntime && existingRuntime.initialized) {
    existingRuntime.lastPingAt = Date.now();
    return;
}

window[CONTENT_RUNTIME_KEY] = {
    initialized: true,
    startedAt: Date.now(),
    lastPingAt: Date.now()
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'TEXTAREA', 'INPUT']);
const BLOCK_BOUNDARY_TAGS = new Set([
    'P', 'LI', 'DT', 'DD', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'MAIN', 'DIV'
]);
const STRONG_END_CHARS = new Set(['。', '！', '？', '；', '.', '!', '?', ';']);
const COMMA_CHARS = new Set([',', '，', '、']);
const TRAILING_CLOSE_CHARS = new Set(['"', '\'', ')', ']', '}', '”', '’', '）', '】', '》', '」', '』']);
const PREFERRED_SPLIT_CHARS = new Set([',', '，', ';', '；', ':', '：', '、', ' ', '\n']);
const ABBREVIATION_TOKENS = new Set([
    'e.g.', 'i.e.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'vs.', 'etc.'
]);
const INTERACTIVE_TAGS = new Set([
    'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY', 'DETAILS'
]);
const INTERACTIVE_ROLES = new Set([
    'button', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option', 'combobox', 'slider'
]);

const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';
const IS_EDGE_BROWSER = true;
const IS_CHROME_BROWSER = false;
const BROWSER_PROFILE = 'edge';
const CLICK_TEXT_HIT_PADDING = 2;
const NAVIGATION_FORCE_REFRESH_WINDOW_MS = IS_EDGE_BROWSER ? 1300 : 1800;
const MIN_SEGMENT_CHARS = 8;
const MAX_SEGMENT_CHARS = 220;
const COMMA_SPLIT_TRIGGER_CHARS = 96;
const LINE_BREAK_SPLIT_TRIGGER_CHARS = 140;
const LOW_CONFIDENCE_THRESHOLD = 0.45;
const MAX_FALLBACK_CHARS = 320;
const PREPROCESS_QUEUE_FLUSH_DELAY_MS = IS_EDGE_BROWSER ? 72 : 110;
const PREPROCESS_FLUSH_BATCH_SIZE = IS_EDGE_BROWSER ? 30 : 18;
const PREPROCESS_CHUNK_YIELD_MS = IS_EDGE_BROWSER ? 0 : 8;
const NAVIGATION_PREPROCESS_DELAY_MS = IS_EDGE_BROWSER ? 95 : 130;
const PRIORITY_SCAN_DOWNWARD_PX = 2000;
const PRIORITY_SCAN_UPWARD_PX = 240;
const LOW_PRIORITY_SCAN_BATCH_SIZE = IS_EDGE_BROWSER ? 34 : 24;
const LOW_PRIORITY_IDLE_TIMEOUT_MS = IS_EDGE_BROWSER ? 140 : 220;
const SHADOW_SCAN_STEP_PX = IS_EDGE_BROWSER ? 560 : 780;
const SHADOW_SCAN_MAX_STEPS_PER_CYCLE = IS_EDGE_BROWSER ? 9 : 13;
const SHADOW_SCAN_STEP_DELAY_MS = IS_EDGE_BROWSER ? 26 : 34;
const SHADOW_SCAN_GROWTH_THRESHOLD_PX = 72;
const TRANSLATION_WAKE_POLL_INTERVAL_MS = IS_EDGE_BROWSER ? 980 : 1180;
const TRANSLATION_WAKE_IDLE_TIMEOUT_MS = IS_EDGE_BROWSER ? 240 : 360;

window[CONTENT_RUNTIME_KEY].browserProfile = BROWSER_PROFILE;

const sentenceSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
    : null;

let tooltip = null;
let featureEnabled = false;
let lastKnownUrl = window.location.href;
let navigationPreprocessTimer = null;
let allowSnapshotForceRefreshUntil = 0;
let mutationObserver = null;
let lifecycleObserver = null;
let historyPatched = false;
let originalPushState = null;
let originalReplaceState = null;
let delegatedEventBody = null;
let translationStateMode = 'unknown';
let translationStateSignature = '';
let translationStateEvaluationHandle = null;
let translationStateEvaluationMode = 'none';
let translationWakePollHandle = null;
let translationWakePollMode = 'none';
let baselineDocumentLang = '';

let textNodeSnapshots = new WeakMap();
let blockSnapshots = new WeakMap();
const pendingRoots = new Map();
const totalOriginalContentIndex = new Map();
const signatureToIndexKeys = new Map();
const liveSnapshotBoundaryKeys = new Set();
let nodeOriginalIndexKeys = new WeakMap();
const lowPriorityBoundaries = new Map();
const preemptiveCaptureRoots = new Set();
let blockDisplayProjectionCache = new WeakMap();
let flushTimer = null;
let flushTimerMode = 'none';
let flushInProgress = false;
let preemptiveCaptureHandle = null;
let preemptiveCaptureHandleMode = 'none';
let lowPriorityScanHandle = null;
let lowPriorityScanHandleMode = 'none';
let shadowScanTimer = null;
let shadowScanInProgress = false;
let shadowScanNeedsRerun = false;
let shadowScanCursorY = 0;
let observedScrollHeight = 0;
let idleShadowScanHandle = null;
let idleShadowScanHandleMode = 'none';

function ensureTooltip() {
    if (tooltip && tooltip.isConnected) {
        return tooltip;
    }

    if (!document.body) {
        return null;
    }

    tooltip = document.createElement('div');
    tooltip.id = 'bilingual-tooltip';
    tooltip.classList.add('notranslate');
    tooltip.setAttribute('translate', 'no');
    tooltip.setAttribute('lang', 'und');
    document.body.appendChild(tooltip);
    return tooltip;
}

function hasInteractiveRole(element) {
    if (!(element instanceof Element)) return false;

    const roleAttr = element.getAttribute('role');
    if (!roleAttr) return false;

    return roleAttr
        .toLowerCase()
        .split(/\s+/)
        .some((role) => INTERACTIVE_ROLES.has(role));
}

function isInteractiveElement(element) {
    if (!(element instanceof Element)) return false;

    if (INTERACTIVE_TAGS.has(element.tagName)) return true;
    if (hasInteractiveRole(element)) return true;

    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable && contentEditable.toLowerCase() !== 'false';
}

function isHiddenElement(element) {
    if (!(element instanceof Element)) return false;

    if (element.closest('[hidden], [aria-hidden="true"]')) {
        return true;
    }

    const style = window.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden';
}

function isInsideInteractiveContainer(element) {
    let cursor = element;
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
        if (isInteractiveElement(cursor)) {
            return true;
        }
        cursor = cursor.parentElement;
    }

    return false;
}

function shouldSkipTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest('#bilingual-tooltip')) return true;
    if (isInsideInteractiveContainer(parent)) return true;
    if (isHiddenElement(parent)) return true;
    return false;
}

function getSiblingIndex(node) {
    if (!(node instanceof Node) || !node.parentNode) {
        return 1;
    }

    let index = 0;
    let cursor = node.parentNode.firstChild;
    while (cursor) {
        const sameType = cursor.nodeType === node.nodeType;
        const sameTag = node.nodeType !== Node.ELEMENT_NODE || cursor.nodeName === node.nodeName;
        if (sameType && sameTag) {
            index += 1;
        }

        if (cursor === node) {
            return Math.max(1, index);
        }

        cursor = cursor.nextSibling;
    }

    return 1;
}

function buildNodeDomPath(node) {
    if (!(node instanceof Node)) {
        return '';
    }

    if (node === document.documentElement) {
        return '/html[1]';
    }

    if (node === document.body) {
        return '/html[1]/body[1]';
    }

    const segments = [];
    let cursor = node;

    while (cursor && cursor !== document) {
        if (cursor.nodeType === Node.TEXT_NODE) {
            segments.push(`text()[${getSiblingIndex(cursor)}]`);
            cursor = cursor.parentNode;
            continue;
        }

        if (cursor.nodeType === Node.ELEMENT_NODE) {
            const tagName = (cursor.nodeName || 'node').toLowerCase();
            segments.push(`${tagName}[${getSiblingIndex(cursor)}]`);
            cursor = cursor.parentNode;
            continue;
        }

        cursor = cursor.parentNode;
    }

    return `/${segments.reverse().join('/')}`;
}

function getIndexKeyForNode(node) {
    if (!(node instanceof Node)) {
        return '';
    }

    const existingKey = nodeOriginalIndexKeys.get(node);
    if (existingKey) {
        return existingKey;
    }

    const key = buildNodeDomPath(node);
    if (key) {
        nodeOriginalIndexKeys.set(node, key);
    }
    return key;
}

function buildTextSignature(text) {
    const normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) {
        return '';
    }

    const compact = normalized
        .replace(/[^a-z0-9\u00c0-\u024f\u4e00-\u9fff ]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!compact) {
        return '';
    }

    const prefix = compact.slice(0, 56);
    const suffix = compact.slice(-24);
    const tokenCount = (compact.match(/[a-z0-9\u00c0-\u024f\u4e00-\u9fff]+/g) || []).length;
    return `${prefix}|${suffix}|${compact.length}|${tokenCount}`;
}

function appendSignatureIndex(signature, key) {
    if (!signature || !key) {
        return;
    }

    let keys = signatureToIndexKeys.get(signature);
    if (!keys) {
        keys = new Set();
        signatureToIndexKeys.set(signature, keys);
    }

    keys.add(key);
}

function findIndexKeyBySignature(text) {
    const signature = buildTextSignature(text);
    if (!signature) {
        return '';
    }

    const keys = signatureToIndexKeys.get(signature);
    if (!keys || keys.size === 0) {
        return '';
    }

    for (const key of keys) {
        if (totalOriginalContentIndex.has(key)) {
            return key;
        }
    }

    return '';
}

function rehydrateOriginalIndexReferences() {
    if (!document.body || totalOriginalContentIndex.size === 0) {
        return 0;
    }

    let rehydratedCount = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
        if (shouldSkipTextNode(current)) {
            current = walker.nextNode();
            continue;
        }

        const liveText = (current.nodeValue || '').trim();
        if (!liveText) {
            current = walker.nextNode();
            continue;
        }

        const currentPath = buildNodeDomPath(current);
        if (currentPath && totalOriginalContentIndex.has(currentPath)) {
            nodeOriginalIndexKeys.set(current, currentPath);
            rehydratedCount += 1;
            current = walker.nextNode();
            continue;
        }

        const matchedKey = findIndexKeyBySignature(liveText);
        if (matchedKey) {
            nodeOriginalIndexKeys.set(current, matchedKey);
            const record = totalOriginalContentIndex.get(matchedKey);
            if (record) {
                record.lastSeenAt = Date.now();
            }
            rehydratedCount += 1;
        }

        current = walker.nextNode();
    }

    return rehydratedCount;
}

function rememberOriginalContent(node, text, metadata = {}) {
    if (!(node instanceof Node)) {
        return;
    }

    const normalizedText = (text || '').trim();
    if (!normalizedText) {
        return;
    }

    const key = getIndexKeyForNode(node);
    if (!key) {
        return;
    }

    const now = Date.now();
    const signature = buildTextSignature(normalizedText);
    const existing = totalOriginalContentIndex.get(key);

    if (!existing || metadata.force === true) {
        totalOriginalContentIndex.set(key, {
            key,
            nodeType: node.nodeType,
            nodeName: node.nodeName || 'UNKNOWN',
            blockTag: metadata.blockTag || '',
            source: metadata.source || 'scan',
            originalText: normalizedText,
            latestText: normalizedText,
            signature,
            firstCapturedAt: now,
            lastSeenAt: now
        });

        appendSignatureIndex(signature, key);
        return;
    }

    existing.latestText = normalizedText;
    existing.lastSeenAt = now;
    if (!existing.blockTag && metadata.blockTag) {
        existing.blockTag = metadata.blockTag;
    }
}

function getIndexedOriginalTextFromNode(node) {
    if (!(node instanceof Node)) {
        return '';
    }

    const key = nodeOriginalIndexKeys.get(node) || buildNodeDomPath(node);
    if (key) {
        const record = totalOriginalContentIndex.get(key);
        if (record && typeof record.originalText === 'string' && record.originalText.length > 0) {
            return record.originalText;
        }
    }

    if (node instanceof Text) {
        const boundary = getBlockBoundaryElement(node.parentElement);
        if (boundary) {
            const boundaryKey = nodeOriginalIndexKeys.get(boundary) || buildNodeDomPath(boundary);
            const boundaryRecord = boundaryKey ? totalOriginalContentIndex.get(boundaryKey) : null;
            if (boundaryRecord && boundaryRecord.originalText) {
                return boundaryRecord.originalText;
            }
        }
    }

    return '';
}

function getDocumentScrollHeight() {
    const body = document.body;
    const doc = document.documentElement;
    return Math.max(
        body ? body.scrollHeight : 0,
        doc ? doc.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        doc ? doc.offsetHeight : 0
    );
}

function clearPreemptiveCaptureHandle() {
    if (preemptiveCaptureHandle === null) {
        return;
    }

    if (preemptiveCaptureHandleMode === 'raf') {
        window.cancelAnimationFrame(preemptiveCaptureHandle);
    } else {
        window.clearTimeout(preemptiveCaptureHandle);
    }

    preemptiveCaptureHandle = null;
    preemptiveCaptureHandleMode = 'none';
}

function clearLowPriorityScanHandle() {
    if (lowPriorityScanHandle === null) {
        return;
    }

    if (lowPriorityScanHandleMode === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(lowPriorityScanHandle);
    } else {
        window.clearTimeout(lowPriorityScanHandle);
    }

    lowPriorityScanHandle = null;
    lowPriorityScanHandleMode = 'none';
}

function clearShadowScanTimer() {
    if (shadowScanTimer === null) {
        return;
    }

    window.clearTimeout(shadowScanTimer);
    shadowScanTimer = null;
}

function clearIdleShadowScanHandle() {
    if (idleShadowScanHandle === null) {
        return;
    }

    if (idleShadowScanHandleMode === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleShadowScanHandle);
    } else {
        window.clearTimeout(idleShadowScanHandle);
    }

    idleShadowScanHandle = null;
    idleShadowScanHandleMode = 'none';
}

function clearTranslationStateEvaluationHandle() {
    if (translationStateEvaluationHandle === null) {
        return;
    }

    if (translationStateEvaluationMode === 'raf') {
        window.cancelAnimationFrame(translationStateEvaluationHandle);
    } else {
        window.clearTimeout(translationStateEvaluationHandle);
    }

    translationStateEvaluationHandle = null;
    translationStateEvaluationMode = 'none';
}

function clearTranslationWakePollHandle() {
    if (translationWakePollHandle === null) {
        return;
    }

    if (translationWakePollMode === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(translationWakePollHandle);
    } else {
        window.clearTimeout(translationWakePollHandle);
    }

    translationWakePollHandle = null;
    translationWakePollMode = 'none';
}

function getEffectiveCharLength(text) {
    return (text || '').replace(/\s+/g, '').length;
}

function countLatinWords(text) {
    const matches = (text || '').match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g);
    return matches ? matches.length : 0;
}

function isShortSegment(text) {
    const effectiveLength = getEffectiveCharLength(text);
    if (effectiveLength === 0) return true;
    if (effectiveLength < MIN_SEGMENT_CHARS) return true;

    const latinWordCount = countLatinWords(text);
    if (latinWordCount > 0 && latinWordCount <= 3 && effectiveLength < 30) {
        return true;
    }

    return false;
}

function normalizeWhitespaceForTooltip(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function truncateTooltipText(text) {
    const normalized = normalizeWhitespaceForTooltip(text);
    if (normalized.length <= MAX_FALLBACK_CHARS) {
        return normalized;
    }

    return `${normalized.slice(0, MAX_FALLBACK_CHARS)}...`;
}

function findTokenStart(text, fromIndex) {
    let index = fromIndex;
    while (index >= 0) {
        const char = text[index];
        if (/\s/.test(char) || /[(){}\[\]<>"'“”‘’]/.test(char)) {
            break;
        }
        index -= 1;
    }
    return index + 1;
}

function isLikelyUrlEmailOrPath(snippet) {
    if (!snippet) return false;

    return /(https?:\/\/|www\.)\S+/i.test(snippet)
        || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(snippet)
        || /[A-Za-z]:\\[^\s]+/.test(snippet)
        || /(?:^|[\s(])\/[\w./-]+/.test(snippet);
}

function endsWithProtectedAbbreviation(text) {
    const normalized = (text || '').trim().toLowerCase();
    if (!normalized) return false;

    if (ABBREVIATION_TOKENS.has(normalized)) return true;
    if (/(?:\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|sr|jr|vs|etc)\.)$/i.test(normalized)) return true;
    if (/\b[A-Za-z]\.$/.test(normalized)) return true;
    if (/(?:[A-Za-z]\.){2,}$/.test(normalized)) return true;
    return false;
}

function isProtectedDot(text, index) {
    if (index <= 0 || index >= text.length - 1) {
        return false;
    }

    const prevChar = text[index - 1];
    const nextChar = text[index + 1];

    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
        return true;
    }

    const tokenStart = findTokenStart(text, index - 1);
    const token = text.slice(tokenStart, index + 1);
    if (endsWithProtectedAbbreviation(token)) {
        return true;
    }

    const nearbySnippet = text.slice(
        Math.max(0, index - 48),
        Math.min(text.length, index + 48)
    );

    return isLikelyUrlEmailOrPath(nearbySnippet);
}

function extendBoundaryTail(text, index, maxEnd) {
    let cursor = index;
    while (cursor < maxEnd) {
        const char = text[cursor];
        if (TRAILING_CLOSE_CHARS.has(char) || /\s/.test(char)) {
            cursor += 1;
            continue;
        }
        break;
    }
    return cursor;
}

function pushNormalizedRange(ranges, text, start, end) {
    let safeStart = start;
    let safeEnd = end;

    while (safeStart < safeEnd && /\s/.test(text[safeStart])) {
        safeStart += 1;
    }

    while (safeEnd > safeStart && /\s/.test(text[safeEnd - 1])) {
        safeEnd -= 1;
    }

    if (safeEnd <= safeStart) return;

    ranges.push({
        start: safeStart,
        end: safeEnd
    });
}

function normalizeRanges(text, ranges) {
    if (!ranges || ranges.length === 0) return [];

    const result = [];
    ranges
        .slice()
        .sort((a, b) => a.start - b.start)
        .forEach((range) => pushNormalizedRange(result, text, range.start, range.end));

    return result;
}

function splitByBlankLines(text) {
    const ranges = [];
    const blankLineRegex = /\n\s*\n+/g;
    let cursor = 0;
    let match = blankLineRegex.exec(text);

    while (match) {
        const breakStart = match.index;
        if (breakStart > cursor) {
            ranges.push({ start: cursor, end: breakStart });
        }

        cursor = match.index + match[0].length;
        match = blankLineRegex.exec(text);
    }

    if (cursor < text.length) {
        ranges.push({ start: cursor, end: text.length });
    }

    if (ranges.length === 0 && text.trim().length > 0) {
        ranges.push({ start: 0, end: text.length });
    }

    return ranges;
}

function getIntlSentenceRanges(text, start, end) {
    if (!sentenceSegmenter) return [];

    const paragraph = text.slice(start, end);
    const ranges = [];

    for (const item of sentenceSegmenter.segment(paragraph)) {
        const segmentStart = start + item.index;
        const segmentEnd = segmentStart + item.segment.length;
        pushNormalizedRange(ranges, text, segmentStart, segmentEnd);
    }

    return ranges;
}

function getFallbackSentenceRanges(text, start, end) {
    const ranges = [];
    let cursor = start;

    for (let index = start; index < end; index += 1) {
        const char = text[index];
        const shouldBreakByLine = char === '\n' && (index - cursor) >= LINE_BREAK_SPLIT_TRIGGER_CHARS;

        if (!shouldBreakByLine && !STRONG_END_CHARS.has(char)) {
            continue;
        }

        if (char === '.' && isProtectedDot(text, index)) {
            continue;
        }

        const boundary = extendBoundaryTail(text, index + 1, end);
        pushNormalizedRange(ranges, text, cursor, boundary);
        cursor = boundary;
    }

    if (cursor < end) {
        pushNormalizedRange(ranges, text, cursor, end);
    }

    if (ranges.length === 0) {
        pushNormalizedRange(ranges, text, start, end);
    }

    return ranges;
}

function shouldMergeRanges(text, previousRange, currentRange) {
    const previousText = text.slice(previousRange.start, previousRange.end).trim();
    const currentText = text.slice(currentRange.start, currentRange.end).trim();

    if (!previousText || !currentText) {
        return true;
    }

    if (endsWithProtectedAbbreviation(previousText)) {
        return true;
    }

    if (/\d\.$/.test(previousText) && /^\d/.test(currentText)) {
        return true;
    }

    const mergedPreview = `${previousText}${currentText}`;
    if (isLikelyUrlEmailOrPath(mergedPreview)) {
        return true;
    }

    return isShortSegment(previousText);
}

function mergeProtectedAndShortSentenceRanges(text, ranges) {
    if (!ranges || ranges.length <= 1) {
        return ranges || [];
    }

    const merged = [];
    ranges.forEach((range) => {
        if (merged.length === 0) {
            merged.push({ start: range.start, end: range.end });
            return;
        }

        const previous = merged[merged.length - 1];
        if (shouldMergeRanges(text, previous, range)) {
            previous.end = range.end;
        } else {
            merged.push({ start: range.start, end: range.end });
        }
    });

    return normalizeRanges(text, merged);
}

function isSafeCommaBoundary(text, index, start, end, cursor) {
    if ((index - cursor) < MIN_SEGMENT_CHARS) {
        return false;
    }

    if (index + 1 >= end) {
        return false;
    }

    const prevChar = text[index - 1] || '';
    const nextChar = text[index + 1] || '';

    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
        return false;
    }

    const nearbySnippet = text.slice(
        Math.max(start, index - 40),
        Math.min(end, index + 40)
    );

    return !isLikelyUrlEmailOrPath(nearbySnippet);
}

function splitSingleRangeByComma(text, start, end) {
    const ranges = [];
    let cursor = start;

    for (let index = start; index < end; index += 1) {
        const char = text[index];
        if (!COMMA_CHARS.has(char)) {
            continue;
        }

        if (!isSafeCommaBoundary(text, index, start, end, cursor)) {
            continue;
        }

        const boundary = extendBoundaryTail(text, index + 1, end);
        pushNormalizedRange(ranges, text, cursor, boundary);
        cursor = boundary;
    }

    if (cursor < end) {
        pushNormalizedRange(ranges, text, cursor, end);
    }

    if (ranges.length <= 1) {
        return [{ start, end }];
    }

    return ranges;
}

function splitRangesByCommaForLongSentences(text, ranges) {
    const result = [];

    ranges.forEach((range) => {
        const candidateText = text.slice(range.start, range.end);
        if (getEffectiveCharLength(candidateText) <= COMMA_SPLIT_TRIGGER_CHARS) {
            result.push({ start: range.start, end: range.end });
            return;
        }

        const splitRanges = splitSingleRangeByComma(text, range.start, range.end);
        splitRanges.forEach((splitRange) => result.push(splitRange));
    });

    return normalizeRanges(text, result);
}

function isPreferredBreakChar(char) {
    return PREFERRED_SPLIT_CHARS.has(char);
}

function isAllowedBreakAt(text, index) {
    const char = text[index];
    if (char === '.' && isProtectedDot(text, index)) {
        return false;
    }

    if (COMMA_CHARS.has(char)) {
        const prevChar = text[index - 1] || '';
        const nextChar = text[index + 1] || '';
        if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
            return false;
        }
    }

    return true;
}

function findBestBreakBackward(text, start, target) {
    for (let index = target; index > start; index -= 1) {
        const char = text[index];
        if (!isPreferredBreakChar(char)) continue;
        if (!isAllowedBreakAt(text, index)) continue;
        return index;
    }
    return -1;
}

function findBestBreakForward(text, target, end) {
    for (let index = target; index < end; index += 1) {
        const char = text[index];
        if (!isPreferredBreakChar(char)) continue;
        if (!isAllowedBreakAt(text, index)) continue;
        return index;
    }
    return -1;
}

function splitRangeByMaxLength(text, start, end, outputRanges) {
    let cursor = start;

    while (cursor < end) {
        const remainingText = text.slice(cursor, end);
        if (getEffectiveCharLength(remainingText) <= MAX_SEGMENT_CHARS) {
            pushNormalizedRange(outputRanges, text, cursor, end);
            break;
        }

        const target = Math.min(end - 1, cursor + MAX_SEGMENT_CHARS);
        let breakIndex = findBestBreakBackward(text, cursor, target);

        if (breakIndex === -1 || breakIndex <= cursor) {
            breakIndex = findBestBreakForward(text, target, end);
        }

        if (breakIndex === -1 || breakIndex <= cursor) {
            breakIndex = Math.min(end - 1, target);
        }

        const boundary = extendBoundaryTail(text, breakIndex + 1, end);
        if (boundary <= cursor) {
            break;
        }

        pushNormalizedRange(outputRanges, text, cursor, boundary);
        cursor = boundary;
    }
}

function enforceMaxLengthByPreferredBreaks(text, ranges) {
    const result = [];
    ranges.forEach((range) => splitRangeByMaxLength(text, range.start, range.end, result));
    return normalizeRanges(text, result);
}

function mergeTinyRanges(text, ranges) {
    if (!ranges || ranges.length <= 1) {
        return ranges || [];
    }

    const merged = [];
    ranges.forEach((range) => {
        if (merged.length === 0) {
            merged.push({ start: range.start, end: range.end });
            return;
        }

        const previous = merged[merged.length - 1];
        const previousText = text.slice(previous.start, previous.end);
        const currentText = text.slice(range.start, range.end);

        if (isShortSegment(previousText) || isShortSegment(currentText)) {
            previous.end = range.end;
        } else {
            merged.push({ start: range.start, end: range.end });
        }
    });

    if (merged.length >= 2) {
        const last = merged[merged.length - 1];
        const lastText = text.slice(last.start, last.end);
        if (isShortSegment(lastText)) {
            const previous = merged[merged.length - 2];
            previous.end = last.end;
            merged.pop();
        }
    }

    return normalizeRanges(text, merged);
}

function splitParagraphIntoSentenceRanges(text, start, end) {
    const options = arguments[3] || {};
    const enableCommaSplit = options.enableCommaSplit !== false;
    const enableMaxLength = options.enableMaxLength !== false;
    const enableTinyMerge = options.enableTinyMerge !== false;

    if (start >= end) return [];

    let ranges = getIntlSentenceRanges(text, start, end);
    if (ranges.length <= 1) {
        ranges = getFallbackSentenceRanges(text, start, end);
    }

    ranges = mergeProtectedAndShortSentenceRanges(text, ranges);
    if (enableCommaSplit) {
        ranges = splitRangesByCommaForLongSentences(text, ranges);
    }

    if (enableMaxLength) {
        ranges = enforceMaxLengthByPreferredBreaks(text, ranges);
    }

    if (enableTinyMerge) {
        ranges = mergeTinyRanges(text, ranges);
    }

    return normalizeRanges(text, ranges);
}

function splitTextIntoSegments(text) {
    const options = arguments[1] || {};

    if (!text || text.trim().length === 0) {
        return [];
    }

    const paragraphRanges = splitByBlankLines(text);
    const segmentRanges = [];

    paragraphRanges.forEach((paragraphRange) => {
        const sentenceRanges = splitParagraphIntoSentenceRanges(
            text,
            paragraphRange.start,
            paragraphRange.end,
            options
        );
        sentenceRanges.forEach((range) => segmentRanges.push(range));
    });

    const normalized = normalizeRanges(text, segmentRanges);

    if (normalized.length === 0) {
        return [{
            text: text.trim(),
            start: 0,
            end: text.length
        }];
    }

    return normalized.map((range) => ({
        text: text.slice(range.start, range.end).trim(),
        start: range.start,
        end: range.end
    })).filter((segment) => segment.text.length > 0);
}

function getBlockBoundaryElement(fromElement) {
    if (!fromElement) {
        return document.body || document.documentElement || null;
    }

    let cursor = fromElement;
    while (cursor) {
        if (isInteractiveElement(cursor)) {
            cursor = cursor.parentElement;
            continue;
        }

        if (cursor.tagName && BLOCK_BOUNDARY_TAGS.has(cursor.tagName)) {
            return cursor;
        }

        // Custom components in chat-like UIs are often block containers without semantic tags.
        const display = window.getComputedStyle(cursor).display;
        if (display === 'block' || display === 'list-item' || display === 'table-cell') {
            return cursor;
        }

        if (cursor === document.body || cursor === document.documentElement) {
            return cursor;
        }

        cursor = cursor.parentElement;
    }

    return document.body || document.documentElement || fromElement;
}

function collectBlockBoundaries(root) {
    const boundaries = new Set();

    if (!root) return boundaries;

    if (root.nodeType === Node.TEXT_NODE) {
        const boundary = getBlockBoundaryElement(root.parentElement);
        if (boundary) {
            boundaries.add(boundary);
        }
        return boundaries;
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
        return boundaries;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        if (!shouldSkipTextNode(current)) {
            const boundary = getBlockBoundaryElement(current.parentElement);
            if (boundary) {
                boundaries.add(boundary);
            }
        }
        current = walker.nextNode();
    }

    if (boundaries.size === 0 && root.nodeType === Node.ELEMENT_NODE) {
        const boundary = getBlockBoundaryElement(root);
        if (boundary) {
            boundaries.add(boundary);
        }
    }

    return boundaries;
}

function collectBoundaryTextNodes(boundaryElement) {
    const textNodes = [];
    if (!boundaryElement) return textNodes;

    const walker = document.createTreeWalker(boundaryElement, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        if (!shouldSkipTextNode(current)) {
            textNodes.push(current);
        }
        current = walker.nextNode();
    }

    return textNodes;
}

function buildBlockOriginalSnapshot(boundaryElement, textNodes) {
    if (!boundaryElement || !Array.isArray(textNodes) || textNodes.length === 0) {
        return null;
    }

    let originalText = '';
    const nodeRanges = [];

    textNodes.forEach((textNode) => {
        const start = originalText.length;
        const value = textNode.nodeValue || '';
        originalText += value;
        const end = originalText.length;

        nodeRanges.push({
            node: textNode,
            start,
            end
        });
    });

    if (originalText.trim().length === 0) {
        return null;
    }

    const segments = splitTextIntoSegments(originalText);
    if (segments.length === 0) {
        return null;
    }

    const coarseSegments = splitTextIntoSegments(originalText, {
        enableCommaSplit: false,
        enableMaxLength: false,
        enableTinyMerge: false
    });

    return {
        boundaryElement,
        blockTag: boundaryElement.tagName || 'UNKNOWN',
        originalText,
        originalSegments: segments,
        originalCoarseSegments: coarseSegments.length > 0 ? coarseSegments : segments,
        nodeRanges,
        indexedAt: Date.now()
    };
}

function snapshotTextNode(textNode, blockSnapshot, nodeStart, nodeEnd) {
    if (!(textNode instanceof Text)) return;
    if (!blockSnapshot || !blockSnapshot.boundaryElement) return;

    textNodeSnapshots.set(textNode, {
        blockElement: blockSnapshot.boundaryElement,
        blockTag: blockSnapshot.blockTag,
        fullOriginalText: blockSnapshot.originalText,
        segments: blockSnapshot.originalSegments,
        offsetInBlock: nodeStart,
        nodeOriginalStart: nodeStart,
        nodeOriginalEnd: nodeEnd,
        indexedAt: blockSnapshot.indexedAt
    });

    const originalNodeText = blockSnapshot.originalText.slice(nodeStart, nodeEnd);
    rememberOriginalContent(textNode, originalNodeText, {
        blockTag: blockSnapshot.blockTag,
        source: 'block-snapshot',
        force: false
    });
}

function preprocessBoundary(boundaryElement, force = false) {
    if (!boundaryElement) return;

    const boundaryKey = getIndexKeyForNode(boundaryElement);

    // Keep original snapshots stable unless caller explicitly requests refresh.
    if (!force && blockSnapshots.has(boundaryElement)) {
        if (boundaryKey) {
            liveSnapshotBoundaryKeys.add(boundaryKey);
        }
        return;
    }

    const textNodes = collectBoundaryTextNodes(boundaryElement);
    const blockSnapshot = buildBlockOriginalSnapshot(boundaryElement, textNodes);
    if (!blockSnapshot) {
        blockSnapshots.delete(boundaryElement);
        blockDisplayProjectionCache.delete(boundaryElement);
        if (boundaryKey) {
            liveSnapshotBoundaryKeys.delete(boundaryKey);
        }
        return;
    }

    blockSnapshots.set(boundaryElement, blockSnapshot);
    blockDisplayProjectionCache.delete(boundaryElement);
    rememberOriginalContent(boundaryElement, blockSnapshot.originalText, {
        blockTag: blockSnapshot.blockTag,
        source: 'boundary-snapshot',
        force
    });

    if (boundaryKey) {
        liveSnapshotBoundaryKeys.add(boundaryKey);
    }

    blockSnapshot.nodeRanges.forEach((nodeRange) => {
        snapshotTextNode(nodeRange.node, blockSnapshot, nodeRange.start, nodeRange.end);
    });
}

function isBoundaryWithinPriorityRange(boundary, rangeTop, rangeBottom) {
    if (!(boundary instanceof Element) || !boundary.isConnected) {
        return false;
    }

    const rect = boundary.getBoundingClientRect();
    const absoluteTop = rect.top + window.scrollY;
    const absoluteBottom = rect.bottom + window.scrollY;
    return absoluteBottom >= rangeTop && absoluteTop <= rangeBottom;
}

function queueBoundaryForLowPriorityScan(boundary, force = false) {
    if (!(boundary instanceof Element) || !boundary.isConnected) {
        return;
    }

    const previousForce = lowPriorityBoundaries.get(boundary) || false;
    lowPriorityBoundaries.set(boundary, previousForce || force);
}

function flushLowPriorityBoundaries(deadline) {
    lowPriorityScanHandle = null;
    lowPriorityScanHandleMode = 'none';

    if (lowPriorityBoundaries.size === 0) {
        return;
    }

    let processed = 0;
    const queuedEntries = Array.from(lowPriorityBoundaries.entries());

    for (const [boundary, force] of queuedEntries) {
        if (processed >= LOW_PRIORITY_SCAN_BATCH_SIZE) {
            break;
        }

        if (
            deadline
            && typeof deadline.timeRemaining === 'function'
            && processed > 0
            && deadline.timeRemaining() < 2
        ) {
            break;
        }

        lowPriorityBoundaries.delete(boundary);

        try {
            preprocessBoundary(boundary, force);
        } catch (_error) {
            // Keep low-priority pass resilient to DOM changes.
        }

        processed += 1;
    }

    if (lowPriorityBoundaries.size > 0) {
        scheduleLowPriorityBoundaryFlush();
    }
}

function scheduleLowPriorityBoundaryFlush() {
    if (lowPriorityScanHandle !== null || lowPriorityBoundaries.size === 0) {
        return;
    }

    if (typeof window.requestIdleCallback === 'function') {
        lowPriorityScanHandleMode = 'idle';
        lowPriorityScanHandle = window.requestIdleCallback(
            flushLowPriorityBoundaries,
            { timeout: LOW_PRIORITY_IDLE_TIMEOUT_MS }
        );
        return;
    }

    lowPriorityScanHandleMode = 'timeout';
    lowPriorityScanHandle = window.setTimeout(flushLowPriorityBoundaries, PREPROCESS_QUEUE_FLUSH_DELAY_MS);
}

function preprocessRoot(root, force = false) {
    const boundaries = collectBlockBoundaries(root);
    boundaries.forEach((boundary) => preprocessBoundary(boundary, force));
}

function preprocessRootWithPriority(root, force = false, anchorY = window.scrollY) {
    const boundaries = collectBlockBoundaries(root);
    if (boundaries.size === 0) {
        return;
    }

    const viewportHeight = Math.max(window.innerHeight || 0, 1);
    const rangeTop = Math.max(0, anchorY - PRIORITY_SCAN_UPWARD_PX);
    const rangeBottom = anchorY + viewportHeight + PRIORITY_SCAN_DOWNWARD_PX;

    boundaries.forEach((boundary) => {
        if (isBoundaryWithinPriorityRange(boundary, rangeTop, rangeBottom)) {
            preprocessBoundary(boundary, force);
            return;
        }

        queueBoundaryForLowPriorityScan(boundary, force);
    });

    scheduleLowPriorityBoundaryFlush();
}

function getPreprocessTargets() {
    if (document.body) {
        return [document.body];
    }

    if (document.documentElement) {
        return [document.documentElement];
    }

    return [];
}

function runFullPreprocess(force = false) {
    const options = arguments[1] || {};
    const anchorY = Number.isFinite(options.anchorY) ? options.anchorY : window.scrollY;
    const targets = getPreprocessTargets();
    targets.forEach((target) => preprocessRootWithPriority(target, force, anchorY));
}

function normalizeQueuedRoot(root) {
    if (!root) {
        return null;
    }

    if (root instanceof Text) {
        if (!root.isConnected) {
            return null;
        }

        return getBlockBoundaryElement(root.parentElement);
    }

    if (root instanceof Element) {
        if (!root.isConnected) {
            return null;
        }

        if (root.closest('#bilingual-tooltip')) {
            return null;
        }

        return root;
    }

    if (root instanceof Document) {
        return root;
    }

    return null;
}

function clearPendingFlushTimer() {
    if (flushTimer === null) {
        return;
    }

    if (flushTimerMode === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(flushTimer);
    } else {
        window.clearTimeout(flushTimer);
    }

    flushTimer = null;
    flushTimerMode = 'none';
}

function schedulePendingRootsFlush() {
    if (flushTimer !== null || flushInProgress) {
        return;
    }

    if (!IS_EDGE_BROWSER && typeof window.requestIdleCallback === 'function') {
        flushTimerMode = 'idle';
        flushTimer = window.requestIdleCallback(
            flushPendingRootsInBatches,
            { timeout: PREPROCESS_QUEUE_FLUSH_DELAY_MS }
        );
        return;
    }

    flushTimerMode = 'timeout';
    flushTimer = window.setTimeout(flushPendingRootsInBatches, PREPROCESS_QUEUE_FLUSH_DELAY_MS);
}

function flushPendingRootsInBatches() {
    flushTimer = null;
    flushTimerMode = 'none';

    if (flushInProgress || pendingRoots.size === 0) {
        return;
    }

    flushInProgress = true;
    const queuedEntries = Array.from(pendingRoots.entries());
    pendingRoots.clear();
    let cursor = 0;

    const runChunk = () => {
        const end = Math.min(cursor + PREPROCESS_FLUSH_BATCH_SIZE, queuedEntries.length);
        for (; cursor < end; cursor += 1) {
            const [queuedRoot, queuedForce] = queuedEntries[cursor];
            try {
                preprocessRoot(queuedRoot, queuedForce);
            } catch (_error) {
                // Keep queue processing resilient when page DOM mutates mid-iteration.
            }
        }

        if (cursor < queuedEntries.length) {
            window.setTimeout(runChunk, PREPROCESS_CHUNK_YIELD_MS);
            return;
        }

        flushInProgress = false;

        if (pendingRoots.size > 0) {
            schedulePendingRootsFlush();
        }
    };

    runChunk();
}

function queueRootForPreprocess(root, force = false) {
    const normalizedRoot = normalizeQueuedRoot(root);
    if (!normalizedRoot) return;

    const previousForce = pendingRoots.get(normalizedRoot) || false;
    pendingRoots.set(normalizedRoot, previousForce || force);

    schedulePendingRootsFlush();
}

function normalizeCaptureRoot(root) {
    if (!root) {
        return null;
    }

    if (root instanceof Text) {
        return root.isConnected ? root : null;
    }

    if (root instanceof Element) {
        if (!root.isConnected) {
            return null;
        }

        if (root.closest('#bilingual-tooltip')) {
            return null;
        }

        return root;
    }

    if (typeof DocumentFragment !== 'undefined' && root instanceof DocumentFragment) {
        return root;
    }

    if (root instanceof Document) {
        return root.body || root.documentElement;
    }

    return null;
}

function captureOriginalTextNodesFromRoot(root, source = 'mutation-sync') {
    if (!root) {
        return;
    }

    if (root instanceof Text) {
        if (!shouldSkipTextNode(root)) {
            rememberOriginalContent(root, root.nodeValue || '', { source });
        }
        return;
    }

    if (
        !(root instanceof Element)
        && !(root instanceof Document)
        && !(typeof DocumentFragment !== 'undefined' && root instanceof DocumentFragment)
    ) {
        return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        if (!shouldSkipTextNode(current)) {
            rememberOriginalContent(current, current.nodeValue || '', { source });
        }
        current = walker.nextNode();
    }
}

function flushPreemptiveCaptureRoots() {
    preemptiveCaptureHandle = null;
    preemptiveCaptureHandleMode = 'none';

    if (preemptiveCaptureRoots.size === 0) {
        return;
    }

    const queuedRoots = Array.from(preemptiveCaptureRoots.values());
    preemptiveCaptureRoots.clear();

    queuedRoots.forEach((root) => {
        captureOriginalTextNodesFromRoot(root, 'mutation-raf');
        queueRootForPreprocess(root, false);
    });
}

function schedulePreemptiveCapture(root) {
    const normalizedRoot = normalizeCaptureRoot(root);
    if (!normalizedRoot) {
        return;
    }

    // Grab text in the current task first, then consolidate on next frame.
    captureOriginalTextNodesFromRoot(normalizedRoot, 'mutation-sync');
    preemptiveCaptureRoots.add(normalizedRoot);

    if (preemptiveCaptureHandle !== null) {
        return;
    }

    if (typeof window.requestAnimationFrame === 'function') {
        preemptiveCaptureHandleMode = 'raf';
        preemptiveCaptureHandle = window.requestAnimationFrame(flushPreemptiveCaptureRoots);
        return;
    }

    preemptiveCaptureHandleMode = 'timeout';
    preemptiveCaptureHandle = window.setTimeout(flushPreemptiveCaptureRoots, 16);
}

function performSilentScrollProbe(probeY, restoreX, restoreY) {
    const clampedProbeY = Math.max(0, Math.floor(probeY));
    const moved = Math.abs(window.scrollY - clampedProbeY) > 1;

    if (moved) {
        window.scrollTo(restoreX, clampedProbeY);
    }

    // Trigger scroll-based lazy loading without user-visible jump.
    window.dispatchEvent(new Event('scroll'));

    const rootTarget = document.body || document.documentElement;
    if (rootTarget) {
        queueRootForPreprocess(rootTarget, false);
    }

    if (moved && Math.abs(window.scrollY - restoreY) > 1) {
        window.scrollTo(restoreX, restoreY);
    }
}

function runShadowScanCycle() {
    shadowScanTimer = null;

    if (!featureEnabled || !document.documentElement) {
        return;
    }

    if (shadowScanInProgress) {
        shadowScanNeedsRerun = true;
        return;
    }

    shadowScanInProgress = true;

    const restoreX = window.scrollX;
    const restoreY = window.scrollY;
    const viewportHeight = Math.max(window.innerHeight || 0, 1);

    if (!Number.isFinite(shadowScanCursorY) || shadowScanCursorY < 0) {
        shadowScanCursorY = 0;
    }

    let steps = 0;

    const finalize = () => {
        window.scrollTo(restoreX, restoreY);

        const previousHeight = observedScrollHeight;
        const latestHeight = getDocumentScrollHeight();
        const grew = latestHeight > (previousHeight + SHADOW_SCAN_GROWTH_THRESHOLD_PX);

        observedScrollHeight = Math.max(previousHeight, latestHeight);
        shadowScanInProgress = false;

        runFullPreprocess(false, { anchorY: restoreY });

        if (grew) {
            const resumeFrom = Math.max(0, previousHeight - viewportHeight);
            shadowScanCursorY = Math.min(shadowScanCursorY, resumeFrom);
        }

        const hasRemainingDepth = shadowScanCursorY <= Math.max(0, latestHeight - viewportHeight);
        if (shadowScanNeedsRerun || grew || hasRemainingDepth) {
            shadowScanNeedsRerun = false;
            scheduleShadowScan(false);
        }
    };

    const runStep = () => {
        if (!featureEnabled) {
            finalize();
            return;
        }

        const currentHeight = getDocumentScrollHeight();
        observedScrollHeight = Math.max(observedScrollHeight, currentHeight);
        const maxScrollY = Math.max(0, currentHeight - viewportHeight);

        if (shadowScanCursorY > maxScrollY || steps >= SHADOW_SCAN_MAX_STEPS_PER_CYCLE) {
            finalize();
            return;
        }

        const probeY = Math.min(shadowScanCursorY, maxScrollY);
        performSilentScrollProbe(probeY, restoreX, restoreY);

        shadowScanCursorY = probeY + SHADOW_SCAN_STEP_PX;
        steps += 1;
        window.setTimeout(runStep, SHADOW_SCAN_STEP_DELAY_MS);
    };

    runStep();
}

function scheduleShadowScan(immediate = false) {
    if (!featureEnabled) {
        return;
    }

    if (shadowScanInProgress) {
        shadowScanNeedsRerun = true;
        return;
    }

    if (shadowScanTimer !== null) {
        return;
    }

    shadowScanTimer = window.setTimeout(
        runShadowScanCycle,
        immediate ? 0 : SHADOW_SCAN_STEP_DELAY_MS
    );
}

function handlePotentialScrollHeightGrowth() {
    const previousHeight = observedScrollHeight;
    const latestHeight = getDocumentScrollHeight();

    if (latestHeight > (previousHeight + SHADOW_SCAN_GROWTH_THRESHOLD_PX)) {
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const resumeFrom = Math.max(0, previousHeight - viewportHeight);
        shadowScanCursorY = Math.min(shadowScanCursorY, resumeFrom);
        observedScrollHeight = latestHeight;
        scheduleShadowScan(false);
        return;
    }

    observedScrollHeight = Math.max(previousHeight, latestHeight);
}

function scheduleIdleShadowScan() {
    clearIdleShadowScanHandle();

    const runWhenIdle = () => {
        idleShadowScanHandle = null;
        idleShadowScanHandleMode = 'none';

        if (!featureEnabled) {
            return;
        }

        shadowScanCursorY = 0;
        observedScrollHeight = getDocumentScrollHeight();
        scheduleShadowScan(true);
    };

    if (typeof window.requestIdleCallback === 'function') {
        idleShadowScanHandleMode = 'idle';
        idleShadowScanHandle = window.requestIdleCallback(
            runWhenIdle,
            { timeout: LOW_PRIORITY_IDLE_TIMEOUT_MS * 2 }
        );
        return;
    }

    idleShadowScanHandleMode = 'timeout';
    idleShadowScanHandle = window.setTimeout(runWhenIdle, PREPROCESS_QUEUE_FLUSH_DELAY_MS);
}

function clearOldSnapshots(options = {}) {
    const preserveIndex = options.preserveIndex !== false;

    hideTooltip();

    clearPendingFlushTimer();
    flushInProgress = false;
    pendingRoots.clear();

    clearPreemptiveCaptureHandle();
    preemptiveCaptureRoots.clear();

    clearLowPriorityScanHandle();
    lowPriorityBoundaries.clear();

    clearShadowScanTimer();
    clearIdleShadowScanHandle();

    shadowScanInProgress = false;
    shadowScanNeedsRerun = false;
    shadowScanCursorY = 0;
    observedScrollHeight = 0;

    blockDisplayProjectionCache = new WeakMap();
    textNodeSnapshots = new WeakMap();
    blockSnapshots = new WeakMap();
    liveSnapshotBoundaryKeys.clear();
    nodeOriginalIndexKeys = new WeakMap();

    if (!preserveIndex) {
        totalOriginalContentIndex.clear();
        signatureToIndexKeys.clear();
    }
}

function isTranslatedClassName(classValue) {
    return /\btranslated-(ltr|rtl)\b/i.test(classValue || '');
}

function detectTranslationRenderState() {
    const html = document.documentElement;
    const body = document.body;

    const htmlLang = (html?.getAttribute('lang') || '').trim().toLowerCase();
    const htmlClass = html?.className || '';
    const bodyClass = body?.className || '';
    const htmlTranslate = (html?.getAttribute('translate') || '').trim().toLowerCase();
    const hasTranslatedClass = isTranslatedClassName(htmlClass) || isTranslatedClassName(bodyClass);
    const hasTranslateWrapper = Boolean(
        document.querySelector('font[style*="vertical-align: inherit"], span[style*="vertical-align: inherit"]')
    );
    const hasLangShift = Boolean(baselineDocumentLang && htmlLang && htmlLang !== baselineDocumentLang);
    const translated = hasTranslatedClass || hasTranslateWrapper || hasLangShift;

    return {
        mode: translated ? 'translated' : 'original',
        signature: [
            translated ? '1' : '0',
            htmlLang,
            htmlClass,
            bodyClass,
            htmlTranslate
        ].join('|')
    };
}

function shouldServeTooltipInteractions() {
    return featureEnabled && translationStateMode === 'translated';
}

function forceLifecycleHotStart(reason = 'unknown') {
    if (!featureEnabled || translationStateMode !== 'translated') {
        return;
    }

    clearOldSnapshots({ preserveIndex: true });
    rehydrateOriginalIndexReferences();
    runFullPreprocess(true, { anchorY: window.scrollY });
    observedScrollHeight = getDocumentScrollHeight();
    shadowScanCursorY = 0;
    scheduleShadowScan(true);
}

function maybeRunLifecycleWake(reason = 'wake-poll') {
    if (!featureEnabled || translationStateMode !== 'translated') {
        return;
    }

    const tip = ensureTooltip();
    const tooltipReady = Boolean(tip && tip.isConnected);
    const hasSnapshots = liveSnapshotBoundaryKeys.size > 0;
    if (tooltipReady && hasSnapshots) {
        return;
    }

    forceLifecycleHotStart(reason);
}

function handleTranslationModeTransition(previousMode, nextMode, reason = 'state-change') {
    if (!featureEnabled || previousMode === nextMode) {
        return;
    }

    if (nextMode === 'translated') {
        forceLifecycleHotStart(reason);
        return;
    }

    clearOldSnapshots({ preserveIndex: true });
    runFullPreprocess(true, { anchorY: window.scrollY });
    observedScrollHeight = getDocumentScrollHeight();
    shadowScanCursorY = 0;
    scheduleIdleShadowScan();
    hideTooltip();
}

function evaluateTranslationState(reason = 'observer') {
    translationStateEvaluationHandle = null;
    translationStateEvaluationMode = 'none';

    if (!document.documentElement) {
        return;
    }

    if (!baselineDocumentLang) {
        baselineDocumentLang = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
    }

    const snapshot = detectTranslationRenderState();
    const previousMode = translationStateMode;
    const signatureChanged = snapshot.signature !== translationStateSignature;

    translationStateMode = snapshot.mode;
    translationStateSignature = snapshot.signature;

    if (previousMode !== 'unknown' && previousMode !== snapshot.mode) {
        handleTranslationModeTransition(previousMode, snapshot.mode, reason);
        return;
    }

    if (signatureChanged) {
        maybeRunLifecycleWake(reason);
    }
}

function scheduleTranslationStateEvaluation(reason = 'observer') {
    if (translationStateEvaluationHandle !== null) {
        return;
    }

    if (typeof window.requestAnimationFrame === 'function') {
        translationStateEvaluationMode = 'raf';
        translationStateEvaluationHandle = window.requestAnimationFrame(() => {
            evaluateTranslationState(reason);
        });
        return;
    }

    translationStateEvaluationMode = 'timeout';
    translationStateEvaluationHandle = window.setTimeout(() => {
        evaluateTranslationState(reason);
    }, 24);
}

function refreshLifecycleObserverTargets() {
    if (!lifecycleObserver || !document.documentElement) {
        return;
    }

    lifecycleObserver.disconnect();

    lifecycleObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang', 'class', 'translate', 'dir'],
        childList: true
    });

    if (document.body) {
        lifecycleObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['lang', 'class', 'translate', 'dir']
        });
    }
}

function setupLifecycleObserver() {
    if (lifecycleObserver || !document.documentElement) {
        return;
    }

    lifecycleObserver = new MutationObserver((mutations) => {
        let shouldEvaluate = false;
        let bodyChanged = false;

        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                shouldEvaluate = true;
            }

            if (mutation.type === 'childList') {
                shouldEvaluate = true;
                bodyChanged = true;
            }
        }

        if (bodyChanged) {
            refreshLifecycleObserverTargets();
            bindDelegatedInteractionListeners();
        }

        if (shouldEvaluate) {
            scheduleTranslationStateEvaluation('lifecycle-observer');
        }
    });

    refreshLifecycleObserverTargets();
    scheduleTranslationStateEvaluation('lifecycle-init');
}

function teardownLifecycleObserver() {
    if (lifecycleObserver) {
        lifecycleObserver.disconnect();
        lifecycleObserver = null;
    }

    clearTranslationStateEvaluationHandle();
    clearTranslationWakePollHandle();

    translationStateMode = 'unknown';
    translationStateSignature = '';
}

function runTranslationWakePoll() {
    translationWakePollHandle = null;
    translationWakePollMode = 'none';

    if (!featureEnabled) {
        return;
    }

    scheduleTranslationStateEvaluation('wake-poll');
    maybeRunLifecycleWake('wake-poll');
    scheduleTranslationWakePoll();
}

function scheduleTranslationWakePoll(delay = TRANSLATION_WAKE_POLL_INTERVAL_MS) {
    if (translationWakePollHandle !== null) {
        return;
    }

    if (typeof window.requestIdleCallback === 'function') {
        translationWakePollMode = 'idle';
        translationWakePollHandle = window.requestIdleCallback(
            runTranslationWakePoll,
            { timeout: Math.max(delay, TRANSLATION_WAKE_IDLE_TIMEOUT_MS) }
        );
        return;
    }

    translationWakePollMode = 'timeout';
    translationWakePollHandle = window.setTimeout(runTranslationWakePoll, delay);
}

function scheduleForcedFullPreprocess(delay = NAVIGATION_PREPROCESS_DELAY_MS) {
    allowSnapshotForceRefreshUntil = Date.now() + NAVIGATION_FORCE_REFRESH_WINDOW_MS;

    if (navigationPreprocessTimer !== null) {
        window.clearTimeout(navigationPreprocessTimer);
    }

    navigationPreprocessTimer = window.setTimeout(() => {
        navigationPreprocessTimer = null;
        runFullPreprocess(true, { anchorY: window.scrollY });
        shadowScanCursorY = 0;
        observedScrollHeight = getDocumentScrollHeight();
        scheduleShadowScan(true);
    }, delay);
}

function maybeHandleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl === lastKnownUrl) return;

    lastKnownUrl = currentUrl;
    scheduleTranslationStateEvaluation('url-change');
    scheduleForcedFullPreprocess();
}

function handleHistoryNavigation() {
    maybeHandleUrlChange();
}

function setupNavigationObservers() {
    if (historyPatched) return;

    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
        const result = originalPushState.apply(this, args);
        maybeHandleUrlChange();
        return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
        const result = originalReplaceState.apply(this, args);
        maybeHandleUrlChange();
        return result;
    };

    window.addEventListener('popstate', handleHistoryNavigation, true);
    window.addEventListener('hashchange', handleHistoryNavigation, true);
    historyPatched = true;
}

function teardownNavigationObservers() {
    if (!historyPatched) return;

    if (originalPushState) {
        history.pushState = originalPushState;
    }

    if (originalReplaceState) {
        history.replaceState = originalReplaceState;
    }

    window.removeEventListener('popstate', handleHistoryNavigation, true);
    window.removeEventListener('hashchange', handleHistoryNavigation, true);
    historyPatched = false;
    originalPushState = null;
    originalReplaceState = null;
}

function setupMutationObserver() {
    if (mutationObserver || (!document.body && !document.documentElement)) return;

    const observerRoot = document.body || document.documentElement;
    if (!observerRoot) {
        return;
    }

    mutationObserver = new MutationObserver((mutations) => {
        let hasAddedNodes = false;

        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    hasAddedNodes = true;
                    schedulePreemptiveCapture(node);
                    queueRootForPreprocess(node, false);
                });
            }

            if (mutation.type === 'characterData' && mutation.target instanceof Text) {
                const textNode = mutation.target;
                if (!textNodeSnapshots.has(textNode)) {
                    schedulePreemptiveCapture(textNode);
                    queueRootForPreprocess(textNode, false);
                } else if (Date.now() <= allowSnapshotForceRefreshUntil) {
                    queueRootForPreprocess(textNode, true);
                }
            }
        }

        if (hasAddedNodes) {
            handlePotentialScrollHeightGrowth();
        }
    });

    mutationObserver.observe(observerRoot, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function teardownMutationObserver() {
    if (!mutationObserver) return;

    mutationObserver.disconnect();
    mutationObserver = null;

    clearPendingFlushTimer();

    flushInProgress = false;
    pendingRoots.clear();

    clearPreemptiveCaptureHandle();
    preemptiveCaptureRoots.clear();

    clearLowPriorityScanHandle();
    lowPriorityBoundaries.clear();

    clearShadowScanTimer();
    clearIdleShadowScanHandle();

    shadowScanInProgress = false;
    shadowScanNeedsRerun = false;
}

function showTooltip(text, clientX, clientY) {
    if (!text || text.trim() === '') return;

    const tip = ensureTooltip();
    if (!tip) return;

    // Render from an attribute to avoid browser translators rewriting a text node.
    tip.setAttribute('data-original-text', text);
    tip.textContent = '';
    tip.style.display = 'block';

    const tooltipRect = tip.getBoundingClientRect();
    let top = clientY - tooltipRect.height - 14;
    let left = clientX - tooltipRect.width / 2;

    if (top < 8) top = clientY + 14;
    if (left < 8) left = 8;

    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}

function getCaretInfoFromPoint(clientX, clientY) {
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (range) {
            return { node: range.startContainer, offset: range.startOffset };
        }
    }

    if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(clientX, clientY);
        if (position) {
            return { node: position.offsetNode, offset: position.offset };
        }
    }

    return null;
}

function getDistanceToRect(clientX, clientY, rect) {
    const dx = clientX < rect.left ? rect.left - clientX : (clientX > rect.right ? clientX - rect.right : 0);
    const dy = clientY < rect.top ? rect.top - clientY : (clientY > rect.bottom ? clientY - rect.bottom : 0);
    return Math.hypot(dx, dy);
}

function isPointNearTextRange(range, clientX, clientY) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return false;

    const hasDirectHit = rects.some((rect) => (
        clientX >= rect.left - CLICK_TEXT_HIT_PADDING
        && clientX <= rect.right + CLICK_TEXT_HIT_PADDING
        && clientY >= rect.top - CLICK_TEXT_HIT_PADDING
        && clientY <= rect.bottom + CLICK_TEXT_HIT_PADDING
    ));

    return hasDirectHit;
}

function isPointOnTextGlyph(textNode, offset, clientX, clientY) {
    if (!(textNode instanceof Text)) return false;

    const textLength = (textNode.nodeValue || '').length;
    if (textLength === 0) return false;

    const safeOffset = Math.max(0, Math.min(offset, textLength));
    const candidateRanges = [];

    if (safeOffset > 0) {
        candidateRanges.push({ start: safeOffset - 1, end: safeOffset });
    }

    if (safeOffset < textLength) {
        candidateRanges.push({ start: safeOffset, end: safeOffset + 1 });
    }

    if (candidateRanges.length === 0) {
        candidateRanges.push({ start: textLength - 1, end: textLength });
    }

    for (const candidate of candidateRanges) {
        const range = document.createRange();
        try {
            range.setStart(textNode, candidate.start);
            range.setEnd(textNode, candidate.end);
        } catch (_error) {
            continue;
        }

        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) {
            continue;
        }

        const hit = rects.some((rect) => (
            clientX >= rect.left - CLICK_TEXT_HIT_PADDING
            && clientX <= rect.right + CLICK_TEXT_HIT_PADDING
            && clientY >= rect.top - CLICK_TEXT_HIT_PADDING
            && clientY <= rect.bottom + CLICK_TEXT_HIT_PADDING
        ));

        if (hit) {
            return true;
        }
    }

    return false;
}

function clampToUnit(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function detectScriptProfile(text) {
    const source = text || '';
    const cjkMatches = source.match(/[\u3400-\u9fff]/g);
    const latinMatches = source.match(/[A-Za-z]/g);

    return {
        cjkCount: cjkMatches ? cjkMatches.length : 0,
        latinCount: latinMatches ? latinMatches.length : 0
    };
}

function getTerminalPunctuation(text) {
    const normalized = (text || '').trim();
    if (!normalized) return '';

    let cursor = normalized.length - 1;
    while (cursor >= 0) {
        const char = normalized[cursor];

        if (TRAILING_CLOSE_CHARS.has(char) || /\s/.test(char)) {
            cursor -= 1;
            continue;
        }

        if (STRONG_END_CHARS.has(char) || COMMA_CHARS.has(char) || char === ':' || char === '：') {
            return char;
        }

        break;
    }

    return '';
}

function normalizeTerminalPunctuation(char) {
    if (!char) return '';
    if (char === '？') return '?';
    if (char === '！') return '!';
    if (char === '。') return '.';
    if (char === '；') return ';';
    if (char === '，' || char === '、') return ',';
    if (char === '：') return ':';
    return char;
}

function isStrongTerminalMark(mark) {
    return mark === '.' || mark === '!' || mark === '?' || mark === ';';
}

function buildCumulativeSegmentMetrics(segments) {
    const safeSegments = Array.isArray(segments) ? segments : [];
    if (safeSegments.length === 0) {
        return {
            metrics: [],
            totalUnits: 1
        };
    }

    const unitLengths = safeSegments.map((segment) => {
        const effectiveLength = getEffectiveCharLength(segment?.text || '');
        const rawSpan = Math.max(1, (segment?.end || 0) - (segment?.start || 0));
        return Math.max(1, effectiveLength || rawSpan);
    });

    const totalUnits = Math.max(1, unitLengths.reduce((sum, length) => sum + length, 0));
    let cursor = 0;

    const metrics = safeSegments.map((segment, index) => {
        const startRatio = cursor / totalUnits;
        cursor += unitLengths[index];
        const endRatio = cursor / totalUnits;
        const terminalPunctuation = getTerminalPunctuation(segment?.text || '');
        const normalizedPunctuation = normalizeTerminalPunctuation(terminalPunctuation);

        return {
            index,
            text: segment?.text || '',
            absoluteLength: unitLengths[index],
            startRatio,
            endRatio,
            centerRatio: (startRatio + endRatio) / 2,
            spanRatio: Math.max(0.0001, endRatio - startRatio),
            terminalPunctuation,
            normalizedPunctuation,
            hasStrongEnding: STRONG_END_CHARS.has(terminalPunctuation)
        };
    });

    return {
        metrics,
        totalUnits
    };
}

function findMetricIndexByCenter(metrics, centerRatio) {
    if (!Array.isArray(metrics) || metrics.length === 0) {
        return -1;
    }

    if (centerRatio <= metrics[0].startRatio) {
        return 0;
    }

    const lastIndex = metrics.length - 1;
    if (centerRatio >= metrics[lastIndex].endRatio) {
        return lastIndex;
    }

    for (let index = 0; index < metrics.length; index += 1) {
        const metric = metrics[index];
        if (centerRatio >= metric.startRatio && centerRatio <= metric.endRatio) {
            return index;
        }
    }

    let nearestIndex = 0;
    let nearestDistance = Infinity;

    metrics.forEach((metric, index) => {
        const distance = Math.abs(metric.centerRatio - centerRatio);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
        }
    });

    return nearestIndex;
}

function getRangeOverlapRatio(startA, endA, startB, endB) {
    const overlap = Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
    if (overlap <= 0) return 0;

    const minSpan = Math.max(0.0001, Math.min(endA - startA, endB - startB));
    return clampToUnit(overlap / minSpan);
}

function getPunctuationAlignmentScore(displayPunctuation, originalPunctuation) {
    if (!displayPunctuation && !originalPunctuation) {
        return 0.55;
    }

    if (!displayPunctuation || !originalPunctuation) {
        return 0.1;
    }

    if (displayPunctuation === originalPunctuation) {
        return displayPunctuation === '?' ? 1 : 0.92;
    }

    if (isStrongTerminalMark(displayPunctuation) && isStrongTerminalMark(originalPunctuation)) {
        return 0.35;
    }

    if (displayPunctuation === ',' && originalPunctuation === ';') {
        return 0.2;
    }

    if (displayPunctuation === ';' && originalPunctuation === ',') {
        return 0.2;
    }

    return 0;
}

function computeExpansionFactor(displayText, originalText, displayTotalLength, originalTotalLength) {
    const rawFactor = originalTotalLength / Math.max(1, displayTotalLength);
    const displayProfile = detectScriptProfile(displayText);
    const originalProfile = detectScriptProfile(originalText);

    const likelyZhToEn = displayProfile.cjkCount > (displayProfile.latinCount * 0.8)
        && originalProfile.latinCount > (originalProfile.cjkCount * 0.8);

    if (likelyZhToEn) {
        return Math.min(4.2, Math.max(1.35, rawFactor));
    }

    return Math.min(3, Math.max(0.75, rawFactor));
}

function scoreDisplayToOriginalCandidate(displayMetric, originalMetric, options) {
    const centerDistance = Math.abs(displayMetric.centerRatio - originalMetric.centerRatio);
    const centerScore = 1 - Math.min(1, centerDistance * 2.4);

    const startDistance = Math.abs(displayMetric.startRatio - originalMetric.startRatio);
    const endDistance = Math.abs(displayMetric.endRatio - originalMetric.endRatio);
    const edgeScore = 1 - Math.min(1, ((startDistance + endDistance) / 2) * 2.1);

    const overlapScore = getRangeOverlapRatio(
        displayMetric.startRatio,
        displayMetric.endRatio,
        originalMetric.startRatio,
        originalMetric.endRatio
    );

    const expectedOriginalLength = Math.max(1, displayMetric.absoluteLength * options.expansionFactor);
    const lengthDelta = Math.abs(originalMetric.absoluteLength - expectedOriginalLength);
    let lengthScore = 1 - Math.min(
        1,
        lengthDelta / Math.max(expectedOriginalLength, originalMetric.absoluteLength, 1)
    );

    if (originalMetric.absoluteLength < expectedOriginalLength * 0.52) {
        lengthScore *= 0.7;
    }

    const reverseDisplayIndex = findMetricIndexByCenter(options.displayMetrics, originalMetric.centerRatio);
    const reverseIndexDistance = Math.abs(reverseDisplayIndex - displayMetric.index);
    const reverseIndexScore = 1 - Math.min(1, reverseIndexDistance / 2.5);
    const reverseCenterScore = 1 - Math.min(1, centerDistance * 2.6);
    const reverseScore = (reverseIndexScore * 0.65) + (reverseCenterScore * 0.35);

    const punctuationScore = getPunctuationAlignmentScore(
        displayMetric.normalizedPunctuation,
        originalMetric.normalizedPunctuation
    );

    let score = (centerScore * 0.23)
        + (edgeScore * 0.17)
        + (overlapScore * 0.08)
        + (lengthScore * 0.2)
        + (reverseScore * 0.14)
        + (punctuationScore * 0.18)
        + (options.countSimilarity * 0.05);

    if (displayMetric.normalizedPunctuation === '?' && originalMetric.normalizedPunctuation === '?') {
        score += 0.15;
    } else if (
        displayMetric.normalizedPunctuation === '?'
        && originalMetric.normalizedPunctuation !== '?'
    ) {
        score -= 0.1;
    }

    return clampToUnit(score);
}

function getMergeSupportScore(previousDisplayMetric, currentDisplayMetric, originalMetric) {
    if (!previousDisplayMetric || !currentDisplayMetric || !originalMetric) {
        return 0;
    }

    if (previousDisplayMetric.hasStrongEnding) {
        return 0;
    }

    if (
        previousDisplayMetric.normalizedPunctuation === '?'
        || previousDisplayMetric.normalizedPunctuation === '!'
    ) {
        return 0;
    }

    const combinedStart = previousDisplayMetric.startRatio;
    const combinedEnd = currentDisplayMetric.endRatio;
    const combinedCenter = (combinedStart + combinedEnd) / 2;
    const combinedSpan = Math.max(0.0001, combinedEnd - combinedStart);

    const centerScore = 1 - Math.min(1, Math.abs(combinedCenter - originalMetric.centerRatio) * 2.5);
    const spanScore = 1 - Math.min(1, Math.abs(combinedSpan - originalMetric.spanRatio) * 2.8);

    return clampToUnit((centerScore * 0.62) + (spanScore * 0.38));
}

function mapDisplaySegmentToOriginal(displaySegments, originalSegments, displayIndex, displayText, originalText) {
    if (!Array.isArray(displaySegments) || !Array.isArray(originalSegments)) {
        return { index: -1, confidence: 0 };
    }

    if (displayIndex < 0 || displayIndex >= displaySegments.length || originalSegments.length === 0) {
        return { index: -1, confidence: 0 };
    }

    if (displaySegments.length === originalSegments.length) {
        return {
            index: Math.min(displayIndex, originalSegments.length - 1),
            confidence: 0.98
        };
    }

    const countSimilarity = Math.min(displaySegments.length, originalSegments.length)
        / Math.max(displaySegments.length, originalSegments.length);

    const displayAnchors = buildCumulativeSegmentMetrics(displaySegments);
    const originalAnchors = buildCumulativeSegmentMetrics(originalSegments);

    if (
        !Array.isArray(displayAnchors.metrics)
        || !Array.isArray(originalAnchors.metrics)
        || displayAnchors.metrics.length === 0
        || originalAnchors.metrics.length === 0
    ) {
        return { index: -1, confidence: 0 };
    }

    const expansionFactor = computeExpansionFactor(
        displayText,
        originalText,
        displayAnchors.totalUnits,
        originalAnchors.totalUnits
    );

    const candidateScores = displayAnchors.metrics.map((displayMetric) => (
        originalAnchors.metrics.map((originalMetric) => scoreDisplayToOriginalCandidate(
            displayMetric,
            originalMetric,
            {
                expansionFactor,
                countSimilarity,
                displayMetrics: displayAnchors.metrics
            }
        ))
    ));

    const assignedIndexes = new Array(displayAnchors.metrics.length).fill(0);
    const assignedScores = new Array(displayAnchors.metrics.length).fill(0);
    let previousAssignedIndex = 0;

    for (let index = 0; index < displayAnchors.metrics.length; index += 1) {
        const lowerBound = index === 0 ? 0 : previousAssignedIndex;
        let bestIndex = lowerBound;
        let bestAdjustedScore = -1;

        for (let originalIndex = lowerBound; originalIndex < originalAnchors.metrics.length; originalIndex += 1) {
            const baseScore = candidateScores[index][originalIndex] || 0;
            let adjustedScore = baseScore;

            if (index > 0) {
                const jumpSize = originalIndex - previousAssignedIndex;
                if (jumpSize > 2) {
                    adjustedScore -= Math.min(0.12, 0.03 * (jumpSize - 2));
                }
            }

            if (
                displayAnchors.metrics.length > originalAnchors.metrics.length
                && index > 0
                && originalIndex === previousAssignedIndex
            ) {
                const mergeSupportScore = getMergeSupportScore(
                    displayAnchors.metrics[index - 1],
                    displayAnchors.metrics[index],
                    originalAnchors.metrics[originalIndex]
                );
                adjustedScore += mergeSupportScore * 0.2;
            }

            if (index < displayAnchors.metrics.length - 1) {
                const nextSameScore = candidateScores[index + 1]?.[originalIndex] || 0;
                const nextAdvanceScore = (originalIndex + 1 < originalAnchors.metrics.length)
                    ? (candidateScores[index + 1]?.[originalIndex + 1] || 0)
                    : 0;
                const lookaheadDelta = Math.max(0, nextSameScore - nextAdvanceScore);
                const lookaheadWeight = displayAnchors.metrics.length > originalAnchors.metrics.length
                    ? 0.24
                    : 0.08;
                adjustedScore += lookaheadDelta * lookaheadWeight;
            }

            if (adjustedScore > bestAdjustedScore) {
                bestAdjustedScore = adjustedScore;
                bestIndex = originalIndex;
            }
        }

        assignedIndexes[index] = bestIndex;
        assignedScores[index] = clampToUnit(bestAdjustedScore);
        previousAssignedIndex = bestIndex;
    }

    const mappedIndex = assignedIndexes[displayIndex];
    if (!Number.isInteger(mappedIndex) || mappedIndex < 0 || mappedIndex >= originalAnchors.metrics.length) {
        return { index: -1, confidence: 0 };
    }

    const baseScore = candidateScores[displayIndex]?.[mappedIndex] || 0;
    const sequenceScore = assignedScores[displayIndex] || baseScore;
    let confidence = clampToUnit((baseScore * 0.72) + (sequenceScore * 0.28));

    confidence *= 0.55 + (countSimilarity * 0.45);

    const mappedOriginalMetric = originalAnchors.metrics[mappedIndex];
    const targetDisplayMetric = displayAnchors.metrics[displayIndex];
    if (mappedOriginalMetric && targetDisplayMetric) {
        const centerDistance = Math.abs(targetDisplayMetric.centerRatio - mappedOriginalMetric.centerRatio);
        if (centerDistance > 0.36) {
            confidence *= 0.78;
        }

        if (
            targetDisplayMetric.normalizedPunctuation === '?'
            && mappedOriginalMetric.normalizedPunctuation !== '?'
        ) {
            confidence *= 0.68;
        }
    }

    if (displayAnchors.metrics.length > originalAnchors.metrics.length) {
        confidence = Math.max(confidence, baseScore * 0.6);
    }

    return {
        index: mappedIndex,
        confidence: clampToUnit(confidence)
    };
}

function chooseFallbackOriginalText(snapshot, preferredIndex = -1) {
    if (!snapshot) return '';

    const { originalText, originalSegments, originalCoarseSegments } = snapshot;
    if (!Array.isArray(originalSegments) || originalSegments.length === 0) {
        return truncateTooltipText(originalText || '');
    }

    if (
        Array.isArray(originalCoarseSegments)
        && originalCoarseSegments.length > 0
        && preferredIndex >= 0
        && preferredIndex < originalSegments.length
    ) {
        const preferred = originalSegments[preferredIndex];
        const midPoint = Math.floor((preferred.start + preferred.end) / 2);
        const matchedCoarse = originalCoarseSegments.find(
            (segment) => midPoint >= segment.start && midPoint < segment.end
        );

        if (matchedCoarse && matchedCoarse.text) {
            return truncateTooltipText(matchedCoarse.text);
        }
    }

    if (Array.isArray(originalCoarseSegments) && originalCoarseSegments.length > 0) {
        const preferred = originalCoarseSegments.find((segment) => !isShortSegment(segment.text))
            || originalCoarseSegments[0];
        return truncateTooltipText(preferred?.text || '');
    }

    if (Array.isArray(originalSegments) && originalSegments.length > 0) {
        const preferred = originalSegments.find((segment) => !isShortSegment(segment.text))
            || originalSegments[0];
        return truncateTooltipText(preferred?.text || '');
    }

    return truncateTooltipText(originalText || '');
}

function getTextNodeOffsetInBlock(textNode, blockElement) {
    if (!(textNode instanceof Text) || !(blockElement instanceof Element)) {
        return -1;
    }

    const existing = textNodeSnapshots.get(textNode);
    if (existing && existing.blockElement === blockElement && Number.isInteger(existing.offsetInBlock)) {
        return existing.offsetInBlock;
    }

    let offset = 0;
    const walker = document.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
        if (shouldSkipTextNode(current)) {
            current = walker.nextNode();
            continue;
        }

        if (current === textNode) {
            return offset;
        }

        offset += (current.nodeValue || '').length;
        current = walker.nextNode();
    }

    return -1;
}

function buildBlockDisplayProjection(blockSnapshot) {
    if (!blockSnapshot || !(blockSnapshot.boundaryElement instanceof Element)) {
        return null;
    }

    const cached = blockDisplayProjectionCache.get(blockSnapshot.boundaryElement);
    if (cached && cached.snapshotIndexedAt === blockSnapshot.indexedAt) {
        return cached.projection;
    }

    const textNodes = collectBoundaryTextNodes(blockSnapshot.boundaryElement);
    if (textNodes.length === 0) {
        blockDisplayProjectionCache.delete(blockSnapshot.boundaryElement);
        return null;
    }

    let displayText = '';
    const nodeRanges = [];

    textNodes.forEach((textNode) => {
        if (!(textNode instanceof Text)) return;
        if (!textNode.isConnected) return;
        if (shouldSkipTextNode(textNode)) return;

        const start = displayText.length;
        const value = textNode.nodeValue || '';
        displayText += value;
        const end = displayText.length;

        nodeRanges.push({
            node: textNode,
            start,
            end
        });
    });

    const displaySegments = splitTextIntoSegments(displayText);
    const projection = {
        displayText,
        nodeRanges,
        totalLength: displayText.length,
        displaySegments
    };

    blockDisplayProjectionCache.set(blockSnapshot.boundaryElement, {
        snapshotIndexedAt: blockSnapshot.indexedAt,
        projection
    });

    return projection;
}

function findSegmentIndexByOffset(segments, offset) {
    if (!Array.isArray(segments) || segments.length === 0) {
        return -1;
    }

    let index = segments.findIndex(
        (segment) => offset >= segment.start && offset < segment.end
    );

    if (index === -1) {
        index = segments.findIndex((segment) => offset === segment.end);
    }

    return index;
}

function resolveNodeOffsetInProjection(projection, globalOffset) {
    if (!projection || !Array.isArray(projection.nodeRanges) || projection.nodeRanges.length === 0) {
        return null;
    }

    const clampedOffset = Math.max(0, Math.min(globalOffset, projection.totalLength));

    for (const nodeRange of projection.nodeRanges) {
        if (clampedOffset < nodeRange.start || clampedOffset > nodeRange.end) {
            continue;
        }

        const nodeTextLength = (nodeRange.node.nodeValue || '').length;
        const localOffset = Math.max(0, Math.min(nodeTextLength, clampedOffset - nodeRange.start));
        return {
            node: nodeRange.node,
            offset: localOffset
        };
    }

    if (clampedOffset <= 0) {
        return {
            node: projection.nodeRanges[0].node,
            offset: 0
        };
    }

    const last = projection.nodeRanges[projection.nodeRanges.length - 1];
    return {
        node: last.node,
        offset: (last.node.nodeValue || '').length
    };
}

function createRangeFromProjection(projection, startOffset, endOffset) {
    const startPoint = resolveNodeOffsetInProjection(projection, startOffset);
    const endPoint = resolveNodeOffsetInProjection(projection, endOffset);
    if (!startPoint || !endPoint) {
        return null;
    }

    const range = document.createRange();
    try {
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
    } catch (_error) {
        return null;
    }

    return range;
}

function getOriginalSegmentFromClick(clientX, clientY, boundaryHint = null) {
    const caret = getCaretInfoFromPoint(clientX, clientY);
    if (!caret || !(caret.node instanceof Text)) return '';
    if ((caret.node.nodeValue || '').trim().length === 0) return '';

    const textNodeSnapshot = textNodeSnapshots.get(caret.node);
    const boundaryElement = textNodeSnapshot?.blockElement
        || boundaryHint
        || getBlockBoundaryElement(caret.node.parentElement);
    if (!boundaryElement) return '';

    const blockSnapshot = blockSnapshots.get(boundaryElement);
    if (!blockSnapshot) {
        const indexed = getIndexedOriginalTextFromNode(caret.node);
        return indexed ? truncateTooltipText(indexed) : '';
    }

    const projection = buildBlockDisplayProjection(blockSnapshot);
    if (!projection || projection.displayText.trim().length === 0) return '';

    const targetNodeRange = projection.nodeRanges.find((item) => item.node === caret.node);
    if (!targetNodeRange) return '';

    const nodeTextLength = (caret.node.nodeValue || '').length;
    const safeCaretOffset = Math.max(0, Math.min(caret.offset, nodeTextLength));
    if (!isPointOnTextGlyph(caret.node, safeCaretOffset, clientX, clientY)) {
        return '';
    }

    const displayOffset = targetNodeRange.start + safeCaretOffset;

    const displaySegments = projection.displaySegments || [];
    if (displaySegments.length === 0) return '';

    const displayIndex = findSegmentIndexByOffset(displaySegments, displayOffset);

    if (displayIndex === -1) return '';

    const displaySegment = displaySegments[displayIndex];
    if (!displaySegment) return '';

    const hitRange = createRangeFromProjection(projection, displaySegment.start, displaySegment.end);
    if (!hitRange) {
        return '';
    }

    if (!isPointNearTextRange(hitRange, clientX, clientY)) {
        return '';
    }

    const mapping = mapDisplaySegmentToOriginal(
        displaySegments,
        blockSnapshot.originalSegments,
        displayIndex,
        projection.displayText,
        blockSnapshot.originalText
    );

    const absoluteOffsetInBlock = getTextNodeOffsetInBlock(caret.node, boundaryElement);
    const absoluteOriginalIndex = absoluteOffsetInBlock >= 0
        ? findSegmentIndexByOffset(
            blockSnapshot.originalSegments,
            absoluteOffsetInBlock + safeCaretOffset
        )
        : -1;

    if (mapping.index < 0) {
        if (absoluteOriginalIndex >= 0) {
            return chooseFallbackOriginalText(blockSnapshot, absoluteOriginalIndex);
        }
        return '';
    }

    if (displaySegments.length === 1 && blockSnapshot.originalSegments.length > 1) {
        return chooseFallbackOriginalText(blockSnapshot, mapping.index);
    }

    if (mapping.confidence < LOW_CONFIDENCE_THRESHOLD) {
        if (absoluteOriginalIndex >= 0) {
            return chooseFallbackOriginalText(blockSnapshot, absoluteOriginalIndex);
        }
        return chooseFallbackOriginalText(blockSnapshot, mapping.index);
    }

    return blockSnapshot.originalSegments[mapping.index]?.text || '';
}

function rangesIntersect(rangeA, rangeB) {
    try {
        const endToStart = rangeA.compareBoundaryPoints(Range.END_TO_START, rangeB);
        const startToEnd = rangeA.compareBoundaryPoints(Range.START_TO_END, rangeB);
        return endToStart > 0 && startToEnd < 0;
    } catch (_error) {
        return false;
    }
}

function collectOriginalSegmentsFromSelection(selection) {
    if (!selection || selection.rangeCount === 0) return [];

    const selectionRange = selection.getRangeAt(0);
    const root = selectionRange.commonAncestorContainer;
    const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
    if (!walkerRoot) return [];

    const originals = [];
    const seen = new Set();
    const candidateBlocks = new Set();
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);

    let textNode = walker.nextNode();
    while (textNode) {
        const textNodeSnapshot = textNodeSnapshots.get(textNode);
        const boundaryElement = textNodeSnapshot?.blockElement
            || getBlockBoundaryElement(textNode.parentElement);

        if (!boundaryElement || !blockSnapshots.has(boundaryElement)) {
            const indexedText = getIndexedOriginalTextFromNode(textNode);
            if (indexedText && !seen.has(indexedText)) {
                seen.add(indexedText);
                originals.push(truncateTooltipText(indexedText));
            }

            textNode = walker.nextNode();
            continue;
        }

        const nodeRange = document.createRange();
        try {
            nodeRange.selectNodeContents(textNode);
        } catch (_error) {
            textNode = walker.nextNode();
            continue;
        }

        if (rangesIntersect(selectionRange, nodeRange)) {
            candidateBlocks.add(boundaryElement);
        }

        textNode = walker.nextNode();
    }

    candidateBlocks.forEach((blockElement) => {
        const blockSnapshot = blockSnapshots.get(blockElement);
        if (!blockSnapshot) return;

        const projection = buildBlockDisplayProjection(blockSnapshot);
        if (!projection || projection.displayText.trim().length === 0) return;

        const displaySegments = projection.displaySegments || [];
        if (displaySegments.length === 0) return;

        displaySegments.forEach((displaySegment, index) => {
            const segmentRange = createRangeFromProjection(projection, displaySegment.start, displaySegment.end);
            if (!segmentRange || !rangesIntersect(selectionRange, segmentRange)) {
                return;
            }

            const mapping = mapDisplaySegmentToOriginal(
                displaySegments,
                blockSnapshot.originalSegments,
                index,
                projection.displayText,
                blockSnapshot.originalText
            );

            let text = '';
            if (mapping.index >= 0 && mapping.confidence >= LOW_CONFIDENCE_THRESHOLD) {
                text = blockSnapshot.originalSegments[mapping.index]?.text || '';
            } else {
                text = chooseFallbackOriginalText(blockSnapshot, mapping.index);
            }

            if (text && !seen.has(text)) {
                seen.add(text);
                originals.push(text);
            }
        });
    });

    return originals;
}

function stopHeavyProcessing() {
    teardownMutationObserver();
    teardownLifecycleObserver();
    teardownNavigationObservers();
    unbindDelegatedInteractionListeners();

    if (navigationPreprocessTimer !== null) {
        window.clearTimeout(navigationPreprocessTimer);
        navigationPreprocessTimer = null;
    }

    clearOldSnapshots({ preserveIndex: false });

    allowSnapshotForceRefreshUntil = 0;
    baselineDocumentLang = '';
}

function startHeavyProcessing(forceRefresh = false) {
    if (forceRefresh) {
        clearOldSnapshots({ preserveIndex: false });
    }

    if (!baselineDocumentLang && document.documentElement) {
        baselineDocumentLang = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
    }

    bindDelegatedInteractionListeners();

    observedScrollHeight = getDocumentScrollHeight();
    if (forceRefresh) {
        shadowScanCursorY = 0;
    }

    setupMutationObserver();
    setupLifecycleObserver();
    setupNavigationObservers();
    evaluateTranslationState('start');
    runFullPreprocess(forceRefresh, { anchorY: window.scrollY });
    scheduleIdleShadowScan();
    scheduleTranslationWakePoll();
}

function setFeatureEnabled(enabled, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const nextEnabled = Boolean(enabled);

    if (featureEnabled === nextEnabled && !forceRefresh) {
        return;
    }

    featureEnabled = nextEnabled;
    if (!featureEnabled) {
        hideTooltip();
        stopHeavyProcessing();
        return;
    }

    startHeavyProcessing(forceRefresh);
}

function synchronizeFeatureState() {
    if (!chrome.storage || !chrome.storage.local) {
        setFeatureEnabled(false);
        return;
    }

    chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
            setFeatureEnabled(false);
            return;
        }
        setFeatureEnabled(result[FEATURE_ENABLED_STORAGE_KEY] === true, { forceRefresh: true });
    });

    if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes[FEATURE_ENABLED_STORAGE_KEY]) {
                return;
            }

            setFeatureEnabled(changes[FEATURE_ENABLED_STORAGE_KEY].newValue === true, { forceRefresh: true });
        });
    }
}

function resolveBoundaryFromEventTarget(target) {
    if (target instanceof Text) {
        return getBlockBoundaryElement(target.parentElement);
    }

    if (target instanceof Element) {
        return getBlockBoundaryElement(target);
    }

    return null;
}

function handleDelegatedBodyClick(event) {
    if (!shouldServeTooltipInteractions()) {
        hideTooltip();
        return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
        return;
    }

    const boundaryHint = resolveBoundaryFromEventTarget(event.target);
    const text = getOriginalSegmentFromClick(event.clientX, event.clientY, boundaryHint);
    if (text) {
        showTooltip(text, event.clientX, event.clientY);
        return;
    }

    hideTooltip();
}

function handleDelegatedBodyMouseUp(event) {
    if (!shouldServeTooltipInteractions()) {
        hideTooltip();
        return;
    }

    const selection = window.getSelection();
    if (!selection) {
        hideTooltip();
        return;
    }

    if (selection.toString().trim().length === 0) {
        return;
    }

    const originals = collectOriginalSegmentsFromSelection(selection);
    if (originals.length > 0) {
        showTooltip(originals.join(' '), event.clientX, event.clientY);
        return;
    }

    hideTooltip();
}

function bindDelegatedInteractionListeners() {
    const body = document.body;
    if (!body) {
        return;
    }

    if (delegatedEventBody === body) {
        return;
    }

    if (delegatedEventBody) {
        delegatedEventBody.removeEventListener('click', handleDelegatedBodyClick, true);
        delegatedEventBody.removeEventListener('mouseup', handleDelegatedBodyMouseUp, true);
    }

    body.addEventListener('click', handleDelegatedBodyClick, true);
    body.addEventListener('mouseup', handleDelegatedBodyMouseUp, true);
    delegatedEventBody = body;
}

function unbindDelegatedInteractionListeners() {
    if (!delegatedEventBody) {
        return;
    }

    delegatedEventBody.removeEventListener('click', handleDelegatedBodyClick, true);
    delegatedEventBody.removeEventListener('mouseup', handleDelegatedBodyMouseUp, true);
    delegatedEventBody = null;
}

document.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
        return;
    }

    if (message.type === 'BTV_PING') {
        const runtime = window[CONTENT_RUNTIME_KEY];
        if (runtime && typeof runtime === 'object') {
            runtime.lastPingAt = Date.now();
        }

        sendResponse({ ok: true, enabled: featureEnabled, browser: BROWSER_PROFILE });
        return;
    }

    if (message.type === 'BTV_PREPROCESS_NOW') {
        runFullPreprocess(true, { anchorY: window.scrollY });
        shadowScanCursorY = 0;
        observedScrollHeight = getDocumentScrollHeight();
        scheduleShadowScan(true);
        sendResponse({ ok: true, time: Date.now() });
        return;
    }

    if (message.type === 'BTV_SET_ENABLED') {
        const enabled = Boolean(message.enabled);
        setFeatureEnabled(enabled, { forceRefresh: enabled });
        sendResponse({ ok: true, enabled: featureEnabled });
    }
});

function initialize() {
    synchronizeFeatureState();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}

})();