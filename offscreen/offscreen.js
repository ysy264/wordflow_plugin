// Offscreen document: 接收 background 消息播放音频
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'playAudio' && msg.url) {
    const audio = new Audio(msg.url);
    audio.play().catch(() => {});
  }
});
