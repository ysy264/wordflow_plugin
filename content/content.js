// ========================================
// WordFlow v2 Content Script
// 卡片 A: 单词采集 / 卡片 B: 段落翻译
// ========================================

(() => {
  'use strict';

  let currentCard = null;
  let selectionTimeout = null;
  let settings = { selectionMode: 'auto', autoSpeak: false };

  chrome.storage.local.get({ selectionMode: 'auto', autoSpeak: false }, data => {
    settings = data;
  });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.selectionMode) settings.selectionMode = changes.selectionMode.newValue;
    if (changes.autoSpeak) settings.autoSpeak = changes.autoSpeak.newValue;
  });

  // ========== 1. Selection Detection ==========

  document.addEventListener('mouseup', e => {
    if (settings.selectionMode === 'disabled') return;
    if (currentCard?.contains(e.target)) return;

    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (!text || text.length < 1) { removeCard(); return; }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      if (isParagraph(text)) {
        showParaCard(text, rect);
      } else {
        const word = normalizeWord(text);
        if (word) showWordCard(word, rect);
      }
    }, 280);
  });

  document.addEventListener('mousedown', e => {
    if (currentCard && !currentCard.contains(e.target)) removeCard();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') removeCard();
  });

  function isParagraph(text) {
    return text.split(/\s+/).length > 3;
  }

  function normalizeWord(text) {
    return text.toLowerCase().replace(/[^a-zA-Z'\-]/g, '').trim();
  }

  // ========== 2. DOM Sentence Extraction ==========

  function getParentSentence() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;

    // Walk up to find a block-level element or text container
    for (let i = 0; i < 5; i++) {
      if (!node || node === document.body) break;
      const text = (node.textContent || '').trim();
      if (text.length > 10 && text.length < 800) return text;
      if (node.parentElement) node = node.parentElement;
    }

    // Fallback: get the whole parent element text
    const parent = range.commonAncestorContainer?.parentElement;
    if (parent) {
      const text = parent.textContent?.trim() || '';
      if (text.length < 800) return text;
      return text.substring(0, 200) + '...';
    }

    return '';
  }

  // ========== 3. Card A: Word Collection ==========

  function showWordCard(word, rect) {
    removeCard();
    const sentence = getParentSentence();

    const card = document.createElement('div');
    card.id = 'wordflow-card';
    card.className = 'card-word';
    card.innerHTML = `
      <div class="wf-drag-hint"></div>
      <div class="wf-word-row">
        <span class="wf-word-text">${esc(word)}</span>
      </div>
      <div class="wf-phonetic-row">
        <span class="wf-phonetic" id="wf-phonetic">查询中...</span>
        <span class="wf-speaker" title="发音"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM14 3.23v2.06a7.007 7.007 0 0 1 0 13.42v2.06A9.01 9.01 0 0 0 14 3.23z"/></svg></span>
      </div>
      <div class="wf-dict-section">
        <div class="wf-dict-pos" id="wf-dict-pos"></div>
        <div class="wf-dict-def" id="wf-dict-def">正在查询释义...</div>
      </div>
      <div class="wf-divider"></div>
      <div class="wf-context-section" id="wf-context-section">
        <div class="wf-context-label">✦ 语境释义</div>
        <div class="wf-context-sentence" id="wf-context-sent"></div>
        <div class="wf-context-meaning" id="wf-context-meaning">
          <span class="wf-loading">AI 分析中...</span>
        </div>
      </div>
      <div class="wf-btn-row">
        <button class="wf-btn wf-btn-cancel" id="wf-btn-cancel">取消</button>
        <button class="wf-btn wf-btn-save" id="wf-btn-save">存入词展</button>
      </div>
    `;

    positionCard(card, rect, 340);
    document.body.appendChild(card);
    currentCard = card;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // Events
    card.querySelector('#wf-btn-cancel').addEventListener('click', removeCard);
    card.querySelector('.wf-speaker').addEventListener('click', () => speakWord(word));
    card.querySelector('#wf-btn-save').addEventListener('click', () => saveWord(word));

    // Lookup dictionary
    sendMsg({ action: 'lookupWord', word }).then(entry => {
      if (!card.isConnected) return;
      if (entry) {
        card.querySelector('#wf-phonetic').textContent = entry.phonetic ? `/${entry.phonetic}/` : '';
        const pos = extractPos(entry.definition);
        card.querySelector('#wf-dict-pos').textContent = pos;
        card.querySelector('#wf-dict-def').textContent = entry.definition || '未找到释义';
      } else {
        card.querySelector('#wf-phonetic').textContent = '';
        card.querySelector('#wf-dict-pos').textContent = '';
        card.querySelector('#wf-dict-def').textContent = '未找到释义';
      }
    });

    // Contextual meaning
    const contextSentEl = card.querySelector('#wf-context-sent');
    const contextMeaningEl = card.querySelector('#wf-context-meaning');

    if (sentence) {
      // Truncate long paragraphs around the target word (like Android)
      const displaySentence = truncateAroundWord(sentence, word);
      const regex = new RegExp(`(${escRegex(word)})`, 'gi');
      contextSentEl.innerHTML = `"${esc(displaySentence).replace(regex, '<span class="wf-target">$1</span>')}"`;

      sendMsg({ action: 'contextualMeaning', word, sentence, paragraph: sentence }).then(result => {
        if (!card.isConnected) return;
        if (result && result.meaning) {
          contextMeaningEl.innerHTML = `此处意为<strong>"${esc(result.meaning)}"</strong>${result.explanation ? '——' + esc(result.explanation) : ''}`;
        } else {
          contextMeaningEl.innerHTML = '<span class="wf-loading">暂无法获取语境释义</span>';
        }
      });
    } else {
      contextSentEl.textContent = '';
      contextMeaningEl.innerHTML = '<span class="wf-loading">未检测到上下文</span>';
    }
  }

  function extractPos(definition) {
    const m = definition?.match(/^([a-z]+\.)\s/);
    return m ? m[1] : '';
  }

  async function saveWord(word) {
    const btn = currentCard?.querySelector('#wf-btn-save');
    if (!btn) return;
    btn.textContent = '保存中...';
    btn.classList.add('disabled');

    const sentence = getParentSentence();
    const context = sentence ? {
      text: sentence,
      source: window.location.href,
      provider: 'deepseek'
    } : null;

    const result = await sendMsg({
      action: 'saveWordFromContent',
      word,
      context
    });

    if (!currentCard) return;

    if (result?.status === 'exists') {
      btn.textContent = '已在词展中';
      btn.classList.add('saved');
      setTimeout(removeCard, 1500);
    } else if (result?.status === 'saved') {
      btn.textContent = '已存入';
      btn.classList.add('saved');
      showToast(`"${word}" 已存入词展`);
      setTimeout(removeCard, 1500);
    } else {
      btn.textContent = '存入词展';
      btn.classList.remove('disabled');
    }
  }

  // ========== 4. Card B: Paragraph Translation ==========

  let paraWords = [];
  let paraTranslation = '';
  let paraWordEntries = {}; // word → { phonetic, definition }

  function showParaCard(text, rect) {
    removeCard();

    const tokens = extractTokens(text);
    paraWords = tokens;
    paraTranslation = '';
    paraWordEntries = {};

    const card = document.createElement('div');
    card.id = 'wordflow-card';
    card.className = 'card-para';
    card.innerHTML = `
      <div class="wf-drag-hint"></div>
      <div class="wf-para-header">
        <span class="wf-para-header-label">段落翻译</span>
        <span class="wf-para-header-source" id="wf-para-source">deepseek</span>
      </div>
      <div class="wf-source-section">
        <div class="wf-source-text" id="wf-source-text"></div>
      </div>
      <div class="wf-thick-divider"></div>
      <div class="wf-translation-section">
        <div class="wf-full-translation" id="wf-full-trans">
          <span class="wf-loading">翻译中...</span>
        </div>
        <div class="wf-contextual-panel" id="wf-ctx-panel">
          <div class="wf-context-label">✦ 语境释义 — <strong id="wf-ctx-word"></strong></div>
          <div class="wf-contextual-dict" id="wf-ctx-dict"></div>
          <div class="wf-contextual-ai" id="wf-ctx-ai"></div>
        </div>
      </div>
      <div class="wf-para-footer">
        <span class="wf-save-hint" id="wf-save-hint"></span>
        <span class="wf-footer-hint" id="wf-footer-hint">点击上方单词查看语境释义</span>
        <button class="wf-btn-close" id="wf-btn-close">关闭</button>
      </div>
    `;

    positionCard(card, rect, 420);
    document.body.appendChild(card);
    currentCard = card;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    card.querySelector('#wf-btn-close').addEventListener('click', removeCard);

    // Render tappable words
    renderSourceWords(card, tokens);

    // Translate paragraph
    sendMsg({ action: 'translateParagraph', text }).then(result => {
      if (!card.isConnected) return;
      if (result?.translation) {
        paraTranslation = result.translation;
        card.querySelector('#wf-full-trans').textContent = result.translation;
      } else {
        card.querySelector('#wf-full-trans').textContent = '翻译暂时不可用';
      }
    });
  }

  function renderSourceWords(card, tokens) {
    const container = card.querySelector('#wf-source-text');
    container.innerHTML = tokens.map(t => {
      const isWord = /^[a-zA-Z]/.test(t);
      return `<span class="wf-source-word" data-word="${esc(t)}" style="cursor:${isWord ? 'pointer' : 'default'}">${esc(t)}</span>`;
    }).join('');

    container.querySelectorAll('.wf-source-word').forEach(el => {
      const w = el.dataset.word;
      if (!/^[a-zA-Z]/.test(w)) return;

      el.addEventListener('click', () => onWordTap(card, w, el));
    });
  }

  async function onWordTap(card, word, el) {
    if (card.classList.contains('word-selected') && el.classList.contains('selected')) return;

    // Select word
    card.querySelectorAll('.wf-source-word').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    card.classList.add('word-selected');

    // Update contextual panel
    const ctxWord = card.querySelector('#wf-ctx-word');
    const ctxDict = card.querySelector('#wf-ctx-dict');
    const ctxAi = card.querySelector('#wf-ctx-ai');
    const footerHint = card.querySelector('#wf-footer-hint');
    const saveHint = card.querySelector('#wf-save-hint');

    ctxWord.textContent = word;
    ctxDict.textContent = '查询中...';
    ctxAi.innerHTML = '<span class="wf-loading">AI 语境分析中...</span>';

    // Lookup dictionary
    const entry = await sendMsg({ action: 'lookupWord', word: normalizeWord(word) });
    if (card.isConnected && entry) {
      paraWordEntries[word] = entry;
      ctxDict.textContent = entry.definition || '未找到释义';
    }

    // Get contextual meaning
    const fullText = paraWords.join(' ');
    const result = await sendMsg({
      action: 'contextualMeaning',
      word: normalizeWord(word),
      sentence: fullText,
      paragraph: fullText
    });

    if (!card.isConnected) return;
    if (result?.meaning) {
      ctxAi.innerHTML = `此处意为<strong>"${esc(result.meaning)}"</strong>${result.explanation ? '——' + esc(result.explanation) : ''}`;
    } else {
      ctxAi.innerHTML = '<span class="wf-loading">无法获取语境释义</span>';
    }

    // Auto-save silently
    const contextInfo = {
      text: fullText,
      translation: paraTranslation,
      meaning: result?.meaning || '',
      explanation: result?.explanation || '',
      paragraphTranslation: paraTranslation,
      provider: 'deepseek',
      source: window.location.href
    };

    const saveResult = await sendMsg({
      action: 'saveWordFromContent',
      word: normalizeWord(word),
      context: contextInfo
    });

    if (!card.isConnected) return;
    saveHint.style.display = 'block';
    if (saveResult?.status === 'exists') {
      saveHint.textContent = word + ' 已在词展中';
    } else {
      saveHint.textContent = word + ' 已自动存入词展';
    }
    footerHint.textContent = '点击其他单词切换';
  }

  function extractTokens(text) {
    // Preserve words and punctuation as separate tokens
    return text.match(/[A-Za-z'][A-Za-z'\-]*|[.,!?;:'"()\u2018\u2019\u201C\u201D\u2014\u2013\s]+/g)
      ?.filter(t => t.trim())
      .map(t => t.trim()) || text.split(/\s+/);
  }

  // ========== 5. Card Positioning & Dragging ==========

  function positionCard(card, rect, width) {
    card.style.visibility = 'hidden';
    document.body.appendChild(card);
    const cr = card.getBoundingClientRect();
    document.body.removeChild(card);
    card.style.visibility = '';

    // Default: right third of viewport
    const rightEdge = window.innerWidth - 20;
    let left = rightEdge - cr.width;
    let top = Math.max(20, window.innerHeight * 0.1);

    if (left < 20) left = 20;
    if (top + cr.height > window.innerHeight - 20) {
      top = Math.max(20, window.innerHeight - cr.height - 20);
    }

    card.style.position = 'fixed';
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.zIndex = '2147483647';

    // Drag support
    enableDrag(card);
  }

  function enableDrag(card) {
    let dragging = false;
    let startX, startY, origLeft, origTop;

    const onDown = (e) => {
      // Only drag from header area, not buttons/links
      if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = card.offsetLeft;
      origTop = card.offsetTop;
      card.style.transition = 'none';
      card.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = origLeft + dx;
      let newTop = origTop + dy;

      // Keep within viewport
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - card.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));

      card.style.left = newLeft + 'px';
      card.style.top = newTop + 'px';
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      card.style.cursor = '';
      card.style.transition = '';
    };

    card.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // Touch support
    card.addEventListener('touchstart', (e) => {
      if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
      dragging = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      origLeft = card.offsetLeft;
      origTop = card.offsetTop;
      card.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      let newLeft = origLeft + dx;
      let newTop = origTop + dy;
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - card.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
      card.style.left = newLeft + 'px';
      card.style.top = newTop + 'px';
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      card.style.cursor = '';
      card.style.transition = '';
    });
  }

  // ========== 6. Pronunciation ==========

  function speakWord(word) {
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
    const audio = new Audio(url);
    audio.play().catch(() => {
      sendMsg({ action: 'speakWord', word });
    });
  }

  // ========== 7. Card Removal ==========

  function removeCard() {
    if (currentCard) {
      currentCard.remove();
      currentCard = null;
    }
  }

  // ========== 8. Background Messages (toast) ==========

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'word-saved') {
      showToast(`"${msg.entry.word}" 已存入词展`);
    } else if (msg.type === 'word-exists') {
      showToast(`"${msg.word}" 已在词展中`);
    } else if (msg.type === 'show-paragraph-card') {
      // Right-click triggered: show Card B at center-ish position
      const rect = { top: 100, bottom: 120, left: 100, right: 200 };
      showParaCard(msg.text, rect);
    }
  });

  function showToast(text) {
    const old = document.getElementById('wordflow-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'wordflow-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // ========== 9. Utilities ==========

  function sendMsg(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, resolve);
    });
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function truncateAroundWord(fullText, word, contextChars = 70) {
    if (!fullText || !word) return fullText || '';
    if (fullText.length <= contextChars * 2 + word.length + 30) return fullText;
    const idx = fullText.toLowerCase().indexOf(word.toLowerCase());
    if (idx === -1) return fullText.substring(0, contextChars * 2) + '...';

    let start = Math.max(0, idx - contextChars);
    let end = Math.min(fullText.length, idx + word.length + contextChars);

    // Adjust to nearest word boundary
    while (start > 0 && /[a-zA-Z]/.test(fullText[start])) start--;
    while (end < fullText.length && /[a-zA-Z]/.test(fullText[end])) end++;

    let result = '';
    if (start > 0) result += '...';
    result += fullText.substring(start, end).trim();
    if (end < fullText.length) result += '...';
    return result;
  }

})();
