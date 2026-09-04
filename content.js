/**
 * Gemini Outline - 嵌入式右侧大纲与提问导航侧轨 (Section Rail & Prompt Navigator)
 * 适配 Google Gemini 网页端 (gemini.google.com)
 */

(function () {
  'use strict';

  // 状态管理
  const state = {
    turns: [],               // 所有问答轮次 { index, userEl, userText, modelEl, headings: [] }
    activeTurnIndex: 0,      // 当前处于视口或激活的问答轮次
    activeHeadingId: null,   // 当前正在阅读的高亮标题 ID
    isStreaming: false,      // 是否正在流式生成新回答
    scrollContainer: null,   // 页面滚动容器
    lastScrollY: 0,
    railMounted: false,
    hoverTooltipTimer: null
  };

  // 防抖函数
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // 节流函数 (基于 requestAnimationFrame)
  function throttleRaf(fn) {
    let running = false;
    return function (...args) {
      if (running) return;
      running = true;
      requestAnimationFrame(() => {
        fn.apply(this, args);
        running = false;
      });
    };
  }

  // 寻找 Gemini 当前页面的真实滚动容器
  function findScrollContainer() {
    // 优先检查常见滚动容器
    const selectors = [
      'infinite-scroller',
      '.chat-history',
      '.conversation-container',
      'main',
      'chat-window',
      '[data-test-id="chat-history"]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'hidden') {
        return el;
      }
    }

    // 向上查找有 overflow-y 的父级
    let current = document.querySelector('user-query, model-response, .query-text');
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }

    return window;
  }

  // 获取滚动容器当前 scrollTop
  function getScrollTop(container) {
    if (!container || container === window) {
      return window.pageYOffset || document.documentElement.scrollTop || 0;
    }
    return container.scrollTop;
  }

  // 平滑滚动定位到指定元素，预留顶部 Header 间距
  function scrollToTarget(element) {
    if (!element) return;
    const headerOffset = 76; // 避开 Gemini 顶部导航条
    const container = state.scrollContainer || findScrollContainer();

    if (container === window) {
      const elementPosition = element.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - headerOffset;
      window.scrollTo({
        top: Math.max(0, offsetPosition),
        behavior: 'smooth'
      });
    } else {
      const containerRect = container.getBoundingClientRect();
      const elRect = element.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top + container.scrollTop - headerOffset;
      container.scrollTo({
        top: Math.max(0, relativeTop),
        behavior: 'smooth'
      });
    }

    // 给予目标元素瞬间的高亮闪烁动画，增强视觉引导
    element.classList.add('go-target-pulse');
    setTimeout(() => {
      element.classList.remove('go-target-pulse');
    }, 1200);
  }

  // 提取页面所有问答轮次并结构化
  function scanTurns() {
    // 1. 查找用户提问节点
    const userQuerySelectors = [
      'user-query',
      '[data-test-id*="user-query"]',
      '.user-query-container',
      '.query-text',
      'div[class*="user-query"]'
    ];
    let userQueryElements = [];
    for (const sel of userQuerySelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        // 去除嵌套重复
        userQueryElements = els.filter(el => !el.closest(sel) || el.closest(sel) === el);
        break;
      }
    }

    // 2. 查找模型回答节点
    const modelResponseSelectors = [
      'model-response',
      '[data-test-id*="model-response"]',
      '.model-response-text',
      '.model-response',
      'div[class*="model-response"]'
    ];
    let modelResponseElements = [];
    for (const sel of modelResponseSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        modelResponseElements = els.filter(el => !el.closest(sel) || el.closest(sel) === el);
        break;
      }
    }

    // 兜底方案：如果两者数量不完全相等，根据 DOM 顺序逐个归类
    const turns = [];
    const maxCount = Math.max(userQueryElements.length, modelResponseElements.length);

    for (let i = 0; i < maxCount; i++) {
      const userEl = userQueryElements[i] || null;
      const modelEl = modelResponseElements[i] || null;

      // 提取提问纯文本
      let userText = '';
      if (userEl) {
        userText = userEl.innerText ? userEl.innerText.trim() : userEl.textContent.trim();
        // 清除多余空白
        userText = userText.replace(/\s+/g, ' ');
      }
      if (!userText) {
        userText = `提问 #${i + 1}`;
      }

      // 给提问节点打上锚点
      if (userEl && !userEl.dataset.goAnchor) {
        userEl.dataset.goAnchor = `go-turn-${i}-user`;
      }

      // 提取该回答内部的各级标题
      const headings = [];
      if (modelEl) {
        const headingEls = modelEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
        headingEls.forEach((hEl, hIndex) => {
          const rawText = hEl.innerText ? hEl.innerText.trim() : hEl.textContent.trim();
          if (!rawText) return;

          const level = parseInt(hEl.tagName.substring(1), 10) || 2;
          const headingId = `go-turn-${i}-h-${hIndex}`;
          hEl.dataset.goHeadingId = headingId;

          headings.push({
            id: headingId,
            element: hEl,
            level: level,
            text: rawText
          });
        });

        // 规范化层级深度 (depth: 0 为最低级别起始)
        if (headings.length > 0) {
          const minLevel = Math.min(...headings.map(h => h.level));
          headings.forEach(h => {
            h.depth = Math.min(3, Math.max(0, h.level - minLevel));
          });
        }
      }

      turns.push({
        index: i,
        userEl,
        userText,
        modelEl,
        headings
      });
    }

    state.turns = turns;

    // 检查 Gemini 是否正在打字流式吐字
    const streamingIndicator = document.querySelector('.typing-indicator, [class*="streaming"], [class*="typing"]');
    state.isStreaming = Boolean(streamingIndicator);

    // 如果正在生成，且有最新轮次，自动聚焦最新轮次
    if (state.isStreaming && turns.length > 0) {
      state.activeTurnIndex = turns.length - 1;
    }
  }

  // 视口阅读带感知：根据当前滚动位置计算活跃的轮次与标题
  function updateScrollSpy() {
    if (state.turns.length === 0) return;

    const viewportHeight = window.innerHeight;
    const readingTop = 80;
    const readingBottom = viewportHeight * 0.55; // 黄金阅读带

    // 1. 如果用户没有手动锁定，根据视口中心判定活跃问答轮次
    if (!state.isStreaming) {
      let bestTurnIndex = 0;
      let maxOverlap = -Infinity;

      state.turns.forEach((turn) => {
        const el = turn.modelEl || turn.userEl;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        // 计算元素在阅读带内的重合高度
        const overlapTop = Math.max(rect.top, readingTop);
        const overlapBottom = Math.min(rect.bottom, readingBottom);
        const overlap = overlapBottom - overlapTop;

        // 如果刚好处于阅读视口内
        if (overlap > 0 && overlap > maxOverlap) {
          maxOverlap = overlap;
          bestTurnIndex = turn.index;
        } else if (rect.top <= readingBottom && rect.bottom >= readingTop && maxOverlap <= 0) {
          bestTurnIndex = turn.index;
        }
      });

      if (bestTurnIndex !== state.activeTurnIndex) {
        state.activeTurnIndex = bestTurnIndex;
        renderRail(); // 轮次发生切换时重新渲染下层大纲
        return;
      }
    }

    // 2. 在当前活跃回答内部寻找正在阅读的高亮标题
    const activeTurn = state.turns[state.activeTurnIndex];
    if (!activeTurn || activeTurn.headings.length === 0) {
      state.activeHeadingId = null;
      updateActiveHeadingUI();
      return;
    }

    let activeHeading = null;
    for (let i = 0; i < activeTurn.headings.length; i++) {
      const h = activeTurn.headings[i];
      const rect = h.element.getBoundingClientRect();

      // 标题越过顶部阅读线 (约 130px)
      if (rect.top <= 140) {
        activeHeading = h;
      } else {
        break;
      }
    }

    // 如果还没有滑过第一个标题，且第一个标题在视野中
    if (!activeHeading && activeTurn.headings.length > 0) {
      const firstRect = activeTurn.headings[0].element.getBoundingClientRect();
      if (firstRect.top < viewportHeight * 0.8) {
        activeHeading = activeTurn.headings[0];
      }
    }

    const newHeadingId = activeHeading ? activeHeading.id : null;
    if (newHeadingId !== state.activeHeadingId) {
      state.activeHeadingId = newHeadingId;
      updateActiveHeadingUI();
    }
  }

  // 创建并注入侧轨 DOM 宿主
  function ensureRailHost() {
    let railHost = document.getElementById('gemini-outline-rail');
    if (!railHost) {
      railHost = document.createElement('div');
      railHost.id = 'gemini-outline-rail';
      railHost.className = 'gemini-outline-rail';
      document.body.appendChild(railHost);
    }
    return railHost;
  }

  // 动态对齐：将侧轨定位在 Gemini 居中正文的右侧空白槽位中
  function updateRailPosition() {
    const rail = document.getElementById('gemini-outline-rail');
    if (!rail) return;

    // 寻找 Gemini 居中正文容器
    const contentContainers = [
      'chat-window',
      '.chat-history',
      '.conversation-container',
      'infinite-scroller',
      'main [class*="content"]',
      'main'
    ];

    let contentRect = null;
    for (const sel of contentContainers) {
      const el = document.querySelector(sel);
      if (el && el.clientWidth > 400) {
        contentRect = el.getBoundingClientRect();
        break;
      }
    }

    const windowWidth = window.innerWidth;

    // 如果屏幕宽度过窄 (< 980px)，进入极简收拢状态
    if (windowWidth < 980) {
      rail.classList.add('go-narrow-mode');
      rail.style.right = '8px';
      rail.style.left = 'auto';
      return;
    } else {
      rail.classList.remove('go-narrow-mode');
    }

    // 如果找到了正文容器，定位到正文右边缘外侧 24px
    if (contentRect && contentRect.right > 0) {
      const idealLeft = contentRect.right + 20;
      const maxLeft = windowWidth - 220; // 保证右侧不被截断

      if (idealLeft <= maxLeft) {
        rail.style.left = `${Math.round(idealLeft)}px`;
        rail.style.right = 'auto';
      } else {
        rail.style.left = 'auto';
        rail.style.right = '16px';
      }
    } else {
      rail.style.left = 'auto';
      rail.style.right = '24px';
    }
  }

  // 渲染完整的侧轨内容 (ChatGPT 提问栈 + 章节大纲)
  function renderRail() {
    const rail = ensureRailHost();
    if (state.turns.length === 0) {
      rail.style.display = 'none';
      return;
    }
    rail.style.display = 'flex';

    // 构建 Prompt Navigator (ChatGPT 风格提问小横条)
    let promptHtml = `
      <div class="go-prompt-stack" aria-label="提问导航">
        <div class="go-stack-label">PROMPTS</div>
        <div class="go-stack-items">
    `;

    state.turns.forEach((turn) => {
      const isActive = turn.index === state.activeTurnIndex;
      // 截取提问文本前 70 个字符作为悬浮提示
      const safeText = turn.userText.replace(/"/g, '&quot;');
      const previewSnippet = safeText.length > 70 ? safeText.substring(0, 68) + '...' : safeText;

      promptHtml += `
        <div class="go-prompt-pill-wrapper" data-turn="${turn.index}">
          <button class="go-prompt-pill ${isActive ? 'is-active' : ''}" 
                  data-turn="${turn.index}"
                  aria-label="跳转至提问 ${turn.index + 1}">
            <span class="go-pill-bar"></span>
            <span class="go-pill-tag">Q${turn.index + 1}</span>
          </button>
          <div class="go-prompt-tooltip">
            <span class="go-tooltip-num">Q${turn.index + 1}:</span> ${previewSnippet}
          </div>
        </div>
      `;
    });

    promptHtml += `
        </div>
      </div>
    `;

    // 构建当前活跃回答的章节大纲 (Section Rail)
    const activeTurn = state.turns[state.activeTurnIndex];
    let sectionHtml = '';

    if (activeTurn && activeTurn.headings.length > 0) {
      sectionHtml = `
        <div class="go-rail-divider"></div>
        <div class="go-section-rail" aria-label="当前回答章节大纲">
          <div class="go-section-track">
            <div class="go-track-line"></div>
          </div>
          <ul class="go-section-list">
      `;

      activeTurn.headings.forEach((h) => {
        const isActive = h.id === state.activeHeadingId;
        sectionHtml += `
          <li class="go-section-item go-depth-${h.depth} ${isActive ? 'is-active' : ''}" data-heading-id="${h.id}">
            <button class="go-section-link" data-heading-id="${h.id}" title="${h.text.replace(/"/g, '&quot;')}">
              <span class="go-section-bullet"></span>
              <span class="go-section-title">${h.text}</span>
            </button>
          </li>
        `;
      });

      sectionHtml += `
          </ul>
        </div>
      `;
    } else {
      // 当前回答没有小标题时的空状态 (极简显示)
      sectionHtml = `
        <div class="go-rail-divider"></div>
        <div class="go-section-rail go-section-empty">
          <div class="go-empty-hint">当前回答无分段标题</div>
        </div>
      `;
    }

    rail.innerHTML = promptHtml + sectionHtml;

    // 绑定提问条点击与交互事件
    const pillBtns = rail.querySelectorAll('.go-prompt-pill');
    pillBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const turnIdx = parseInt(btn.dataset.turn, 10);
        const targetTurn = state.turns[turnIdx];
        if (targetTurn && targetTurn.userEl) {
          state.activeTurnIndex = turnIdx;
          renderRail();
          scrollToTarget(targetTurn.userEl);
        }
      });
    });

    // 绑定大纲标题点击事件
    const sectionBtns = rail.querySelectorAll('.go-section-link');
    sectionBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hId = btn.dataset.headingId;
        const activeTurn = state.turns[state.activeTurnIndex];
        if (activeTurn) {
          const heading = activeTurn.headings.find(h => h.id === hId);
          if (heading && heading.element) {
            scrollToTarget(heading.element);
            state.activeHeadingId = hId;
            updateActiveHeadingUI();
          }
        }
      });
    });

    updateRailPosition();
    updateActiveHeadingUI();
  }

  // 仅刷新标题高亮样式，避免完全重绘 DOM
  function updateActiveHeadingUI() {
    const rail = document.getElementById('gemini-outline-rail');
    if (!rail) return;

    // 更新提问条高亮
    const pillWrappers = rail.querySelectorAll('.go-prompt-pill-wrapper');
    pillWrappers.forEach((wrap) => {
      const turnIdx = parseInt(wrap.dataset.turn, 10);
      const pill = wrap.querySelector('.go-prompt-pill');
      if (pill) {
        if (turnIdx === state.activeTurnIndex) {
          pill.classList.add('is-active');
        } else {
          pill.classList.remove('is-active');
        }
      }
    });

    // 更新大纲标题高亮
    const items = rail.querySelectorAll('.go-section-item');
    items.forEach((item) => {
      const hId = item.dataset.headingId;
      if (hId === state.activeHeadingId) {
        item.classList.add('is-active');
        // 自动微调侧轨内部滚动，保持高亮项在视野内
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.classList.remove('is-active');
      }
    });
  }

  // 周期同步与变化响应核心
  function syncAll() {
    state.scrollContainer = findScrollContainer();
    scanTurns();
    renderRail();
    updateScrollSpy();
  }

  const debouncedSyncAll = debounce(syncAll, 200);
  const throttledScroll = throttleRaf(updateScrollSpy);
  const debouncedResize = debounce(() => {
    updateRailPosition();
    updateScrollSpy();
  }, 100);

  // 初始化扩展与监听
  function init() {
    // 监听窗口滚动与内部容器滚动
    window.addEventListener('scroll', throttledScroll, { passive: true });
    window.addEventListener('resize', debouncedResize, { passive: true });

    // 深度监听 DOM 变动 (处理流式打字生成、SPA 对话切换)
    const observer = new MutationObserver((mutations) => {
      let shouldSync = false;
      for (const m of mutations) {
        // 如果是插件自身的变化，忽略
        if (m.target && m.target.closest && m.target.closest('#gemini-outline-rail')) {
          continue;
        }
        shouldSync = true;
        break;
      }

      if (shouldSync) {
        debouncedSyncAll();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 寻找滚动容器并附加滚动监听
    setInterval(() => {
      const currentContainer = findScrollContainer();
      if (currentContainer && currentContainer !== state.scrollContainer) {
        if (state.scrollContainer && state.scrollContainer !== window) {
          state.scrollContainer.removeEventListener('scroll', throttledScroll);
        }
        state.scrollContainer = currentContainer;
        if (currentContainer !== window) {
          currentContainer.addEventListener('scroll', throttledScroll, { passive: true });
        }
      }
    }, 1500);

    // 初始执行一次同步
    setTimeout(syncAll, 500);
    setTimeout(syncAll, 1500);
  }

  // 当页面加载完成时执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
