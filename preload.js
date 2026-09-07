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

contextBridge.exposeInMainWorld('electronAPI', {
  renderMarkdown,
  startPrompter: (data) => ipcRenderer.send('start-prompter', data),
  closePrompter: () => ipcRenderer.send('close-prompter'),
  onInitPrompter: (cb) => ipcRenderer.on('init-prompter', (_e, d) => cb(d)),

  connectXunfei: () => ipcRenderer.send('connect-xunfei'),
  closeXunfei: () => ipcRenderer.send('close-xunfei'),
  sendPcmData: (buf) => ipcRenderer.send('send-pcm-data', buf),
  onAsrInterim: (cb) => ipcRenderer.on('asr-interim-result', (_e, d) => cb(d)),
  onAsrFinal: (cb) => ipcRenderer.on('asr-final-result', (_e, d) => cb(d)),
  onLlmChunk: (cb) => ipcRenderer.on('llm-chunk', (_e, t) => cb(t)),
  onLlmEnd: (cb) => ipcRenderer.on('llm-end', () => cb()),
  triggerLlm: (history) => ipcRenderer.send('trigger-llm', history),
  abortLlm: () => ipcRenderer.send('abort-llm'),
  chatToAi: (history) => ipcRenderer.send('chat-to-ai', history),
  preChat: (history) => ipcRenderer.send('pre-chat', history),
  onPreChunk: (cb) => ipcRenderer.on('pre-chunk', (_e, t) => cb(t)),
  onPreEnd: (cb) => ipcRenderer.on('pre-end', () => cb()),
  startTestMic: () => ipcRenderer.send('start-test-mic'),
  stopTestMic: () => ipcRenderer.send('stop-test-mic'),
  onXunfeiStatus: (cb) => ipcRenderer.on('xunfei-status', (_e, s) => cb(s)),

  getLicenseStatus: () => ipcRenderer.invoke('license:get-status'),
  checkLicenseTime: (request) => ipcRenderer.invoke('license:check-time', request),
  listActivationCodes: (options) => ipcRenderer.invoke('license:list-codes', options),
  generateActivationCodes: (request) => ipcRenderer.invoke('license:generate-codes', request),
  redeemActivationCode: (code) => ipcRenderer.invoke('license:redeem', code),
  setActivationCodeDisabled: (request) => ipcRenderer.invoke('license:set-code-disabled', request),
  onLicenseStatus: (cb) => ipcRenderer.on('license-status', (_e, s) => cb(s)),
  onLicenseError: (cb) => ipcRenderer.on('license-error', (_e, message) => cb(message))
});
