const button = document.getElementById('preprocess-btn');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#334155';
}

async function triggerPreprocess() {
  button.disabled = true;
  setStatus('正在预处理当前页面...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('无法获取当前标签页');
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'BTV_PREPROCESS_NOW'
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['assets/styles/content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/content.js']
        });
        // 稍等内容脚本初始化
        await new Promise(resolve => setTimeout(resolve, 100));
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'BTV_PREPROCESS_NOW'
        });
      } else {
        throw err;
      }
    }

    if (!response || !response.ok) {
      throw new Error('内容脚本没有返回成功状态');
    }

    setStatus('预处理完成。现在可以开始翻译页面。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`预处理失败：${message}`, true);
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', triggerPreprocess);
