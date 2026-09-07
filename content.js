/**
 * Gemini Outline - 极简嵌入式侧轨与提问跳转 (Section Rail & Prompt Navigator)
 * 采用 Shadow DOM 隔离、纯短横线提问栈与悬浮信息卡片
 */

(function () {
  'use strict';

  // 状态管理
  const state = {
    turns: [],               // 所有问答轮次 { index, userEl, userFullText, modelEl, headings: [] }
    activeTurnIndex: 0,      // 当前处于视口或激活的问答轮次
    activeHeadingId: null,   // 当前正在阅读的高亮标题 ID
    isStreaming: false,      // 是否正在流式生成新回答
    hostEl: null,            // 挂载在页面的宿主元素
    shadowRoot: null,        // 开放的 Shadow DOM
    containerEl: null,       // 侧轨主 DOM 容器
    lastRenderedHtml: '',    // 上次渲染的 HTML，用于对比避免冗余重绘
    tooltipEl: null          // 单例全局悬浮提示框
  };

  // 防抖函数
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // 节流函数 (requestAnimationFrame)
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

  // 稳健的目标元素滚动直达机制
  function scrollToTarget(element) {
    if (!element) return;

    const originalMargin = element.style.scrollMarginTop;
    element.style.scrollMarginTop = '84px';

    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      element.scrollIntoView(true);
    }

    element.classList.add('go-target-pulse');
    setTimeout(() => {
      element.classList.remove('go-target-pulse');
      element.style.scrollMarginTop = originalMargin;
      if (element.getAttribute('style') === '') {
        element.removeAttribute('style');
      }
    }, 1200);
  }

  // 过滤系统/角色标签，排除如 "Gemini 说" 等非正文小标题
  const SYSTEM_TITLE_PATTERNS = [
    /^(gemini(\s*说|\s*said)?)$/i,
    /^(google\s*gemini)$/i,
    /^(model\s*response)$/i,
    /^(draft\s*\d+)$/i,
    /^(回答|提问|user|assistant)$/i
  ];

  function isValidHeading(hEl, text) {
    if (!text || text.length < 1) return false;
    const clean = text.trim();
    if (clean.length < 1) return false;

    for (const pattern of SYSTEM_TITLE_PATTERNS) {
      if (pattern.test(clean)) return false;
    }

    if (hEl.getAttribute('aria-hidden') === 'true' && !hEl.innerText) return false;
    if (hEl.closest('.header, .message-header, .response-header, .avatar-header')) return false;

    return true;
  }

  // 扫描并结构化页面所有问答轮次
  function scanTurns() {
    // 1. 查找用户提问节点
    const userQuerySelectors = [
      'user-query',
      '[data-test-id*="user-query"]',
      '.user-query-container',
      '.user-query',
      '.query-text',
      'div[class*="user-query"]',
      'div[class*="query-content"]'
    ];

    let userQueryElements = [];
    for (const sel of userQuerySelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        userQueryElements = els.filter(el => !el.parentElement || !el.parentElement.closest(sel));
        break;
      }
    }

    // 2. 查找模型回答节点
    const modelResponseSelectors = [
      'model-response',
      '[data-test-id*="model-response"]',
      '.model-response-text',
      '.model-response',
      'div[class*="model-response"]',
      'div[class*="response-container"]'
    ];

    let modelResponseElements = [];
    for (const sel of modelResponseSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        modelResponseElements = els.filter(el => !el.parentElement || !el.parentElement.closest(sel));
        break;
      }
    }

    const allNodes = [...userQueryElements, ...modelResponseElements].sort((a, b) => {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    const turns = [];
    let currentTurn = null;
    let turnIndex = 0;

    allNodes.forEach((node) => {
      const isUser = userQueryElements.includes(node);
      if (isUser) {
        currentTurn = { index: turnIndex++, userEl: node, modelEl: null, headings: [], userFullText: '' };
        turns.push(currentTurn);
      } else {
        if (!currentTurn) {
          currentTurn = { index: turnIndex++, userEl: null, modelEl: node, headings: [], userFullText: '' };
          turns.push(currentTurn);
        } else if (currentTurn.modelEl) {
          currentTurn = { index: turnIndex++, userEl: null, modelEl: node, headings: [], userFullText: '' };
          turns.push(currentTurn);
        } else {
          currentTurn.modelEl = node;
        }
      }
    });

    turns.forEach((turn) => {
      const { userEl, modelEl, index } = turn;

      // 提取提问纯文本
      let userFullText = '';
      if (userEl) {
        // 尝试更精准地定位正文以避开外层无障碍标签
        const textNode = userEl.querySelector('.query-text, .user-query-text, [data-test-id*="query"], [class*="content"]') || userEl;
        userFullText = textNode.innerText ? textNode.innerText.trim() : textNode.textContent.trim();
        userFullText = userFullText.replace(/\s+/g, ' ');
        // 移除无障碍或辅助文本前缀（如 Gemini 的 "你说" 或 "You said"）
        userFullText = userFullText.replace(/^(你说|You said)[:：\s]*/i, '');
        
        // 解决因 Gemini 包含隐藏的无障碍节点，导致 `innerText` 抓取到重复内容的问题
        // 现象：文本变成完全相同的两半，比如 "提问内容 提问内容"
        const halfLen = Math.floor(userFullText.length / 2);
        if (userFullText.length > 5 && userFullText.charAt(halfLen) === ' ') {
          const firstHalf = userFullText.substring(0, halfLen);
          const secondHalf = userFullText.substring(halfLen + 1);
          if (firstHalf === secondHalf) {
            userFullText = firstHalf; // 去重，只保留一半
          }
        }
      }

      if (!userFullText) {
        userFullText = `提问 #${index + 1}`;
      }
      turn.userFullText = userFullText;

      // 提取当前回答内部的真实 Markdown 标题
      const headings = [];
      if (modelEl) {
        const headingEls = modelEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
        let validIdx = 0;
        headingEls.forEach((hEl) => {
          const rawText = hEl.innerText ? hEl.innerText.trim() : hEl.textContent.trim();
          if (!isValidHeading(hEl, rawText)) return;

          const level = parseInt(hEl.tagName.substring(1), 10) || 2;
          const headingId = `go-turn-${index}-h-${validIdx++}`;
          hEl.dataset.goHeadingId = headingId;

          headings.push({
            id: headingId,
            element: hEl,
            level: level,
            text: rawText
          });
        });

        // 规范化层级深度 (depth: 0 ~ 3)
        if (headings.length > 0) {
          const minLevel = Math.min(...headings.map(h => h.level));
          headings.forEach(h => {
            h.depth = Math.min(3, Math.max(0, h.level - minLevel));
          });
        }
      }
      turn.headings = headings;
    });

    state.turns = turns;

    // 检查是否处于打字流式吐字状态
    const streamingIndicator = document.querySelector('.typing-indicator, [class*="streaming"], [class*="typing"]');
    state.isStreaming = Boolean(streamingIndicator);

    if (state.isStreaming && turns.length > 0) {
      state.activeTurnIndex = turns.length - 1;
    }
  }

  // 视口阅读带感知：根据当前浏览高度计算活跃轮次与当前高亮标题
  function updateScrollSpy() {
    if (state.turns.length === 0) return;

    const viewportHeight = window.innerHeight;
    const readingTop = 80;
    const readingBottom = viewportHeight * 0.55;

    // 1. 自动追踪视口中心占主导的问答轮次
    if (!state.isStreaming) {
      let bestTurnIndex = 0;
      let maxOverlap = -Infinity;

      state.turns.forEach((turn) => {
        const el = turn.modelEl || turn.userEl;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const overlapTop = Math.max(rect.top, readingTop);
        const overlapBottom = Math.min(rect.bottom, readingBottom);
        const overlap = overlapBottom - overlapTop;

        if (overlap > 0 && overlap > maxOverlap) {
          maxOverlap = overlap;
          bestTurnIndex = turn.index;
        } else if (rect.top <= readingBottom && rect.bottom >= readingTop && maxOverlap <= 0) {
          bestTurnIndex = turn.index;
        }
      });

      if (bestTurnIndex !== state.activeTurnIndex) {
        state.activeTurnIndex = bestTurnIndex;
        renderRail();
        return;
      }
    }

    // 2. 在当前活跃回答中寻找阅读视野对应的高亮小标题
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

      if (rect.top <= 140) {
        activeHeading = h;
      } else {
        break;
      }
    }

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

  // 初始化 Shadow DOM 宿主并注入隔离保护
  function ensureShadowHost() {
    if (!state.hostEl) {
      let existing = document.getElementById('gemini-outline-rail-host');
      if (existing) existing.remove();

      const host = document.createElement('div');
      host.id = 'gemini-outline-rail-host';
      document.body.appendChild(host);

      // 创建开放模式的 Shadow DOM，彻底隔离任何外部删除线与样式干扰
      const shadow = host.attachShadow({ mode: 'open' });

      // 注入 CSS 链接
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('styles.css');
      shadow.appendChild(link);

      // 极速硬重置 style，杜绝任何一毫秒的删除线
      const resetStyle = document.createElement('style');
      resetStyle.textContent = `
        *, *::before, *::after {
          box-sizing: border-box;
          text-decoration: none !important;
        }
      `;
      shadow.appendChild(resetStyle);

      // 内部侧轨主容器
      const container = document.createElement('div');
      container.className = 'gemini-outline-rail';
      shadow.appendChild(container);

      // 单例全局 Tooltip
      const tooltip = document.createElement('div');
      tooltip.id = 'go-singleton-tooltip';
      tooltip.className = 'go-prompt-tooltip';
      tooltip.innerHTML = `
        <div class="go-tooltip-header"></div>
        <div class="go-tooltip-body"></div>
      `;
      shadow.appendChild(tooltip);

      state.hostEl = host;
      state.shadowRoot = shadow;
      state.containerEl = container;
      state.tooltipEl = tooltip;
    }
    return state.containerEl;
  }

  // 动态对齐：将侧轨吸附在居中正文右侧安全区域
  function updateRailPosition() {
    const host = state.hostEl;
    if (!host) return;

    // 侦测深色模式 (涵盖各种可能的 Gemini 暗色标记及系统级偏好)
    const isDark = document.documentElement.classList.contains('dark-theme') ||
                   document.body.classList.contains('dark-theme') ||
                   document.documentElement.getAttribute('data-theme') === 'dark' ||
                   document.body.getAttribute('data-theme') === 'dark' ||
                   document.documentElement.hasAttribute('dark') ||
                   window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) {
      host.classList.add('dark-theme');
    } else {
      host.classList.remove('dark-theme');
    }

    const windowWidth = window.innerWidth;

    // 1. 基于几何计算获取正文真实物理右边界 (放弃依赖不稳定的内部 DOM)
    const contentContainers = [
      'chat-window',
      '.chat-history',
      'infinite-scroller',
      'main'
    ];

    let chatAreaRect = null;
    for (const sel of contentContainers) {
      const el = document.querySelector(sel);
      if (el && el.clientWidth > 400) {
        chatAreaRect = el.getBoundingClientRect();
        break;
      }
    }

    let trueContentRight = 0;
    if (chatAreaRect) {
      // Gemini 对话正文最大宽度约为 768px~820px，并在主聊天容器中居中
      const chatAreaCenter = chatAreaRect.left + (chatAreaRect.width / 2);
      trueContentRight = chatAreaCenter + 400; // 半宽取 400px 安全余量
    } else {
      trueContentRight = windowWidth / 2 + 400;
    }

    const availableMargin = windowWidth - trueContentRight;

    // 2. 三档自适应吸附策略
    // A. 空间充裕：自然嵌入留白区
    if (availableMargin >= 230 && windowWidth >= 1020) {
      host.classList.remove('go-narrow-mode');
      host.style.left = `${Math.round(trueContentRight + 16)}px`;
      host.style.right = 'auto';
    } 
    // B. 空间临界：紧贴屏幕边缘，大纲不折叠
    else if (availableMargin >= 170 && windowWidth >= 1020) {
      host.classList.remove('go-narrow-mode');
      host.style.left = 'auto';
      host.style.right = '8px';
    } 
    // C. 空间不足 (或窗口较窄)：自动切换微横条模式
    else {
      host.classList.add('go-narrow-mode');
      host.style.left = 'auto';
      host.style.right = '8px';
    }
  }

  // 渲染完整的嵌入式侧轨 (纯段横线提问栈 + 悬浮信息框 + 章节大纲)
  function renderRail() {
    const container = ensureShadowHost();
    if (state.turns.length === 0) {
      state.hostEl.style.display = 'none';
      return;
    }
    state.hostEl.style.display = 'flex';

    // 1. ChatGPT 风格纯段横线提问导航栈 (无 Q1/Q2 冗余文字，间距紧凑，悬停冒出信息框)
    let promptHtml = `
      <div class="go-prompt-stack" aria-label="提问导航">
        <div class="go-stack-label">PROMPTS</div>
        <div class="go-stack-items">
    `;

    state.turns.forEach((turn) => {
      const isActive = turn.index === state.activeTurnIndex;
      const safeFull = turn.userFullText.replace(/"/g, '&quot;');

      promptHtml += `
        <div class="go-prompt-pill-wrapper" data-turn="${turn.index}" data-text="${safeFull}">
          <button class="go-prompt-pill ${isActive ? 'is-active' : ''}" 
                  data-turn="${turn.index}"
                  aria-label="跳转至第 ${turn.index + 1} 轮提问">
            <span class="go-pill-bar"></span>
          </button>
        </div>
      `;
    });

    promptHtml += `
        </div>
      </div>
    `;

    // 2. 当前活跃回答章节大纲 (Section Rail)
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
        const safeHeading = h.text.replace(/"/g, '&quot;');
        sectionHtml += `
          <li class="go-section-item go-depth-${h.depth} ${isActive ? 'is-active' : ''}" data-heading-id="${h.id}">
            <button class="go-section-link" data-heading-id="${h.id}" title="${safeHeading}">
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
      sectionHtml = `
        <div class="go-rail-divider"></div>
        <div class="go-section-rail go-section-empty">
          <div class="go-empty-hint">当前回答无分段标题</div>
        </div>
      `;
    }

    const newHtml = promptHtml + sectionHtml;
    if (state.lastRenderedHtml === newHtml) {
      updateActiveHeadingUI();
      return;
    }
    state.lastRenderedHtml = newHtml;

    const oldList = container.querySelector('.go-section-list');
    const oldScrollTop = oldList ? oldList.scrollTop : 0;

    container.innerHTML = newHtml;

    if (oldScrollTop > 0) {
      const newList = container.querySelector('.go-section-list');
      if (newList) {
        newList.scrollTop = oldScrollTop;
      }
    }

    // 绑定段横线点击跳转
    const pillBtns = container.querySelectorAll('.go-prompt-pill');
    pillBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const turnIdx = parseInt(btn.dataset.turn, 10);
        const targetTurn = state.turns[turnIdx];
        if (targetTurn) {
          state.activeTurnIndex = turnIdx;
          renderRail();
          const targetEl = targetTurn.userEl || targetTurn.modelEl;
          if (targetEl) {
            scrollToTarget(targetEl);
          }
        }
      });
    });

    // 绑定段横线悬浮事件 (单例 Tooltip)
    const pillWrappers = container.querySelectorAll('.go-prompt-pill-wrapper');
    const tooltip = state.tooltipEl;
    pillWrappers.forEach((wrapper) => {
      wrapper.addEventListener('mouseenter', () => {
        const turnIdx = parseInt(wrapper.dataset.turn, 10);
        const text = wrapper.dataset.text;
        if (tooltip) {
          tooltip.querySelector('.go-tooltip-header').innerText = `第 ${turnIdx + 1} 轮提问`;
          tooltip.querySelector('.go-tooltip-body').innerText = text;
          
          const rect = wrapper.getBoundingClientRect();
          const hostRect = state.hostEl.getBoundingClientRect();
          const topPos = rect.top - hostRect.top + (rect.height / 2);
          
          tooltip.style.top = `${topPos}px`;
          tooltip.classList.add('is-visible');
        }
      });
      wrapper.addEventListener('mouseleave', () => {
        if (tooltip) {
          tooltip.classList.remove('is-visible');
        }
      });
    });

    // 绑定大纲标题点击跳转
    const sectionBtns = container.querySelectorAll('.go-section-link');
    sectionBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hId = btn.dataset.headingId;
        const currentTurn = state.turns[state.activeTurnIndex];
        if (currentTurn) {
          const heading = currentTurn.headings.find(h => h.id === hId);
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

  // 局部刷新高亮，无需重绘
  function updateActiveHeadingUI() {
    const container = state.containerEl;
    if (!container) return;

    // 更新段横线激活状态
    const pillWrappers = container.querySelectorAll('.go-prompt-pill-wrapper');
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

    // 更新大纲小节激活状态
    const items = container.querySelectorAll('.go-section-item');
    items.forEach((item) => {
      const hId = item.dataset.headingId;
      if (hId === state.activeHeadingId) {
        item.classList.add('is-active');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.classList.remove('is-active');
      }
    });
  }

  // 全量同步
  function syncAll() {
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

  // 绑定滚动监听
  function attachScrollListeners() {
    window.addEventListener('scroll', throttledScroll, { passive: true });
    window.addEventListener('resize', debouncedResize, { passive: true });

    document.addEventListener('scroll', () => {
      throttledScroll();
    }, { capture: true, passive: true });
  }

  // 初始化扩展
  function init() {
    attachScrollListeners();

    // 观察 DOM 变动 (处理流式打字与 SPA 对话切换)
    const observer = new MutationObserver((mutations) => {
      let shouldSync = false;
      for (const m of mutations) {
        const target = m.target;
        if (target && target.closest && target.closest('#gemini-outline-rail-host')) {
          continue;
        }
        if (m.type === 'attributes' && m.attributeName !== 'class') {
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
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'theme', 'dark']
    });

    // 监听系统级暗色模式切换
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.hostEl) {
        updateRailPosition();
      }
    });

    // 注入全局目标高亮脉冲动画规则
    if (!document.getElementById('go-global-pulse-style')) {
      const pulseStyle = document.createElement('style');
      pulseStyle.id = 'go-global-pulse-style';
      pulseStyle.textContent = `
        @keyframes goTargetFlash {
          0% { background-color: rgba(26, 115, 232, 0.25); outline: 2px solid #1a73e8; outline-offset: 4px; }
          70% { background-color: rgba(26, 115, 232, 0.16); outline: 2px solid #1a73e8; outline-offset: 4px; }
          100% { background-color: transparent; outline: 2px solid transparent; outline-offset: 4px; }
        }
        .go-target-pulse {
          animation: goTargetFlash 1.2s cubic-bezier(0.2, 0, 0, 1) forwards !important;
          border-radius: 4px;
        }
      `;
      document.head.appendChild(pulseStyle);
    }

    setTimeout(syncAll, 400);
    setTimeout(syncAll, 1200);
    setTimeout(syncAll, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
