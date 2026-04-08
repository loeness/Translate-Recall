# Translate Racall - v1.3.0

一个用于 Edge/Chrome 的 MV3 扩展：在页面翻译后，点击字词即可查看对应句的原语言文本。

## 演示动图

##### 开关选项（先开启原文显示，再点击手动预处理）

![Switch Demo GIF](assets/demo/switch_demo.gif)

##### 功能演示
![Click Demo GIF](assets/demo/click_demo.gif)


## 功能亮点

- 原生增强，零成本使用：无需配置 DeepL 或 OpenAI 等繁琐的 API 密钥，直接增强浏览器（Edge/Chrome）自带的免费翻译功能，主打一个省心省钱。
- 一键开关与状态持久化：弹窗新增“功能总开关”，设置会自动保存。关闭后点击/划词不再干扰阅读，设置跨页面、跨浏览器重启依然生效
- 翻译隔离保护：通过 DOM 隔离技术，确保悬浮窗内的原文不会被浏览器翻译器“二次翻译”回中文。
- 支持跨标签语义识别，插件现在可以识别带有格式（加粗、代码等）的完整句子。
- 完善逻辑，使用Greedy Merge Support，匹配更加准确。

## 目录结构

```text
Translate Racall/
├── manifest.json
├── _locales/
│   ├── en/messages.json
│   └── zh_CN/messages.json
├── assets/
│   ├── icons/
│   │   ├── icon16.png
│   │   ├── icon48.png
│   │   └── icon128.png
│   └── styles/
│       └── content.css
├── src/
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── content/
│   │   └── content.js
│   └── background/
│       └── .gitkeep
├── README.md
└── LICENSE
```

## 本地安装

1. 打开 `edge://extensions/` 或 `chrome://extensions/`
2. 开启「开发人员模式」
3. 点击「加载解压缩的扩展」
4. 选择本项目根目录

## 使用流程

1. 打开目标网页
2. 点击扩展图标，开启原文显示后在弹窗中执行「手动启用预处理」
3. 使用浏览器（Edge/Chrome）页面翻译功能
4. 翻译完成后，点击或划词查看原文


## 后续建议

- 待开发划词聚合功能：支持鼠标拖拽选择多行文字，插件会自动聚合选区内的所有原句，实现流畅的对比阅读
- 自主设计ui，高定制化
- 待改善处理逻辑，应对不同字体格式和大小，以及对超链接的处理
- 处理不同语言对应翻译后语言的词数不同造成的显式不同（已解决英文->中文，合并词为1；2）


#### 欢迎大家提出建议以及PR