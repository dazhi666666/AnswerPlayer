// Run with Electron. No production preload or main process is loaded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'answerplayer-interview-test-')));
const output = path.join(__dirname, '..', 'artifacts', 'interview');
fs.mkdirSync(output, { recursive: true });
let win;
const passed = [];
async function run(code) { return win.webContents.executeJavaScript(`(async () => { ${code} })()`); }
async function check(name, code) {
  if (!await run(code)) throw new Error(`FAIL: ${name}`);
  passed.push(name); console.log(`PASS: ${name}`);
}
async function settle() { await run('await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));'); }
async function shot(name) { await settle(); fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, frame: false, width: 430, height: 560,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, '..', 'prompter.html'));
    await run(`
      window.sent = [];
      window.addEventListener('message', e => { if (e.data?.t === 'ipc-send') sent.push(e.data); });
      window.emit = async (t, d) => { window.postMessage({ t, d }, '*'); await new Promise(r => setTimeout(r, 15)); };
    `);
    await check('Empty state, default size, and draggable header', `
      return getComputedStyle(document.querySelector('#emptyState')).display !== 'none' &&
        getComputedStyle(document.querySelector('#chatHeader')).webkitAppRegion === 'drag' &&
        getComputedStyle(document.querySelector('#closeBtn')).webkitAppRegion === 'no-drag';
    `);
    await shot('interview-empty');
    await check('Connection, error, disconnect and recovery states', `
      await emit('xunfei-status', { source: 'mic', state: 'connecting' });
      if (document.querySelector('#asrStatus').dataset.state !== 'connecting') return false;
      await emit('xunfei-status', { source: 'mic', state: 'error', detail: '连接失败' });
      if (!document.querySelector('#asrStatus').textContent.includes('连接失败')) return false;
      await emit('xunfei-status', { source: 'mic', state: 'disconnected' });
      if (!document.querySelector('#asrStatus').textContent.includes('已断开')) return false;
      await emit('xunfei-status', { source: 'mic', state: 'connected' });
      await emit('xunfei-status', { source: 'system', state: 'connected' });
      return document.querySelector('#asrStatus').textContent === '麦克风与系统音频已连接';
    `);
    await check('Interim replacement retains role and final transcript', `
      await emit('asr-interim-result', { role: 'user', source: 'mic', text: '我主要负责' });
      await emit('asr-interim-result', { role: 'user', source: 'mic', text: '我主要负责前端开发。' });
      if (document.querySelectorAll('.interim').length !== 1 || document.querySelector('.interim .bubble-label').textContent !== '我') return false;
      await emit('asr-final-result', { role: 'user', source: 'mic', text: '我主要负责前端开发。' });
      return !document.querySelector('.interim') && document.querySelector('.user .bubble-content').textContent === '我主要负责前端开发。' && getComputedStyle(document.querySelector('#emptyState')).display === 'none';
    `);
    await check('Duplicate transcripts remain deduplicated', `
      await emit('asr-final-result', { role: 'user', source: 'mic', text: '我主要负责前端开发。' });
      return document.querySelectorAll('.user').length === 1;
    `);
    await check('Question triggers AI and streamed Markdown retains label', `
      await emit('asr-final-result', { role: 'interviewer', source: 'system', text: '能介绍一个你做过的性能优化项目吗？' });
      await new Promise(r => setTimeout(r, 1550));
      if (!sent.some(m => m.c === 'trigger-llm') || !document.querySelector('#aiStatus').classList.contains('busy')) return false;
      await emit('llm-chunk', '可以围绕 **问题 → 行动 → 结果** 来回答。\\n\\n1. **问题**：说明当时的页面加载瓶颈。\\n2. **行动**：讲清你的分析过程与优化措施。\\n3. **结果**：用真实指标说明改善效果。');
      if (!document.querySelector('.streaming strong') || document.querySelector('.assistant .bubble-label').textContent !== 'AI · 回答建议') return false;
      await emit('llm-end');
      return !document.querySelector('.streaming') && document.querySelector('#aiStatus').textContent === 'AI 待命';
    `);
    await shot('interview-conversation');
    await check('Long code and transcript do not overflow horizontally', `
      await emit('llm-chunk', '\`\`\`js\\n' + 'longCode'.repeat(140) + '\\n\`\`\`\\n\\n' + '长内容'.repeat(400));
      await emit('llm-end');
      const chat = document.querySelector('#chatMessages');
      return chat.scrollWidth <= chat.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    `);
    await settle();
    await check('Reading history pauses follow; latest button resumes', `
      const chat = document.querySelector('#chatMessages');
      chat.scrollTop = 0; chat.dispatchEvent(new Event('scroll'));
      await emit('llm-chunk', '新的建议');
      await new Promise(r => requestAnimationFrame(r));
      if (chat.scrollTop !== 0 || document.querySelector('#latestBtn').hidden) return false;
      document.querySelector('#latestBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 32;
      await emit('llm-end');
      return atBottom && document.querySelector('#latestBtn').hidden;
    `);
    for (const [width, height] of [[430, 560], [320, 420], [700, 700]]) {
      win.setSize(width, height); await settle();
      await check(`Layout ${width}x${height} and long error`, `
        await emit('xunfei-status', { source: 'system', state: 'error', detail: '连接不可用'.repeat(60) });
        const footer = document.querySelector('#footerTip').getBoundingClientRect();
        const chat = document.querySelector('#chatMessages');
        return document.documentElement.scrollWidth <= innerWidth && chat.scrollWidth <= chat.clientWidth && footer.bottom <= innerHeight && chat.clientHeight > 100;
      `);
    }
    await check('Subtitle shortcuts and end button preserve IPC', `
      for (const key of ['ArrowLeft', 'ArrowRight', 'Escape']) document.dispatchEvent(new KeyboardEvent('keydown', { key }));
      document.querySelector('#closeBtn').click(); await new Promise(r => setTimeout(r, 20));
      return sent.some(m => m.c === 'prev-subtitle-line') && sent.some(m => m.c === 'next-subtitle-line') && sent.filter(m => m.c === 'close-prompter').length === 2;
    `);
    await check('Audio permission failure remains visible after later status', `
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => { throw new Error('测试权限被拒绝'); } });
      await emit('init-interview', {});
      await emit('xunfei-status', { source: 'mic', state: 'connected' });
      return document.querySelector('#asrStatus').dataset.state === 'error' && document.querySelector('#asrStatus').textContent.includes('测试权限被拒绝');
    `);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed, services: 'Simulated postMessage events; no real audio capture or paid services.' }, null, 2));
    console.log(`Completed ${passed.length} checks.`);
    win.destroy(); app.exit(0);
  } catch (err) { console.error(err); if (win) { await shot('failure'); win.destroy(); } app.exit(1); }
});
