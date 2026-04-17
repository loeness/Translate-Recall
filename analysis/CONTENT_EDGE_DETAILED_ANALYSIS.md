# Translate Recall - Content.edge.js 详细技术分析

## 📋 目录
1. [架构概述](#架构概述)
2. [启动与初始化](#启动与初始化)
3. [核心数据结构](#核心数据结构)
4. [原文快照系统](#原文快照系统)
5. [布局补偿引擎](#布局补偿引擎)
6. [翻译状态管理](#翻译状态管理)
7. [文本分割算法](#文本分割算法)
8. [段落映射匹配](#段落映射匹配)
9. [交互与事件处理](#交互与事件处理)
10. [性能优化策略](#性能优化策略)

---

## 架构概述

### 核心设计哲学

这个 Content Script 的核心思想是：**在翻译前后两种状态下，建立完整的映射关系，使得用户点击译文时能准确反向查询到原文**。

整个架构可以分为三个层级：

```
┌─────────────────────────────────────────┐
│     交互层 (UI/Event Handling)           │
│  - 点击监听  - 划词聚合  - 悬浮窗展示    │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│    映射层 (Segment Mapping)              │
│  - 译文→原文段落转换  - 置信度评分      │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│    存储层 (Data Indexing)                │
│  - 快照存储  - 原文索引  - 布局蓝图     │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│     监听层 (Observer Layer)              │
│  - DOM 变化监听  - 视口预热  - 翻译态检测 │
└─────────────────────────────────────────┘
```

---

## 启动与初始化

### 1. 双重加载机制（重要！）

```javascript
// content.js 充当路由器，根据浏览器类型动态加载专用模块
const isEdgeBrowser = /\bEdg\//.test(userAgent);
const targetFile = isEdgeBrowser ? 'src/content/content.edge.js' : 'src/content/content.chrome.js';
import(chrome.runtime.getURL(targetFile))
```

**个人思考**：这里设计非常巧妙，避免了冗余代码。但是有一个潜在问题：
- 如果 import() 失败，用户无法得到友好提示
- 建议在实际项目中添加 error boundary 和回退机制

### 2. 运行时重入保护

```javascript
const CONTENT_RUNTIME_KEY = '__BTV_CONTENT_RUNTIME__';
const existingRuntime = window[CONTENT_RUNTIME_KEY];
if (existingRuntime && existingRuntime.initialized) {
    existingRuntime.lastPingAt = Date.now();
    return; // 防止重复加载
}
```

**关键点**：使用全局命名空间避免污染，同时防止多次加载导致的性能问题和内存泄漏。

---

## 核心数据结构

### 1. 快照体系

整个系统使用了 **两层快照机制**：

#### 第一层：文本节点快照 (`textNodeSnapshots: WeakMap`)

```javascript
textNodeSnapshots.set(textNode, {
    blockElement,           // 所属块元素
    blockTag,              // 块元素标签名
    fullOriginalText,      // 整个块的原文
    segments,              // 原文分割后的段落数组
    offsetInBlock,         // 该文本节点在块内的偏移
    nodeOriginalStart,     // 该节点对应原文的起始位置
    nodeOriginalEnd,       // 该节点对应原文的结束位置
    indexedAt              // 快照创建时间戳
});
```

**为什么用 WeakMap**：
- DOM 节点被删除时，WeakMap 会自动回收内存
- 避免因为快照导致的内存泄漏

#### 第二层：块元素快照 (`blockSnapshots: WeakMap`)

```javascript
blockSnapshots.set(boundaryElement, {
    boundaryElement,       // 块边界元素
    blockTag,             // 标签名
    originalText,         // 完整原文
    originalSegments,     // 精细分割（支持逗号拆分、最大长度限制）
    originalCoarseSegments, // 粗糙分割（仅按句号等分割）
    nodeRanges,           // 该块内所有文本节点的范围
    indexedAt,            // 快照创建时间
    usesPreservedOriginalText // 是否使用保存的索引原文
});
```

**个人理解**：
- `originalSegments` 用于精确匹配，细粒度
- `originalCoarseSegments` 用于回退，当精确匹配失败时使用
- 两层设计提供了**容错机制**

#### 第三层：原文索引 (`totalOriginalContentIndex: Map`)

```javascript
totalOriginalContentIndex.set(nodeKey, {
    key,                   // 节点的 DOM 路径
    nodeType,
    nodeName,
    blockTag,
    source,               // 来源标签：'scan', 'block-snapshot', 'boundary-snapshot'
    originalText,         // 原文内容
    latestText,           // 最近见到的文本（用于检测变化）
    signature,            // 文本签名（用于快速查询）
    firstCapturedAt,
    lastSeenAt            // 最后一次看到这个原文的时间
});

// 反向索引用于快速查询
signatureToIndexKeys.set(signature, new Set([key1, key2, ...]));
```

**个人想法**：这是系统的**核心**。当进入翻译态时，虽然 DOM 文本被改变为译文，但通过 DOM 路径或文本签名，仍能查到原文。这是 Translate Recall 的灵魂所在。

### 2. 布局蓝图系统 (`layoutBlueprintIndex: Map` + `layoutBlueprintByNode: WeakMap`)

```javascript
const layoutFrame = {
    key,                      // 节点的 DOM 路径
    selectorPath,            // 完整的 DOM XPath
    isAnchor,                // 是否为锚点（有 id、data-testid 等特征）
    
    originalTop,             // 原始状态的上边界位置（px）
    originalHeight,          // 原始状态的高度
    originalBottom,          // 原始状态的下边界
    
    translatedTop,           // 翻译后的上边界位置
    translatedHeight,        // 翻译后的高度
    translatedBottom,        // 翻译后的下边界
    
    lastOriginalCaptureAt,   // 最后一次捕获原始位置的时间
    lastTranslatedCaptureAt, // 最后一次捕获翻译位置的时间
    source                   // 数据来源
};
```

**核心算法**：布局拉伸比率
```javascript
const stretchRatio = translatedHeight / originalHeight;
// 例如：中文→英文，高度通常变为 0.5 ~ 0.7 倍
//      英文→中文，高度通常变为 1.5 ~ 3 倍
```

---

## 原文快照系统

### 1. 预处理流程 (`preprocessBoundary()`)

```
┌─────────────────────────┐
│ 收集块内所有文本节点      │ collectBoundaryTextNodes()
└────────────┬────────────┘
             │
┌────────────▼────────────┐
│ 构建块快照               │ buildBlockOriginalSnapshot()
│ - 拼接文本              │
│ - 分割段落              │
└────────────┬────────────┘
             │
┌────────────▼────────────┐
│ 记住原文内容             │ rememberOriginalContent()
│ - 快照存储              │
│ - 索引建立              │
└────────────┬────────────┘
             │
┌────────────▼────────────┐
│ 拍摄布局蓝图             │ captureBoundaryLayoutBlueprint()
│ - 记录位置信息          │
└─────────────────────────┘
```

**关键问题**：翻译态下的快照重建

当页面已翻译时，如果我们直接读取 `textNode.nodeValue`，得到的是 **译文**，不是原文。所以有三层回退：

```javascript
function getIndexedOriginalTextFromNode(node) {
    // 第一层：原子绑定（未翻译时保存）
    const atomicText = atomicOriginalTextByNode.get(node);
    if (atomicText) return atomicText;
    
    // 第二层：索引查询
    const key = nodeOriginalIndexKeys.get(node) || buildNodeDomPath(node);
    const record = totalOriginalContentIndex.get(key);
    if (record?.originalText) return record.originalText;
    
    // 第三层：块级回退
    const boundary = getBlockBoundaryElement(node.parentElement);
    const boundaryAtomic = atomicOriginalTextByNode.get(boundary);
    if (boundaryAtomic) return boundaryAtomic;
    
    return '';
}
```

**个人思考**：
- 原子绑定 (`atomicOriginalTextByNode`) 只在 `translationStateMode !== 'translated'` 时写入
- 这确保了原文只被捕获一次，之后的所有读取都来自该快照
- 这是防止翻译态污染原文索引的关键设计

### 2. 强制预处理机制

```javascript
// 导航后强制重新扫描
if (Date.now() <= allowSnapshotForceRefreshUntil) {
    queueRootForPreprocess(textNode, true);  // force = true
}

// 强制预处理会：
// 1. 忽略现有快照，重新构建
// 2. 强制更新原文索引
// 3. 重新拍摄布局蓝图
```

---

## 布局补偿引擎

这是整个系统最复杂的部分，用于解决 **同一文字位置在原文和译文中不同** 的问题。

### 1. 问题诊断

```
原始文本：「This is a great example」（23 字符）
翻译文本：「这是一个很好的例子」（11 字符）

用户点击译文的 "一个很好"
↓
需要反向映射到原文的 "is a great"
↓
但这两者的文字位置关系完全不同（长度比为 1:2.3）
```

### 2. 补偿算法

#### 第一步：找到包含该点击的块边界

```javascript
const boundaryElement = getBlockBoundaryElement(pointTarget);
const boundaryFrame = captureBoundaryLayoutBlueprint(boundaryElement, {
    captureTranslated: true,  // 翻译态下捕获当前位置
    captureOriginal: false
});
```

#### 第二步：计算拉伸比率和锚点偏移

```javascript
function computeCompensatedOriginalY(pageY, boundaryFrame, anchorFrame) {
    // 使用拉伸比率进行局部补偿
    const stretchRatio = getLayoutStretchRatio(boundaryFrame);
    const localTranslatedOffset = pageY - boundaryFrame.translatedTop;
    let compensatedY = boundaryFrame.originalTop + (localTranslatedOffset / stretchRatio);
    
    // 使用锚点进行全局补偿（权重 32%）
    if (anchorFrame) {
        const anchorShift = anchorFrame.translatedTop - anchorFrame.originalTop;
        const anchoredY = pageY - anchorShift;
        return (compensatedY * 0.68) + (anchoredY * 0.32);
    }
    
    return compensatedY;
}
```

**个人分析**：
- **拉伸比率补偿**（68%）：处理当前块内的高度变化
- **锚点补偿**（32%）：处理全局滚动偏移，利用最近的有 id/标记 的元素

这是一个 **两层补偿系统**：
1. 本地补偿：利用块内的高度差异
2. 全局补偿：利用页面级的参考点

#### 第三步：查找最接近的原始位置的块

```javascript
function findNearestLayoutFrameByOriginalY(originalY) {
    // 在所有已记录的块中，找距离该原始 Y 坐标最近的块
    for (const frame of layoutBlueprintIndex.values()) {
        if (originalY 在 [frame.originalTop, frame.originalBottom] 范围内) {
            return frame;  // 直接命中
        }
        // 否则计算距离，返回最近的
    }
}
```

### 3. 三级回退机制

```javascript
// 第一级：使用布局补偿找到的原文
const frameText = getLayoutFrameOriginalText(mappedFrame);
if (frameText) return frameText;

// 第二级：使用索引查询
const indexed = getIndexedOriginalTextFromNode(boundaryElement);
if (indexed) return indexed;

// 第三级：完全回退（返回空字符串，隐藏悬浮窗）
return '';
```

**个人想法**：这个设计非常保险，确保在任何情况下都不会显示错误的原文。宁可不显示，也不要误导用户。

---

## 翻译状态管理

### 1. 翻译态检测

系统通过以下 **多个信号** 来判断页面是否已翻译：

```javascript
function detectTranslationRenderState() {
    const html = document.documentElement;
    
    // 信号 1：HTML 标签的 lang 属性变化
    const hasLangShift = Boolean(
        baselineDocumentLang && 
        (html.getAttribute('lang') || '').trim().toLowerCase() !== baselineDocumentLang
    );
    
    // 信号 2：检测浏览器翻译标记（Edge/Chrome 翻译器）
    const hasTranslatedClass = /\btranslated-(ltr|rtl)\b/i.test(
        html.className || '' + body.className || ''
    );
    
    // 信号 3：检测翻译包装元素
    // Chrome/Edge 翻译器使用 <font> 或 <span style="vertical-align: inherit">
    const hasTranslateWrapper = Boolean(
        document.querySelector('font[style*="vertical-align: inherit"]')
    );
    
    // 综合判断
    const translated = hasTranslatedClass || hasTranslateWrapper || hasLangShift;
    
    return {
        mode: translated ? 'translated' : 'original',
        signature: [translated ? '1' : '0', htmlLang, ...].join('|')
    };
}
```

**为什么需要 signature**：
- 仅检测 mode 变化不够，有时 mode 不变但布局会改变
- 例如：用户手动修改 HTML 的 class，导致视觉变化但 mode 仍为 translated
- signature 能捕捉这些细微变化

### 2. 态转换处理

```
原始态 ──(检测到翻译)──> 翻译态
 │                        │
 │                        ├─ 清空旧快照（保留索引）
 │                        ├─ 重新扫描（使用已索引的原文）
 │                        ├─ 强制拍摄布局蓝图（翻译位置）
 │                        └─ 启动布局校准

翻译态 ──(检测到原文)──> 原始态
 │                        │
 │                        ├─ 清空旧快照（保留索引）
 │                        ├─ 强制预处理（重建原文快照）
 │                        └─ 启动闲置阴影扫描
```

**关键设计**：`preserveIndex = true`
```javascript
function handleTranslationModeTransition(previousMode, nextMode, reason) {
    // 清空快照但保留索引，因为原文不会改变
    clearOldSnapshots({ preserveIndex: true });
    
    // 重新构建快照
    rehydrateOriginalIndexReferences();  // 尝试恢复原有快照
    runFullPreprocess(false);
}
```

---

## 文本分割算法

这是系统中的核心算法之一，直接影响匹配精度。

### 1. 三层分割策略

```javascript
function splitTextIntoSegments(text, options = {}) {
    // 第 1 层：按空白行分割（段落级别）
    const paragraphRanges = splitByBlankLines(text);
    
    // 第 2 层：按句子分割
    const sentenceRanges = paragraphRanges.flatMap(para => 
        sentenceSegmenter ?
            getIntlSentenceRanges(text, para.start, para.end) :  // 使用 Intl.Segmenter（推荐）
            getFallbackSentenceRanges(text, para.start, para.end)  // 回退方案
    );
    
    // 第 3 层：精化处理
    let ranges = mergeProtectedAndShortSentenceRanges(sentenceRanges);
    
    if (enableCommaSplit) {
        ranges = splitRangesByCommaForLongSentences(ranges);
    }
    if (enableMaxLength) {
        ranges = enforceMaxLengthByPreferredBreaks(ranges);
    }
    if (enableTinyMerge) {
        ranges = mergeTinyRanges(ranges);
    }
    
    return ranges;
}
```

### 2. 保护机制

分割算法有多个保护机制，防止在不恰当的地方切分：

#### 保护缩写词

```javascript
const ABBREVIATION_TOKENS = new Set([
    'e.g.', 'i.e.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.'
]);

function endsWithProtectedAbbreviation(text) {
    // 检测是否以常见缩写结尾
    // 避免在 "e.g." 处切分导致 "e.g" 和 "." 分离
}

function isProtectedDot(text, index) {
    // 保护：数字中的点（如 3.14）
    // 保护：缩写词中的点
    // 保护：URL 或邮箱地址中的点
}
```

#### 保护 URL/邮箱

```javascript
function isLikelyUrlEmailOrPath(snippet) {
    return /(https?:\/\/|www\.)\S+/i.test(snippet)
        || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(snippet)
        || /[A-Za-z]:\\[^\s]+/.test(snippet);
}

// 在选择切分点时，避免在 URL 中间切分
if (isLikelyUrlEmailOrPath(nearbySnippet)) {
    continue;  // 跳过这个候选切分点
}
```

#### 安全的逗号边界检测

```javascript
function isSafeCommaBoundary(text, index, start, end, cursor) {
    if ((index - cursor) < MIN_SEGMENT_CHARS) {
        return false;  // 段落太短
    }
    
    if (index + 1 >= end) {
        return false;  // 逗号在末尾
    }
    
    const prevChar = text[index - 1];
    const nextChar = text[index + 1];
    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
        return false;  // 数字分隔符（如 1,000）
    }
    
    // 避免在 URL/邮箱中切分
    return !isLikelyUrlEmailOrPath(nearbySnippet);
}
```

### 3. 长句子处理

```javascript
// 当有效字符数 > 96 时，尝试按逗号拆分
if (getEffectiveCharLength(candidateText) > COMMA_SPLIT_TRIGGER_CHARS) {
    splitRanges = splitSingleRangeByComma(text, ...);
}

// 当句子长度 > 220 字符时，按最优断点截断
function splitRangeByMaxLength(text, start, end, outputRanges) {
    while (cursor < end) {
        if (getEffectiveCharLength(remaining) <= MAX_SEGMENT_CHARS) {
            break;  // 足够短了
        }
        
        // 寻找最优断点
        let breakIndex = findBestBreakBackward(text, cursor, target);
        if (breakIndex === -1) {
            breakIndex = findBestBreakForward(text, target, end);
        }
        if (breakIndex === -1) {
            breakIndex = target;  // 没有好的断点，强制截断
        }
    }
}
```

**个人想法**：
- 三层分割看似复杂，实际上是多个 **单一职责** 的算法组合
- 粗分割（按句号）→ 细分割（按逗号、行长） → 合并（短句合并）
- 这样即使任何一层有缺陷，其他层也能补救

---

## 段落映射匹配

这是匹配 **显示文本的第 N 段** 到 **原文的第 M 段** 的核心算法。

### 1. 映射计算流程

```javascript
function mapDisplaySegmentToOriginal(
    displaySegments,      // 译文分割后的段落数组
    originalSegments,     // 原文分割后的段落数组
    displayIndex,         // 用户点击的是译文的第几段
    displayText,          // 译文完整文本
    originalText          // 原文完整文本
) {
    // Step 1：计算膨胀因子（英文→中文时的长度比例）
    const expansionFactor = computeExpansionFactor(displayText, originalText, ...);
    
    // Step 2：为每个段落构建累积指标
    const displayMetrics = buildCumulativeSegmentMetrics(displaySegments);
    const originalMetrics = buildCumulativeSegmentMetrics(originalSegments);
    
    // Step 3：构建候选打分矩阵
    const candidateScores[i][j] = scoreDisplayToOriginalCandidate(
        displayMetrics[i],
        originalMetrics[j],
        { expansionFactor, countSimilarity, ... }
    );
    
    // Step 4：Greedy 匹配（从左到右）
    for (let displayIdx = 0; displayIdx < displayMetrics.length; displayIdx++) {
        let bestScore = -1;
        let bestOriginalIdx = 0;
        
        for (let originalIdx = previousMatchIdx; originalIdx < originalMetrics.length; originalIdx++) {
            let adjustedScore = candidateScores[displayIdx][originalIdx];
            
            // 应用各种调整
            adjustedScore -= jumpPenalty(displayIdx - previousMatchIdx);
            adjustedScore += mergeBonus();  // 如果当前段应该与前一段合并
            adjustedScore += lookaheadBonus();  // 看下一段的分数
            
            if (adjustedScore > bestScore) {
                bestScore = adjustedScore;
                bestOriginalIdx = originalIdx;
            }
        }
        
        assignedIndexes[displayIdx] = bestOriginalIdx;
        assignedScores[displayIdx] = bestScore;
        previousMatchIdx = bestOriginalIdx;
    }
}
```

### 2. 核心打分函数

```javascript
function scoreDisplayToOriginalCandidate(displayMetric, originalMetric, options) {
    // 权重分配（总和 = 1）
    
    // 位置匹配 (centerScore: 23%)
    const centerDistance = abs(display.centerRatio - original.centerRatio);
    const centerScore = 1 - min(1, centerDistance * 2.4);
    
    // 边界匹配 (edgeScore: 17%)
    const edgeScore = 1 - min(1, (startDist + endDist) / 2 * 2.1);
    
    // 重叠度 (overlapScore: 8%)
    const overlapScore = getRangeOverlapRatio(display, original);
    
    // 长度匹配 (lengthScore: 20%)
    // 特殊处理：如果长度差异很大（< 52%），进一步降权 (× 0.7)
    const expectedLength = display.length * expansionFactor;
    const lengthScore = 1 - min(1, abs(diff) / max(expected, actual));
    
    // 反向指标 (reverseScore: 14%)
    // 以原文位置反向查找，应该能找到该显示段
    const reverseCenterScore = 1 - min(1, centerDistance * 2.6);
    
    // 标点对齐 (punctuationScore: 18%)
    // "？" 匹配 "?" 得 1 分；一强一无得 0.1 分；都无得 0.55 分
    
    // 最终得分
    let score = (centerScore * 0.23)
        + (edgeScore * 0.17)
        + (overlapScore * 0.08)
        + (lengthScore * 0.2)
        + (reverseScore * 0.14)
        + (punctuationScore * 0.18)
        + (countSimilarity * 0.05);
    
    // 额外加成
    if (display.punctuation === '?' && original.punctuation === '?') {
        score += 0.15;  // 问号有强指导作用
    }
    
    return clamp(score);
}
```

**个人分析**：
- **为什么权重是这样分布的**？
  - 位置（23%）+ 反向（14%）= 37% 强调空间位置
  - 长度（20%）处理英中转换的长度差异
  - 标点（18%）利用文本结构特征
  - 重叠（8%）提供额外保险

- **两个特殊处理**：
  1. 长度得分在 < 52% 时额外降权：防止长度畸形的匹配
  2. 问号（?）额外加 0.15：问号几乎不会改变，是最强信号

### 3. Greedy Merge Support

```javascript
// 如果显示段落数 > 原文段落数（说明可能有合并）
if (displaySegments.length > originalSegments.length) {
    // 检查当前段是否应该与前一段合并指向同一原文段
    const mergeSupportScore = getMergeSupportScore(
        previousDisplayMetric,
        currentDisplayMetric,
        originalMetric
    );
    
    adjustedScore += mergeSupportScore * 0.2;
}
```

这解决了一个常见场景：**原文 3 句，译文 5 句**（翻译时某些句子被拆分了）

### 4. 置信度计算与回退

```javascript
if (mapping.confidence < LOW_CONFIDENCE_THRESHOLD) {  // 0.45
    // 置信度不足，尝试布局补偿
    const compensated = getLayoutCompensatedOriginalTextFromClick(...);
    if (compensated) {
        return compensated;  // 用布局补偿的结果
    }
    
    // 如果布局补偿也失败，使用粗粒度回退
    return chooseFallbackOriginalText(blockSnapshot, mapping.index);
}
```

---

## 交互与事件处理

### 1. 点击事件处理

```javascript
function handleDelegatedBodyClick(event) {
    // 检查 1：是否启用了功能？是否在翻译态？
    if (!shouldServeTooltipInteractions()) {
        hideTooltip();
        return;
    }
    
    // 检查 2：用户是否在选中文本？（选中时不显示悬浮窗）
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
        return;  // 不处理，允许正常复制流程
    }
    
    // 检查 3：目标元素是否被隐藏或禁用？
    const targetElement = event.target instanceof Text
        ? event.target.parentElement
        : (event.target instanceof Element ? event.target : null);
    if (targetElement && isElementSuppressedFromTooltip(targetElement)) {
        hideTooltip();
        return;
    }
    
    // 检查 4：获取精确的点击文本命中
    const boundaryHint = resolveBoundaryFromEventTarget(event.target);
    const strictHit = getStrictTextHitFromPoint(
        event.clientX,
        event.clientY,
        boundaryHint
    );
    
    if (!strictHit) {
        hideTooltip();
        return;
    }
    
    // 最后一步：获取原文段落
    const text = getOriginalSegmentFromClick(
        event.clientX,
        event.clientY,
        boundaryHint,
        strictHit
    );
    
    if (text) {
        showTooltip(text, event.clientX, event.clientY);
    } else {
        hideTooltip();
    }
}
```

**关键点**：使用 `strictHit` 确保用户确实点击在文本上，而不是空白区域。

### 2. 划词聚合

```javascript
function handleDelegatedBodyMouseUp(event) {
    const selection = window.getSelection();
    if (!selection || selection.toString().trim().length === 0) {
        return;  // 未选中任何文本
    }
    
    // 关键函数：从选区中收集所有的原文段落
    const originals = collectOriginalSegmentsFromSelection(selection);
    
    if (originals.length > 0) {
        // 用空格连接多个段落
        showTooltip(originals.join(' '), event.clientX, event.clientY);
    } else {
        hideTooltip();
    }
}

function collectOriginalSegmentsFromSelection(selection) {
    const selectionRange = selection.getRangeAt(0);
    const originals = [];
    const seen = new Set();  // 去重
    
    // Step 1：找出所有与选区重叠的块边界
    const candidateBlocks = new Set();
    const walker = document.createTreeWalker(...);
    
    let textNode = walker.nextNode();
    while (textNode) {
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(textNode);
        
        // 检查是否与选区相交
        if (rangesIntersect(selectionRange, nodeRange)) {
            candidateBlocks.add(boundaryElement);
        }
        
        textNode = walker.nextNode();
    }
    
    // Step 2：对每个相交的块，逐段检查
    candidateBlocks.forEach(blockElement => {
        const projection = buildBlockDisplayProjection(blockSnapshot);
        const displaySegments = projection.displaySegments;
        
        displaySegments.forEach((displaySegment, index) => {
            const segmentRange = createRangeFromProjection(projection, ...);
            
            // 检查该段是否与选区相交
            if (rangesIntersect(selectionRange, segmentRange)) {
                // 查找对应原文
                const mapping = mapDisplaySegmentToOriginal(...);
                
                if (mapping.confidence >= LOW_CONFIDENCE_THRESHOLD) {
                    const text = blockSnapshot.originalSegments[mapping.index]?.text;
                    if (text && !seen.has(text)) {
                        originals.push(text);
                        seen.add(text);
                    }
                }
            }
        });
    });
    
    return originals;
}
```

**个人想法**：
- 划词聚合的设计相当优雅
- 不是简单地连接选区内的所有文本，而是 **按段落级别** 智能聚合
- 即使用户的选区跨越了多个段落，也能准确提取

---

## 性能优化策略

### 1. 分层扫描系统

系统采用 **三层优先级** 来处理 DOM：

```javascript
function preprocessRootWithPriority(root, force, anchorY) {
    const boundaries = collectBlockBoundaries(root);
    const viewportHeight = window.innerHeight;
    
    // 第 1 优先级：视口及周边区域（立即处理）
    const priorityTop = anchorY - 240;           // 上方 240px
    const priorityBottom = anchorY + viewportHeight + 2000;  // 下方 2000px
    
    boundaries.forEach(boundary => {
        if (isBoundaryWithinPriorityRange(boundary, priorityTop, priorityBottom)) {
            preprocessBoundary(boundary, force);  // 同步处理
        } else {
            queueBoundaryForLowPriorityScan(boundary, force);  // 异步队列
        }
    });
    
    scheduleLowPriorityBoundaryFlush();
}

// 低优先级扫描在 requestIdleCallback 中执行
function flushLowPriorityBoundaries(deadline) {
    let processed = 0;
    
    for (const [boundary, force] of lowPriorityBoundaries.entries()) {
        if (processed >= LOW_PRIORITY_SCAN_BATCH_SIZE) break;
        
        // 检查剩余时间，避免卡顿
        if (deadline && deadline.timeRemaining() < 2) break;
        
        preprocessBoundary(boundary, force);
        processed++;
    }
    
    // 如果还有剩余，继续调度
    if (lowPriorityBoundaries.size > 0) {
        scheduleLowPriorityBoundaryFlush();
    }
}
```

**关键参数**（针对 Edge 优化）：
```javascript
const PRIORITY_SCAN_UPWARD_PX = 240;           // 上方预扫范围较小
const PRIORITY_SCAN_DOWNWARD_PX = 2000;        // 下方预扫范围较大
const LOW_PRIORITY_SCAN_BATCH_SIZE = 34;       // 批量大小
const LOW_PRIORITY_IDLE_TIMEOUT_MS = 140;      // 闲置超时
const PREPROCESS_CHUNK_YIELD_MS = 0;           // Edge 上不让出控制权（更快）
```

### 2. 视口预热 (Viewport Prewarm)

```javascript
function setupViewportPrewarmObserver() {
    viewportPrewarmObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                
                // 元素进入预热区时，立即触发 prewarm 捕获
                enqueueViewportPrewarmCapture(entry.target);
            });
        },
        {
            rootMargin: '1500px 0px'  // 垂直方向提前 1500px 触发
        }
    );
}
```

**为什么 1500px？**
- 用户通常以 60-120px/frame 的速度滚动
- 提前 1500px 给约 15-25 frames 的处理时间
- 确保用户滚动到时已经预处理完成

### 3. 阴影扫描 (Shadow Scan)

处理 **延迟加载** 和 **动态内容** 的问题：

```javascript
function runShadowScanCycle() {
    // 目的：通过静默滚动，触发延迟加载，然后预处理新内容
    
    const restoreX = window.scrollX;
    const restoreY = window.scrollY;
    let steps = 0;
    
    const runStep = () => {
        const currentHeight = getDocumentScrollHeight();
        const maxScrollY = currentHeight - viewportHeight;
        
        if (shadowScanCursorY > maxScrollY) {
            // 已扫描到页面底部
            finalize();
            return;
        }
        
        // 静默滚动到该位置
        performSilentScrollProbe(shadowScanCursorY, restoreX, restoreY);
        
        // 预处理新加载的内容
        runFullPreprocess(false, { anchorY: restoreY });
        
        shadowScanCursorY += SHADOW_SCAN_STEP_PX;  // 560px/step
        steps++;
        
        if (steps < SHADOW_SCAN_MAX_STEPS_PER_CYCLE) {  // 9 steps max
            window.setTimeout(runStep, SHADOW_SCAN_STEP_DELAY_MS);  // 26ms delay
        } else {
            finalize();
        }
    };
}
```

**参数设置**（针对 Edge）：
```javascript
const SHADOW_SCAN_STEP_PX = 560;              // 每步扫描 560px
const SHADOW_SCAN_MAX_STEPS_PER_CYCLE = 9;    // 最多 9 步
const SHADOW_SCAN_STEP_DELAY_MS = 26;         // 步间延迟
// 总覆盖：560 × 9 = 5040px，总耗时 26 × 9 ≈ 234ms
```

### 4. 内存管理

使用 WeakMap 自动回收：

```javascript
// 这些都是 WeakMap，DOM 节点被删除时自动回收
const textNodeSnapshots = new WeakMap();       // 文本节点快照
const blockSnapshots = new WeakMap();          // 块快照
const atomicOriginalTextByNode = new WeakMap();// 原子原文绑定
const layoutBlueprintByNode = new WeakMap();   // 布局蓝图（按节点）
```

**但是有一个手动清理机制**：

```javascript
function clearOldSnapshots(options = {}) {
    if (!options.preserveIndex) {
        // 保存索引（原文内容不变）
        totalOriginalContentIndex.clear();
        signatureToIndexKeys.clear();
        atomicOriginalTextByNode = new WeakMap();
        layoutBlueprintIndex.clear();
    }
    
    // 始终清空临时缓存
    blockDisplayProjectionCache = new WeakMap();
    textNodeSnapshots = new WeakMap();
    blockSnapshots = new WeakMap();
}
```

---

## 核心算法总结

| 算法 | 目的 | 复杂度 | 关键参数 |
|------|------|--------|---------|
| **文本分割** | 将段落拆分成句子 | O(n) | 最大长度 220 字符 |
| **段落映射** | 译文段→原文段 | O(m×n) | 膨胀因子、权重矩阵 |
| **布局补偿** | 点击位置映射 | O(k) | 拉伸比率、锚点偏移 |
| **快照重建** | 翻译态下恢复原文 | O(n) | 三层回退机制 |
| **阴影扫描** | 处理延迟加载 | O(h/560) | 步长、最大步数 |

---

## 个人思考与评价

### 优点

1. **极端的稳定性设计**
   - 三层回退机制确保永远不会显示错误信息
   - WeakMap 防止内存泄漏
   - 多信号融合判断翻译态

2. **精妙的数据结构**
   - 原子绑定：确保原文只被捕获一次
   - 双向索引：快速查询，支持回退
   - 布局蓝图：解决了最棘手的布局问题

3. **对浏览器差异的细致考量**
   - Edge vs Chrome 的不同参数优化
   - `requestIdleCallback` 的优雅 fallback
   - `Intl.Segmenter` 的 polyfill 支持

4. **交互体验**
   - 划词聚合很优雅
   - 悬浮窗自动定位避免遮挡
   - 选中文本时不干扰复制

### 缺点与改进建议

1. **代码体积太大**
   - 单个文件 4000+ 行，建议按功能拆分模块
   - 可考虑使用 Rollup + Tree-shaking 减少最终体积

2. **缺少错误恢复**
   ```javascript
   // 当快照系统崩溃时，应该有应急预案
   try {
       preprocessBoundary(boundary, force);
   } catch (error) {
       // 只是静默忽略，最好有上报或恢复机制
   }
   ```

3. **调试困难**
   - 没有中文注释，国内开发者难以理解
   - 建议补充详细的中文文档

4. **性能微调空间**
   - 阴影扫描的参数是硬编码的，不同网站需要不同配置
   - 建议使用机器学习预测最优参数

5. **特殊页面支持**
   - 不能处理 Shadow DOM 内的翻译内容
   - 不能处理 Canvas/WebGL 渲染的文字

---

## 总结

这个 Content Script 是一个 **工程水准很高的项目**：

- **理论基础** ⭐⭐⭐⭐⭐：从翻译的基本原理出发，设计了完整的映射系统
- **代码质量** ⭐⭐⭐⭐☆：逻辑清晰，但体积过大，缺乏模块化
- **性能优化** ⭐⭐⭐⭐⭐：分层扫描、视口预热、阴影扫描等都是业界一流的手段
- **容错能力** ⭐⭐⭐⭐⭐：三层回退、多信号融合，很难崩溃
- **用户体验** ⭐⭐⭐⭐☆：交互自然，但悬浮窗的拖拽能力还可以增强

最核心的创新是 **布局补偿算法** —— 它巧妙地利用拉伸比率和锚点偏移，在完全不同的布局下精确回映原文位置。这是 Translate Recall 的核心竞争力。
