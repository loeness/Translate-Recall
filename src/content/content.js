const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT']);
const CONTENT_ROOT_SELECTORS = ['article', 'main', '[role="main"]', '#content', '.content', '.article', '.post', '.entry-content'];
const DELIMITER_REGEX = /([,.;!?，。；！？\n]+)/g;

let tooltip = null;
const textNodeSnapshots = new WeakMap();
const pendingRoots = new Set();
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

function shouldSkipTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest('#bilingual-tooltip')) return true;
    return false;
}

function splitTextIntoSegments(text) {
    const parts = text.split(DELIMITER_REGEX);
    const segments = [];
    let cursor = 0;
    let pendingText = '';
    let pendingStart = -1;

    for (const part of parts) {
        if (!part) continue;

        const isDelimiter = /^[,.;!?，。；！？\n]+$/.test(part);
        if (isDelimiter) {
            if (pendingStart !== -1) {
                pendingText += part;
                segments.push({
                    text: pendingText,
                    start: pendingStart,
                    end: pendingStart + pendingText.length
                });
                pendingText = '';
                pendingStart = -1;
            }
            cursor += part.length;
            continue;
        }

        if (part.trim().length === 0) {
            cursor += part.length;
            continue;
        }

        if (pendingStart === -1) {
            pendingStart = cursor;
            pendingText = part;
        } else {
            pendingText += part;
        }
        cursor += part.length;
    }

    if (pendingStart !== -1 && pendingText.trim().length > 0) {
        segments.push({
            text: pendingText,
            start: pendingStart,
            end: pendingStart + pendingText.length
        });
    }

    return segments;
}

function snapshotTextNode(textNode, force = false) {
    if (!(textNode instanceof Text)) return;
    if (shouldSkipTextNode(textNode)) return;

    const text = textNode.nodeValue || '';
    if (text.trim().length === 0) return;

    if (!force && textNodeSnapshots.has(textNode)) return;

    const segments = splitTextIntoSegments(text);
    if (segments.length === 0) return;

    textNodeSnapshots.set(textNode, {
        originalText: text,
        originalSegments: segments,
        indexedAt: Date.now()
    });
}

function preprocessRoot(root, force = false) {
    if (!root) return;

    if (root.nodeType === Node.TEXT_NODE) {
        snapshotTextNode(root, force);
        return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
        return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        snapshotTextNode(current, force);
        current = walker.nextNode();
    }
}

function getPreprocessTargets() {
    const targets = [];

    for (const selector of CONTENT_ROOT_SELECTORS) {
        document.querySelectorAll(selector).forEach((el) => {
            if (!targets.includes(el)) {
                targets.push(el);
            }
        });
    }

    if (targets.length === 0) {
        if (document.body) {
            targets.push(document.body);
        } else {
            targets.push(document.documentElement);
        }
    }

    return targets;
}

function runFullPreprocess(force = false) {
    const targets = getPreprocessTargets();
    targets.forEach((target) => preprocessRoot(target, force));
}

function queueRootForPreprocess(root) {
    if (!root) return;
    pendingRoots.add(root);

    if (flushTimer !== null) return;

    flushTimer = window.setTimeout(() => {
        pendingRoots.forEach((queuedRoot) => preprocessRoot(queuedRoot, false));
        pendingRoots.clear();
        flushTimer = null;
    }, 120);
}

function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => queueRootForPreprocess(node));
            }

            if (mutation.type === 'characterData' && mutation.target instanceof Text) {
                const textNode = mutation.target;
                if (!textNodeSnapshots.has(textNode)) {
                    queueRootForPreprocess(textNode);
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });
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

function mapDisplayIndexToOriginalIndex(displayIndex, displayLength, originalLength) {
    if (originalLength === 0) return -1;
    if (displayLength === originalLength) return displayIndex;
    if (displayLength <= 1) return 0;

    const ratio = displayIndex / (displayLength - 1);
    return Math.min(originalLength - 1, Math.max(0, Math.round(ratio * (originalLength - 1))));
}

function getOriginalSegmentFromClick(clientX, clientY) {
    const caret = getCaretInfoFromPoint(clientX, clientY);
    if (!caret || !(caret.node instanceof Text)) return '';

    const snapshot = textNodeSnapshots.get(caret.node);
    if (!snapshot) return '';

    const displaySegments = splitTextIntoSegments(caret.node.nodeValue || '');
    if (displaySegments.length === 0) return '';

    let displayIndex = displaySegments.findIndex(
        (segment) => caret.offset >= segment.start && caret.offset < segment.end
    );

    if (displayIndex === -1) {
        displayIndex = Math.max(0, displaySegments.length - 1);
    }

    const originalIndex = mapDisplayIndexToOriginalIndex(
        displayIndex,
        displaySegments.length,
        snapshot.originalSegments.length
    );

    return snapshot.originalSegments[originalIndex]?.text || '';
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
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);

    let textNode = walker.nextNode();
    while (textNode) {
        const snapshot = textNodeSnapshots.get(textNode);
        if (!snapshot) {
            textNode = walker.nextNode();
            continue;
        }

        const displaySegments = splitTextIntoSegments(textNode.nodeValue || '');
        if (displaySegments.length === 0) {
            textNode = walker.nextNode();
            continue;
        }

        for (let index = 0; index < displaySegments.length; index += 1) {
            const displaySegment = displaySegments[index];
            const segmentRange = document.createRange();

            try {
                segmentRange.setStart(textNode, displaySegment.start);
                segmentRange.setEnd(textNode, displaySegment.end);
            } catch (_error) {
                continue;
            }

            if (!rangesIntersect(selectionRange, segmentRange)) continue;

            const originalIndex = mapDisplayIndexToOriginalIndex(
                index,
                displaySegments.length,
                snapshot.originalSegments.length
            );

            const text = snapshot.originalSegments[originalIndex]?.text;
            if (text && !seen.has(text)) {
                seen.add(text);
                originals.push(text);
            }
        }

        textNode = walker.nextNode();
    }

    return originals;
}

document.addEventListener('click', (event) => {
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
    if (!message || message.type !== 'BTV_PREPROCESS_NOW') {
        return;
    }

    runFullPreprocess(true);
    sendResponse({ ok: true, time: Date.now() });
});

function initialize() {
    runFullPreprocess(false);
    setupMutationObserver();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}