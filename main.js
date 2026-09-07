const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const fs = require('fs');
const WebSocket = require('ws');

const CONFIG = {
  XUNFEI_APPID: process.env.XUNFEI_APPID || '',
  XUNFEI_API_KEY: process.env.XUNFEI_API_KEY || '',
  XUNFEI_API_SECRET: process.env.XUNFEI_API_SECRET || '',
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
};

let mainWindow = null;
let interviewWindow = null;
let subtitleWindow = null;

let abortController = null;
let preChatAbortController = null;
let isTestMode = false;
let isClosingInterviewWindows = false;
const xunfeiSessions = new Map();

const interviewState = {
  sentences: [],
  lines: 2,
  currentIndex: 0,
  persona: '',
  preChatHistory: [],
  scriptText: '',
  denoiseMode: 'standard'
};

const DEBUG_LOG_PATH = path.join(__dirname, 'debug-main.log');
const LICENSE_PRODUCTS = [
  { sku: 'time_5', name: '5分钟体验', minutes: 5, priceCents: 0 },
  { sku: 'time_30', name: '30分钟', minutes: 30, priceCents: 10000 },
  { sku: 'time_60', name: '60分钟', minutes: 60, priceCents: 20000 }
];
const LICENSE_USER_ID = 'local-default-user';
const LICENSE_TIME_CONFLICT_SECONDS = 30;
const ACTIVATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let activationStoreCache = null;

function getActivationStorePath() {
  return path.join(app.getPath('userData'), 'activation-store.json');
}

function createEmptyActivationStore() {
  return {
    version: 1,
    codes: [],
    batches: [],
    entitlements: {}
  };
}

function loadActivationStore() {
  if (activationStoreCache) return activationStoreCache;

  const storePath = getActivationStorePath();
  try {
    if (!fs.existsSync(storePath)) {
      activationStoreCache = createEmptyActivationStore();
      saveActivationStore();
      return activationStoreCache;
    }

    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    activationStoreCache = {
      ...createEmptyActivationStore(),
      ...parsed,
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      batches: Array.isArray(parsed.batches) ? parsed.batches : [],
      entitlements: parsed.entitlements && typeof parsed.entitlements === 'object' ? parsed.entitlements : {}
    };
  } catch (err) {
    writeDebugLog('activation-store-load-error', err && err.message ? err.message : String(err));
    activationStoreCache = createEmptyActivationStore();
  }

  return activationStoreCache;
}

function saveActivationStore() {
  if (!activationStoreCache) return;
  const storePath = getActivationStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(activationStoreCache, null, 2)}\n`, 'utf8');
}

function getServerNowMs() {
  return Date.now();
}

function normalizeActivationCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashActivationCode(code) {
  return crypto.createHash('sha256').update(normalizeActivationCode(code), 'utf8').digest('hex');
}

function generateActivationCode() {
  let raw = '';
  while (raw.length < 20) {
    const bytes = crypto.randomBytes(20);
    for (const byte of bytes) {
      if (raw.length >= 20) break;
      raw += ACTIVATION_CODE_ALPHABET[byte % ACTIVATION_CODE_ALPHABET.length];
    }
  }
  return raw.match(/.{1,4}/g).join('-');
}

function getProductBySku(sku) {
  return LICENSE_PRODUCTS.find((product) => product.sku === sku) || null;
}

function getEntitlement(userId = LICENSE_USER_ID) {
  const store = loadActivationStore();
  if (!store.entitlements[userId]) {
    store.entitlements[userId] = {
      userId,
      activeUntilMs: 0,
      totalRedeemedSeconds: 0,
      redemptions: []
    };
  }
  return store.entitlements[userId];
}

function buildLicenseStatus(userId = LICENSE_USER_ID) {
  const nowMs = getServerNowMs();
  const entitlement = getEntitlement(userId);
  const activeUntilMs = Number(entitlement.activeUntilMs) || 0;
  const remainingSeconds = Math.max(0, Math.floor((activeUntilMs - nowMs) / 1000));

  return {
    serverNowMs: nowMs,
    activeUntilMs,
    remainingSeconds,
    isActive: remainingSeconds > 0,
    totalRedeemedSeconds: Number(entitlement.totalRedeemedSeconds) || 0,
    products: LICENSE_PRODUCTS
  };
}

function hasActiveEntitlement() {
  return buildLicenseStatus().isActive;
}

function evaluateLicenseTime(clientActiveUntilMs, userId = LICENSE_USER_ID) {
  const serverStatus = buildLicenseStatus(userId);
  const serverNowMs = serverStatus.serverNowMs;
  const normalizedClientActiveUntilMs = Math.max(0, Number(clientActiveUntilMs) || 0);
  const clientRemainingSeconds = Math.max(0, Math.floor((normalizedClientActiveUntilMs - serverNowMs) / 1000));
  const serverRemainingSeconds = serverStatus.remainingSeconds;
  const deltaSeconds = clientRemainingSeconds - serverRemainingSeconds;
  const serverActiveUntilMs = Number(serverStatus.activeUntilMs) || 0;

  let shouldCorrect = false;
  let reason = 'ok';
  let correctionActiveUntilMs = normalizedClientActiveUntilMs;

  if (serverActiveUntilMs > normalizedClientActiveUntilMs) {
    shouldCorrect = true;
    reason = 'server-longer';
    correctionActiveUntilMs = serverActiveUntilMs;
  } else if (clientRemainingSeconds > 0 && deltaSeconds > LICENSE_TIME_CONFLICT_SECONDS) {
    shouldCorrect = true;
    reason = 'client-ahead';
    correctionActiveUntilMs = serverActiveUntilMs;
  }

  return {
    shouldCorrect,
    reason,
    thresholdSeconds: LICENSE_TIME_CONFLICT_SECONDS,
    serverNowMs,
    serverActiveUntilMs,
    clientActiveUntilMs: normalizedClientActiveUntilMs,
    correctionActiveUntilMs,
    clientRemainingSeconds,
    serverRemainingSeconds,
    deltaSeconds,
    products: serverStatus.products
  };
}

function listActivationCodes({ limit = 80 } = {}) {
  const store = loadActivationStore();
  return store.codes
    .slice()
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 80, 500)))
    .map((code) => ({
      id: code.id,
      batchId: code.batchId,
      productSku: code.productSku,
      minutes: code.minutes,
      priceCents: code.priceCents,
      note: code.note || '',
      createdAtMs: code.createdAtMs,
      redeemedAtMs: code.redeemedAtMs || 0,
      disabledAtMs: code.disabledAtMs || 0,
      status: code.disabledAtMs ? 'disabled' : (code.redeemedAtMs ? 'redeemed' : 'unused')
    }));
}

function assertActivationAdmin(adminSecret) {
  const expectedSecret = process.env.ACTIVATION_ADMIN_SECRET || '';
  if (!expectedSecret) {
    throw new Error('后台管理未启用：请先在服务端设置 ACTIVATION_ADMIN_SECRET');
  }

  const actualBuffer = Buffer.from(String(adminSecret || ''), 'utf8');
  const expectedBuffer = Buffer.from(expectedSecret, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('后台管理密钥不正确');
  }
}

function generateActivationCodes({ productSku, quantity = 1, note = '' } = {}) {
  const product = getProductBySku(productSku);
  if (!product) {
    throw new Error('请选择有效的商品时长');
  }

  const safeQuantity = Math.max(1, Math.min(Number(quantity) || 1, 500));
  const store = loadActivationStore();
  const nowMs = getServerNowMs();
  const batchId = crypto.randomUUID();
  const generated = [];

  while (generated.length < safeQuantity) {
    const code = generateActivationCode();
    const codeHash = hashActivationCode(code);
    const exists = store.codes.some((record) => record.codeHash === codeHash);
    if (exists) continue;

    const record = {
      id: crypto.randomUUID(),
      codeHash,
      batchId,
      productSku: product.sku,
      minutes: product.minutes,
      priceCents: product.priceCents,
      note: String(note || '').slice(0, 120),
      createdAtMs: nowMs,
      redeemedAtMs: 0,
      redeemedBy: '',
      disabledAtMs: 0
    };

    store.codes.push(record);
    generated.push({
      code,
      id: record.id,
      productSku: record.productSku,
      minutes: record.minutes,
      priceCents: record.priceCents
    });
  }

  store.batches.push({
    id: batchId,
    productSku: product.sku,
    quantity: safeQuantity,
    note: String(note || '').slice(0, 120),
    createdAtMs: nowMs
  });
  saveActivationStore();

  return {
    batchId,
    serverNowMs: nowMs,
    generated,
    codes: listActivationCodes()
  };
}

function redeemActivationCode(rawCode, userId = LICENSE_USER_ID) {
  const normalized = normalizeActivationCode(rawCode);
  if (normalized.length < 12) {
    throw new Error('激活码格式不正确');
  }

  const store = loadActivationStore();
  const nowMs = getServerNowMs();
  const codeHash = hashActivationCode(normalized);
  const record = store.codes.find((item) => item.codeHash === codeHash);

  if (!record) {
    throw new Error('激活码不存在或已失效');
  }
  if (record.disabledAtMs) {
    throw new Error('激活码已被停用');
  }
  if (record.redeemedAtMs) {
    throw new Error('激活码已被兑换');
  }

  const entitlement = getEntitlement(userId);
  const durationMs = Number(record.minutes) * 60 * 1000;
  const baseMs = Math.max(nowMs, Number(entitlement.activeUntilMs) || 0);
  const activeUntilMs = baseMs + durationMs;

  record.redeemedAtMs = nowMs;
  record.redeemedBy = userId;
  entitlement.activeUntilMs = activeUntilMs;
  entitlement.totalRedeemedSeconds = (Number(entitlement.totalRedeemedSeconds) || 0) + Math.floor(durationMs / 1000);
  entitlement.redemptions.push({
    codeId: record.id,
    productSku: record.productSku,
    minutes: record.minutes,
    redeemedAtMs: nowMs,
    activeUntilMs
  });
  saveActivationStore();

  return {
    redeemed: {
      productSku: record.productSku,
      minutes: record.minutes,
      priceCents: record.priceCents
    },
    status: buildLicenseStatus(userId)
  };
}

function setActivationCodeDisabled(codeId, disabled) {
  const store = loadActivationStore();
  const code = store.codes.find((item) => item.id === codeId);
  if (!code) {
    throw new Error('激活码记录不存在');
  }
  if (code.redeemedAtMs) {
    throw new Error('已兑换的激活码不能停用');
  }

  code.disabledAtMs = disabled ? getServerNowMs() : 0;
  saveActivationStore();
  return {
    codes: listActivationCodes(),
    status: buildLicenseStatus()
  };
}

function writeDebugLog(...parts) {
  try {
    const line = `[${new Date().toISOString()}] ${parts.map((part) => {
      if (typeof part === 'string') return part;
      try { return JSON.stringify(part); } catch (_) { return String(part); }
    }).join(' ')}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line, 'utf8');
  } catch (_) {}
}

function sendXunfeiStatus(source, state, detail = '') {
  const payload = { source, state, detail };

  if (source === 'test-mic') {
    if (isTestMode && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('xunfei-status', payload);
    }
    return;
  }

  if (interviewWindow && !interviewWindow.isDestroyed()) {
    interviewWindow.webContents.send('xunfei-status', payload);
  }
}

function resetRoleDetection() {
  // Speaker detection is now derived from isolated audio sources.
}

function generateSignature(params, secret) {
  const keys = Object.keys(params).sort();
  const baseString = keys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  return crypto.createHmac('sha1', secret).update(baseString).digest('base64');
}

function formatUtcTime() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  return `${iso}${sign}${hours}${minutes}`;
}

function probeXunfeiHandshake(urlString) {
  return new Promise((resolve) => {
    let settled = false;
    let raw = '';

    const finish = (detail) => {
      if (settled) return;
      settled = true;
      resolve(detail);
    };

    try {
      const target = new URL(urlString);
      const socket = tls.connect(
        target.port ? Number(target.port) : 443,
        target.hostname,
        { servername: target.hostname },
        () => {
          const key = crypto.randomBytes(16).toString('base64');
          const request = [
            `GET ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.host}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '\r\n'
          ].join('\r\n');
          socket.write(request);
        }
      );

      socket.setTimeout(4000, () => {
        try { socket.destroy(); } catch (_) {}
        finish('Handshake probe timed out');
      });

      socket.on('data', (chunk) => {
        raw += chunk.toString('utf8');
        if (!raw.includes('\r\n\r\n')) return;
        const headerText = raw.split('\r\n\r\n')[0];
        const lines = headerText.split('\r\n').filter(Boolean);
        const statusLine = lines[0] || 'Unknown response';
        const errorHeader = lines.find((line) => /^error:/i.test(line));
        try { socket.end(); } catch (_) {}
        finish(errorHeader ? `${statusLine}; ${errorHeader}` : statusLine);
      });

      socket.on('error', (err) => finish(err && err.message ? err.message : 'Handshake probe failed'));
      socket.on('close', () => {
        if (raw) return;
        finish('Connection closed before handshake response');
      });
    } catch (err) {
      finish(err && err.message ? err.message : 'Handshake probe failed');
    }
  });
}

function configureWindowSession(browserWindow, permissions) {
  const session = browserWindow.webContents.session;
  const allowedPermissions = new Set(permissions);

  session.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  return session;
}

function createMainWindow() {
  try { fs.writeFileSync(DEBUG_LOG_PATH, '', 'utf8'); } catch (_) {}
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:answerplayer-main'
    }
  });

  configureWindowSession(mainWindow, ['media']);
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    writeDebugLog('renderer-console', { level, message, line, sourceId });
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const bridgeState = await mainWindow.webContents.executeJavaScript(`({
        electronAPIType: typeof window.electronAPI,
        electronAPIKeys: window.electronAPI ? Object.keys(window.electronAPI) : []
      })`);
      writeDebugLog('bridge-state', bridgeState);
    } catch (err) {
      writeDebugLog('bridge-state-error', err && err.message ? err.message : String(err));
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createInterviewWindow(data) {
  const display = screen.getPrimaryDisplay().workArea;
  const width = 430;
  const height = Math.min(560, Math.max(420, display.height - 80));
  const x = display.x + display.width - width - 28;
  const y = display.y + 28;

  interviewWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-prompter.js'),
      partition: 'persist:answerplayer-interview'
    }
  });

  const session = configureWindowSession(interviewWindow, ['media', 'display-capture']);
  session.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({
        video: source,
        audio: process.platform === 'win32' ? 'loopback' : undefined
      });
    } catch (err) {
      console.error('Display media request failed:', err);
      callback({});
    }
  });

  interviewWindow.setVisibleOnAllWorkspaces(true);
  interviewWindow.loadFile('prompter.html');
  interviewWindow.webContents.on('did-finish-load', () => {
    if (!interviewWindow || interviewWindow.isDestroyed()) return;
    interviewWindow.webContents.send('init-interview', data);
    interviewWindow.focus();
  });
  interviewWindow.on('closed', () => {
    interviewWindow = null;
    onInterviewChildClosed();
  });
}

function createSubtitleWindow(data) {
  const display = screen.getPrimaryDisplay().workArea;
  const width = Math.round(display.width * 0.78);
  const height = 190;
  const x = display.x + Math.round((display.width - width) / 2);
  const y = display.y + Math.round(display.height * 0.68) - Math.round(height / 2);

  subtitleWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-subtitle.js'),
      partition: 'persist:answerplayer-subtitle'
    }
  });

  configureWindowSession(subtitleWindow, []);
  subtitleWindow.setVisibleOnAllWorkspaces(true);
  subtitleWindow.loadFile('subtitle.html');
  subtitleWindow.webContents.on('did-finish-load', () => {
    if (!subtitleWindow || subtitleWindow.isDestroyed()) return;
    subtitleWindow.webContents.send('init-subtitle', {
      sentences: data.sentences || [],
      lines: data.lines || 2,
      currentIndex: interviewState.currentIndex
    });
  });
  subtitleWindow.on('closed', () => {
    subtitleWindow = null;
    onInterviewChildClosed();
  });
}

function buildSubtitlePayload() {
  return {
    sentences: interviewState.sentences,
    lines: interviewState.lines,
    currentIndex: interviewState.currentIndex
  };
}

function syncSubtitleWindow() {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.webContents.send('subtitle-state', buildSubtitlePayload());
  }
}

function moveSubtitleIndex(delta) {
  if (!interviewState.sentences.length) return false;
  const nextIndex = Math.max(0, Math.min(interviewState.currentIndex + delta, interviewState.sentences.length - 1));
  if (nextIndex === interviewState.currentIndex) return false;
  interviewState.currentIndex = nextIndex;
  syncSubtitleWindow();
  return true;
}

function closeInterviewWindows({ focusMain = true } = {}) {
  if (isClosingInterviewWindows) return;
  isClosingInterviewWindows = true;

  abortLLM();
  closeXunfei();

  const windows = [interviewWindow, subtitleWindow];
  interviewWindow = null;
  subtitleWindow = null;

  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      try {
        win.close();
      } catch (_) {}
    }
  }

  if (focusMain && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }

  isClosingInterviewWindows = false;
}

function onInterviewChildClosed() {
  if (isClosingInterviewWindows) return;
  closeInterviewWindows();
}

function startInterview(data) {
  closeInterviewWindows({ focusMain: false });
  isTestMode = false;
  resetRoleDetection();
  closeXunfei();

  interviewState.sentences = Array.isArray(data.sentences) ? data.sentences : [];
  interviewState.lines = data.lines === 1 ? 1 : 2;
  interviewState.currentIndex = 0;
  interviewState.persona = data.persona || 'You are an interview copilot. Give concise, practical suggestions.';
  interviewState.preChatHistory = Array.isArray(data.preChatHistory) ? data.preChatHistory : [];
  interviewState.scriptText = data.scriptText || '';
  interviewState.denoiseMode = ['off', 'standard', 'strong'].includes(data.denoiseMode) ? data.denoiseMode : 'standard';

  createInterviewWindow({
    persona: interviewState.persona,
    preChatHistory: interviewState.preChatHistory,
    scriptText: interviewState.scriptText,
    denoiseMode: interviewState.denoiseMode
  });
  createSubtitleWindow(buildSubtitlePayload());
}

function startKeepAlive(session) {
  return setInterval(() => {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(Buffer.alloc(1280));
    }
  }, 10000);
}

function getRoleLabelForSource(source) {
  return source === 'system' ? 'interviewer' : 'user';
}

function getTargetWindowForSource(source) {
  return source === 'test-mic' ? mainWindow : interviewWindow;
}

function closeXunfei(source) {
  if (typeof source === 'string') {
    const session = xunfeiSessions.get(source);
    if (!session) return;

    session.lastStatus = 'manual-close';
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({ end: true, sessionId: session.sessionId || '' }));
      } catch (_) {}
    }
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }
    session.pcmQueue = [];
    if (session.ws) {
      try { session.ws.close(); } catch (_) {}
      session.ws = null;
    }
    session.connected = false;
    session.sessionId = '';
    xunfeiSessions.delete(source);

    if (source === 'test-mic') {
      sendXunfeiStatus(source, 'idle');
    }
    return;
  }

  for (const key of [...xunfeiSessions.keys()]) {
    closeXunfei(key);
  }
}

function connectXunfei(options = {}) {
  const source = options.source || (isTestMode ? 'test-mic' : 'mic');
  closeXunfei(source);

  const params = {
    accessKeyId: CONFIG.XUNFEI_API_KEY,
    appId: CONFIG.XUNFEI_APPID,
    uuid: crypto.randomUUID(),
    utc: formatUtcTime(),
    audio_encode: 'pcm_s16le',
    lang: 'autodialect',
    samplerate: '16000',
    role_type: '2'
  };

  params.signature = generateSignature(params, CONFIG.XUNFEI_API_SECRET);
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const url = `wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1?${query}`;
  const session = {
    source,
    ws: null,
    pcmQueue: [],
    connected: false,
    keepAliveTimer: null,
    sessionId: '',
    lastStatus: 'connecting'
  };
  xunfeiSessions.set(source, session);
  sendXunfeiStatus(source, 'connecting');

  let detailedErrorSent = false;
  const ws = new WebSocket(url);
  session.ws = ws;

  ws.on('unexpected-response', async (_request, response) => {
    session.connected = false;
    let detail = `HTTP ${response.statusCode || 'unknown'}`;
    if (response.statusMessage) detail += ` ${response.statusMessage}`;
    if (response.headers && response.headers.error) detail += `: ${response.headers.error}`;
    console.error('Xunfei unexpected response:', detail);
    detailedErrorSent = true;
    session.lastStatus = 'error';
    sendXunfeiStatus(source, 'error', detail);
    try { response.resume(); } catch (_) {}
  });

  ws.on('open', () => {
    session.connected = true;
    for (const buffer of session.pcmQueue) ws.send(buffer);
    session.pcmQueue = [];
    session.keepAliveTimer = startKeepAlive(session);
    session.lastStatus = 'connected';
    sendXunfeiStatus(source, 'connected');
  });

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.sid) session.sessionId = message.sid;
      if (message.msg_type === 'error') {
        const detail = typeof message.data === 'string'
          ? message.data
          : JSON.stringify(message.data || {});
        console.error('Xunfei error:', detail);
        session.lastStatus = 'error';
        sendXunfeiStatus(source, 'error', detail);
        return;
      }
      if (message.msg_type === 'result' && message.res_type === 'asr' && message.data) {
        parseAsrResult(source, message.data);
      }
    } catch (_) {}
  });

  ws.on('close', (code, reasonBuffer) => {
    session.connected = false;
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = null;
    }
    const reason = reasonBuffer ? reasonBuffer.toString() : '';
    if (session.lastStatus === 'error') return;
    if (session.lastStatus === 'manual-close') {
      if (source === 'test-mic') sendXunfeiStatus(source, 'idle');
      return;
    }
    const detail = [code ? `code=${code}` : '', reason ? `reason=${reason}` : '']
      .filter(Boolean)
      .join(', ');
    session.lastStatus = 'disconnected';
    sendXunfeiStatus(source, 'disconnected', detail);
  });

  ws.on('error', async (err) => {
    session.connected = false;
    let detail = err && err.message ? err.message : 'WebSocket error';
    if (/Invalid response status/i.test(detail) && !detailedErrorSent) {
      const probed = await probeXunfeiHandshake(url);
      if (probed) {
        detail = probed;
        detailedErrorSent = true;
      }
    }
    if (detailedErrorSent && /Invalid response status/i.test(detail) && session.lastStatus === 'error') {
      return;
    }
    console.error('Xunfei websocket error:', detail);
    session.lastStatus = 'error';
    sendXunfeiStatus(source, 'error', detail);
  });
}

function sendPcmToXunfei(source, buffer) {
  if (!buffer || buffer.byteLength === 0) return;
  const session = xunfeiSessions.get(source);
  if (!session) return;
  const chunk = Buffer.from(buffer);
  if (session.connected && session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(chunk);
  } else {
    session.pcmQueue.push(chunk);
  }
}

function parseAsrResult(source, data) {
  try {
    const st = data.cn && data.cn.st;
    if (!st || !st.rt) return;

    const isFinal = String(st.type) === '0';
    let text = '';

    for (const rt of st.rt) {
      if (!rt.ws) continue;
      for (const ws of rt.ws) {
        if (!ws.cw || !ws.cw[0]) continue;
        for (const cw of ws.cw) {
          text += cw.w || '';
        }
      }
    }

    const roleLabel = getRoleLabelForSource(source);
    const payload = { text, role: roleLabel, source };
    const targetWindow = getTargetWindowForSource(source);

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send(isFinal ? 'asr-final-result' : 'asr-interim-result', payload);
    }
  } catch (_) {}
}

async function streamDeepSeek(messages, signal, targetWindow, chunkChannel, endChannel) {
  const hasSystemMessage = messages.some((message) => message.role === 'system');
  const chatMessages = hasSystemMessage
    ? messages
    : [{ role: 'system', content: 'You are an interview copilot. Give concise, practical suggestions.' }, ...messages];

  try {
    const response = await fetch(`${CONFIG.DEEPSEEK_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: chatMessages,
        stream: true
      }),
      signal
    });

    if (!response.ok || !response.body) {
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send(endChannel);
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content && targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send(chunkChannel, content);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }

  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send(endChannel);
  }
}

function callDeepSeek(messages) {
  abortController = new AbortController();
  streamDeepSeek(messages, abortController.signal, interviewWindow, 'llm-chunk', 'llm-end');
}

function abortLLM() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

ipcMain.on('connect-xunfei', (_event, options) => {
  connectXunfei(options || {});
});

ipcMain.on('close-xunfei', (_event, source) => {
  closeXunfei(source);
});

ipcMain.on('send-pcm-data', (_event, payload) => {
  if (payload && typeof payload === 'object' && payload.buffer) {
    sendPcmToXunfei(payload.source || 'test-mic', payload.buffer);
    return;
  }
  sendPcmToXunfei(isTestMode ? 'test-mic' : 'mic', payload);
});

ipcMain.on('trigger-llm', (_event, history) => {
  abortLLM();
  callDeepSeek(history);
});

ipcMain.on('abort-llm', () => {
  abortLLM();
});

ipcMain.on('chat-to-ai', (_event, history) => {
  abortLLM();
  callDeepSeek(history);
});

ipcMain.on('start-test-mic', () => {
  isTestMode = true;
  resetRoleDetection();
  connectXunfei({ source: 'test-mic' });
});

ipcMain.on('stop-test-mic', () => {
  isTestMode = false;
  closeXunfei('test-mic');
});

ipcMain.handle('license:get-status', () => buildLicenseStatus());

ipcMain.handle('license:check-time', (_event, request) => {
  const payload = request || {};
  return evaluateLicenseTime(payload.clientActiveUntilMs);
});

ipcMain.handle('license:list-codes', (_event, options) => {
  const payload = options || {};
  assertActivationAdmin(payload.adminSecret);
  return {
    codes: listActivationCodes(payload),
    status: buildLicenseStatus()
  };
});

ipcMain.handle('license:generate-codes', (_event, request) => {
  const payload = request || {};
  assertActivationAdmin(payload.adminSecret);
  return generateActivationCodes(payload);
});

ipcMain.handle('license:redeem', (_event, rawCode) => redeemActivationCode(rawCode));

ipcMain.handle('license:set-code-disabled', (_event, request) => {
  const payload = request || {};
  assertActivationAdmin(payload.adminSecret);
  return setActivationCodeDisabled(payload.codeId, Boolean(payload.disabled));
});

ipcMain.on('start-prompter', (_event, data) => {
  const payload = data || {};
  const clientActiveUntilMs = Number(payload.licenseClientActiveUntilMs) || 0;
  if (clientActiveUntilMs <= getServerNowMs()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('license-error', '客户端权益已过期，请先兑换激活码后再开始。');
    }
    return;
  }
  startInterview(payload);
});

ipcMain.on('close-prompter', () => {
  closeInterviewWindows();
});

ipcMain.on('next-subtitle-line', () => {
  moveSubtitleIndex(1);
});

ipcMain.on('prev-subtitle-line', () => {
  moveSubtitleIndex(-1);
});

ipcMain.on('pre-chat', (_event, history) => {
  if (preChatAbortController) {
    preChatAbortController.abort();
    preChatAbortController = null;
  }
  preChatAbortController = new AbortController();
  streamDeepSeek(history, preChatAbortController.signal, mainWindow, 'pre-chunk', 'pre-end');
});

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
});
