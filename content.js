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
    containerEl: null        // 侧轨主 DOM 容器
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

  // 稳健的目标元素滚动直达机制 (原生 scrollIntoView + 滚动祖先兜底)
  function scrollToTarget(element) {
    if (!element) return;

    // 1. 设置 84px 的顶部预留间距，避开 Gemini 顶部导航条
    element.style.scrollMarginTop = '84px';

    // 2. 原生 scrollIntoView：由浏览器引擎自行寻找各层级滚动容器对齐
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      element.scrollIntoView(true);
    }

    // 3. 向上寻找并兜底最邻近的具有 overflow-y 滚动特性的祖先容器
    let parent = element.parentElement;
    while (parent && parent !== document.documentElement && parent !== document.body) {
      const style = getComputedStyle(parent);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
        const parentRect = parent.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        const targetScroll = parent.scrollTop + (elRect.top - parentRect.top) - 84;
        parent.scrollTo({
          top: Math.max(0, targetScroll),
          behavior: 'smooth'
        });
        break;
      }
      parent = parent.parentElement;
    }

    // 4. 目标元素高亮微闪烁引导视觉
    element.classList.add('go-target-pulse');
    setTimeout(() => {
      element.classList.remove('go-target-pulse');
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

    const turns = [];
    const maxCount = Math.max(userQueryElements.length, modelResponseElements.length);

    for (let i = 0; i < maxCount; i++) {
      const userEl = userQueryElements[i] || null;
      const modelEl = modelResponseElements[i] || null;

      // 提取提问纯文本
      let userFullText = '';
      if (userEl) {
        const textNode = userEl.querySelector('.query-text, .user-query-text, p') || userEl;
        userFullText = textNode.innerText ? textNode.innerText.trim() : textNode.textContent.trim();
        userFullText = userFullText.replace(/\s+/g, ' ');
      }

      if (!userFullText) {
        userFullText = `提问 #${i + 1}`;
      }

      // 提取当前回答内部的真实 Markdown 标题
      const headings = [];
      if (modelEl) {
        const headingEls = modelEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
        let validIdx = 0;
        headingEls.forEach((hEl) => {
          const rawText = hEl.innerText ? hEl.innerText.trim() : hEl.textContent.trim();
          if (!isValidHeading(hEl, rawText)) return;

          const level = parseInt(hEl.tagName.substring(1), 10) || 2;
          const headingId = `go-turn-${i}-h-${validIdx++}`;
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

      turns.push({
        index: i,
        userEl,
        userFullText,
        modelEl,
        headings
      });
    }

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

      state.hostEl = host;
      state.shadowRoot = shadow;
      state.containerEl = container;
    }
    return state.containerEl;
  }

  // 动态对齐：将侧轨吸附在居中正文右侧安全区域
  function updateRailPosition() {
    const host = state.hostEl;
    if (!host) return;

    // 侦测深色模式并传递给 :host
    const isDark = document.documentElement.classList.contains('dark-theme') ||
                   document.body.classList.contains('dark-theme') ||
                   window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) {
      host.classList.add('dark-theme');
    } else {
      host.classList.remove('dark-theme');
    }

    // 寻找居中正文容器
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

    // 屏幕过窄自适应 (< 1020px)
    if (windowWidth < 1020) {
      host.classList.add('go-narrow-mode');
      host.style.right = '8px';
      host.style.left = 'auto';
      return;
    } else {
      host.classList.remove('go-narrow-mode');
    }

    // 靠在正文右侧 20px
    if (contentRect && contentRect.right > 0) {
      const idealLeft = contentRect.right + 20;
      const maxLeft = windowWidth - 230;

      if (idealLeft <= maxLeft) {
        host.style.left = `${Math.round(idealLeft)}px`;
        host.style.right = 'auto';
      } else {
        host.style.left = 'auto';
        host.style.right = '16px';
      }
    } else {
      host.style.left = 'auto';
      host.style.right = '24px';
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
        <div class="go-prompt-pill-wrapper" data-turn="${turn.index}">
          <button class="go-prompt-pill ${isActive ? 'is-active' : ''}" 
                  data-turn="${turn.index}"
                  aria-label="跳转至第 ${turn.index + 1} 轮提问">
            <span class="go-pill-bar"></span>
          </button>
          <div class="go-prompt-tooltip">
            <div class="go-tooltip-header">第 ${turn.index + 1} 轮提问</div>
            <div class="go-tooltip-body">${safeFull}</div>
          </div>
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

    container.innerHTML = promptHtml + sectionHtml;

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
        if (m.target && m.target.closest && m.target.closest('#gemini-outline-rail-host')) {
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
