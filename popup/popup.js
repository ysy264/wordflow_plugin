// ========================================
// WordFlow v2 Popup Script
// 词池列表 + 设置面板 + 导出 + 同步
// ========================================

(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  let words = [];
  let wordContexts = [];
  let expandedId = null;
  let searchQuery = '';
  let sortMode = 'time'; // 'time' | 'alpha'

  // ========== 1. Init ==========

  async function init() {
    await loadData();
    renderList();
    bindEvents();
    loadSettings();
  }

  async function loadData() {
    words = await sendMsg({ action: 'getWords' }) || [];
    wordContexts = await sendMsg({ action: 'getWordContexts' }) || [];
    updateCount();
  }

  function updateCount() {
    $('#count-text').textContent = words.length;
    if (words.length === 0) {
      $('#word-list').classList.add('hidden');
      $('#empty-state').classList.remove('hidden');
    } else {
      $('#word-list').classList.remove('hidden');
      $('#empty-state').classList.add('hidden');
    }
  }

  // ========== 2. Events ==========

  function bindEvents() {
    $('#btn-search').addEventListener('click', () => {
      $('#search-bar').classList.remove('hidden');
      $('#header').classList.add('hidden');
      $('#search-input').focus();
    });

    $('#search-cancel').addEventListener('click', () => {
      $('#search-bar').classList.add('hidden');
      $('#header').classList.remove('hidden');
      $('#search-input').value = '';
      searchQuery = '';
      renderList();
    });

    $('#search-input').addEventListener('input', e => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderList();
    });

    $('#btn-sort').addEventListener('click', () => {
      sortMode = sortMode === 'time' ? 'alpha' : 'time';
      renderList();
    });

    $('#btn-settings').addEventListener('click', () => {
      loadSettings();
      $('#settings-overlay').classList.remove('hidden');
    });

    $('#settings-close').addEventListener('click', () => {
      saveAllSettings();
      $('#settings-overlay').classList.add('hidden');
    });

    $('#btn-export').addEventListener('click', doExport);
    $('#btn-sync').addEventListener('click', syncNow);
  }

  // ========== 3. Render ==========

  function renderList() {
    let list = [...words];

    if (searchQuery) {
      list = list.filter(w =>
        w.word.toLowerCase().includes(searchQuery) ||
        (w.definition || '').includes(searchQuery)
      );
    }

    if (sortMode === 'alpha') {
      list.sort((a, b) => a.word.localeCompare(b.word));
    } else {
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    const container = $('#word-list');

    if (list.length === 0 && searchQuery) {
      container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-muted);font-size:13px">没有匹配的词</div>';
      return;
    }

    container.innerHTML = list.map(w => {
      const expanded = expandedId === w.id;
      const primaryMeaning = extractPrimaryMeaning(w.definition);
      const restMeaning = extractRestMeaning(w.definition);

      return `
        <div class="word-item${expanded ? ' expanded' : ''}" data-id="${w.id}">
          <div class="word-item-header">
            <span class="word-item-word">${esc(w.word)}</span>
          </div>
          <div class="expand-detail">
            <div class="expand-phonetic">${w.phonetic ? '/' + esc(w.phonetic) + '/' : ''}</div>
            <div class="expand-def">
              ${primaryMeaning ? `<span class="meaning-primary">${esc(primaryMeaning)}</span>` : ''}
              ${restMeaning ? `<br><span class="meaning-rest">${esc(restMeaning)}</span>` : ''}
              ${!primaryMeaning && !restMeaning ? esc(w.definition || '') : ''}
            </div>
            <div class="expand-actions">
              <button data-action="speak" data-word="${esc(w.word)}">🔊 发音</button>
              <button data-action="copy" data-word="${esc(w.word)}">📋 复制</button>
              <button data-action="delete" data-id="${w.id}">🗑 删除</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Bind word item clicks
    container.querySelectorAll('.word-item').forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const id = item.dataset.id;
        expandedId = expandedId === id ? null : id;
        renderList();
      });
    });

    // Bind action buttons
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'speak') speakWord(btn.dataset.word);
        else if (action === 'copy') copyText(btn.dataset.word);
        else if (action === 'delete') {
          await deleteWord(btn.dataset.id);
        }
      });
    });
  }

  function extractPrimaryMeaning(def) {
    if (!def) return '';
    const lines = def.split('\n').filter(Boolean);
    if (lines.length === 0) return '';
    const first = lines[0].replace(/^[a-z]+\.\s*/i, '');
    return first.trim();
  }

  function extractRestMeaning(def) {
    if (!def) return '';
    const lines = def.split('\n').filter(Boolean);
    if (lines.length <= 1) return '';
    return lines.slice(1).join('；').replace(/^[a-z]+\.\s*/gi, '');
  }

  // ========== 4. Actions ==========

  function speakWord(word) {
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
    new Audio(url).play().catch(() => {});
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => toast('已复制'));
  }

  async function deleteWord(id) {
    await sendMsg({ action: 'deleteWord', id });
    words = words.filter(w => w.id !== id);
    if (expandedId === id) expandedId = null;
    updateCount();
    renderList();
  }

  // ========== 5. Export ==========

  function doExport() {
    const format = $('#sel-export').value;
    const configs = {
      bubei: { fn: 'wordflow_bubei.txt', gen: w => w.word, minCount: 20 },
      momo: { fn: 'wordflow_momo.txt', gen: w => w.definition ? `${w.word}##${w.definition}` : w.word },
      anki: { fn: 'wordflow_anki.txt', gen: w => `${w.word}\t${w.phonetic || ''}\t${w.definition || ''}` },
      quizlet: { fn: 'wordflow_quizlet.txt', gen: w => `${w.word}\t${w.definition || ''}` },
      txt: { fn: 'wordflow_export.txt', gen: w => w.word },
      csv: { fn: 'wordflow_export.csv', gen: null }
    };

    const cfg = configs[format] || configs.txt;

    if (cfg.minCount && words.length < cfg.minCount) {
      toast(`不背单词至少需要 ${cfg.minCount} 个词，还差 ${cfg.minCount - words.length} 个`);
      return;
    }

    let content;
    if (format === 'csv') {
      content = '\uFEFFword,phonetic,definition\n' +
        words.map(w => `"${w.word}","${w.phonetic || ''}","${(w.definition || '').replace(/"/g, '""')}"`).join('\n');
    } else {
      content = words.map(cfg.gen).join('\n');
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = cfg.fn;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 ' + cfg.fn);
  }

  // ========== 6. Settings ==========

  async function loadSettings() {
    const data = await new Promise(resolve => {
      chrome.storage.local.get({
        selectionMode: 'auto',
        autoSpeak: false,
        deepseekKey: '',
        webdavUser: '',
        webdavPass: ''
      }, resolve);
    });

    $('#sel-mode').value = data.selectionMode;
    $('#auto-speak').checked = data.autoSpeak;
    $('#deepseek-key').value = data.deepseekKey;
    $('#webdav-user').value = data.webdavUser;
    $('#webdav-pass').value = data.webdavPass;

    // Bind settings save events
    $('#sel-mode').onchange = saveAllSettings;
    $('#auto-speak').onchange = saveAllSettings;
    $('#deepseek-key').onblur = saveAllSettings;
    $('#webdav-user').onblur = saveAllSettings;
    $('#webdav-pass').onblur = saveAllSettings;

    // Sync/test buttons
    $('#btn-test-webdav').onclick = testWebDAV;
    $('#btn-sync-now').onclick = syncNow;
    $('#btn-clear-reviews').onclick = () => {
      if (confirm('确定要清空所有复习进度吗？此操作不可撤销。')) {
        toast('复习进度已清空');
      }
    };
  }

  function saveAllSettings() {
    chrome.storage.local.set({
      selectionMode: $('#sel-mode').value,
      autoSpeak: $('#auto-speak').checked,
      deepseekKey: $('#deepseek-key').value.trim()
    });

    const user = $('#webdav-user').value.trim();
    const pass = $('#webdav-pass').value.trim();
    if (user || pass) {
      sendMsg({ action: 'saveWebDAVConfig', user, pass });
    }
  }

  // ========== 7. WebDAV Sync ==========

  async function testWebDAV() {
    const user = $('#webdav-user').value.trim();
    const pass = $('#webdav-pass').value.trim();
    if (!user || !pass) {
      setSyncStatus('请填写账号和应用密码', 'error');
      return;
    }
    await sendMsg({ action: 'saveWebDAVConfig', user, pass });
    setSyncStatus('测试中...', '');
    const result = await sendMsg({ action: 'testWebDAV', user, pass });
    setSyncStatus(result?.ok ? '连接成功！' : '连接失败，请检查', result?.ok ? 'success' : 'error');
  }

  async function syncNow() {
    // Read credentials directly from storage (not just DOM inputs)
    const config = await new Promise(resolve => {
      chrome.storage.local.get({ webdavUser: '', webdavPass: '' }, resolve);
    });
    const user = config.webdavUser;
    const pass = config.webdavPass;

    if (!user || !pass) {
      toast('请先配置坚果云账号');
      $('#settings-overlay').classList.remove('hidden');
      return;
    }

    toast('正在同步...');
    const result = await sendMsg({ action: 'doSync' });
    if (result?.ok) {
      toast(`同步完成 · ${result.stats.words} 词`);
      await loadData();
      renderList();
      // Also update the settings status if visible
      setSyncStatus(`同步成功！${result.stats.words} 词`, 'success');
    } else {
      toast('同步失败: ' + (result?.error || '连接错误'));
      setSyncStatus('同步失败: ' + (result?.error || '未知错误'), 'error');
    }
  }

  function setSyncStatus(text, cls) {
    const el = $('#sync-status');
    el.textContent = text;
    el.className = 'sync-status ' + (cls || '');
  }

  // ========== 8. Utilities ==========

  function sendMsg(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function toast(text) {
    const old = document.getElementById('popup-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'popup-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ========== Start ==========

  init();
})();
