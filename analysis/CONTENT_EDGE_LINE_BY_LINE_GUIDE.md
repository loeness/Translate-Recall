# Translate Recall - Content.edge.js 完整逐行梳理指南 (v2.0)

> **本文档采用源代码顺序法，从第 1 行到当前版本的完整脚本（约 4100+ 行）逐个分析每个函数、每个设计决策、每个算法的思考方式。** 不仅展现代码是什么，更重要的是为什么这样设计、这样做的好处是什么。

---

## 文档核心思路

### 这份文档会回答什么问题？

1. **WHAT（是什么）**：每个函数做什么、每行代码的含义
2. **WHY（为什么）**：为什么需要这个函数、为什么要这样设计
3. **HOW（怎么做）**：实现原理、算法细节、性能考量
4. **WHERE（在哪用）**：这个函数在整个系统中的位置、被谁调用
5. **TRADE-OFF（权衡）**：为什么选择这个方案而不是其他方案

### 核心问题：如何在翻译后的页面找到原文？

整个完整脚本代码的存在目的只有一个：**解决这个问题**

```
用户在翻译页面看到："你好，世界"
用户点击这个文本
脚本立即查询：这个翻译对应的原文是什么？
显示在悬浮窗："Hello, world"
```

这听起来很简单，但中间涉及：
- DOM 结构变化（翻译前后可能结构改变）
- 布局变化（翻译通常导致高度不同）
- 文本分割（需要找到精确匹配的段落）
- 性能考量（4000+ 行代码，用户感受不到卡顿）
- 鲁棒性（各种奇葩网站、各种翻译工具都要支持）

我们将一步步看到这个复杂系统如何从 1 行的 IIFE 开始，逐步构建出一个完整的解决方案。

---

## 快速导航

### 核心模块（按源代码顺序）
1. **第 1-12 行**：[IIFE 包装与防护机制](#第-1-12-行iife-包装与防护机制)
2. **第 13-76 行**：[常量配置系统](#第-13-76-行常量配置系统)
3. **第 71-127 行**：[全局变量声明](#第-71-127-行全局变量声明)
4. **第 129-300 行**：[基础工具函数](#第-129-300-行基础工具函数)
5. **第 302-650 行**：[DOM 路径与布局系统](#第-302-650-行dom-路径与布局系统)
6. **第 651-1100 行**：[文本分割与段落处理](#第-651-1100-行文本分割与段落处理)
7. **第 1101-1450 行**：[块边界与快照系统](#第-1101-1450-行块边界与快照系统)
8. **第 1451-1900 行**：[预处理与队列系统](#第-1451-1900-行预处理与队列系统)
9. **第 1901-2200 行**：[影子扫描与懒加载](#第-1901-2200-行影子扫描与懒加载)
10. **第 2201-2700 行**：[翻译状态与观察者](#第-2201-2700-行翻译状态与观察者)
11. **第 2701-3100 行**：[事件处理与命中检测](#第-2701-3100-行事件处理与命中检测)
12. **第 3101-3450 行**：[段落映射与评分](#第-3101-3450-行段落映射与评分)
13. **第 3451-3950 行**：[显示投影与交互](#第-3451-3950-行显示投影与交互)
14. **第 3951-4100+ 行**：[初始化与消息处理](#第-3951-4100-行初始化与消息处理)

---

## 第 1-12 行：IIFE 包装与防护机制

### 代码结构

```javascript
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
```

### 逐行分析
- **作用域隔离**：将所有变量和函数包装在闭包内，防止污染全局 namespace
- **避免变量冲突**：如果内容脚本被加载多次（某些浏览器环境），不会覆盖全局变量
- **性能优化**：局部变量查询速度比全局变量快

#### `CONTENT_RUNTIME_KEY = '__BTV_CONTENT_RUNTIME__'`

这个常量是一个唯一的全局标识符，用于在 `window` 对象上存储运行时状态。为什么用 `'__BTV_'` 前缀？
- `__` 双下划线表示这是内部使用的私有属性
- `BTV` 可能是项目名称（Bilingual Tooltip Vision 或类似）
- 这样可以避免与其他脚本的命名冲突

#### 重入保护机制

```javascript
const existingRuntime = window[CONTENT_RUNTIME_KEY];
if (existingRuntime && existingRuntime.initialized) {
    existingRuntime.lastPingAt = Date.now();
    return;  // 直接返回，不重复初始化
}
```

**为什么需要这个保护？**
- 在某些浏览器中（特别是 MV3 扩展），content script 可能被加载多次
- 如果不加保护，会创建多个观察者、事件监听器，导致：
  - 内存泄漏
  - 事件处理多次触发
  - 性能严重下降

**`lastPingAt` 的用途：**
- Popup 脚本通过发送 `BTV_PING` 消息检查 content script 是否存活
- 这个时间戳用于验证脚本是否还在运行

#### 运行时对象初始化

```javascript
window[CONTENT_RUNTIME_KEY] = {
    initialized: true,      // 标记已初始化
    startedAt: Date.now(),  // 记录启动时间（毫秒级）
    lastPingAt: Date.now()  // 记录最后一次 ping 的时间
};
```

这三个属性的用途：
- `initialized`：bool 标志，第二次加载时通过这个判断是否跳过初始化
- `startedAt`：用于调试，知道脚本运行了多久
- `lastPingAt`：Popup 定期检查这个时间，判断 content script 是否还活着

---

## 常量配置系统

### 第 14-42 行：标签与字符常量集合

```javascript
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'TEXTAREA', 'INPUT']);
```

**为什么这些标签要跳过？**
- `SCRIPT`：包含 JavaScript 代码，不应该翻译
- `STYLE`：CSS 代码，翻译没有意义
- `NOSCRIPT`：仅在禁用 JS 时显示，通常不需要翻译
- `PRE`：预格式化文本，翻译会破坏格式
- `TEXTAREA`：用户输入框，原始文本已经是用户输入
- `INPUT`：输入框，不应该处理其内容

```javascript
const BLOCK_BOUNDARY_TAGS = new Set([
    'P', 'LI', 'DT', 'DD', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'MAIN', 'DIV'
]);
```

**块边界的含义：**
- 这些标签代表"块级元素"，通常包含一个独立的逻辑单元（如一个段落、一个列表项）
- 系统将以这些块为单位进行原文快照和段落分割
- 这样可以避免跨块级元素的不合理切分

```javascript
const STRONG_END_CHARS = new Set(['。', '！', '？', '；', '.', '!', '?', ';']);
```

这些是**强句子结束符号**，意味着遇到这些字符时，一定要分割句子：
- 中文标点：。！？；
- 英文标点：. ! ? ;

```javascript
const COMMA_CHARS = new Set([',', '，', '、']);
```

逗号用于**条件分割**：
- `,`（英文逗号）
- `，`（中文逗号）
- `、`（中文顿号）
只有当句子足够长（>96 字符）时才在逗号处分割。

```javascript
const TRAILING_CLOSE_CHARS = new Set(['"', '\'', ')', ']', '}', '"', ''', '）', '】', '》', '」', '』']);
```

**尾部关闭字符**的作用：
- 当在句号处分割时，需要包含后面的这些字符
- 例如：`"Hello world."` 应该分割为 `"Hello world."` 而不是 `"Hello world"` 加上 `"."`

```javascript
const ABBREVIATION_TOKENS = new Set([
    'e.g.', 'i.e.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'vs.', 'etc.'
]);
```

这些是常见的缩写词，不应该在其内部分割。例如：
- 错误：`e.g.` 分成 `e.g` 和 `.`
- 正确：保持 `e.g.` 完整

```javascript
const INTERACTIVE_TAGS = new Set([
    'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL', 'SUMMARY', 'DETAILS'
]);
const INTERACTIVE_ROLES = new Set([
    'button', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option', 'combobox', 'slider'
]);
```

**交互元素**不应该处理，因为：
- 用户可能需要输入或交互
- 翻译这些元素的内容会影响交互体验

---

### 第 44-76 行：性能与行为参数

```javascript
const FEATURE_ENABLED_STORAGE_KEY = 'btvFeatureEnabled';
```

这是存储在 `chrome.storage.local` 中的键名，用于保存用户的启用/禁用偏好设置。

```javascript
const IS_EDGE_BROWSER = true;
const IS_CHROME_BROWSER = false;
const BROWSER_PROFILE = 'edge';
```

由于这是 `content.edge.js` 文件，所以硬编码 Edge 浏览器标识。这些标识符在代码各处用于：
- 调整性能参数
- 选择不同的 API（Edge 和 Chrome 的 API 有细微差异）
- 发送给 Popup 脚本的浏览器类型信息

```javascript
const CLICK_TEXT_HIT_PADDING = 2;
```

**点击命中的容差距离**：
- 用户点击的位置不一定完全在文字上
- 这个值表示允许 2px 的偏差
- 增加用户体验的容错性

```javascript
const NAVIGATION_FORCE_REFRESH_WINDOW_MS = IS_EDGE_BROWSER ? 1300 : 1800;
```

**导航后强制刷新的时间窗口**：
- 当页面导航（URL 改变）时，之前保存的原文快照失效
- 在这个时间窗口内（1300ms for Edge），对新加载的文本强制刷新
- Edge 设置比 Chrome 短 500ms，因为 Edge 通常加载速度更快

```javascript
const MIN_SEGMENT_CHARS = 8;
const MAX_SEGMENT_CHARS = 220;
```

段落长度的限制：
- 最小 8 个字符：避免过于碎片化的分割
- 最大 220 个字符：保证悬浮窗中显示的原文内容不会太长而难以阅读

```javascript
const COMMA_SPLIT_TRIGGER_CHARS = 96;
const LINE_BREAK_SPLIT_TRIGGER_CHARS = 140;
```

**分割触发阈值**：
- 当有效字符数 > 96 时，尝试按逗号分割
- 当行内字符数 > 140 时，允许按换行符分割
- 这样可以保持段落长度在合理范围

```javascript
const LOW_CONFIDENCE_THRESHOLD = 0.45;
```

**段落映射置信度阈值**：
- 当映射的置信度 < 0.45 时，不使用映射结果
- 转而尝试布局补偿或回退方案
- 这确保只显示有把握的原文

```javascript
const MAX_FALLBACK_CHARS = 320;
```

**悬浮窗最大显示字符数**：
- 如果原文超过 320 字符，截断并添加 `...`
- 防止悬浮窗过大影响页面布局

```javascript
const PREPROCESS_QUEUE_FLUSH_DELAY_MS = IS_EDGE_BROWSER ? 72 : 110;
const PREPROCESS_FLUSH_BATCH_SIZE = IS_EDGE_BROWSER ? 30 : 18;
const PREPROCESS_CHUNK_YIELD_MS = IS_EDGE_BROWSER ? 0 : 8;
```

**批量预处理的参数**：
- `PREPROCESS_QUEUE_FLUSH_DELAY_MS`：等待多久后批量处理队列中的任务
  - Edge: 72ms（更激进，快速处理）
  - Chrome: 110ms（更保守，让其他任务有机会）
  
- `PREPROCESS_FLUSH_BATCH_SIZE`：每次批处理多少个根节点
  - Edge: 30（更多任务）
  - Chrome: 18（更少，避免阻塞）
  
- `PREPROCESS_CHUNK_YIELD_MS`：处理一个批次后让出控制权多久
  - Edge: 0（Edge 性能好，不让出）
  - Chrome: 8ms（留给其他任务）

```javascript
const PRIORITY_SCAN_DOWNWARD_PX = 2000;
const PRIORITY_SCAN_UPWARD_PX = 240;
```

**优先级扫描范围**：
- 下方 2000px：用户通常向下滚动，预先处理下方内容
- 上方 240px：向上滚动时范围较小即可

```javascript
const VIEWPORT_PREWARM_ROOT_MARGIN = '1500px 0px';
```

**视口预热的提前触发距离**：
- 当元素距离视口还有 1500px 时就开始预处理
- 这样用户滚动到时已经准备好了
- 水平方向不预热（0px）

```javascript
const LAYOUT_ANCHOR_SELECTOR = 'img,svg,canvas,video,iframe,table,pre,code,[id],[data-testid],h1,h2,h3,h4,h5,h6';
```

**布局锚点选择器**：
- 这些元素通常在页面中位置相对固定
- 用于布局补偿时的参考点
- 例如：一个页面顶部的 logo 图片就是很好的锚点

---

### 第 78 行：Intl.Segmenter 的配置

```javascript
const sentenceSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
    : null;
```

**详细分析：**

这是对 `Intl.Segmenter` API 的智能包装，这个 API 用于按句子分割文本。

**为什么这样检查？**
1. `typeof Intl !== 'undefined'`：检查浏览器是否支持国际化 API
2. `typeof Intl.Segmenter === 'function'`：检查该浏览器是否支持 Segmenter
3. 如果都支持，创建一个实例；否则设为 null

**使用 undefined 语言的含义：**
```javascript
new Intl.Segmenter(undefined, { granularity: 'sentence' })
```
- `undefined` 表示使用浏览器的默认语言
- `granularity: 'sentence'` 表示按句子级别分割（不是按词）
- 这个 API 智能地识别各种语言的句子分界符

**后续的回退机制：**
在代码中如果 `sentenceSegmenter` 为 null，会使用 `getFallbackSentenceRanges()` 函数手工分割，这提供了老旧浏览器的支持。

---

## 全局变量声明

### 第 80-151 行：全局状态变量

```javascript
let tooltip = null;
```

悬浮窗容器的 DOM 引用。为什么用 `let` 而不是 `const`？
- 需要动态创建和销毁悬浮窗
- 某些情况下需要重新初始化

```javascript
let featureEnabled = false;
```

功能的启用/禁用状态。这个变量：
- 同步到 `chrome.storage.local`
- 控制所有重处理（观察者、预处理等）的启动/停止

```javascript
let lastKnownUrl = window.location.href;
```

用于检测 URL 变化。当用户：
- 点击链接导航到新页面
- 使用浏览器前进/后退
- 调用 `window.history.pushState()` 等

都需要重新初始化快照和观察者。

```javascript
let translationStateMode = 'unknown';
let translationStateSignature = '';
```

翻译态的追踪：
- `mode`：三种状态
  - `'unknown'`：初始状态，还未判断
  - `'original'`：页面为原始语言，未翻译
  - `'translated'`：页面已被翻译
  
- `signature`：完整的翻译状态特征，包含：
  - 翻译标志
  - HTML lang 属性
  - 类名
  - 属性值
  
**为什么需要 signature？**
有时 mode 不变（都是 translated），但页面布局改变（例如用户手动修改了 CSS），这时 signature 会变化，触发重新处理。

### 快照存储相关的全局变量

```javascript
let textNodeSnapshots = new WeakMap();
let blockSnapshots = new WeakMap();
let atomicOriginalTextByNode = new WeakMap();
```

**为什么使用 WeakMap？**
- DOM 节点被删除时，WeakMap 会自动清理引用
- 防止内存泄漏（普通 Map 会持久化节点）

```javascript
const layoutBlueprintIndex = new Map();
let layoutBlueprintByNode = new WeakMap();
```

这是对称的双索引：
- `layoutBlueprintIndex`：按 DOM 路径 key 索引，用于快速查找
- `layoutBlueprintByNode`：按节点对象索引，用于即时查询

使用 `const Map()` 而不是 `let new Map()` 是一个 bug（应该都用 let），但不影响功能。

```javascript
const pendingRoots = new Map();
const totalOriginalContentIndex = new Map();
const signatureToIndexKeys = new Map();
```

这些都是核心索引结构：
- `pendingRoots`：待处理的根节点队列
- `totalOriginalContentIndex`：所有已捕获原文的索引库
- `signatureToIndexKeys`：反向索引，从文本签名查找节点

---

## 工具函数 - 基础操作

### 第 153-179 行：ensureTooltip() - 悬浮窗初始化

```javascript
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
```

**逐行分析：**

```javascript
if (tooltip && tooltip.isConnected) {
    return tooltip;
}
```
- 如果悬浮窗已存在且仍连接到 DOM，直接返回
- `isConnected` 属性检查节点是否在文档中（如果用户刷新或页面重新加载，可能断开连接）

```javascript
if (!document.body) {
    return null;
}
```
- 页面初期可能还没有 body 元素
- 此时返回 null，让调用者处理

```javascript
tooltip = document.createElement('div');
tooltip.id = 'bilingual-tooltip';
```
创建容器，并指定 id，便于 CSS 定位和选择。

```javascript
tooltip.classList.add('notranslate');
tooltip.setAttribute('translate', 'no');
tooltip.setAttribute('lang', 'und');
```

**三重防护，防止浏览器翻译器翻译悬浮窗内容：**
1. `notranslate` class：Google Translate 和其他翻译工具识别的标志
2. `translate="no"` 属性：HTML5 标准属性
3. `lang="und"` 属性：设置为"未定义"语言，翻译器不会处理

这是非常重要的，因为：
- 用户是在翻译后的页面看悬浮窗
- 如果悬浮窗的原文被二次翻译，就毁了
- 例如："Hello" 被翻译成 "你好"，然后再被翻译成"你是否"，完全错误

```javascript
document.body.appendChild(tooltip);
return tooltip;
```
将悬浮窗添加到页面，并返回引用。

---

### 第 181-218 行：元素分类检查

```javascript
function hasInteractiveRole(element) {
    if (!(element instanceof Element)) return false;

    const roleAttr = element.getAttribute('role');
    if (!roleAttr) return false;

    return roleAttr
        .toLowerCase()
        .split(/\s+/)
        .some((role) => INTERACTIVE_ROLES.has(role));
}
```

**作用：** 检查元素是否具有交互性 ARIA role。

**为什么需要这个？**
某些元素虽然不是语义化的 `<button>`、`<input>` 等，但通过 `role` 属性被标记为交互元素，例如：
```html
<div role="button" tabindex="0">Click me</div>
```

**代码分析：**
- `roleAttr.split(/\s+/)`：一个元素可以有多个 role，用空格分隔
- `.some((role) => ...)`：只要有一个 role 是交互性的就返回 true

```javascript
function isInteractiveElement(element) {
    if (!(element instanceof Element)) return false;

    if (INTERACTIVE_TAGS.has(element.tagName)) return true;
    if (hasInteractiveRole(element)) return true;

    const contentEditable = element.getAttribute('contenteditable');
    return contentEditable && contentEditable.toLowerCase() !== 'false';
}
```

**综合检查三种交互元素：**
1. 语义标签（button、input 等）
2. ARIA role 标记
3. contenteditable 属性（用户可编辑的元素）

```javascript
function isHiddenElement(element) {
    if (!(element instanceof Element)) return false;

    if (element.closest('[hidden], [aria-hidden="true"]')) {
        return true;
    }

    const style = window.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden';
}
```

**检查元素是否隐藏，有三个来源：**
1. HTML `hidden` 属性
2. ARIA `aria-hidden="true"`
3. CSS 样式（display:none 或 visibility:hidden）

```javascript
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
```

**向上遍历 DOM 树，检查是否在交互元素内部。**

例如：
```html
<button>
  <span>Click me</span>  <!-- span 被认为在 button 内 -->
</button>
```

这样可以避免在按钮内部处理文本。

---

### 第 220-236 行：shouldSkipTextNode() - 文本节点过滤

```javascript
function shouldSkipTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest('#bilingual-tooltip')) return true;
    if (isInsideInteractiveContainer(parent)) return true;
    if (isHiddenElement(parent)) return true;
    return false;
}
```

**综合判断一个文本节点是否应该被跳过（不处理）。**

跳过的情况：
1. 父元素不存在（孤立的文本节点）
2. 父元素是被禁止的标签（script、style 等）
3. 在悬浮窗内（避免处理自己的内容）
4. 在交互元素内（用户输入的区域）
5. 隐藏的元素（用户看不到）

---

## DOM 路径与文本索引

### 第 238-259 行：getSiblingIndex() - 节点序号计算

```javascript
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
```

**作用：** 计算节点在其兄弟节点中的序号（XPath 风格）。

**为什么用这个方式计算？**
- XPath 中节点的索引是从 1 开始的（不是 0）
- 需要同时考虑节点类型和标签名

**例子：**
```html
<div>
  <p>Para 1</p>      <!-- p[1] -->
  <p>Para 2</p>      <!-- p[2] -->
  Text node
  <p>Para 3</p>      <!-- p[3] -->
</div>
```

当计算第二个 `<p>` 的序号时：
- 遍历所有兄弟节点
- 只计算相同类型和标签的节点
- 返回当前节点的序号

---

### 第 261-289 行：buildNodeDomPath() - 构建完整 DOM 路径

```javascript
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
```

**作用：** 为任何 DOM 节点生成唯一的路径标识符。

**格式示例：**
```
/html[1]/body[1]/div[2]/p[1]/text()[1]
     ↑                           ↑
   html元素              第一个文本节点
```

**为什么需要这个？**
- WeakMap 基于对象引用，不能序列化
- 需要一个字符串标识符来在页面刷新后恢复映射关系
- 这个路径在页面结构不变的情况下保持稳定

**逐行解析：**

```javascript
if (node === document.documentElement) {
    return '/html[1]';
}
```
特殊处理 html 元素，因为它没有父节点。

```javascript
const segments = [];
let cursor = node;

while (cursor && cursor !== document) {
    // 自下而上构建路径
}

return `/${segments.reverse().join('/')}`;
```
- 从目标节点开始，向上遍历到根
- 将每一层的标签和序号记录
- 最后反转顺序（因为是从下往上）并用 `/` 连接

---

### 第 291-305 行：文本签名与快速查找

```javascript
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
```

**作用：** 为文本内容生成一个特征签名，用于快速查询。

**设计原理：**

文本签名不是哈希（哈希会丢失信息），而是：
- 前 56 个字符
- 后 24 个字符
- 总长度
- 单词计数

**为什么这样设计？**
1. **前后缀**：如果文本被略微修改（例如添加或删除了中间的空格），前后缀仍然相同
2. **长度和词数**：提供额外的辨识度
3. **快速过滤**：多个文本可能有相同的前缀，但组合签名的重复概率很低

**例子：**
```
原文：     "This is a very long paragraph about something important"
签名：     "this is a very long paragraph about som|something important|55|10"
                ↑ 前 56 字符                    ↑ 后 24 字符
```

如果用户刷新页面，页面重新加载，虽然 DOM 路径可能改变，但文本内容（因此签名）保持不变，可以通过签名快速重新关联。

---

### 第 307-360 行：原文索引与查询

```javascript
function getIndexedOriginalTextFromNode(node) {
    if (!(node instanceof Node)) {
        return '';
    }

    // 第一优先级：原子绑定（最可靠）
    const atomicText = atomicOriginalTextByNode.get(node);
    if (atomicText) {
        return atomicText;
    }

    // 第二优先级：节点路径索引
    const key = nodeOriginalIndexKeys.get(node) || buildNodeDomPath(node);
    if (key) {
        const record = totalOriginalContentIndex.get(key);
        if (record && typeof record.originalText === 'string' && record.originalText.length > 0) {
            return record.originalText;
        }
    }

    // 第三优先级：块级回退
    if (node instanceof Text) {
        const boundary = getBlockBoundaryElement(node.parentElement);
        if (boundary) {
            const boundaryAtomic = atomicOriginalTextByNode.get(boundary);
            if (boundaryAtomic) {
                return boundaryAtomic;
            }

            const boundaryKey = nodeOriginalIndexKeys.get(boundary) || buildNodeDomPath(boundary);
            const boundaryRecord = boundaryKey ? totalOriginalContentIndex.get(boundaryKey) : null;
            if (boundaryRecord && boundaryRecord.originalText) {
                return boundaryRecord.originalText;
            }
        }
    }

    return '';
}
```

**作用：** 从各种来源查询一个节点的原文内容，具有三级回退机制。

**为什么需要三级？**

考虑这个场景：
1. 页面初期，用户未翻译：我们捕获了所有节点的原文
2. 用户触发翻译：节点的 textContent 现在是译文
3. 用户返回原始页面：需要找到之前保存的原文

三级回退确保总能找到原文：
- **Level 1**：原子绑定（最快、最可靠）
- **Level 2**：通过节点路径查询索引
- **Level 3**：查询块级元素的原文（最宽松的回退）

---

## 布局蓝图系统

### 第 402-470 行：布局测量与蓝图记录

```javascript
function measureElementLayoutInDocument(element) {
    if (!(element instanceof Element)) {
        return null;
    }

    const rect = element.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const height = Math.max(1, element.clientHeight || 0, rect.height || 0);
    return {
        top,
        height,
        bottom: top + height
    };
}
```

**作用：** 测量元素在文档坐标系中的位置。

**为什么是文档坐标而不是视口坐标？**
- 视口坐标会随着滚动改变
- 文档坐标是绝对的，适合比较

**计算细节：**
```javascript
const top = rect.top + window.scrollY;
```
- `rect.top`：元素距离视口顶部的距离
- `window.scrollY`：页面已滚动的距离
- 相加得到文档中的绝对位置

```javascript
const height = Math.max(1, element.clientHeight || 0, rect.height || 0);
```
- 使用 `clientHeight` 和 `rect.height` 的最大值
- 至少为 1（避免零高度导致后续计算错误）

---

### 第 472-549 行：布局蓝图的创建与更新

```javascript
function getLayoutBlueprintFrameForBoundary(boundaryElement) {
    if (!(boundaryElement instanceof Element)) {
        return null;
    }

    const now = Date.now();
    const frameByNode = layoutBlueprintByNode.get(boundaryElement);
    if (frameByNode) {
        frameByNode.lastSeenAt = now;
        return frameByNode;
    }

    const key = getIndexKeyForNode(boundaryElement);
    if (!key) {
        return null;
    }

    let frame = layoutBlueprintIndex.get(key);
    if (!frame) {
        frame = {
            key,
            selectorPath: buildNodeDomPath(boundaryElement),
            isAnchor: isLayoutAnchorBoundary(boundaryElement),
            originalTop: NaN,
            originalHeight: NaN,
            originalBottom: NaN,
            translatedTop: NaN,
            translatedHeight: NaN,
            translatedBottom: NaN,
            lastOriginalCaptureAt: 0,
            lastTranslatedCaptureAt: 0,
            lastSeenAt: now,
            source: ''
        };
        layoutBlueprintIndex.set(key, frame);
    }

    if (!frame.selectorPath) {
        frame.selectorPath = buildNodeDomPath(boundaryElement);
    }

    if (!frame.isAnchor) {
        frame.isAnchor = isLayoutAnchorBoundary(boundaryElement);
    }

    frame.lastSeenAt = now;
    layoutBlueprintByNode.set(boundaryElement, frame);
    return frame;
}
```

**作用：** 获取或创建一个块元素的布局蓝图。

**双层缓存的含义：**
```javascript
const frameByNode = layoutBlueprintByNode.get(boundaryElement);
if (frameByNode) {
    frameByNode.lastSeenAt = now;
    return frameByNode;  // 快速路径
}

let frame = layoutBlueprintIndex.get(key);  // 备用路径
```

为什么要有两层？
- `layoutBlueprintByNode`：对于当前存活的 DOM 节点，直接通过节点对象查询（最快）
- `layoutBlueprintIndex`：如果节点对象已被垃圾回收，通过 key 查询（备用）

**布局蓝图的初始化：**
```javascript
originalTop: NaN,
originalHeight: NaN,
...
```
初始值为 NaN，表示尚未捕获。只有在调用 `captureBoundaryLayoutBlueprint()` 时才会真正设置。

---

### 第 572-619 行：布局补偿核心算法

```javascript
function computeCompensatedOriginalY(pageY, boundaryFrame, anchorFrame) {
    let compensatedY = pageY;

    // 第一层补偿：块级拉伸比率
    if (
        boundaryFrame
        && Number.isFinite(boundaryFrame.originalTop)
        && Number.isFinite(boundaryFrame.translatedTop)
    ) {
        const stretchRatio = getLayoutStretchRatio(boundaryFrame);
        const localTranslatedOffset = pageY - boundaryFrame.translatedTop;
        compensatedY = boundaryFrame.originalTop + (localTranslatedOffset / stretchRatio);
    }

    // 第二层补偿：全局锚点偏移
    if (
        anchorFrame
        && Number.isFinite(anchorFrame.originalTop)
        && Number.isFinite(anchorFrame.translatedTop)
    ) {
        const anchorShift = anchorFrame.translatedTop - anchorFrame.originalTop;
        const anchoredY = pageY - anchorShift;
        if (!Number.isFinite(compensatedY)) {
            return anchoredY;
        }

        return (compensatedY * 0.68) + (anchoredY * 0.32);
    }

    return compensatedY;
}
```

**这是整个项目中最核心的算法之一。**

**问题背景：**

用户在 **译文页面** 点击，坐标 `pageY = 500px`。但我们需要找到对应的 **原文位置**。

原文和译文的高度可能完全不同：
```
原文：                   译文：
Line 1: "Hello"         Line 1: "你好"
Line 2: "World"         Line 2: "世界"
Line 3: "Test"          (共 2 行，原文 3 行)
```

**解决方案：** 两层补偿

#### 第一层：块级拉伸比率补偿

假设这个块在：
- 原文态：top=100, height=300
- 译文态：top=100, height=150

拉伸比率 = 150 / 300 = 0.5

用户点击译文的 `pageY=150`（在块内偏移 50px）：
```
原文位置 = 100 + (50 / 0.5) = 100 + 100 = 200
```

#### 第二层：全局锚点偏移补偿

但如果页面中有多个块，且它们的拉伸比率不同，第一层补偿可能不准确。

所以寻找最接近的**锚点块**（例如页面顶部的 header）：
```
锚点在原文：top=0
锚点在译文：top=0
anchorShift = 0 - 0 = 0
```

如果锚点偏移了（例如译文的 header 更大）：
```
anchorShift = 200 - 100 = 100px
```

最终位置是两个补偿的加权平均：
```javascript
return (compensatedY * 0.68) + (anchoredY * 0.32);
```
- 68% 权重给块级补偿（更精确）
- 32% 权重给锚点补偿（作为全局参考）

---

## 文本分割算法

这是项目最复杂的部分之一，需要详细讲解。

### 第 920-936 行：splitByBlankLines() - 段落分割

```javascript
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
```

**作用：** 按空白行分割文本成段落。

**正则表达式分析：**
```javascript
const blankLineRegex = /\n\s*\n+/g;
```
- `\n`：换行符
- `\s*`：可能的空格或制表符
- `\n+`：一个或多个换行符
- 匹配结果：两个或更多换行符之间的空白

**例子：**
```
Paragraph 1
（空行）
Paragraph 2
```

分割结果：
```
[
  { start: 0, end: 11 },    // "Paragraph 1"
  { start: 13, end: 24 }    // "Paragraph 2"
]
```

---

### 第 938-1002 行：sentence 分割

```javascript
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
```

**作用：** 使用 Intl.Segmenter 进行智能句子分割。

**Intl.Segmenter 的智能之处：**
```
Input: "Hello. Mr. Smith is here."
```

它能够识别：
- `Mr.` 不是句子结尾（这是缩写）
- 只在最后的 `.` 处分割

```javascript
for (const item of sentenceSegmenter.segment(paragraph)) {
    // item.segment = 实际的句子文本
    // item.index = 句子在段落中的起始位置
}
```

---

### 第 1004-1036 行：getFallbackSentenceRanges() - 回退分割

```javascript
function getFallbackSentenceRanges(text, start, end) {
    const ranges = [];
    let cursor = start;

    for (let index = start; index < end; index += 1) {
        const char = text[index];
        const shouldBreakByLine = char === '\n' && (index - cursor) >= LINE_BREAK_SPLIT_TRIGGER_CHARS;

        if (!shouldBreakByLine && !STRONG_END_CHARS.has(char)) {
            continue;  // 不是分割点，继续
        }

        if (char === '.' && isProtectedDot(text, index)) {
            continue;  // 这是缩写词的点，不分割
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
```

**作用：** 当 Intl.Segmenter 不可用时的回退方案。

**分割逻辑：**
1. 遍历每个字符
2. 如果遇到强结束符（`.`, `!`, `?`, `;` 等）且不是保护的点，分割
3. 或者遇到换行且足够长的段落，分割
4. 每个分割点后的尾部字符（`)`、`'` 等）也包含在分割内

---

### 第 1114-1195 行：mergeProtectedAndShortSentenceRanges() - 合并短句

```javascript
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
            previous.end = range.end;  // 合并到前一个范围
        } else {
            merged.push({ start: range.start, end: range.end });
        }
    });

    return normalizeRanges(text, merged);
}
```

**目的：** 将过短或不合理的句子段与前面的句子合并。

**何时合并：**
```javascript
function shouldMergeRanges(text, previousRange, currentRange) {
    const previousText = text.slice(previousRange.start, previousRange.end).trim();
    const currentText = text.slice(currentRange.start, currentRange.end).trim();

    if (!previousText || !currentText) {
        return true;  // 空句子，合并
    }

    if (endsWithProtectedAbbreviation(previousText)) {
        return true;  // 前一句以缩写结尾，合并（例如"e.g."）
    }

    if (/\d\.$/.test(previousText) && /^\d/.test(currentText)) {
        return true;  // 列表项（"1." "2." 等），保持合并
    }

    const mergedPreview = `${previousText}${currentText}`;
    if (isLikelyUrlEmailOrPath(mergedPreview)) {
        return true;  // 可能是 URL 被误分割
    }

    return isShortSegment(previousText);  // 前一句太短
}
```

**例子：**
```
分割结果：["Hello world.", "I am here."]
短句检测：["Hello.", "e.g.", "test"]
合并后：["Hello. e.g. test", "I am here."]
```

---

### 第 1197-1262 行：按逗号分割长句

```javascript
function splitRangesByCommaForLongSentences(text, ranges) {
    const result = [];

    ranges.forEach((range) => {
        const candidateText = text.slice(range.start, range.end);
        if (getEffectiveCharLength(candidateText) <= COMMA_SPLIT_TRIGGER_CHARS) {
            result.push({ start: range.start, end: range.end });
            return;  // 太短，不分割
        }

        const splitRanges = splitSingleRangeByComma(text, range.start, range.end);
        splitRanges.forEach((splitRange) => result.push(splitRange));
    });

    return normalizeRanges(text, result);
}
```

**目的：** 对超过 96 个字符的句子，尝试按逗号进一步分割。

**例子：**
```
原句：
"The cat, which was very large, ran quickly across the field, jumping over the fence."
（有效字符数：> 96）

按逗号分割后：
"The cat"
"which was very large"
"ran quickly across the field"
"jumping over the fence"
```

---

### 第 1309-1395 行：最大长度限制

```javascript
function splitRangeByMaxLength(text, start, end, outputRanges) {
    let cursor = start;

    while (cursor < end) {
        const remainingText = text.slice(cursor, end);
        if (getEffectiveCharLength(remainingText) <= MAX_SEGMENT_CHARS) {
            pushNormalizedRange(outputRanges, text, cursor, end);
            break;  // 足够短了，添加并退出
        }

        const target = Math.min(end - 1, cursor + MAX_SEGMENT_CHARS);
        let breakIndex = findBestBreakBackward(text, cursor, target);

        if (breakIndex === -1 || breakIndex <= cursor) {
            breakIndex = findBestBreakForward(text, target, end);
        }

        if (breakIndex === -1 || breakIndex <= cursor) {
            breakIndex = Math.min(end - 1, target);  // 强制截断
        }

        const boundary = extendBoundaryTail(text, breakIndex + 1, end);
        if (boundary <= cursor) {
            break;  // 陷入死循环，退出
        }

        pushNormalizedRange(outputRanges, text, cursor, boundary);
        cursor = boundary;
    }
}
```

**目的：** 确保没有句子超过 220 个字符。

**最优断点搜索策略：**
1. **向后搜索**（`findBestBreakBackward`）：从目标位置向前寻找最近的好断点
   - 优先级：逗号 > 分号 > 冒号 > 空格
2. **向前搜索**（`findBestBreakForward`）：如果向后没找到，向前搜索
3. **强制截断**：如果都没找到，按最大长度截断

**为什么分主要和辅助断点？**
```
"This is a very, very long sentence with many words and clauses; it should be split"
                 ↑ 优先使用这个逗号
                                        ↑ 或这个分号
                                                                     ↑ 再不行就按字符数
```

---

## 块边界识别

### 第 1443-1464 行：getBlockBoundaryElement()

```javascript
function getBlockBoundaryElement(fromElement) {
    if (!fromElement) {
        return document.body || document.documentElement || null;
    }

    let cursor = fromElement;
    while (cursor) {
        if (isInteractiveElement(cursor)) {
            cursor = cursor.parentElement;
            continue;  // 跳过交互元素，继续向上
        }

        if (cursor.tagName && BLOCK_BOUNDARY_TAGS.has(cursor.tagName)) {
            return cursor;  // 找到了块级标签
        }

        const display = window.getComputedStyle(cursor).display;
        if (display === 'block' || display === 'list-item' || display === 'table-cell') {
            return cursor;  // 按 CSS 的 display 属性识别
        }

        if (cursor === document.body || cursor === document.documentElement) {
            return cursor;  // 到达根节点
        }

        cursor = cursor.parentElement;
    }

    return document.body || document.documentElement || fromElement;
}
```

**作用：** 从一个元素向上遍历，找到第一个块级容器。

**为什么需要这个？**
在 SPA 应用中，块级容器可能不是语义化的 `<p>` 或 `<div>`，而是自定义组件：

```html
<ChatMessage className="custom-message">
  <span>Hello</span>
  <span>World</span>
</ChatMessage>
```

这个函数能找到 `ChatMessage` 作为块边界。

**搜索优先级：**
1. 明确的块标签（P, DIV, LI 等）
2. CSS 属性为 block 的元素
3. 根节点（body 或 html）

---

## 快照与预处理系统

### 第 1627-1681 行：buildBlockOriginalSnapshot()

```javascript
function buildBlockOriginalSnapshot(boundaryElement, textNodes, options = {}) {
    if (!boundaryElement || !Array.isArray(textNodes) || textNodes.length === 0) {
        return null;
    }

    const preservedOriginalText = typeof options.preservedOriginalText === 'string'
        ? options.preservedOriginalText.trim()
        : '';

    let liveText = '';
    const nodeRanges = [];

    // 第一步：拼接所有文本节点
    textNodes.forEach((textNode) => {
        const start = liveText.length;
        const value = textNode.nodeValue || '';
        liveText += value;
        const end = liveText.length;

        nodeRanges.push({
            node: textNode,
            start,
            end
        });
    });

    if (liveText.trim().length === 0) {
        return null;  // 没有实际内容
    }

    // 决定使用哪个原文版本
    const originalText = preservedOriginalText || liveText;

    // 第二步：分割成精细段落（逗号、最大长度等都考虑）
    const segments = splitTextIntoSegments(originalText);
    if (segments.length === 0) {
        return null;
    }

    // 第三步：分割成粗糙段落（仅按句号）
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
        indexedAt: Date.now(),
        usesPreservedOriginalText: Boolean(preservedOriginalText)
    };
}
```

**作用：** 为一个块级元素创建完整的原文快照。

**为什么需要粗细两种分割？**

- **细分割**（originalSegments）：用于精确匹配翻译后的段落
  - 考虑逗号分割、最大长度限制、短句合并
  - 结果可能是 5-10 个小句子
  
- **粗分割**（originalCoarseSegments）：用于回退
  - 仅按强结束符（句号）分割
  - 结果是 2-3 个大句子
  - 当精确匹配失败时使用

**例子：**
```
原文：
"Hello, my name is John. I am a developer; I write code daily."

细分割：
1. "Hello,"
2. "my name is John."
3. "I am a developer;"
4. "I write code daily."

粗分割：
1. "Hello, my name is John."
2. "I am a developer; I write code daily."
```

---

### 第 1683-1713 行：snapshotTextNode()

```javascript
function snapshotTextNode(textNode, blockSnapshot, nodeStart, nodeEnd) {
    if (!(textNode instanceof Text)) return;
    if (!blockSnapshot || !blockSnapshot.boundaryElement) return;

    // 为这个文本节点创建快照
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

    // 如果不是使用保存的原文，那么额外记住这个文本节点的原文
    if (blockSnapshot.usesPreservedOriginalText) {
        return;  // 已使用保存的原文，不需要单独记录
    }

    const originalNodeText = blockSnapshot.originalText.slice(nodeStart, nodeEnd);
    if (!originalNodeText) {
        return;
    }

    rememberOriginalContent(textNode, originalNodeText, {
        blockTag: blockSnapshot.blockTag,
        source: 'block-snapshot',
        force: false
    });
}
```

**作用：** 为块内的每个文本节点创建索引快照。

**为什么需要单独的文本节点快照？**

块快照记录的是整个块的原文，但当用户点击时，我们需要快速定位到那个特定的文本节点。

快照内容包含：
- 所属块的引用
- 在块内的起始和结束位置
- 块的所有分割段落

这样当处理点击时，可以：
1. 获取文本节点快照 → 找到所属块
2. 从块快照获取原文和分割 → 匹配翻译后的位置

---

### 第 1715-1785 行：preprocessBoundary() - 核心预处理

```javascript
function preprocessBoundary(boundaryElement, force = false) {
    if (!boundaryElement) return;

    const boundaryKey = getIndexKeyForNode(boundaryElement);

    // 缓存优化：如果已经处理过且不是强制刷新，直接返回
    if (!force && blockSnapshots.has(boundaryElement)) {
        if (boundaryKey) {
            liveSnapshotBoundaryKeys.add(boundaryKey);
        }
        return;
    }

    // 收集所有文本节点
    const textNodes = collectBoundaryTextNodes(boundaryElement);
    
    // 如果在翻译态且不是强制刷新，优先使用已保存的原文
    const shouldPreferIndexedOriginal = translationStateMode === 'translated' && !force;
    const preservedOriginalText = shouldPreferIndexedOriginal
        ? getIndexedOriginalTextFromNode(boundaryElement)
        : '';

    // 构建块快照
    const blockSnapshot = buildBlockOriginalSnapshot(boundaryElement, textNodes, {
        preservedOriginalText
    });

    if (!blockSnapshot) {
        return;
    }

    // 为每个文本节点创建快照
    let offsetInBlock = 0;
    for (const textNode of textNodes) {
        const originalNodeText = blockSnapshot.originalText.slice(
            offsetInBlock,
            offsetInBlock + (textNode.nodeValue?.length || 0)
        );
        
        snapshotTextNode(textNode, blockSnapshot, offsetInBlock, offsetInBlock + originalNodeText.length);
        offsetInBlock += originalNodeText.length;
    }

    // 存储块快照
    blockSnapshots.set(boundaryElement, blockSnapshot);
    liveSnapshotBoundaryKeys.add(boundaryKey);

    // 建立原文索引
    for (const segment of blockSnapshot.originalSegments) {
        const key = `${boundaryKey}|${segment.start}|${segment.end}`;
        totalOriginalContentIndex.set(key, {
            originalText: blockSnapshot.originalText.slice(segment.start, segment.end),
            boundaryElement,
            segmentIndex: blockSnapshot.originalSegments.indexOf(segment)
        });
    }
}
```

**这个函数的关键工作流：**

```
输入：块级元素
  ↓
1. 检查缓存（已预处理过吗？）
  ↓
2. 收集文本节点
  ↓
3. 决定使用哪个原文版本
  - 未翻译的页面：使用现有文本
  - 已翻译的页面：使用之前保存的原文（关键！）
  ↓
4. 创建块快照（分割、索引）
  ↓
5. 为每个文本节点创建快照（建立节点→块的映射）
  ↓
6. 建立全局索引（供查询使用）
```

**为什么这个设计如此重要？**

假设用户刷新页面的过程：

```
T = 0秒：用户访问英文页面
  └─ 脚本加载，preprocessBoundary() 被调用
  └─ 原文快照被创建并保存在 blockSnapshots 和 totalOriginalContentIndex

T = 2秒：用户点击浏览器翻译按钮
  └─ 页面被翻译，所有文本内容变成中文
  └─ DOM 节点对象本身没有变化（仍然是同样的 DOM 节点）
  └─ textNodeSnapshots 仍然指向这些节点，仍然包含原文信息！

T = 3秒：用户点击翻译页面上的文本
  └─ 脚本查询快照：
     1. 通过 DOM 节点找到快照（节点对象没变）
     2. 快照中包含原文
     3. 显示原文
```

这就是为什么 WeakMap 这么重要——即使页面被翻译，DOM 节点对象本身没变，我们的 WeakMap 仍然有效。

---

### 第 1787-1848 行：批量处理队列系统

**问题陈述：**

假设用户快速滚动页面，MutationObserver 在 2 秒内捕获了 10000 个节点变化。

**坏做法：** 立即处理每个变化
- 同步处理每个节点的预处理：50-100ms 每个
- 总耗时：500,000 - 1,000,000 ms
- 结果：用户体验卡顿，可能 10+ 秒没有响应

**我们的做法：** 批量处理 + 优先级调度

```javascript
const pendingRoots = new Map();  // 待处理的根节点队列
let flushTimer = null;           // 批处理定时器
let flushInProgress = false;     // 是否正在处理

function queueRootForPreprocess(root, force = false) {
    if (!root) return;

    const normalized = normalizeQueuedRoot(root);
    if (!normalized) return;

    if (!pendingRoots.has(normalized)) {
        pendingRoots.set(normalized, {
            root: normalized,
            force,
            addedAt: Date.now()
        });
    }

    schedulePendingRootsFlush();
}

function schedulePendingRootsFlush() {
    if (flushTimer !== null || flushInProgress) {
        return;  // 已经有处理在进行
    }

    // 延迟一段时间，让多个变化合并
    flushTimer = setTimeout(() => {
        flushPendingRootsInBatches();
    }, PREPROCESS_QUEUE_FLUSH_DELAY_MS);  // 72ms (Edge) 或 110ms (Chrome)
}

function flushPendingRootsInBatches() {
    flushInProgress = true;
    flushTimer = null;

    const roots = Array.from(pendingRoots.entries());

    // 每批处理固定数量的节点
    const batch = roots.slice(0, PREPROCESS_FLUSH_BATCH_SIZE);  // 30 (Edge) 或 18 (Chrome)

    for (const [normalized, info] of batch) {
        preprocessRoot(normalized, info.force);
        pendingRoots.delete(normalized);
    }

    // 如果还有待处理的，继续
    if (pendingRoots.size > 0) {
        setTimeout(() => {
            flushPendingRootsInBatches();
        }, PREPROCESS_CHUNK_YIELD_MS);  // 0 (Edge) 或 8 (Chrome)
    }

    flushInProgress = false;
}
```

**为什么这个参数设置这样调整？**

| 参数 | Edge | Chrome | 原因 |
|------|------|--------|------|
| FLUSH_DELAY_MS | 72 | 110 | Edge 更快，可以更快收集变化后立即处理 |
| BATCH_SIZE | 30 | 18 | Edge 性能更好，可以一次处理更多 |
| YIELD_MS | 0 | 8 | Edge 单线程性能好，不需要让出；Chrome 需要 8ms 让垃圾回收等其他任务运行 |

**处理时间线：**

```
事件        时间    说明
────────────────────────────────────────
用户快速滚动   0ms    MutationObserver 捕获 10000 个变化
               0ms    变化被添加到 pendingRoots，启动定时器
               ...
            72ms    定时器触发，开始处理
              ├─ 处理第 1-30 个根节点 (25ms)
              └─ 启动下一批定时器 (0ms yield)
            97ms    处理第 31-60 个根节点 (25ms)
           122ms    处理第 61-90 个根节点 (25ms)
           ...
          4300ms    最后一批完成

用户体感：
   - 0-72ms：快速滚动，页面响应
   - 72-4300ms：慢慢处理背景任务，用户不会感到卡顿
```

相比之下，如果同步处理，用户会在第一秒就感到明显的卡顿。

---

### 第 1850-2050 行：优先级预处理

**问题：** 页面加载后，有些块在视口内（用户能看到），有些在视口外（看不到）。

**解决方案：** 优先级处理

```javascript
function isBoundaryWithinPriorityRange(boundaryElement) {
    const rect = boundaryElement.getBoundingClientRect();
    const center = rect.top + rect.height / 2;

    // 视口内
    if (center >= -PRIORITY_SCAN_UPWARD_PX && center <= window.innerHeight + PRIORITY_SCAN_DOWNWARD_PX) {
        return true;
    }

    return false;
}

function preprocessRootWithPriority(root) {
    const boundaries = collectBlockBoundaries(root);

    // 分为两组
    const priority = [];
    const lowPriority = [];

    for (const boundary of boundaries) {
        if (isBoundaryWithinPriorityRange(boundary)) {
            priority.push(boundary);
        } else {
            lowPriority.push(boundary);
        }
    }

    // 立即处理高优先级
    for (const boundary of priority) {
        preprocessBoundary(boundary);
    }

    // 低优先级放入队列，缓慢处理
    for (const boundary of lowPriority) {
        queueBoundaryForLowPriorityScan(boundary);
    }
}
```

**优先级范围的可视化：**

```
                  ↑ 上方 240px (PRIORITY_SCAN_UPWARD_PX)
                  |
         ┌────────┴────────┐
         │  VIEWPORT AREA  │  用户能看到的区域
         │                 │
         └────────┬────────┘
                  |
                  ↓ 下方 2000px (PRIORITY_SCAN_DOWNWARD_PX)

处理策略：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
├─ 高优先级：立即处理，保证用户看到时已经准备好
└─ 低优先级：后台缓慢处理，用户滚动时逐步处理
```

---

### 第 2100-2250 行：影子扫描与动态内容

**问题：** 现代网站大量使用虚拟滚动、懒加载、无限滚动。

当用户向下滚动时，页面的 scrollHeight 不断增加。我们之前保存的布局补偿数据会逐步失效。

**解决方案：** 影子扫描

```javascript
function performSilentScrollProbe(pageY, pageX, actualScrollY) {
    const originalScrollY = window.scrollY;
    
    // 临时滚动到目标位置（但用户看不到）
    window.scrollTo(pageX, pageY);

    // 在这个位置找到所有块
    const elements = document.elementsFromPoint(pageX, window.innerHeight / 2);
    for (const element of elements) {
        const boundary = getBlockBoundaryElement(element);
        if (boundary && !blockSnapshots.has(boundary)) {
            // 找到未处理的块，立即预处理
            preprocessBoundary(boundary, true);
        }
    }

    // 立即恢复用户的滚动位置（看起来像什么都没发生）
    window.scrollTo(pageX, actualScrollY);
}

function runShadowScanCycle() {
    if (shadowScanInProgress) return;

    shadowScanInProgress = true;
    const startY = shadowScanCursor;

    // 扫描一个范围内的所有块
    // SHADOW_SCAN_STEP_PX = 560px 每次扫描的间隔
    // SHADOW_SCAN_MAX_STEPS_PER_CYCLE = 9 每个周期扫描 9 次
    
    for (let step = 0; step < SHADOW_SCAN_MAX_STEPS_PER_CYCLE; step++) {
        const currentY = startY + (step * SHADOW_SCAN_STEP_PX);
        
        if (currentY > getDocumentScrollHeight()) {
            break;  // 已到达底部
        }

        performSilentScrollProbe(currentY, window.scrollX, window.scrollY);
    }

    shadowScanCursor += SHADOW_SCAN_STEP_PX * SHADOW_SCAN_MAX_STEPS_PER_CYCLE;
    shadowScanInProgress = false;

    // 如果页面继续增长，继续扫描
    if (shadowScanNeedsRerun) {
        shadowScanNeedsRerun = false;
        scheduleShadowScan();
    }
}
```

**为什么叫"影子扫描"？**

我们"幽灵般"地滚动页面到各个位置，预先处理那些位置的内容，但用户完全看不到这个过程。这就像用影子的方式进行扫描。

**处理时间线：**

```
用户操作         脚本行为
─────────────────────────────────────────────
用户向下滚动      Scroll event 触发
                ├─ 处理当前视口内容
                └─ 启动影子扫描
                   ├─ 临时滚动到 currentY
                   ├─ 在那个位置预处理块
                   ├─ 恢复滚动位置 ← 用户感受不到！
                   └─ 继续下一个位置

用户继续滚动时    所有内容已经预处理好，响应迅速
```

---

### 第 2300-2500 行：翻译状态检测与观察者

**问题：** 脚本需要知道：用户是否启用了浏览器翻译？页面当前是原文还是译文？

**解决方案：** 双层检测

```javascript
function detectTranslationRenderState() {
    // 检测 1：className 中是否有 'translated' 标志
    const classMode = isTranslatedClassName(document.documentElement.className);

    // 检测 2：html lang 属性是否改变
    const htmlLangValue = document.documentElement.lang || '';
    const isLangChanged = htmlLangValue && htmlLangValue !== baselineDocumentLang;

    let mode = 'original';
    if (classMode === 'translated' || isLangChanged) {
        mode = 'translated';
    }

    // 生成完整特征（用于检测变化）
    const signature = JSON.stringify({
        classMode,
        htmlLang: htmlLangValue,
        bodyClassList: Array.from(document.body.classList),
        htmlAttrs: {
            class: document.documentElement.className,
            lang: document.documentElement.lang,
            'data-lang': document.documentElement.getAttribute('data-lang')
        },
        timestampMs: Date.now()
    });

    return { mode, signature };
}

function setupLifecycleObserver() {
    lifecycleObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                if (
                    mutation.attributeName === 'class' ||
                    mutation.attributeName === 'lang' ||
                    mutation.attributeName === 'data-lang'
                ) {
                    // 翻译状态可能改变了
                    scheduleTranslationStateEvaluation('lifecycle-mutation');
                    return;
                }
            }
        }
    });

    lifecycleObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'lang', 'data-lang'],
        attributeOldValue: true
    });
}

function handleTranslationModeTransition(oldMode, newMode, oldSignature, newSignature) {
    if (oldMode === 'original' && newMode === 'translated') {
        // 页面刚被翻译
        // 触发完整预处理，使用现在的翻译来映射
        runFullPreprocess();
    }

    if (oldMode === 'translated' && newMode === 'original') {
        // 页面翻译被禁用，恢复原文
        // 清理所有翻译状态相关的缓存
        clearTranslationRelatedCache();
    }

    if (oldMode === newMode && oldSignature !== newSignature) {
        // 状态没变，但页面布局改变了（例如 CSS 修改）
        // 更新布局蓝图
        refreshLayoutBlueprints();
    }
}
```

**为什么需要 signature 而不仅仅 mode？**

```
场景 1：用户启用浏览器翻译
  Mode: original → translated ✓ 检测到
  需要：重新预处理

场景 2：用户在已翻译的页面修改 CSS
  Mode: translated → translated (不变) ✗ 只看 mode 会错过！
  Signature: 改变 ✓ 检测到
  需要：重新计算布局补偿

场景 3：用户禁用翻译，翻译工具移除了 class，但留下了 data-lang 属性
  Mode: translated → original ✓ 可能检测到
  Signature: 改变 ✓ 双重确认
  需要：清理缓存
```

---

## 第 2700-3200 行：事件处理与命中检测

    // 构建快照
    const blockSnapshot = buildBlockOriginalSnapshot(boundaryElement, textNodes, {
        preservedOriginalText
    });
    if (!blockSnapshot) {
        blockSnapshots.delete(boundaryElement);
        blockDisplayProjectionCache.delete(boundaryElement);
        if (boundaryKey) {
            liveSnapshotBoundaryKeys.delete(boundaryKey);
        }
        return;  // 没有内容，清除快照
    }

    // 保存快照
    blockSnapshots.set(boundaryElement, blockSnapshot);
    blockDisplayProjectionCache.delete(boundaryElement);  // 清除显示投影缓存
    
    // 拍摄布局蓝图
    captureBoundaryLayoutBlueprint(boundaryElement, {
        source: force ? 'preprocess-force' : 'preprocess',
        captureOriginal: translationStateMode !== 'translated',
        captureTranslated: translationStateMode === 'translated',
        forceOriginal: force && translationStateMode !== 'translated'
    });

    // 记住块级原文
    rememberOriginalContent(boundaryElement, blockSnapshot.originalText, {
        blockTag: blockSnapshot.blockTag,
        source: 'boundary-snapshot',
        force
    });

    if (boundaryKey) {
        liveSnapshotBoundaryKeys.add(boundaryKey);
    }

    // 为每个文本节点创建快照
    blockSnapshot.nodeRanges.forEach((nodeRange) => {
        snapshotTextNode(nodeRange.node, blockSnapshot, nodeRange.start, nodeRange.end);
    });
}
```

**作用：** 为一个块元素做完整的原文快照处理。

**工作流：**
1. 检查缓存（已处理过则跳过）
2. 收集文本节点
3. 决定使用哪个原文（实时或保存）
4. 构建块快照
5. 拍摄布局蓝图（用于点击位置映射）
6. 记住块级和文本节点级的原文
7. 建立所有必要的索引

这是整个系统的核心——确保每个块和其包含的文本都被妥善快照和索引。

---

## 翻译状态管理

### 第 2325-2349 行：detectTranslationRenderState()

```javascript
function detectTranslationRenderState() {
    const html = document.documentElement;
    const body = document.body;

    const htmlLang = (html?.getAttribute('lang') || '').trim().toLowerCase();
    const htmlClass = html?.className || '';
    const bodyClass = body?.className || '';
    const htmlTranslate = (html?.getAttribute('translate') || '').trim().toLowerCase();
    
    // 信号 1：类名检查（Edge/Chrome 翻译器的标记）
    const hasTranslatedClass = isTranslatedClassName(htmlClass) || isTranslatedClassName(bodyClass);
    
    // 信号 2：翻译包装元素检查（translator 标签）
    const hasTranslateWrapper = Boolean(
        document.querySelector('font[style*="vertical-align: inherit"], span[style*="vertical-align: inherit"]')
    );
    
    // 信号 3：lang 属性变化
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
```

**作用：** 检测页面是否已被浏览器翻译。

**三信号融合：**

1. **类名检查**
   ```javascript
   const hasTranslatedClass = /\btranslated-(ltr|rtl)\b/i.test(className);
   ```
   Chrome/Edge 翻译器会添加 `translated-ltr` 或 `translated-rtl` 类

2. **标签检查**
   ```javascript
   document.querySelector('font[style*="vertical-align: inherit"]')
   ```
   翻译器包装被翻译的文本，使用特殊的 `<font>` 或 `<span>` 标签

3. **Lang 属性变化**
   ```javascript
   baselineDocumentLang !== currentLang
   ```
   翻译前 lang="en"，翻译后 lang="zh"

**为什么需要 signature？**

三个信号中任何一个变化都表示翻译态改变了。但有时三个都不变，只是布局改变（用户修改 CSS）。这时 signature 保持相同，但 mode 也保持不变，所以不会重新处理。

---

## 段落映射匹配

### 第 2879-3049 行：mapDisplaySegmentToOriginal()

这是最复杂的算法，用于将译文段落映射到原文。

```javascript
function mapDisplaySegmentToOriginal(displaySegments, originalSegments, displayIndex, displayText, originalText) {
    // 初始检查
    if (!Array.isArray(displaySegments) || !Array.isArray(originalSegments)) {
        return { index: -1, confidence: 0 };
    }

    // 特殊情况：段落数量相同
    if (displaySegments.length === originalSegments.length) {
        return {
            index: Math.min(displayIndex, originalSegments.length - 1),
            confidence: 0.98  // 非常高的置信度
        };
    }

    // 构建评分矩阵
    const countSimilarity = Math.min(displaySegments.length, originalSegments.length)
        / Math.max(displaySegments.length, originalSegments.length);

    const displayAnchors = buildCumulativeSegmentMetrics(displaySegments);
    const originalAnchors = buildCumulativeSegmentMetrics(originalSegments);

    // ... 详细的匹配逻辑 ...

    // 使用贪心算法从左到右匹配
    const assignedIndexes = new Array(displayAnchors.metrics.length).fill(0);
    const assignedScores = new Array(displayAnchors.metrics.length).fill(0);
    let previousAssignedIndex = 0;

    for (let index = 0; index < displayAnchors.metrics.length; index += 1) {
        // 为每个显示段落找最匹配的原文段落
        // ... 复杂的评分逻辑 ...
    }

    // 计算最终置信度
    // ... 多层置信度调整 ...

    return {
        index: mappedIndex,
        confidence: clampToUnit(confidence)
    };
}
```

**核心思想：**

这个函数使用一个二维评分矩阵：

```
       原文1  原文2  原文3
译文1   0.8   0.3   0.1
译文2   0.2   0.9   0.4
译文3   0.1   0.2   0.85
```

然后使用贪心算法从左到右匹配，找一条得分最高的"对角线路径"：

```
译文1 → 原文1 (0.8)
译文2 → 原文2 (0.9)
译文3 → 原文3 (0.85)
总得分 = 2.55
```

**评分包含多个因素：**
- 位置相近度（原译文段落的中心位置）
- 长度相似度（考虑语言间的扩展因子）
- 标点符号对齐
- 反向匹配（原文反过来找译文，确保一致性）

---

## 交互处理与事件绑定

### 第 3652-3708 行：handleDelegatedBodyClick()

```javascript
function handleDelegatedBodyClick(event) {
    // 检查 1：功能是否启用且在翻译态？
    if (!shouldServeTooltipInteractions()) {
        hideTooltip();
        return;
    }

    // 检查 2：用户是否正在选中文本？
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
        return;  // 不打扰选中操作
    }

    // 检查 3：点击目标是否被隐藏或禁用？
    const targetElement = event.target instanceof Text
        ? event.target.parentElement
        : (event.target instanceof Element ? event.target : null);
    if (targetElement && isElementSuppressedFromTooltip(targetElement)) {
        hideTooltip();
        return;
    }

    // 获取点击的块边界提示
    const boundaryHint = resolveBoundaryFromEventTarget(event.target);
    
    // 获取精确的点击文本命中
    const strictHit = getStrictTextHitFromPoint(event.clientX, event.clientY, boundaryHint);
    if (!strictHit) {
        hideTooltip();
        return;
    }

    // 查询原文
    const text = getOriginalSegmentFromClick(event.clientX, event.clientY, boundaryHint, strictHit);
    if (text) {
        showTooltip(text, event.clientX, event.clientY);
        return;
    }

    hideTooltip();
}
```

**逐步逻辑：**

1. **安全检查**：确保功能启用且在翻译态
2. **尊重选中**：如果用户在选中文本，不干扰
3. **隐藏元素检查**：不在被隐藏的元素上显示
4. **精确命中检测**：确保点击确实在文本上，而不是空白区域
5. **查询原文**：多层回退机制查找原文
6. **显示悬浮窗**：位置自动调整以避免遮挡

---

## 初始化与消息处理

### 第 3773-3815 行：Chrome 消息处理

```javascript
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
        return;
    }

    // 消息类型 1: BTV_PING (存活检查)
    if (message.type === 'BTV_PING') {
        const runtime = window[CONTENT_RUNTIME_KEY];
        if (runtime && typeof runtime === 'object') {
            runtime.lastPingAt = Date.now();  // 更新最后 ping 时间
        }

        sendResponse({ 
            ok: true, 
            enabled: featureEnabled, 
            browser: BROWSER_PROFILE 
        });
        return;
    }

    // 消息类型 2: BTV_PREPROCESS_NOW (立即预处理)
    if (message.type === 'BTV_PREPROCESS_NOW') {
        runFullPreprocess(true, { anchorY: window.scrollY });
        shadowScanCursorY = 0;
        observedScrollHeight = getDocumentScrollHeight();
        scheduleShadowScan(true);
        sendResponse({ ok: true, time: Date.now() });
        return;
    }

    // 消息类型 3: BTV_SET_ENABLED (设置启用状态)
    if (message.type === 'BTV_SET_ENABLED') {
        const enabled = Boolean(message.enabled);
        setFeatureEnabled(enabled, { forceRefresh: enabled });
        sendResponse({ ok: true, enabled: featureEnabled });
    }
});
```

**三种消息类型：**

1. **BTV_PING**：Popup 定期发送，检查 content script 是否还活着
   - 返回：启用状态、浏览器类型

2. **BTV_PREPROCESS_NOW**：用户在 Popup 点击"手动预处理"按钮时
   - 立即强制扫描所有内容并建立快照

3. **BTV_SET_ENABLED**：用户在 Popup 开启/关闭功能时
   - 启动或停止所有监听器和处理

---

### 第 3817-3826 行：初始化

```javascript
function initialize() {
    synchronizeFeatureState();  // 从 storage 读取启用状态
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();  // 如果 DOM 已加载，直接初始化
}

})();  // IIFE 结束
```

**初始化流程：**

1. **等待 DOM 就绪**
   - 如果脚本加载时 DOM 还在加载，监听 `DOMContentLoaded`
   - 如果 DOM 已加载，直接初始化

2. **同步功能状态**
   ```javascript
   function synchronizeFeatureState() {
       chrome.storage.local.get(FEATURE_ENABLED_STORAGE_KEY, (result) => {
           setFeatureEnabled(result[FEATURE_ENABLED_STORAGE_KEY] === true, { forceRefresh: true });
       });

       // 监听 storage 变化（用户在其他标签页改变设置）
       chrome.storage.onChanged.addListener((changes, areaName) => {
           if (areaName !== 'local' || !changes[FEATURE_ENABLED_STORAGE_KEY]) {
               return;
           }

           setFeatureEnabled(changes[FEATURE_ENABLED_STORAGE_KEY].newValue === true, { forceRefresh: true });
       });
   }
   ```

这确保：
- 首次加载时从 storage 恢复用户的偏好设置
- 如果用户在 Popup 改变设置，所有标签页都会同步更新

---

## 深度思考与最佳实践

### 为什么选择 WeakMap？

```javascript
let textNodeSnapshots = new WeakMap();
let blockSnapshots = new WeakMap();
```

**WeakMap 的优势：**
- **自动垃圾回收**：当 DOM 节点被删除时，WeakMap 的对应条目也自动删除
- **防止内存泄漏**：如果使用普通 Map，被删除的 DOM 节点仍会被引用，导致内存无法释放
- **页面性能**：随着用户浏览，旧的 DOM 节点被删除，内存自动回收

### 为什么需要两层索引？

```javascript
const layoutBlueprintIndex = new Map();     // 按 key 索引
let layoutBlueprintByNode = new WeakMap();  // 按节点索引
```

**理由：**
- `layoutBlueprintByNode`：对于当前存活的节点，通过对象引用查询最快
- `layoutBlueprintIndex`：如果节点对象已被垃圾回收，仍可通过 key 查询

这提供了两种不同的查询方式，提高了鲁棒性。

### 为什么区分原子绑定和索引查询？

```javascript
const atomicOriginalTextByNode = new WeakMap();  // 原子绑定
const totalOriginalContentIndex = new Map();     // 索引
```

**原子绑定**（atomicOriginalTextByNode）的含义：
- 在 **未翻译态** 首次为节点设置原文
- 之后即使节点的 textContent 改变为译文，atomicOriginalTextByNode 中的原文仍保持不变
- 这确保了原文的唯一性和准确性

**索引查询**（totalOriginalContentIndex）的作用：
- 当节点对象无法直接查询时的备用方案
- 基于 DOM 路径的长期存储
- 用于跨页面加载的恢复

---

## 总结

`content.edge.js` 是一个高度复杂但设计精妙的 Content Script，包含以下核心机制：

### 三大核心系统

1. **原文快照系统**
   - 在翻译前捕获所有原文内容
   - 建立多层索引（原子、路径、签名）
   - 支持翻译后的快速恢复

2. **布局补偿引擎**
   - 解决原文和译文高度差异的问题
   - 使用拉伸比率和锚点偏移进行补偿
   - 确保用户点击位置的精确映射

3. **段落映射算法**
   - 将译文段落智能匹配到原文
   - 使用多维评分矩阵和贪心匹配
   - 提供置信度评估和回退机制

### 关键设计模式

- **IIFE 包装**：隔离作用域，防止全局污染
- **WeakMap 应用**：自动内存管理
- **双层索引**：提高查询的鲁棒性
- **三级回退**：确保总能找到原文
- **信号融合**：多个征象确认翻译态
- **批量处理**：分批处理防止阻塞
- **观察者模式**：监听 DOM 和存储变化

### 性能优化

- 优先级扫描（视口优先）
- 视口预热（提前 1500px 触发）
- 阴影扫描（处理延迟加载）
- 批量队列（减少重排）
- 缓存机制（避免重复计算）

---

## 进一步阅读

如果你想深入理解某个部分，建议：

1. **文本分割算法**：理解 `splitTextIntoSegments()` 及其调用的五个嵌套函数
2. **布局补偿**：追踪 `getOriginalSegmentFromClick()` 到 `computeCompensatedOriginalY()`
3. **观察者系统**：研究 `setupMutationObserver()`, `setupLifecycleObserver()`, `setupViewportPrewarmObserver()`
4. **状态管理**：理解 `evaluateTranslationState()` 和 `handleTranslationModeTransition()`

每个部分都是整个系统中不可或缺的一环。

