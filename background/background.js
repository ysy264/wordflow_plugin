// ========================================
// WordFlow Background Service Worker
// 右键菜单 + 数据存储管理 + WebDAV 同步
// ========================================

// ---------- 1. 右键菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  // 选中文字时显示的右键菜单
  chrome.contextMenus.create({
    id: 'wordflow-save',
    title: '存入 WordFlow',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'wordflow-save') {
    const text = info.selectionText.trim();
    if (!text) return;

    if (isSentence(text)) {
      saveSentence(text, tab);
    } else {
      saveWord(text, tab);
    }
  }
});

// ---------- 2. 判断单词还是句子 ----------

function isSentence(text) {
  // 超过3个空格分隔的词 → 当作句子
  const wordCount = text.split(/\s+/).length;
  return wordCount > 3;
}

// ---------- 3. 存入单词 ----------

async function saveWord(text, tab) {
  const word = text.toLowerCase().replace(/[^a-zA-Z'\-\s]/g, '').trim();
  if (!word) return;

  const data = await chrome.storage.local.get({ words: [] });
  const words = data.words;

  // 去重
  const exists = words.some(w => w.word === word);
  if (exists) {
    // 通知 content script 显示"已在词池中"
    notifyContentScript(tab.id, {
      type: 'word-exists',
      word: word
    });
    return;
  }

  // 查词典
  const entry = await lookupWord(word);

  const newWord = {
    id: Date.now().toString(),
    word: entry ? entry.word : word,
    phonetic: entry ? entry.phonetic : '',
    definition: entry ? entry.definition : '',
    createdAt: Date.now(),
    exported: false
  };

  words.unshift(newWord);
  await chrome.storage.local.set({ words });

  // 通知 content script 显示成功浮层
  notifyContentScript(tab.id, {
    type: 'word-saved',
    entry: newWord
  });

  // 更新 badge
  updateBadge();
}

// ---------- 4. 存入句子 ----------

async function saveSentence(text, tab) {
  const sentence = text.trim();
  if (!sentence) return;

  const data = await chrome.storage.local.get({ sentences: [] });
  const sentences = data.sentences;

  // 去重（完全相同的句子）
  const exists = sentences.some(s => s.text === sentence);
  if (exists) {
    notifyContentScript(tab.id, {
      type: 'sentence-exists',
      text: sentence
    });
    return;
  }

  const newSentence = {
    id: Date.now().toString(),
    text: sentence,
    translation: '',  // 翻译留空，以后加
    source: tab.url || '',
    createdAt: Date.now(),
    exported: false
  };

  sentences.unshift(newSentence);
  await chrome.storage.local.set({ sentences });

  notifyContentScript(tab.id, {
    type: 'sentence-saved',
    entry: newSentence
  });

  updateBadge();
}

// ---------- 5. 查词典（有道在线） ----------

async function lookupWord(word) {
  const target = word.toLowerCase();
  // 有道接口偶尔会返回上次查询的缓存词条（已观察到 interface 被串成
  // timer/Nebuchadnezzar），所以重试最多 3 次，每次加随机参数绕缓存
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bust = attempt === 0 ? '' : `&_=${Date.now()}_${attempt}`;
      const url = `https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&le=en&q=${encodeURIComponent(word)}${bust}`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const entry = parseYoudaoEntry(json, target, word);
      if (entry) return entry;
    } catch (e) {
      console.warn(`WordFlow: 词典查询失败（第 ${attempt + 1} 次）`, e);
    }
  }
  return null;
}

function parseYoudaoEntry(json, target, originalWord) {
  let phonetic = '';
  let definition = '';

  // 关键防御：每个字段都必须校验真的属于当前查询词，不匹配就不用

  // 提取 ec.word 对应词条
  if (json.ec && json.ec.word) {
    const wordList = Array.isArray(json.ec.word) ? json.ec.word : [json.ec.word];
    const getPhrase = (w) => {
      const rp = w && w['return-phrase'];
      if (!rp) return '';
      if (typeof rp === 'string') return rp;
      const i = rp.l && rp.l.i;
      return Array.isArray(i) ? (i[0] || '') : (i || '');
    };
    const wordData = wordList.find(w => getPhrase(w).toLowerCase() === target);

    if (wordData) {
      phonetic = wordData.usphone || wordData.ukphone || '';
      const trs = wordData.trs || [];
      if (trs.length > 0) {
        definition = trs.map(tr => {
          if (tr.pos && tr.tran) return `${tr.pos} ${tr.tran}`;
          if (tr.tr && tr.tr[0] && tr.tr[0].l && tr.tr[0].l.i) {
            return tr.tr[0].l.i[0];
          }
          return '';
        }).filter(Boolean).join('\n');
      }
    }
  }

  // 从 simple.word 补音标，同样必须匹配
  if (!phonetic && json.simple && json.simple.word) {
    const swList = Array.isArray(json.simple.word) ? json.simple.word : [json.simple.word];
    const sw = swList.find(s => ((s && s.word) || '').toLowerCase() === target);
    if (sw) phonetic = sw.usphone || sw.ukphone || '';
  }

  // 兜底：web_trans 也要核对 key 是查询词
  if (!definition && json.web_trans && json.web_trans['web-translation']) {
    const wt = json.web_trans['web-translation'].find(t => {
      const k = t && t.key;
      return typeof k === 'string' && k.toLowerCase() === target;
    });
    if (wt && wt.trans) {
      definition = wt.trans.map(t => t.value).filter(Boolean).slice(0, 3).join('; ');
    }
  }

  if (definition) {
    return { word: originalWord, phonetic, definition };
  }
  return null;
}

// ---------- 6. 通知 Content Script ----------

function notifyContentScript(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // content script 可能未加载，忽略
  });
}

// ---------- 7. Badge 显示总词数 ----------

async function updateBadge() {
  const data = await chrome.storage.local.get({ words: [], sentences: [] });
  const total = data.words.length + data.sentences.length;
  chrome.action.setBadgeText({ text: total > 0 ? total.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#E8752A' });
}

// 启动时更新 badge
updateBadge();

// ---------- 8. Offscreen 音频播放 ----------

let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play word pronunciation audio'
    });
    offscreenCreated = true;
  } catch (e) {
    // 已存在，忽略
    offscreenCreated = true;
  }
}

async function speakWordViaOffscreen(word) {
  await ensureOffscreen();
  const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
  chrome.runtime.sendMessage({ action: 'playAudio', url });
}

// ---------- 9. 监听来自 popup/content 的消息 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getWords') {
    chrome.storage.local.get({ words: [] }, data => {
      sendResponse(data.words);
    });
    return true;
  }

  if (msg.action === 'getSentences') {
    chrome.storage.local.get({ sentences: [] }, data => {
      sendResponse(data.sentences);
    });
    return true;
  }

  if (msg.action === 'deleteWord') {
    chrome.storage.local.get({ words: [], deletedIds: [] }, data => {
      data.words = data.words.filter(w => w.id !== msg.id);
      data.deletedIds.push(msg.id);  // 记录删除，同步时用
      chrome.storage.local.set({ words: data.words, deletedIds: data.deletedIds }, () => {
        updateBadge();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.action === 'deleteSentence') {
    chrome.storage.local.get({ sentences: [], deletedIds: [] }, data => {
      data.sentences = data.sentences.filter(s => s.id !== msg.id);
      data.deletedIds.push(msg.id);  // 记录删除，同步时用
      chrome.storage.local.set({ sentences: data.sentences, deletedIds: data.deletedIds }, () => {
        updateBadge();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.action === 'lookupWord') {
    lookupWord(msg.word).then(entry => {
      sendResponse(entry);
    });
    return true;
  }

  if (msg.action === 'updateBadge') {
    updateBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'saveWordFromContent') {
    // content script 直接请求保存
    const text = msg.word;
    chrome.storage.local.get({ words: [] }, async (data) => {
      const word = text.toLowerCase().replace(/[^a-zA-Z'\-\s]/g, '').trim();
      const exists = data.words.some(w => w.word === word);
      if (exists) {
        sendResponse({ status: 'exists' });
        return;
      }
      const entry = await lookupWord(word);
      const newWord = {
        id: Date.now().toString(),
        word: entry ? entry.word : word,
        phonetic: entry ? entry.phonetic : '',
        definition: entry ? entry.definition : '',
        createdAt: Date.now(),
        exported: false
      };
      data.words.unshift(newWord);
      await chrome.storage.local.set({ words: data.words });
      updateBadge();
      sendResponse({ status: 'saved', entry: newWord });
    });
    return true;
  }

  if (msg.action === 'speakWord') {
    speakWordViaOffscreen(msg.word);
    return false;
  }

  if (msg.action === 'saveSentenceFromContent') {
    const text = msg.text;
    chrome.storage.local.get({ sentences: [] }, async (data) => {
      const exists = data.sentences.some(s => s.text === text);
      if (exists) {
        sendResponse({ status: 'exists' });
        return;
      }
      const newSentence = {
        id: Date.now().toString(),
        text: text,
        translation: '',
        source: msg.source || '',
        createdAt: Date.now(),
        exported: false
      };
      data.sentences.unshift(newSentence);
      await chrome.storage.local.set({ sentences: data.sentences });
      updateBadge();
      sendResponse({ status: 'saved', entry: newSentence });
    });
    return true;
  }

  // ---------- WebDAV 同步 ----------

  if (msg.action === 'testWebDAV') {
    testWebDAVConnection(msg.user, msg.pass).then(ok => {
      sendResponse({ ok });
    });
    return true;
  }

  if (msg.action === 'doSync') {
    doSync().then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.action === 'saveWebDAVConfig') {
    chrome.storage.local.set({
      webdavUser: msg.user,
      webdavPass: msg.pass
    }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'getWebDAVConfig') {
    chrome.storage.local.get({ webdavUser: '', webdavPass: '' }, data => {
      sendResponse({ user: data.webdavUser, pass: data.webdavPass });
    });
    return true;
  }
});

// ==========================================================
// WebDAV Sync (坚果云)
// ==========================================================

const WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/';
const SYNC_FOLDER = 'WordFlow';
const SYNC_FILE = 'wordflow_sync.json';
const SYNC_PATH = `${WEBDAV_BASE}${SYNC_FOLDER}/${SYNC_FILE}`;
const FOLDER_PATH = `${WEBDAV_BASE}${SYNC_FOLDER}/`;

async function getWebDAVCredentials() {
  const data = await chrome.storage.local.get({ webdavUser: '', webdavPass: '' });
  if (!data.webdavUser || !data.webdavPass) return null;
  return { user: data.webdavUser, pass: data.webdavPass };
}

function makeAuthHeader(cred) {
  return 'Basic ' + btoa(cred.user + ':' + cred.pass);
}

async function webdavGet(cred) {
  const resp = await fetch(SYNC_PATH, {
    method: 'GET',
    headers: { 'Authorization': makeAuthHeader(cred) }
  });
  if (resp.status === 404 || resp.status === 409) return null;
  if (!resp.ok) throw new Error(`WebDAV GET failed: ${resp.status}`);
  return await resp.json();
}

async function webdavPut(cred, data) {
  await webdavMkdir(cred);
  const resp = await fetch(SYNC_PATH, {
    method: 'PUT',
    headers: {
      'Authorization': makeAuthHeader(cred),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(data, null, 2)
  });
  if (!resp.ok) throw new Error(`WebDAV PUT failed: ${resp.status}`);
  return true;
}

async function webdavMkdir(cred) {
  const resp = await fetch(FOLDER_PATH, {
    method: 'MKCOL',
    headers: { 'Authorization': makeAuthHeader(cred) }
  });
  return resp.status === 201 || resp.status === 405 || resp.status === 409;
}

async function testWebDAVConnection(user, pass) {
  try {
    const resp = await fetch(WEBDAV_BASE, {
      method: 'PROPFIND',
      headers: {
        'Authorization': 'Basic ' + btoa(user + ':' + pass),
        'Depth': '0'
      }
    });
    return resp.status === 207;
  } catch (e) {
    return false;
  }
}

async function doSync() {
  const cred = await getWebDAVCredentials();
  if (!cred) return { ok: false, error: '未配置 WebDAV 账号' };

  try {
    const local = await chrome.storage.local.get({ words: [], sentences: [], deletedIds: [] });
    let remote = await webdavGet(cred);
    if (!remote) remote = { version: 1, words: [], sentences: [], deletedIds: [] };

    const merged = mergeData(local, remote);

    await webdavPut(cred, {
      version: 1,
      lastModified: Date.now(),
      platform: 'chrome-extension',
      words: merged.words,
      sentences: merged.sentences,
      deletedIds: merged.deletedIds
    });

    await chrome.storage.local.set({
      words: merged.words,
      sentences: merged.sentences,
      deletedIds: merged.deletedIds
    });

    updateBadge();
    return { ok: true, stats: { words: merged.words.length, sentences: merged.sentences.length } };
  } catch (e) {
    console.error('WordFlow Sync Error:', e);
    return { ok: false, error: e.message };
  }
}

function mergeData(local, remote) {
  const allDeleted = new Set([...(local.deletedIds || []), ...(remote.deletedIds || [])]);
  return {
    words: mergeItems(local.words || [], remote.words || [], allDeleted),
    sentences: mergeItems(local.sentences || [], remote.sentences || [], allDeleted),
    deletedIds: [...allDeleted].slice(-500)
  };
}

function mergeItems(localItems, remoteItems, deletedIds) {
  const map = new Map();
  for (const item of remoteItems) {
    if (!deletedIds.has(item.id)) map.set(item.id, item);
  }
  for (const item of localItems) {
    if (deletedIds.has(item.id)) continue;
    const existing = map.get(item.id);
    if (!existing || (item.createdAt || 0) >= (existing.createdAt || 0)) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
