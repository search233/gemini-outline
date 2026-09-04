/**
 * Gemini Outline - 弹出菜单交互逻辑
 */

document.addEventListener('DOMContentLoaded', () => {
  // 检查是否在 Gemini 页面下打开
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    const statusText = document.querySelector('.status-text');
    const statusDot = document.querySelector('.status-dot');

    if (currentTab && currentTab.url && currentTab.url.includes('gemini.google.com')) {
      if (statusText) statusText.textContent = '已在当前 Gemini 页面激活';
      if (statusDot) statusDot.style.background = '#1e8e3e';
    } else {
      if (statusText) statusText.textContent = '等待进入 Gemini 网页端';
      if (statusDot) {
        statusDot.style.background = '#80868b';
        statusDot.style.boxShadow = 'none';
      }
    }
  });
});
