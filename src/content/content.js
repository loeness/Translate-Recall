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
const CLICK_TEXT_HIT_PADDING = 2;
const CLICK_TEXT_MAX_DISTANCE = 8;
const NAVIGATION_FORCE_REFRESH_WINDOW_MS = 1500;
const MIN_SEGMENT_CHARS = 8;
const MAX_SEGMENT_CHARS = 220;
const COMMA_SPLIT_TRIGGER_CHARS = 96;
const LINE_BREAK_SPLIT_TRIGGER_CHARS = 140;
const LOW_CONFIDENCE_THRESHOLD = 0.45;
const MAX_FALLBACK_CHARS = 320;

const sentenceSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
    : null;

let tooltip = null;
let featureEnabled = false;
let lastKnownUrl = window.location.href;
let navigationPreprocessTimer = null;
let allowSnapshotForceRefreshUntil = 0;
let mutationObserver = null;
let historyPatched = false;
let originalPushState = null;
let originalReplaceState = null;

const textNodeSnapshots = new WeakMap();
const blockSnapshots = new WeakMap();
const pendingRoots = new Map();
let flushTimer = null;

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
}

function preprocessBoundary(boundaryElement, force = false) {
    if (!boundaryElement) return;

    // Keep original snapshots stable unless caller explicitly requests refresh.
    if (!force && blockSnapshots.has(boundaryElement)) {
        return;
    }

    const textNodes = collectBoundaryTextNodes(boundaryElement);
    const blockSnapshot = buildBlockOriginalSnapshot(boundaryElement, textNodes);
    if (!blockSnapshot) {
        return;
    }

    blockSnapshots.set(boundaryElement, blockSnapshot);
    blockSnapshot.nodeRanges.forEach((nodeRange) => {
        snapshotTextNode(nodeRange.node, blockSnapshot, nodeRange.start, nodeRange.end);
    });
}

function preprocessRoot(root, force = false) {
    const boundaries = collectBlockBoundaries(root);
    boundaries.forEach((boundary) => preprocessBoundary(boundary, force));
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
    const targets = getPreprocessTargets();
    targets.forEach((target) => preprocessRoot(target, force));
}

function queueRootForPreprocess(root, force = false) {
    if (!root) return;

    const previousForce = pendingRoots.get(root) || false;
    pendingRoots.set(root, previousForce || force);

    if (flushTimer !== null) return;

    flushTimer = window.setTimeout(() => {
        pendingRoots.forEach((queuedForce, queuedRoot) => preprocessRoot(queuedRoot, queuedForce));
        pendingRoots.clear();
        flushTimer = null;
    }, 120);
}

function scheduleForcedFullPreprocess(delay = 120) {
    allowSnapshotForceRefreshUntil = Date.now() + NAVIGATION_FORCE_REFRESH_WINDOW_MS;

    if (navigationPreprocessTimer !== null) {
        window.clearTimeout(navigationPreprocessTimer);
    }

    navigationPreprocessTimer = window.setTimeout(() => {
        navigationPreprocessTimer = null;
        runFullPreprocess(true);
    }, delay);
}

function maybeHandleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl === lastKnownUrl) return;

    lastKnownUrl = currentUrl;
    scheduleForcedFullPreprocess(120);
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
    if (mutationObserver || !document.documentElement) return;

    mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => queueRootForPreprocess(node, false));
            }

            if (mutation.type === 'characterData' && mutation.target instanceof Text) {
                const textNode = mutation.target;
                if (!textNodeSnapshots.has(textNode)) {
                    queueRootForPreprocess(textNode, false);
                } else if (Date.now() <= allowSnapshotForceRefreshUntil) {
                    queueRootForPreprocess(textNode, true);
                }
            }
        }
    });

    mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function teardownMutationObserver() {
    if (!mutationObserver) return;

    mutationObserver.disconnect();
    mutationObserver = null;

    if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
    }

    pendingRoots.clear();
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

    if (hasDirectHit) return true;

    const minDistance = rects.reduce((min, rect) => Math.min(min, getDistanceToRect(clientX, clientY, rect)), Infinity);
    return minDistance <= CLICK_TEXT_MAX_DISTANCE;
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

    const displaySegment = displaySegments[displayIndex];
    const displayLength = Math.max(1, displayText.length);
    const originalLength = Math.max(1, originalText.length);
    const displayMidRatio = ((displaySegment.start + displaySegment.end) / 2) / displayLength;
    const displaySpanRatio = (displaySegment.end - displaySegment.start) / displayLength;
    const countSimilarity = Math.min(displaySegments.length, originalSegments.length)
        / Math.max(displaySegments.length, originalSegments.length);

    let bestIndex = 0;
    let bestScore = -1;

    for (let index = 0; index < originalSegments.length; index += 1) {
        const originalSegment = originalSegments[index];
        const originalMidRatio = ((originalSegment.start + originalSegment.end) / 2) / originalLength;
        const originalSpanRatio = (originalSegment.end - originalSegment.start) / originalLength;

        const positionScore = 1 - Math.min(1, Math.abs(displayMidRatio - originalMidRatio));
        const lengthScore = 1 - Math.min(1, Math.abs(displaySpanRatio - originalSpanRatio) * 2);
        const score = (positionScore * 0.55) + (lengthScore * 0.3) + (countSimilarity * 0.15);

        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }

    let confidence = Math.max(0, Math.min(1, bestScore * countSimilarity));
    if (countSimilarity < 0.5) {
        confidence *= 0.65;
    }

    return {
        index: bestIndex,
        confidence: Math.max(0, Math.min(1, confidence))
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

    const textNodes = collectBoundaryTextNodes(blockSnapshot.boundaryElement);
    if (textNodes.length === 0) {
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

    return {
        displayText,
        nodeRanges,
        totalLength: displayText.length
    };
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

function getOriginalSegmentFromClick(clientX, clientY) {
    const caret = getCaretInfoFromPoint(clientX, clientY);
    if (!caret || !(caret.node instanceof Text)) return '';

    const textNodeSnapshot = textNodeSnapshots.get(caret.node);
    const boundaryElement = textNodeSnapshot?.blockElement
        || getBlockBoundaryElement(caret.node.parentElement);
    if (!boundaryElement) return '';

    const blockSnapshot = blockSnapshots.get(boundaryElement);
    if (!blockSnapshot) return '';

    const projection = buildBlockDisplayProjection(blockSnapshot);
    if (!projection || projection.displayText.trim().length === 0) return '';

    const targetNodeRange = projection.nodeRanges.find((item) => item.node === caret.node);
    if (!targetNodeRange) return '';

    const nodeTextLength = (caret.node.nodeValue || '').length;
    const safeCaretOffset = Math.max(0, Math.min(caret.offset, nodeTextLength));
    const displayOffset = targetNodeRange.start + safeCaretOffset;

    const displaySegments = splitTextIntoSegments(projection.displayText);
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

        const displaySegments = splitTextIntoSegments(projection.displayText);
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
    teardownNavigationObservers();

    if (navigationPreprocessTimer !== null) {
        window.clearTimeout(navigationPreprocessTimer);
        navigationPreprocessTimer = null;
    }

    allowSnapshotForceRefreshUntil = 0;
}

function startHeavyProcessing(forceRefresh = false) {
    setupMutationObserver();
    setupNavigationObservers();
    runFullPreprocess(forceRefresh);
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

document.addEventListener('click', (event) => {
    if (!featureEnabled) {
        hideTooltip();
        return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;

    const text = getOriginalSegmentFromClick(event.clientX, event.clientY);
    if (text) {
        showTooltip(text, event.clientX, event.clientY);
    } else {
        hideTooltip();
    }
});

document.addEventListener('mouseup', (event) => {
    if (!featureEnabled) {
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
    } else {
        hideTooltip();
    }
});

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

        sendResponse({ ok: true, enabled: featureEnabled });
        return;
    }

    if (message.type === 'BTV_PREPROCESS_NOW') {
        runFullPreprocess(true);
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