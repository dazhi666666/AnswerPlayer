const { contextBridge, ipcRenderer } = require('electron');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

contextBridge.exposeInMainWorld('prompterAPI', {
  renderMarkdown,
});

const allowedSendChannels = new Set([
  'connect-xunfei',
  'close-xunfei',
  'send-pcm-data',
  'trigger-llm',
  'abort-llm',
  'close-prompter',
  'next-subtitle-line',
  'prev-subtitle-line'
]);

ipcRenderer.on('init-interview', (_e, d) => window.postMessage({ t: 'init-interview', d }, '*'));
ipcRenderer.on('asr-interim-result', (_e, d) => window.postMessage({ t: 'asr-interim-result', d }, '*'));
ipcRenderer.on('asr-final-result', (_e, d) => window.postMessage({ t: 'asr-final-result', d }, '*'));
ipcRenderer.on('xunfei-status', (_e, d) => window.postMessage({ t: 'xunfei-status', d }, '*'));
ipcRenderer.on('llm-chunk', (_e, t) => window.postMessage({ t: 'llm-chunk', d: t }, '*'));
ipcRenderer.on('llm-end', () => window.postMessage({ t: 'llm-end' }, '*'));

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const msg = e.data;
  if (!msg || msg.t !== 'ipc-send') return;
  if (!allowedSendChannels.has(msg.c)) return;
  ipcRenderer.send(msg.c, msg.d);
});
