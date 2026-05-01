// ========================================
// WordFlow Content Script
// 划词浮层 + 右键菜单反馈
// ========================================

(() => {
  'use strict';

  let currentCard = null;
  let selectionTimeout = null;
  let settings = { selectionMode: 'auto', autoSpeak: false };

  // 加载设置
  chrome.storage.local.get({ selectionMode: 'auto', autoSpeak: false }, (data) => {
    settings = data;
  });

  // 监听设置变化
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.selectionMode) settings.selectionMode = changes.selectionMode.newValue;
    if (changes.autoSpeak) settings.autoSpeak = changes.autoSpeak.newValue;
  });

  // ========== 1. 划词检测 ==========

  document.addEventListener('mouseup', (e) => {
    // 如果划词功能关闭，不处理
    if (settings.selectionMode === 'disabled') return;

    // 如果点击的是卡片内部，不处理
    if (currentCard && currentCard.contains(e.target)) return;

    // 延迟一点再检测，等浏览器完成选中
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();

      if (!text || text.length < 1) {
        removeCard();
        return;
      }

      // 获取选中位置
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      if (isSentence(text)) {
        showSentenceCard(text, rect);
      } else {
        showWordCard(text, rect);
      }
    }, 300);
  });

  // 点击空白处关闭卡片
  document.addEventListener('mousedown', (e) => {
    if (currentCard && !currentCard.contains(e.target)) {
      removeCard();
    }
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') removeCard();
  });

  // ========== 2. 判断单词还是句子 ==========

  function isSentence(text) {
    const wordCount = text.split(/\s+/).length;
    return wordCount > 3;
  }

  // ========== 3. 单词卡片 ==========

  function showWordCard(text, rect) {
    removeCard();

    const word = text.toLowerCase().replace(/[^a-zA-Z'\-]/g, '').trim();
    if (!word) return;

    const card = createCardElement();
    card.innerHTML = `
      <span class="wordflow-close">&times;</span>
      <div class="wordflow-word-row">
        <span class="wordflow-word">${escapeHtml(word)}</span>
        <span class="wordflow-speak" title="发音">🔊</span>
      </div>
      <div class="wordflow-phonetic">查询中...</div>
      <div class="wordflow-definition">正在查询释义...</div>
      <div class="wordflow-buttons">
        <button class="wordflow-btn wordflow-btn-cancel">取消</button>
        <button class="wordflow-btn wordflow-btn-save" id="wordflow-save-btn">存入词池</button>
      </div>
    `;

    positionCard(card, rect);
    document.body.appendChild(card);
    currentCard = card;

    // 绑定事件
    card.querySelector('.wordflow-close').addEventListener('click', removeCard);
    card.querySelector('.wordflow-btn-cancel').addEventListener('click', removeCard);
    card.querySelector('.wordflow-speak').addEventListener('click', () => speakWord(word));

    // 查词典 —— 只有当这张卡还在 DOM 里才写入，避免前一轮请求的回调
    // 串到新卡片上
    chrome.runtime.sendMessage({ action: 'lookupWord', word }, (entry) => {
      if (!card.isConnected) return;

      const phoneticEl = card.querySelector('.wordflow-phonetic');
      const defEl = card.querySelector('.wordflow-definition');

      if (entry) {
        phoneticEl.textContent = entry.phonetic ? `/${entry.phonetic}/` : '';
        defEl.textContent = entry.definition || '未找到释义';
        // 自动发音
        if (settings.autoSpeak) speakWord(word);
      } else {
        phoneticEl.textContent = '';
        defEl.textContent = '未找到释义';
      }
    });

    // 存入按钮
    card.querySelector('#wordflow-save-btn').addEventListener('click', () => {
      const btn = card.querySelector('#wordflow-save-btn');
      btn.textContent = '保存中...';
      btn.classList.add('disabled');

      chrome.runtime.sendMessage({
        action: 'saveWordFromContent',
        word: word
      }, (resp) => {
        if (!currentCard) return;

        if (resp && resp.status === 'exists') {
          btn.textContent = '已在词池中';
          btn.classList.add('disabled');
        } else if (resp && resp.status === 'saved') {
          btn.textContent = '✓ 已存入';
          btn.classList.add('disabled');
          // 1.5秒后自动关闭
          setTimeout(removeCard, 1500);
        }
      });
    });
  }

  // ========== 4. 句子卡片 ==========

  function showSentenceCard(text, rect) {
    removeCard();

    const sentence = text.trim();
    // 显示截断
    const displayText = sentence.length > 120
      ? sentence.substring(0, 120) + '...'
      : sentence;

    const card = createCardElement();
    card.innerHTML = `
      <span class="wordflow-close">&times;</span>
      <div class="wordflow-sentence-text">"${escapeHtml(displayText)}"</div>
      <div class="wordflow-buttons">
        <button class="wordflow-btn wordflow-btn-cancel">取消</button>
        <button class="wordflow-btn wordflow-btn-save" id="wordflow-save-sentence-btn">存入句池</button>
      </div>
    `;

    positionCard(card, rect);
    document.body.appendChild(card);
    currentCard = card;

    // 绑定事件
    card.querySelector('.wordflow-close').addEventListener('click', removeCard);
    card.querySelector('.wordflow-btn-cancel').addEventListener('click', removeCard);

    card.querySelector('#wordflow-save-sentence-btn').addEventListener('click', () => {
      const btn = card.querySelector('#wordflow-save-sentence-btn');
      btn.textContent = '保存中...';
      btn.classList.add('disabled');

      chrome.runtime.sendMessage({
        action: 'saveSentenceFromContent',
        text: sentence,
        source: window.location.href
      }, (resp) => {
        if (!currentCard) return;

        if (resp && resp.status === 'exists') {
          btn.textContent = '已在句池中';
          btn.classList.add('disabled');
        } else if (resp && resp.status === 'saved') {
          btn.textContent = '✓ 已存入';
          btn.classList.add('disabled');
          setTimeout(removeCard, 1500);
        }
      });
    });
  }

  // ========== 5. 卡片定位 ==========

  function createCardElement() {
    const card = document.createElement('div');
    card.id = 'wordflow-card';
    return card;
  }

  function positionCard(card, rect) {
    // 先加到 DOM 以获取尺寸
    card.style.visibility = 'hidden';
    document.body.appendChild(card);
    const cardRect = card.getBoundingClientRect();
    document.body.removeChild(card);
    card.style.visibility = '';

    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;

    // 防止超出右边
    if (left + cardRect.width > window.innerWidth + window.scrollX - 10) {
      left = window.innerWidth + window.scrollX - cardRect.width - 10;
    }

    // 防止超出左边
    if (left < window.scrollX + 10) {
      left = window.scrollX + 10;
    }

    // 如果下方空间不够，显示在上方
    if (rect.bottom + cardRect.height + 20 > window.innerHeight) {
      top = rect.top + window.scrollY - cardRect.height - 8;
    }

    card.style.position = 'absolute';
    card.style.top = top + 'px';
    card.style.left = left + 'px';
  }

  // ========== 6. 发音 ==========

  function speakWord(word) {
    // 先尝试直接播放，如果被 CSP 拦截则走 background
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
    const audio = new Audio(url);
    audio.play().catch(() => {
      // 被页面 CSP 拦截，让 background 来播
      chrome.runtime.sendMessage({ action: 'speakWord', word });
    });
  }

  // ========== 7. 工具函数 ==========

  function removeCard() {
    if (currentCard) {
      currentCard.remove();
      currentCard = null;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ========== 8. 接收 Background 消息（右键菜单反馈） ==========

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'word-saved') {
      showToast(`✓ "${msg.entry.word}" 已存入词池`);
    } else if (msg.type === 'word-exists') {
      showToast(`"${msg.word}" 已在词池中`);
    } else if (msg.type === 'sentence-saved') {
      showToast('✓ 句子已存入句池');
    } else if (msg.type === 'sentence-exists') {
      showToast('该句子已在句池中');
    }
  });

  function showToast(text) {
    // 移除旧的
    const old = document.getElementById('wordflow-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'wordflow-toast';
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2500);
  }

})();
