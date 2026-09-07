// Isolated UI test bridge: no real IPC, credentials, audio or network requests.
const { contextBridge } = require('electron');
const listeners = {};
const calls = [];
let redeemOutcome = 'success';
const products = [{ sku: 'test', name: '测试时长', priceCents: 100, minutes: 60 }];
const api = {
  checkLicenseTime: async () => ({ products }),
  redeemActivationCode: async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (redeemOutcome === 'error') throw new Error('激活码无效');
    return { redeemed: { minutes: 60 }, status: { products } };
  },
  listActivationCodes: async () => ({ codes: [], status: { products } }),
  generateActivationCodes: async () => ({ generated: [{ code: 'TEST-CODE' }], codes: [] }),
  setActivationCodeDisabled: async () => ({ codes: [], status: { products } })
};
for (const name of ['onLicenseStatus', 'onLicenseError', 'onPreChunk', 'onPreEnd', 'onXunfeiStatus', 'onAsrInterim', 'onAsrFinal']) {
  api[name] = cb => { listeners[name] = cb; };
}
for (const name of ['preChat', 'startPrompter', 'closePrompter', 'startTestMic', 'stopTestMic', 'sendPcmData']) {
  api[name] = (...args) => calls.push({ name, args });
}
contextBridge.exposeInMainWorld('electronAPI', api);
contextBridge.exposeInMainWorld('uiTest', {
  emit: (event, payload) => listeners[event]?.(payload),
  calls: () => calls,
  setRedeemOutcome: outcome => { redeemOutcome = outcome; }
});
