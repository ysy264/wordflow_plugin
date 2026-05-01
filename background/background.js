// ========================================
// WordFlow Background Service Worker v2
// 右键菜单 + 有道词典 + DeepSeek AI + 数据存储 + WebDAV 同步
// ========================================

// ---------- 0. DeepSeek Client ----------

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/chat/completions';

async function getDeepSeekKey() {
  const data = await chrome.storage.local.get({ deepseekKey: '' });
  return data.deepseekKey || '';
}

async function callDeepSeek(systemPrompt, userMessage) {
  const key = await getDeepSeekKey();
  if (!key) return null;

  try {
    const resp = await fetch(DEEPSEEK_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 600,
        temperature: 0.3
      })
    });
    if (!resp.ok) {
      console.warn(`WordFlow: DeepSeek API ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.warn('WordFlow: DeepSeek error', e.message);
    return null;
  }
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return 'ds_' + Math.abs(hash).toString(16);
}

async function cachedCall(cacheKey, systemPrompt, userMessage) {
  const cacheData = await chrome.storage.local.get({ [cacheKey]: '' });
  if (cacheData[cacheKey]) return cacheData[cacheKey];

  const result = await callDeepSeek(systemPrompt, userMessage);
  if (result) {
    await chrome.storage.local.set({ [cacheKey]: result });
  }
  return result;
}

const CONTEXT_PROMPT = `你叫 Robin，英语学习教练。
用户提供了一个英文单词和它所在的原文段落。
请分析这个单词在这个特定语境中的含义。

返回纯 JSON，不要用 markdown 包裹：
{"meaning": "该单词在此语境中的中文释义（≤15字）", "explanation": "语境的简要说明（≤30字）"}`;

async function getContextualMeaning(word, sentence, paragraph) {
  const fullContext = paragraph || sentence;
  const cacheKey = hashStr(`ctx:${word}:${fullContext}`);
  const userMsg = `单词: ${word}\n原文段落: ${fullContext}`;
  const raw = await cachedCall(cacheKey, CONTEXT_PROMPT, userMsg);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { meaning: raw, explanation: '' };
  }
}

// Google Translate free endpoint (same as Saladict)
async function translateParagraph(paragraph) {
  const cacheKey = hashStr(`tr:${paragraph}`);
  const cached = await chrome.storage.local.get({ [cacheKey]: '' });
  if (cached[cacheKey]) return cached[cacheKey];

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(paragraph)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    // Response format: [[["translated text", "original", ...], ...], ...]
    const translation = data[0]?.map(part => part[0]).join('') || null;
    if (translation) {
      await chrome.storage.local.set({ [cacheKey]: translation });
    }
    return translation;
  } catch (e) {
    console.warn('WordFlow: Google Translate error', e.message);
    return null;
  }
}

// ---------- 1. 右键菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'wordflow-save',
    title: '存入 WordFlow',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'wordflow-save') return;
  const text = info.selectionText?.trim();
  if (!text) return;

  if (isParagraph(text)) {
    notifyContentScript(tab.id, { type: 'show-paragraph-card', text });
  } else {
    const word = normalizeWord(text);
    if (word) saveWordWithContext(word, tab, null);
  }
});

// ---------- 2. 判断工具 ----------

function isParagraph(text) {
  return text.split(/\s+/).length > 3;
}

function normalizeWord(text) {
  return text.toLowerCase().replace(/[^a-zA-Z'\-]/g, '').trim();
}

// ---------- 3. 存储：Word + WordContext ----------

async function saveWordWithContext(word, tab, contextInfo) {
  const data = await chrome.storage.local.get({ words: [], wordContexts: [] });
  const words = data.words;
  const wordContexts = data.wordContexts;

  const exists = words.find(w => w.word === word);
  if (exists) {
    notifyContentScript(tab?.id, { type: 'word-exists', word });
    if (contextInfo && exists.id) {
      await addContext(exists.id, word, contextInfo);
    }
    return { status: 'exists', entry: exists };
  }

  const entry = await lookupWord(word);

  const newWord = {
    id: Date.now().toString(),
    word: entry?.word || word,
    phonetic: entry?.phonetic || '',
    definition: entry?.definition || '',
    distractors: '',
    extras: '',
    createdAt: Date.now(),
    lookupCount: 1,
    favorite: false,
    archived: false,
    exported: false
  };

  words.unshift(newWord);
  await chrome.storage.local.set({ words });

  if (contextInfo) {
    await addContext(newWord.id, word, contextInfo);
  }

  notifyContentScript(tab?.id, { type: 'word-saved', entry: newWord });
  updateBadge();
  return { status: 'saved', entry: newWord };
}

async function addContext(wordId, word, contextInfo) {
  const data = await chrome.storage.local.get({ wordContexts: [] });
  const contexts = data.wordContexts;

  const ctx = {
    id: `ctx_${Date.now()}`,
    wordId: wordId,
    word: word,
    text: contextInfo.text || '',
    translation: contextInfo.translation || '',
    meaning: contextInfo.meaning || '',
    explanation: contextInfo.explanation || '',
    paragraphTranslation: contextInfo.paragraphTranslation || '',
    provider: contextInfo.provider || 'deepseek',
    source: contextInfo.source || '',
    createdAt: Date.now()
  };

  contexts.unshift(ctx);
  await chrome.storage.local.set({ wordContexts: contexts });
}

// ---------- 4. 有道词典 ----------

async function lookupWord(word) {
  const target = word.toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bust = attempt === 0 ? '' : `&_=${Date.now()}_${attempt}`;
      const url = `https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&le=en&q=${encodeURIComponent(word)}${bust}`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const entry = parseYoudaoEntry(json, target, word);
      if (entry) return entry;
    } catch (e) {
      console.warn(`WordFlow: dict lookup fail (attempt ${attempt + 1})`, e);
    }
  }
  return null;
}

function parseYoudaoEntry(json, target, originalWord) {
  let phonetic = '';
  let definition = '';

  if (json.ec?.word) {
    const wordList = Array.isArray(json.ec.word) ? json.ec.word : [json.ec.word];
    const getPhrase = (w) => {
      const rp = w?.['return-phrase'];
      if (!rp) return '';
      if (typeof rp === 'string') return rp;
      const i = rp.l?.l?.i;
      return Array.isArray(i) ? (i[0] || '') : (i || '');
    };
    const wordData = wordList.find(w => getPhrase(w).toLowerCase() === target);

    if (wordData) {
      phonetic = wordData.usphone || wordData.ukphone || '';
      const trs = wordData.trs || [];
      if (trs.length > 0) {
        definition = trs.map(tr => {
          if (tr.pos && tr.tran) return `${tr.pos}. ${tr.tran}`;
          if (tr.tr?.[0]?.l?.l?.i) return tr.tr[0].l.l.i[0];
          return '';
        }).filter(Boolean).join('\n');
      }
    }
  }

  if (!phonetic && json.simple?.word) {
    const swList = Array.isArray(json.simple.word) ? json.simple.word : [json.simple.word];
    const sw = swList.find(s => (s?.word || '').toLowerCase() === target);
    if (sw) phonetic = sw.usphone || sw.ukphone || '';
  }

  if (!definition && json.web_trans?.['web-translation']) {
    const wt = json.web_trans['web-translation'].find(t =>
      (t?.key || '').toLowerCase() === target
    );
    if (wt?.trans) {
      definition = wt.trans.map(t => t.value).filter(Boolean).slice(0, 3).join('; ');
    }
  }

  if (definition) return { word: originalWord, phonetic, definition };
  return null;
}

// ---------- 5. Content Script 通信 ----------

function notifyContentScript(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ---------- 6. Badge ----------

async function updateBadge() {
  const data = await chrome.storage.local.get({ words: [] });
  const total = data.words.length;
  chrome.action.setBadgeText({ text: total > 0 ? total.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
}

updateBadge();

// ---------- 7. Offscreen 音频 ----------

let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play word pronunciation'
    });
    offscreenCreated = true;
  } catch (e) {
    offscreenCreated = true;
  }
}

async function speakWordViaOffscreen(word) {
  await ensureOffscreen();
  const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
  chrome.runtime.sendMessage({ action: 'playAudio', url });
}

// ---------- 8. 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // --- 数据查询 ---
  if (msg.action === 'getWords') {
    chrome.storage.local.get({ words: [] }, data => sendResponse(data.words));
    return true;
  }
  if (msg.action === 'getWordContexts') {
    chrome.storage.local.get({ wordContexts: [] }, data => sendResponse(data.wordContexts));
    return true;
  }
  if (msg.action === 'getWordContextsForWord') {
    chrome.storage.local.get({ wordContexts: [] }, data => {
      sendResponse(data.wordContexts.filter(c => c.wordId === msg.wordId));
    });
    return true;
  }

  // --- 词典查询 ---
  if (msg.action === 'lookupWord') {
    lookupWord(msg.word).then(entry => sendResponse(entry));
    return true;
  }

  // --- DeepSeek AI ---
  if (msg.action === 'contextualMeaning') {
    getContextualMeaning(msg.word, msg.sentence, msg.paragraph).then(result =>
      sendResponse(result)
    );
    return true;
  }
  if (msg.action === 'translateParagraph') {
    translateParagraph(msg.text).then(translation => sendResponse({ translation }));
    return true;
  }

  // --- 单词保存 ---
  if (msg.action === 'saveWordFromContent') {
    const word = normalizeWord(msg.word);
    if (!word) { sendResponse({ status: 'invalid' }); return false; }
    saveWordWithContext(word, sender.tab, msg.context || null).then(result =>
      sendResponse(result)
    );
    return true;
  }

  // --- 删除 ---
  if (msg.action === 'deleteWord') {
    chrome.storage.local.get({ words: [], wordContexts: [], deletedIds: [] }, data => {
      data.words = data.words.filter(w => w.id !== msg.id);
      data.wordContexts = data.wordContexts.filter(c => c.wordId !== msg.id);
      data.deletedIds.push(msg.id);
      chrome.storage.local.set(data, () => {
        updateBadge();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // --- 发音 ---
  if (msg.action === 'speakWord') {
    speakWordViaOffscreen(msg.word);
    return false;
  }

  // --- AI Key 管理 ---
  if (msg.action === 'getDeepSeekKey') {
    getDeepSeekKey().then(key => sendResponse({ key }));
    return true;
  }
  if (msg.action === 'saveDeepSeekKey') {
    chrome.storage.local.set({ deepseekKey: msg.key }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'isDeepSeekConfigured') {
    getDeepSeekKey().then(key => sendResponse({ configured: !!key }));
    return true;
  }

  // --- Badge ---
  if (msg.action === 'updateBadge') {
    updateBadge();
    return false;
  }

  // --- WebDAV ---
  if (msg.action === 'testWebDAV') {
    testWebDAVConnection(msg.user, msg.pass).then(ok => sendResponse({ ok }));
    return true;
  }
  if (msg.action === 'doSync') {
    doSync().then(result => sendResponse(result));
    return true;
  }
  if (msg.action === 'saveWebDAVConfig') {
    chrome.storage.local.set({ webdavUser: msg.user, webdavPass: msg.pass }, () =>
      sendResponse({ ok: true })
    );
    return true;
  }
  if (msg.action === 'getWebDAVConfig') {
    chrome.storage.local.get({ webdavUser: '', webdavPass: '' }, data =>
      sendResponse({ user: data.webdavUser, pass: data.webdavPass })
    );
    return true;
  }
});

// ==========================================================
// WebDAV Sync (坚果云) — 与 Android SyncManager 对齐
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
  if (!resp.ok) throw new Error(`WebDAV GET: ${resp.status}`);
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
  if (!resp.ok) throw new Error(`WebDAV PUT: ${resp.status}`);
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
  } catch (e) { return false; }
}

async function doSync() {
  const cred = await getWebDAVCredentials();
  if (!cred) return { ok: false, error: '未配置 WebDAV 账号' };

  try {
    const local = await chrome.storage.local.get({ words: [], wordContexts: [], deletedIds: [] });
    let remote = await webdavGet(cred);
    if (!remote) remote = { version: 1, words: [], sentences: [], deletedIds: [] };

    // Convert remote sentences to wordContexts for merge
    const remoteContexts = (remote.sentences || []).map(s => ({
      id: s.id,
      wordId: s.wordId || '',
      word: s.word || '',
      text: s.text,
      translation: s.translation || '',
      meaning: s.meaning || '',
      explanation: s.explanation || '',
      paragraphTranslation: s.paragraphTranslation || s.translation || '',
      provider: s.provider || '',
      source: s.source || '',
      createdAt: s.createdAt || 0
    }));

    const mergedWords = mergeItems(local.words || [], remote.words || [], new Set([
      ...(local.deletedIds || []), ...(remote.deletedIds || [])
    ]));
    const mergedContexts = mergeItems(local.wordContexts || [], remoteContexts, new Set());

    const syncData = {
      version: 1,
      lastModified: Date.now(),
      platform: 'chrome-extension',
      words: mergedWords,
      sentences: mergedContexts,
      deletedIds: [...(new Set([
        ...(local.deletedIds || []), ...(remote.deletedIds || [])
      ]))].slice(-500)
    };

    await webdavPut(cred, syncData);

    await chrome.storage.local.set({
      words: mergedWords,
      wordContexts: mergedContexts,
      deletedIds: syncData.deletedIds
    });

    updateBadge();
    return { ok: true, stats: { words: mergedWords.length, contexts: mergedContexts.length } };
  } catch (e) {
    console.error('WordFlow Sync Error:', e);
    return { ok: false, error: e.message };
  }
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
