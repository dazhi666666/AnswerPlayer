const { ipcRenderer } = require('electron');

const allowedSendChannels = new Set([
  'close-prompter',
  'next-subtitle-line',
  'prev-subtitle-line'
]);

ipcRenderer.on('init-subtitle', (_event, data) => {
  window.postMessage({ t: 'init-subtitle', d: data }, '*');
});

ipcRenderer.on('subtitle-state', (_event, data) => {
  window.postMessage({ t: 'subtitle-state', d: data }, '*');
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.t !== 'ipc-send') return;
  if (!allowedSendChannels.has(message.c)) return;
  ipcRenderer.send(message.c, message.d);
});
