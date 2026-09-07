// Run: node_modules/.bin/electron tests/homepage-ui.cjs
// Uses a hidden Electron renderer and a temporary profile; never loads main.js.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'answerplayer-ui-'));
app.setPath('userData', profile);
const output = path.join(__dirname, '..', 'artifacts', 'homepage');
fs.mkdirSync(output, { recursive: true });
const results = [];
let win;
async function check(name, code) {
  const result = await win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  if (!result) throw new Error(`FAIL: ${name}`);
  results.push(name);
  console.log(`PASS: ${name}`);
}
async function settle() {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function screenshot(name) {
  await settle();
  fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1120, height: 800, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'homepage-preload.cjs'), contextIsolation: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await settle();
    await check('No duplicate IDs and accessible input labels', `
      const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
      return new Set(ids).size === ids.length && [...document.querySelectorAll('input,select,textarea')].every(el => el.labels.length || el.hasAttribute('aria-label'));
    `);
    await check('Initial license prevents starting; defaults preserved', `return document.querySelector('#startBtn').disabled && document.querySelector('#lineMode').value === '2' && document.querySelector('#denoiseStandard').checked;`);
    for (const [width, height] of [[1120, 800], [800, 720], [640, 720], [1120, 500]]) {
      win.setContentSize(width, height);
      await settle();
      await check(`Layout ${width}x${height}`, `
        const footer = document.querySelector('.action-bar').getBoundingClientRect();
        const scroll = document.querySelector('.page-scroll');
        const button = document.querySelector('#startBtn').getBoundingClientRect();
        const columns = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length;
        return document.documentElement.scrollWidth <= innerWidth && scroll.scrollWidth <= scroll.clientWidth && scroll.getBoundingClientRect().bottom <= footer.top + 1 && button.bottom <= innerHeight && columns === (innerWidth < 960 ? 1 : 2);
      `);
      await screenshot(`homepage-${width}x${height}`);
      await check(`Expanded admin and bottom content ${width}x${height}`, `
        document.querySelector('.admin-panel').open = true;
        const scroller = document.querySelector('.page-scroll');
        scroller.scrollTop = scroller.scrollHeight;
        const transcript = document.querySelector('#micStopBtn').parentElement.getBoundingClientRect();
        const valid = scroller.scrollWidth <= scroller.clientWidth && transcript.bottom <= scroller.getBoundingClientRect().bottom;
        scroller.scrollTop = 0;
        document.querySelector('.admin-panel').open = false;
        return valid;
      `);
    }
    win.setContentSize(1120, 800);
    await check('Chinese composition Enter does not send', `
      const input = document.querySelector('#preChatInput'); input.value = '自我介绍';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      return uiTest.calls().filter(call => call.name === 'preChat').length === 0;
    `);
    await check('Send and streaming prevent duplicate submissions', `
      const input = document.querySelector('#preChatInput');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.value = '第二条';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return uiTest.calls().filter(call => call.name === 'preChat').length === 1 && document.querySelector('#preChatSend').disabled && document.querySelector('#preChatStatus').textContent === '正在回复';
    `);
    await check('Streaming Markdown renders and send recovers', `
      uiTest.emit('onPreChunk', '可以按三个部分准备：\\n\\n1. **个人背景**：介绍岗位相关经历。\\n2. **项目亮点**：说明贡献与结果。\\n3. **岗位匹配**：总结你的优势。');
      if (!document.querySelector('.streaming strong')) return false;
      uiTest.emit('onPreEnd');
      return !document.querySelector('#preChatSend').disabled && !document.querySelector('.streaming');
    `);
    await check('Redemption pending and error remain visible', `
      uiTest.setRedeemOutcome('error'); document.querySelector('#activationCodeInput').value = 'invalid';
      document.querySelector('#redeemCodeBtn').click();
      if (!document.querySelector('#redeemCodeBtn').disabled || !document.querySelector('#licenseMessage').textContent.includes('正在兑换')) return false;
      await new Promise(resolve => setTimeout(resolve, 70));
      return !document.querySelector('#redeemCodeBtn').disabled && document.querySelector('#licenseMessage').textContent.includes('激活码无效');
    `);
    await check('Successful redemption enables start', `
      uiTest.setRedeemOutcome('success'); document.querySelector('#activationCodeInput').value = 'test';
      document.querySelector('#redeemCodeBtn').click(); await new Promise(resolve => setTimeout(resolve, 70));
      return !document.querySelector('#startBtn').disabled && document.querySelector('#licenseMessage').textContent.includes('兑换成功');
    `);
    await win.webContents.executeJavaScript(`document.querySelector('#scriptInput').value = '你好，我是一名软件工程师。\\n过去三年，我主要负责产品开发与性能优化。\\n接下来，我想分享一个最有代表性的项目。'; document.querySelector('#preChatInput').value = '';`);
    await screenshot('homepage-ready');
    await check('Long Markdown stays inside chat', `
      document.querySelector('#preChatInput').value = '长文本'; document.querySelector('#preChatSend').click();
      uiTest.emit('onPreChunk', '长文本'.repeat(200) + '\\n\\n\`\`\`js\\n' + 'longCode'.repeat(160) + '\\n\`\`\`\\n\\n|列一|列二|\\n|---|---|\\n|' + 'longCell'.repeat(120) + '|内容|');
      uiTest.emit('onPreEnd');
      const chat = document.querySelector('#preChatMessages');
      return chat.scrollWidth <= chat.clientWidth && document.querySelector('.page-scroll').scrollWidth <= document.querySelector('.page-scroll').clientWidth;
    `);
    await check('Microphone failure message survives cleanup', `
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new Error('权限被拒绝'); } });
      document.querySelector('#micTestBtn').click(); await new Promise(resolve => setTimeout(resolve, 30));
      return document.querySelector('#micTestStatus').textContent.includes('权限被拒绝') && !document.querySelector('#micTestBtn').disabled;
    `);
    await check('Microphone start, ASR events, denoise restart, and stop', `
      window.testTracksStopped = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() { window.testTracksStopped++; } }] }) });
      const node = () => ({ connect() {}, disconnect() {}, frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } });
      window.AudioContext = class { audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return node(); } createBiquadFilter() { return node(); } createDynamicsCompressor() { return node(); } createGain() { return node(); } close() { return Promise.resolve(); } };
      window.AudioWorkletNode = class { port = {}; connect() {} disconnect() {} };
      document.querySelector('#micTestBtn').click(); await new Promise(resolve => setTimeout(resolve, 30));
      if (!document.querySelector('#micTestStatus').textContent.includes('连接')) return false;
      uiTest.emit('onXunfeiStatus', { state: 'connected' });
      uiTest.emit('onAsrInterim', { text: '测试', role: 'user' });
      if (!document.querySelector('#micTestTranscript').classList.contains('interim')) return false;
      uiTest.emit('onAsrFinal', { text: '测试完成', role: 'user' });
      if (document.querySelector('#micTestTranscript').textContent !== '测试完成') return false;
      uiTest.emit('onXunfeiStatus', { state: 'error', detail: '测试连接错误' });
      if (!document.querySelector('#micTestStatus').textContent.includes('测试连接错误')) return false;
      document.querySelector('#denoiseStrong').click(); await new Promise(resolve => setTimeout(resolve, 30));
      if (uiTest.calls().filter(call => call.name === 'startTestMic').length !== 2) return false;
      document.querySelector('#micStopBtn').click();
      return window.testTracksStopped === 2 && document.querySelector('#micStopBtn').style.display === 'none';
    `);
    await check('Start payload and active microphone cleanup preserved', `
      document.querySelector('#micTestBtn').click(); await new Promise(resolve => setTimeout(resolve, 30));
      document.querySelector('#scriptInput').value = '你好。\\n项目经验，成果；';
      document.querySelector('#startBtn').click();
      const calls = uiTest.calls(); const payload = calls.find(call => call.name === 'startPrompter')?.args[0];
      return payload?.lines === 2 && payload.denoiseMode === 'strong' && payload.sentences.join('|') === '你好。|项目经验，|成果；' && payload.preChatHistory.length === 4 && payload.scriptText === '你好。项目经验，成果；' && payload.licenseClientActiveUntilMs > Date.now() && document.querySelector('#micStopBtn').style.display === 'none';
    `);
    await check('Expired license disables start', `
      localStorage.setItem('answerplayer.clientActiveUntilMs', String(Date.now() - 1000));
      uiTest.emit('onLicenseStatus', { products: [] });
      return document.querySelector('#startBtn').disabled && document.querySelector('#licenseStatusText').textContent.includes('已到期');
    `);
    if (errors.length) throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: results, services: 'Mocked IPC and audio only; no live service calls.' }, null, 2));
    console.log(`Completed ${results.length} checks. Screenshots: ${output}`);
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error);
    if (win) { await screenshot('failure'); win.destroy(); }
    app.exit(1);
  }
});
