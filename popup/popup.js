// ========================================
// WordFlow Popup Script
// 词池 + 句池 + 搜索 + 导出 + 设置
// ========================================

(() => {
  'use strict';

  // ========== 状态 ==========

  let words = [];
  let sentences = [];
  let activeTab = 'words';  // 'words' | 'sentences'
  let expandedId = null;
  let searchQuery = '';

  // ========== DOM ==========

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ========== 1. 初始化 ==========

  async function init() {
    await loadData();
    renderList();
    bindEvents();
    loadSettings();
    autoSync();
  }

  async function loadData() {
    words = await sendMessage({ action: 'getWords' }) || [];
    sentences = await sendMessage({ action: 'getSentences' }) || [];
    updateCounts();
  }

  function updateCounts() {
    $('#word-count').textContent = words.length;
    $('#sentence-count').textContent = sentences.length;
    // 导出按钮状态
    const currentItems = activeTab === 'words' ? words.length : sentences.length;
    $('#btn-export').disabled = currentItems === 0;
  }

  // ========== 2. Tab 切换 ==========

  function bindEvents() {
    // Tab 切换
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $$('.panel').forEach(p => p.classList.remove('active'));
        $(`#${activeTab}-panel`).classList.add('active');
        expandedId = null;
        updateCounts();
        renderList();
      });
    });

    // 搜索
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

    $('#search-input').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderList();
    });

    // 设置
    $('#btn-settings').addEventListener('click', showSettings);
    $('#settings-back').addEventListener('click', hideSettings);

    // 导出
    $('#btn-export').addEventListener('click', showExport);
    $('#export-back').addEventListener('click', hideExport);
    $('#guide-back').addEventListener('click', () => {
      $('#export-guide-page').classList.add('hidden');
      $('#export-page').classList.remove('hidden');
    });

    // 导出项点击
    $$('.export-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('disabled')) return;
        doExport(item.dataset.target);
      });
    });

    // 设置项
    $$('input[name="selectionMode"]').forEach(radio => {
      radio.addEventListener('change', saveSettings);
    });
    $('#auto-speak').addEventListener('change', saveSettings);

    // WebDAV 同步
    $('#btn-test-webdav').addEventListener('click', testWebDAV);
    $('#btn-sync-now').addEventListener('click', syncNow);

    // WebDAV 输入框失焦时自动保存配置
    $('#webdav-user').addEventListener('blur', saveWebDAVConfig);
    $('#webdav-pass').addEventListener('blur', saveWebDAVConfig);
  }

  // ========== 3. 渲染词列表 ==========

  function renderList() {
    if (activeTab === 'words') {
      renderWords();
    } else {
      renderSentences();
    }
  }

  function renderWords() {
    const container = $('#words-list');
    const empty = $('#words-empty');

    let filtered = words;
    if (searchQuery) {
      filtered = words.filter(w =>
        w.word.toLowerCase().includes(searchQuery) ||
        (w.definition && w.definition.includes(searchQuery))
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    container.innerHTML = filtered.map(w => `
      <div class="word-item ${expandedId === w.id ? 'expanded' : ''}" data-id="${w.id}">
        <div class="word-item-word">${escapeHtml(w.word)}</div>
        <div class="word-detail">
          <div class="word-detail-row">
            <span class="word-detail-phonetic">${w.phonetic ? '/' + escapeHtml(w.phonetic) + '/' : ''}</span>
          </div>
          <div class="word-detail-def">${escapeHtml(w.definition || '未找到释义')}</div>
          <div class="word-detail-actions">
            <span class="word-action-btn" data-action="speak" data-word="${escapeHtml(w.word)}" title="发音">🔊</span>
            <span class="word-action-btn" data-action="copy" data-word="${escapeHtml(w.word)}" title="复制">📋</span>
            <span class="word-action-btn" data-action="delete" data-id="${w.id}" title="删除">🗑️</span>
          </div>
        </div>
      </div>
    `).join('');

    // 绑定点击事件
    container.querySelectorAll('.word-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // 如果点击的是操作按钮，不触发展开
        if (e.target.closest('.word-action-btn')) return;
        const id = item.dataset.id;
        expandedId = expandedId === id ? null : id;
        renderWords();
      });
    });

    // 操作按钮事件
    container.querySelectorAll('.word-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'speak') {
          speakWord(btn.dataset.word);
        } else if (action === 'copy') {
          copyText(btn.dataset.word);
        } else if (action === 'delete') {
          deleteWord(btn.dataset.id);
        }
      });
    });
  }

  // ========== 4. 渲染句列表 ==========

  function renderSentences() {
    const container = $('#sentences-list');
    const empty = $('#sentences-empty');

    let filtered = sentences;
    if (searchQuery) {
      filtered = sentences.filter(s =>
        s.text.toLowerCase().includes(searchQuery)
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    container.innerHTML = filtered.map(s => {
      let shortUrl = '';
      try { if (s.source) shortUrl = new URL(s.source).hostname; } catch(e) { shortUrl = s.source || ''; }
      return `
        <div class="sentence-item ${expandedId === s.id ? 'expanded' : ''}" data-id="${s.id}">
          <div class="sentence-item-text">${escapeHtml(s.text)}</div>
          <div class="sentence-detail">
            ${shortUrl ? `<div class="sentence-source">来源: ${escapeHtml(shortUrl)}</div>` : ''}
            <div class="sentence-actions">
              <span class="word-action-btn" data-action="copy-sentence" data-text="${escapeAttr(s.text)}" title="复制原文">📋</span>
              <span class="word-action-btn" data-action="delete-sentence" data-id="${s.id}" title="删除">🗑️</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 绑定事件
    container.querySelectorAll('.sentence-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.word-action-btn')) return;
        const id = item.dataset.id;
        expandedId = expandedId === id ? null : id;
        renderSentences();
      });
    });

    container.querySelectorAll('.word-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'copy-sentence') {
          copyText(btn.dataset.text);
        } else if (action === 'delete-sentence') {
          deleteSentence(btn.dataset.id);
        }
      });
    });
  }

  // ========== 5. 操作：发音、复制、删除 ==========

  function speakWord(word) {
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
    new Audio(url).play().catch(() => {});
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
      showPopupToast('已复制');
    });
  }

  async function deleteWord(id) {
    await sendMessage({ action: 'deleteWord', id });
    words = words.filter(w => w.id !== id);
    if (expandedId === id) expandedId = null;
    updateCounts();
    renderList();
  }

  async function deleteSentence(id) {
    await sendMessage({ action: 'deleteSentence', id });
    sentences = sentences.filter(s => s.id !== id);
    if (expandedId === id) expandedId = null;
    updateCounts();
    renderList();
  }

  // ========== 6. 设置 ==========

  function showSettings() {
    $('#stats-text').textContent = `累计 ${words.length} 词 · ${sentences.length} 句`;
    $('#settings-page').classList.remove('hidden');
  }

  function hideSettings() {
    $('#settings-page').classList.add('hidden');
  }

  function loadSettings() {
    chrome.storage.local.get({
      selectionMode: 'auto',
      autoSpeak: false
    }, (data) => {
      const radio = document.querySelector(`input[name="selectionMode"][value="${data.selectionMode}"]`);
      if (radio) radio.checked = true;
      $('#auto-speak').checked = data.autoSpeak;
    });

    // 加载 WebDAV 配置
    sendMessage({ action: 'getWebDAVConfig' }).then(config => {
      if (config) {
        $('#webdav-user').value = config.user || '';
        $('#webdav-pass').value = config.pass || '';
      }
    });
  }

  function saveSettings() {
    const mode = document.querySelector('input[name="selectionMode"]:checked').value;
    const autoSpeak = $('#auto-speak').checked;
    chrome.storage.local.set({
      selectionMode: mode,
      autoSpeak: autoSpeak
    });
  }

  // ========== 6.5 WebDAV 同步 ==========

  function saveWebDAVConfig() {
    const user = $('#webdav-user').value.trim();
    const pass = $('#webdav-pass').value.trim();
    sendMessage({ action: 'saveWebDAVConfig', user, pass });
  }

  function setSyncStatus(text, type) {
    const el = $('#sync-status');
    el.textContent = text;
    el.className = 'sync-status ' + (type || '');
  }

  async function testWebDAV() {
    const user = $('#webdav-user').value.trim();
    const pass = $('#webdav-pass').value.trim();

    if (!user || !pass) {
      setSyncStatus('请填写账号和应用密码', 'error');
      return;
    }

    // 先保存
    await sendMessage({ action: 'saveWebDAVConfig', user, pass });

    setSyncStatus('正在测试连接...', 'loading');
    $('#btn-test-webdav').disabled = true;

    const result = await sendMessage({ action: 'testWebDAV', user, pass });

    $('#btn-test-webdav').disabled = false;

    if (result && result.ok) {
      setSyncStatus('连接成功！', 'success');
    } else {
      setSyncStatus('连接失败，请检查账号和应用密码', 'error');
    }
  }

  async function syncNow() {
    const user = $('#webdav-user').value.trim();
    const pass = $('#webdav-pass').value.trim();

    if (!user || !pass) {
      setSyncStatus('请先配置坚果云账号', 'error');
      return;
    }

    // 先保存配置
    await sendMessage({ action: 'saveWebDAVConfig', user, pass });

    setSyncStatus('正在同步...', 'loading');
    $('#btn-sync-now').disabled = true;

    const result = await sendMessage({ action: 'doSync' });

    $('#btn-sync-now').disabled = false;

    if (result && result.ok) {
      setSyncStatus(`同步成功！词池 ${result.stats.words} 词 · ${result.stats.sentences} 句`, 'success');
      // 刷新本地数据和列表
      await loadData();
      renderList();
    } else {
      setSyncStatus('同步失败: ' + (result ? result.error : '未知错误'), 'error');
    }
  }

  // ========== 6.6 自动同步 ==========

  async function autoSync() {
    const config = await sendMessage({ action: 'getWebDAVConfig' });

    // 未配置坚果云 → 显示提醒条
    if (!config || !config.user || !config.pass) {
      showSyncBanner('☁️ 未配置云同步，数据仅保存在本地', 'warn', () => {
        showSettings();
      });
      return;
    }

    // 已配置 → 静默同步
    showSyncBanner('☁️ 正在同步...', 'loading');
    const result = await sendMessage({ action: 'doSync' });

    if (result && result.ok) {
      const oldWordCount = words.length;
      const oldSentenceCount = sentences.length;
      await loadData();
      renderList();

      const newWords = words.length - oldWordCount;
      const newSentences = sentences.length - oldSentenceCount;

      if (newWords > 0 || newSentences > 0) {
        const parts = [];
        if (newWords > 0) parts.push(`${newWords} 个新词`);
        if (newSentences > 0) parts.push(`${newSentences} 个新句`);
        showSyncBanner(`☁️ 已同步，新增 ${parts.join(' + ')}`, 'success');
      } else {
        showSyncBanner('☁️ 已同步，数据是最新的', 'success');
      }
      // 3秒后隐藏
      setTimeout(hideSyncBanner, 3000);
    } else {
      showSyncBanner('☁️ 同步失败: ' + (result ? result.error : '连接错误'), 'error');
    }
  }

  function showSyncBanner(text, type, onClick) {
    hideSyncBanner();
    const banner = document.createElement('div');
    banner.id = 'sync-banner';
    banner.className = 'sync-banner sync-banner-' + type;
    banner.textContent = text;
    if (onClick) {
      banner.style.cursor = 'pointer';
      banner.addEventListener('click', onClick);
      banner.textContent += ' →';
    }
    // 插入到 header 后面
    const header = $('#header');
    header.parentNode.insertBefore(banner, header.nextSibling);
  }

  function hideSyncBanner() {
    const old = document.getElementById('sync-banner');
    if (old) old.remove();
  }

  // ========== 7. 导出 ==========

  const EXPORT_CONFIG = {
    bubei: {
      name: '不背单词',
      icon: '📗',
      minWords: 20,
      guide: '1. 打开浏览器访问 bbdc.cn\n2. 登录不背单词账号\n3. 点击「导入词书」\n4. 上传刚才下载的文件',
      url: 'https://bbdc.cn'
    },
    momo: {
      name: '墨墨背单词',
      icon: '📘',
      guide: '1. 打开墨墨背单词 App\n2. 我的 → 自定义词书 → 导入\n3. 选择刚才下载的文件'
    },
    anki: {
      name: 'Anki',
      icon: '📙',
      guide: '1. 打开 Anki\n2. 文件 → 导入\n3. 选择文件，分隔符选 Tab\n4. 字段对应：正面=单词，背面=释义'
    },
    quizlet: {
      name: 'Quizlet',
      icon: '📕',
      guide: '1. 打开 quizlet.com\n2. 创建学习集 → 导入\n3. 粘贴文件内容或上传\n4. 分隔符选 Tab',
      url: 'https://quizlet.com/create-set'
    },
    txt: {
      name: '通用 TXT',
      icon: '📄',
      guide: '文件已下载，可直接使用'
    },
    csv: {
      name: '通用 CSV',
      icon: '📊',
      guide: '文件已下载，可用 Excel 或 WPS 打开'
    }
  };

  function showExport() {
    const currentItems = activeTab === 'words' ? words.length : sentences.length;
    const label = activeTab === 'words' ? '词' : '句';

    $('#export-info').textContent = `当前 ${currentItems} 个${label}`;

    // 存储原始描述（首次，必须在修改前）
    $$('.export-item .export-desc').forEach(desc => {
      if (!desc.dataset.original) {
        desc.dataset.original = desc.textContent;
      }
    });

    // 句池模式下只显示通用导出格式
    const sentenceOnlyTargets = ['txt', 'csv', 'anki'];

    // 检查限制并更新显示
    $$('.export-item').forEach(item => {
      const target = item.dataset.target;
      const config = EXPORT_CONFIG[target];
      const descEl = item.querySelector('.export-desc');
      item.classList.remove('disabled');
      item.style.display = '';

      // 句池模式下隐藏不支持的导出格式
      if (activeTab === 'sentences' && !sentenceOnlyTargets.includes(target)) {
        item.style.display = 'none';
        return;
      }

      if (config && config.minWords && activeTab === 'words' && currentItems < config.minWords) {
        item.classList.add('disabled');
        descEl.innerHTML = `<span class="export-warn">至少需要 ${config.minWords} 个词，还差 ${config.minWords - currentItems} 个</span>`;
      } else {
        descEl.textContent = descEl.dataset.original || descEl.textContent;
      }
    });

    if (currentItems === 0) {
      $('#btn-export').disabled = true;
    }

    $('#export-page').classList.remove('hidden');
  }

  function hideExport() {
    $('#export-page').classList.add('hidden');
  }

  function doExport(target) {
    let content = '';
    let filename = '';
    const items = activeTab === 'words' ? words : sentences;

    if (activeTab === 'words') {
      switch (target) {
        case 'bubei':
          content = items.map(w => w.word).join('\n');
          filename = 'wordflow_bubei.txt';
          break;
        case 'momo':
          content = items.map(w => {
            return w.definition ? `${w.word}##${w.definition}` : w.word;
          }).join('\n');
          filename = 'wordflow_momo.txt';
          break;
        case 'anki':
          content = items.map(w => `${w.word}\t${w.phonetic || ''}\t${w.definition || ''}`).join('\n');
          filename = 'wordflow_anki.txt';
          break;
        case 'quizlet':
          content = items.map(w => `${w.word}\t${w.definition || ''}`).join('\n');
          filename = 'wordflow_quizlet.txt';
          break;
        case 'txt':
          content = items.map(w => w.word).join('\n');
          filename = 'wordflow_export.txt';
          break;
        case 'csv':
          content = '\uFEFFword,phonetic,definition\n' +
            items.map(w => `"${w.word}","${w.phonetic || ''}","${(w.definition || '').replace(/"/g, '""')}"`).join('\n');
          filename = 'wordflow_export.csv';
          break;
      }
    } else {
      // 句池导出
      switch (target) {
        case 'txt':
          content = items.map(s => s.text).join('\n');
          filename = 'wordflow_sentences.txt';
          break;
        case 'csv':
          content = '\uFEFFsentence,translation,source\n' +
            items.map(s => `"${s.text.replace(/"/g, '""')}","${(s.translation || '').replace(/"/g, '""')}","${s.source || ''}"`).join('\n');
          filename = 'wordflow_sentences.csv';
          break;
        case 'anki':
          content = items.map(s => `${s.text}\t${s.translation || ''}`).join('\n');
          filename = 'wordflow_sentences_anki.txt';
          break;
        default:
          content = items.map(s => s.text).join('\n');
          filename = `wordflow_sentences_${target}.txt`;
          break;
      }
    }

    // 下载文件
    downloadFile(content, filename);

    // 显示引导
    showExportGuide(target, filename);
  }

  function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showExportGuide(target, filename) {
    const config = EXPORT_CONFIG[target];
    if (!config) return;

    const guide = $('#guide-content');
    guide.innerHTML = `
      <div class="guide-success">
        <span class="guide-success-icon">${config.icon}</span>
        <span class="guide-success-text">✅ 已导出 · ${config.name}</span>
      </div>
      <div class="guide-file">📁 ${filename}</div>
      <div class="guide-steps-title">接下来：</div>
      <div class="guide-steps">${escapeHtml(config.guide).replace(/\n/g, '<br>')}</div>
      <div class="guide-buttons">
        ${config.url ? `<button class="guide-btn guide-btn-primary" onclick="window.open('${config.url}')">打开网页</button>` : ''}
        <button class="guide-btn guide-btn-secondary" id="guide-copy-btn">复制到剪贴板</button>
        <button class="guide-btn guide-btn-secondary" id="guide-done-btn">知道了</button>
      </div>
    `;

    $('#export-page').classList.add('hidden');
    $('#export-guide-page').classList.remove('hidden');

    // 复制到剪贴板（复制文件内容）
    guide.querySelector('#guide-copy-btn')?.addEventListener('click', () => {
      const items = activeTab === 'words' ? words : sentences;
      const text = activeTab === 'words'
        ? items.map(w => w.word).join('\n')
        : items.map(s => s.text).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        guide.querySelector('#guide-copy-btn').textContent = '✓ 已复制';
      });
    });

    guide.querySelector('#guide-done-btn')?.addEventListener('click', () => {
      $('#export-guide-page').classList.add('hidden');
    });
  }

  // ========== 8. 工具函数 ==========

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, resolve);
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showPopupToast(text) {
    const old = document.getElementById('popup-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'popup-toast';
    toast.textContent = text;
    toast.style.cssText = `
      position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
      background: #333; color: #fff; padding: 6px 16px; border-radius: 6px;
      font-size: 13px; z-index: 1000; pointer-events: none;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1500);
  }

  // ========== 启动 ==========

  init();

})();
