// ========================================
// WordFlow WebDAV Sync (坚果云)
// 同步策略：拉取 → 合并 → 推送
// ========================================

const WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/';
const SYNC_FOLDER = 'WordFlow';
const SYNC_FILE = 'wordflow_sync.json';
const SYNC_PATH = `${WEBDAV_BASE}${SYNC_FOLDER}/${SYNC_FILE}`;
const FOLDER_PATH = `${WEBDAV_BASE}${SYNC_FOLDER}/`;

// ---------- 1. 获取 WebDAV 凭据 ----------

async function getWebDAVCredentials() {
  const data = await chrome.storage.local.get({
    webdavUser: '',
    webdavPass: ''
  });
  if (!data.webdavUser || !data.webdavPass) {
    return null;
  }
  return {
    user: data.webdavUser,
    pass: data.webdavPass
  };
}

function makeAuthHeader(cred) {
  return 'Basic ' + btoa(cred.user + ':' + cred.pass);
}

// ---------- 2. WebDAV 基础操作 ----------

async function webdavGet(cred) {
  const resp = await fetch(SYNC_PATH, {
    method: 'GET',
    headers: {
      'Authorization': makeAuthHeader(cred)
    }
  });

  if (resp.status === 404 || resp.status === 409) {
    // 404 = 文件不存在，409 = 文件夹不存在（坚果云特有）
    return null;
  }

  if (!resp.ok) {
    throw new Error(`WebDAV GET failed: ${resp.status} ${resp.statusText}`);
  }

  return await resp.json();
}

async function webdavPut(cred, data) {
  // 先确保文件夹存在
  await webdavMkdir(cred);

  const resp = await fetch(SYNC_PATH, {
    method: 'PUT',
    headers: {
      'Authorization': makeAuthHeader(cred),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(data, null, 2)
  });

  if (!resp.ok) {
    throw new Error(`WebDAV PUT failed: ${resp.status} ${resp.statusText}`);
  }

  return true;
}

async function webdavMkdir(cred) {
  // MKCOL 创建文件夹
  const resp = await fetch(FOLDER_PATH, {
    method: 'MKCOL',
    headers: {
      'Authorization': makeAuthHeader(cred)
    }
  });
  // 201 = 创建成功, 405 = 已存在, 409 = 上级已存在, 都算成功
  return resp.status === 201 || resp.status === 405 || resp.status === 409;
}

// ---------- 3. 测试连接 ----------

async function testWebDAVConnection(user, pass) {
  try {
    const resp = await fetch(WEBDAV_BASE, {
      method: 'PROPFIND',
      headers: {
        'Authorization': 'Basic ' + btoa(user + ':' + pass),
        'Depth': '0'
      }
    });
    return resp.status === 207; // Multi-Status = 成功
  } catch (e) {
    return false;
  }
}

// ---------- 4. 核心同步逻辑 ----------

async function doSync() {
  const cred = await getWebDAVCredentials();
  if (!cred) {
    return { ok: false, error: '未配置 WebDAV 账号' };
  }

  try {
    // 4.1 读取本地数据
    const local = await chrome.storage.local.get({
      words: [],
      sentences: [],
      deletedIds: []  // 记录本地删除过的 ID
    });

    // 4.2 拉取远端数据
    let remote = await webdavGet(cred);
    if (!remote) {
      // 远端没有文件，直接推送本地数据
      remote = { version: 1, words: [], sentences: [], deletedIds: [] };
    }

    // 4.3 合并
    const merged = mergeData(local, remote);

    // 4.4 推送合并结果到远端
    const syncData = {
      version: 1,
      lastModified: Date.now(),
      platform: 'chrome-extension',
      words: merged.words,
      sentences: merged.sentences,
      deletedIds: merged.deletedIds
    };
    await webdavPut(cred, syncData);

    // 4.5 更新本地数据为合并结果
    await chrome.storage.local.set({
      words: merged.words,
      sentences: merged.sentences,
      deletedIds: merged.deletedIds
    });

    // 4.6 更新 badge
    if (typeof updateBadge === 'function') {
      updateBadge();
    }

    return {
      ok: true,
      stats: {
        words: merged.words.length,
        sentences: merged.sentences.length
      }
    };

  } catch (e) {
    console.error('WordFlow Sync Error:', e);
    return { ok: false, error: e.message };
  }
}

// ---------- 5. 数据合并 ----------

function mergeData(local, remote) {
  // 收集所有被删除的 ID
  const localDeleted = new Set(local.deletedIds || []);
  const remoteDeleted = new Set(remote.deletedIds || []);
  const allDeleted = new Set([...localDeleted, ...remoteDeleted]);

  // 合并单词：按 ID 去重，同 ID 取时间戳更新的
  const mergedWords = mergeItems(local.words || [], remote.words || [], allDeleted);

  // 合并句子
  const mergedSentences = mergeItems(local.sentences || [], remote.sentences || [], allDeleted);

  // deletedIds 也合并（保留最近 500 条，避免无限膨胀）
  const mergedDeletedIds = [...allDeleted].slice(-500);

  return {
    words: mergedWords,
    sentences: mergedSentences,
    deletedIds: mergedDeletedIds
  };
}

function mergeItems(localItems, remoteItems, deletedIds) {
  const map = new Map();

  // 先放远端
  for (const item of remoteItems) {
    if (!deletedIds.has(item.id)) {
      map.set(item.id, item);
    }
  }

  // 再放本地，同 ID 比时间戳
  for (const item of localItems) {
    if (deletedIds.has(item.id)) continue;

    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, item);
    } else {
      // 保留更新的那个
      if ((item.createdAt || 0) >= (existing.createdAt || 0)) {
        map.set(item.id, item);
      }
    }
  }

  // 按时间倒序排列
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
