/**
 * wechat-bridge — 常驻远程对话通道（host 平面）
 *
 * 提供两条远程入口，让手机可以和本机 DSH 会话对话：
 *   1. 局域网网页：http://<本机IP>:<port>/
 *   2. 微信 iLink Bot 官方通道：扫码授权后在微信里直接对话
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { uploadWechatFile, WECHAT_FILE_MAX_BYTES } from './wechat-media.mjs';

const WX_BASE = 'https://ilinkai.weixin.qq.com';
const WX_APP_ID = 'bot';
const WX_CLIENT_VERSION = '132102';
const WX_CHANNEL_VERSION = '2.4.6';

function defaultStateDir() {
  const home = process.env.DSH_HOME || path.resolve(os.homedir(), '.dsh');
  return path.join(home, 'wechat-bridge');
}

function isPrivateIp(ip) {
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const n = Number(ip.split('.')[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

function lanAddresses() {
  const priv = [];
  const other = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (isPrivateIp(it.address)) priv.push(it.address);
      else other.push(it.address);
    }
  }
  return priv.concat(other);
}

const PAGE_HEAD = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
  '<title>远程对话</title>',
  '<style>',
  '* { box-sizing: border-box; margin: 0; padding: 0; }',
  'html, body { height: 100%; }',
  'body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f1419; color: #e7e9ea; display: flex; flex-direction: column; }',
  'header { padding: 8px 12px; background: #161b22; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 8px; }',
  'header .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex: none; }',
  'header .dot.off { background: #f85149; }',
  'header .info { flex: 1; min-width: 0; }',
  'header .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  'header .sub { font-size: 11px; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.sel { max-width: 40%; font-size: 12px; background: #0d1117; color: #e7e9ea; border: 1px solid #30363d; border-radius: 8px; padding: 4px 6px; }',
  '#wxbar { display: none; padding: 8px 12px; background: #1c2333; border-bottom: 1px solid #21262d; font-size: 12px; color: #a5b4fc; align-items: center; gap: 8px; flex-wrap: wrap; }',
  '#wxbar a { color: #7aa2f7; }',
  '#wxbar button { font-size: 11px; padding: 3px 8px; border-radius: 6px; }',
  '#msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
  '.msg { max-width: 82%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }',
  '.msg.user { align-self: flex-end; background: #1f6feb; border-bottom-right-radius: 4px; }',
  '.msg.ai { align-self: flex-start; background: #21262d; border-bottom-left-radius: 4px; }',
  '.msg.err { align-self: flex-start; background: #3d1d1d; color: #ffa198; }',
  '.msg.typing { color: #8b949e; font-style: italic; }',
  'footer { display: flex; gap: 8px; padding: 10px; background: #161b22; border-top: 1px solid #21262d; }',
  'textarea { flex: 1; resize: none; border: 1px solid #30363d; background: #0d1117; color: #e7e9ea; border-radius: 10px; padding: 10px; font-size: 15px; line-height: 1.4; outline: none; }',
  'button { border: none; background: #1f6feb; color: #fff; border-radius: 10px; padding: 0 18px; font-size: 15px; cursor: pointer; }',
  'button:disabled { opacity: .5; }',
  '</style>',
  '</head>',
  '<body>',
  '<header>',
  '<span class="dot" id="dot"></span>',
  '<div class="info">',
  '<div class="title" id="title">连接中...</div>',
  '<div class="sub" id="sub"></div>',
  '</div>',
  '<select id="sel" class="sel" style="display:none"></select>',
  '</header>',
  '<div id="wxbar"></div>',
  '<div id="msgs"></div>',
  '<footer>',
  '<textarea id="input" rows="1" placeholder="输入消息，回车发送"></textarea>',
  '<button id="send">发送</button>',
  '</footer>',
].join('\n');

const PAGE_SCRIPT = [
  '<script>',
  '(function () {',
  '  var msgs = document.getElementById("msgs");',
  '  var input = document.getElementById("input");',
  '  var sendBtn = document.getElementById("send");',
  '  var dot = document.getElementById("dot");',
  '  var title = document.getElementById("title");',
  '  var sub = document.getElementById("sub");',
  '  var sel = document.getElementById("sel");',
  '  var wxbar = document.getElementById("wxbar");',
  '  var sessionParam = (location.search.match(/[?&]session=([^&]+)/) || [])[1] || "";',
  '  function enc(v) { return encodeURIComponent(v); }',
  '  function addMsg(role, text) {',
  '    var div = document.createElement("div");',
  '    div.className = "msg " + role;',
  '    div.textContent = text;',
  '    msgs.appendChild(div);',
  '    msgs.scrollTop = msgs.scrollHeight;',
  '    return div;',
  '  }',
  '  function api(p, body) {',
  '    var opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined;',
  '    return fetch(p, opt).then(function (r) { return r.json(); });',
  '  }',
  '  function renderWx(w) {',
  '    wxbar.style.display = "flex";',
  '    wxbar.innerHTML = "";',
  '    var span = document.createElement("span");',
  '    if (!w || !w.enabled) { wxbar.style.display = "none"; return; }',
  '    if (w.connected) {',
  '      span.textContent = "微信通道：已连接" + (w.account ? " (" + w.account.split("@")[0] + ")" : "");',
  '      wxbar.appendChild(span);',
  '    } else {',
  '      span.textContent = "微信通道：未授权";',
  '      wxbar.appendChild(span);',
  '      if (w.qrUrl) {',
  '        var a = document.createElement("a");',
  '        a.href = w.qrUrl;',
  '        a.target = "_blank";',
  '        a.textContent = "用微信打开授权";',
  '        wxbar.appendChild(a);',
  '      }',
  '      var btn = document.createElement("button");',
  '      btn.textContent = "重新生成二维码";',
  '      btn.addEventListener("click", function () {',
  '        btn.disabled = true;',
  '        api("/api/wechat-relogin", {}).then(function () { setTimeout(loadWx, 1500); }).finally(function () { btn.disabled = false; });',
  '      });',
  '      wxbar.appendChild(btn);',
  '    }',
  '    if (w.error) {',
  '      var e = document.createElement("span");',
  '      e.textContent = "· " + w.error;',
  '      wxbar.appendChild(e);',
  '    }',
  '  }',
  '  function loadWx() { return api("/api/wechat-status").then(renderWx).catch(function () {}); }',
  '  function fillSessions(s) {',
  '    if (!s.sessions || !s.sessions.length) return;',
  '    s.sessions.forEach(function (it) {',
  '      var op = document.createElement("option");',
  '      op.value = it.id;',
  '      op.textContent = (it.title || it.id.slice(0, 12)) + " (" + it.id.slice(8, 16) + ")";',
  '      if (it.id === s.sessionId) op.selected = true;',
  '      sel.appendChild(op);',
  '    });',
  '    sel.style.display = "block";',
  '    sel.addEventListener("change", function () { if (sel.value) location.href = location.pathname + "?session=" + enc(sel.value); });',
  '  }',
  '  function load() {',
  '    api("/api/status?session=" + enc(sessionParam)).then(function (s) {',
  '      if (s.ok && s.sessionId) {',
  '        dot.className = "dot";',
  '        title.textContent = s.title || "会话 " + s.sessionId.slice(8, 16);',
  '        sub.textContent = s.sessionId;',
  '        fillSessions(s);',
  '        return api("/api/history?session=" + enc(sessionParam) + "&limit=100").then(function (h) {',
  '          msgs.innerHTML = "";',
  '          if (h.ok && h.messages) h.messages.forEach(function (m) { addMsg(m.role === "user" ? "user" : "ai", m.text); });',
  '        });',
  '      }',
  '      dot.className = "dot off";',
  '      title.textContent = "未连接";',
  '      sub.textContent = (s && s.error) ? s.error : "无可用会话";',
  '    }).catch(function (e) {',
  '      dot.className = "dot off";',
  '      title.textContent = "连接失败";',
  '      sub.textContent = String(e);',
  '    }).finally(loadWx);',
  '  }',
  '  function sendMsg() {',
  '    var text = input.value.trim();',
  '    if (!text) return;',
  '    input.value = "";',
  '    input.style.height = "auto";',
  '    addMsg("user", text);',
  '    var t = addMsg("typing", "思考中...");',
  '    sendBtn.disabled = true;',
  '    api("/api/chat?session=" + enc(sessionParam), { text: text }).then(function (r) {',
  '      if (t.parentNode) msgs.removeChild(t);',
  '      if (r.ok) addMsg("ai", r.reply || "(空回复)");',
  '      else addMsg("err", r.error || "请求失败");',
  '    }).catch(function (e) {',
  '      if (t.parentNode) msgs.removeChild(t);',
  '      addMsg("err", String(e));',
  '    }).finally(function () { sendBtn.disabled = false; });',
  '  }',
  '  sendBtn.addEventListener("click", sendMsg);',
  '  input.addEventListener("keydown", function (e) {',
  '    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }',
  '  });',
  '  input.addEventListener("input", function () {',
  '    input.style.height = "auto";',
  '    input.style.height = Math.min(input.scrollHeight, 140) + "px";',
  '  });',
  '  load();',
  '  setInterval(loadWx, 20000);',
  '})();',
  '</script>',
  '</body>',
  '</html>',
].join('\n');

const PAGE = PAGE_HEAD + '\n' + PAGE_SCRIPT;

export default {
  name: 'dsh-wechat-bridge',
  inject: ['agents', 'userQuestions'],

  apply(ctx, options) {
    const cfg = Object.assign(
      {
        port: 8848,
        host: '127.0.0.1',
        session: '',
        wechat: true,
        syncQuestions: true,
        syncReplies: true,
        summaryChars: 600,
        staleMs: 600000,
        waitMsWeb: 180000,
        waitMsWechat: 600000,
        relay: 'session',
        controlAllowRemote: false,
        controlToken: '',
        eventBacklog: 200,
        guiPort: 3080,
        newSessionCwd: '',
        fileSendRoots: [os.homedir()],
        fileSendMaxBytes: WECHAT_FILE_MAX_BYTES,
        stateDir: defaultStateDir(),
      },
      options || {},
    );

    const logger = typeof ctx.logger === 'function' ? ctx.logger('wechat-bridge') : undefined;
    const TOKEN_FILE = path.join(cfg.stateDir, 'wechat-token.json');
    const CURSOR_FILE = path.join(cfg.stateDir, 'wechat-cursor.txt');
    const SEEN_FILE = path.join(cfg.stateDir, 'wechat-seen.json');
    const seen = new Set();
    const QR_FILE = path.join(cfg.stateDir, 'wechat-qr.txt');
    const CONTEXT_FILE = path.join(cfg.stateDir, 'wechat-context.txt');
    const LOG_FILE = path.join(cfg.stateDir, 'bridge.log');
    const RELAY_FILE = path.join(cfg.stateDir, 'wechat-relay.txt');
    const OUTBOX_FILE = path.join(cfg.stateDir, 'wechat-outbox.json');

    try { fs.mkdirSync(cfg.stateDir, { recursive: true }); } catch { /* best effort */ }

    function log(line) {
      const text = new Date().toISOString() + ' ' + line;
      try { fs.appendFileSync(LOG_FILE, text + '\n'); } catch { /* best effort */ }
      logger?.info?.(line);
      try { emitEvent('log', { line: String(line) }); } catch { /* bus not ready yet */ }
    }

    function note(message) {
      wx.lastError = message;
      log('ERROR ' + message);
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const eventBus = { seq: 0, buffer: [], subscribers: new Set() };

    function emitEvent(type, data) {
      eventBus.seq += 1;
      const event = Object.assign({ seq: eventBus.seq, type, at: Date.now() }, data || {});
      eventBus.buffer.push(event);
      const cap = Math.max(20, Number(cfg.eventBacklog) || 200);
      if (eventBus.buffer.length > cap) eventBus.buffer.splice(0, eventBus.buffer.length - cap);
      for (const send of [...eventBus.subscribers]) {
        try { send(event); } catch { /* subscriber cleanup on close */ }
      }
      return event;
    }

    const RELAY_MODES = ['session', 'cli', 'off'];
    let relayMode = RELAY_MODES.includes(cfg.relay) ? cfg.relay : 'session';

    function loadRelay() {
      try {
        const saved = fs.readFileSync(RELAY_FILE, 'utf-8').trim();
        if (RELAY_MODES.includes(saved)) {
          relayMode = saved;
          log('消息去向(relay): ' + saved + '（沿用上次设置）');
        }
      } catch { /* no saved relay */ }
    }

    function saveRelay(mode) {
      relayMode = mode;
      try { fs.writeFileSync(RELAY_FILE, mode); } catch { /* best effort */ }
      emitEvent('relay', { relay: mode });
    }

    const resumed = new Map();

    async function resolveAgent(sessionId) {
      const target = String(sessionId || cfg.session || '');
      if (target) {
        const live = ctx.agents.get(target);
        if (live) return live;
        const known = resumed.get(target);
        if (known) return known.agent;
        const handle = await ctx.agents.resume({ resumeSessionId: target });
        resumed.set(target, handle);
        log('resumed session ' + target);
        return handle.agent;
      }
      const roots = ctx.agents.roots() || [];
      if (roots.length === 0) throw new Error('当前没有活跃会话，且未配置默认会话');
      return roots.slice().sort((a, b) => (b.session?.seq || 0) - (a.session?.seq || 0))[0];
    }

    function makeUserMessage(text) {
      return { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
    }

    function textBlocks(content) {
      const parts = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      return parts;
    }

    function extractAssistantText(session) {
      const msgs = session.deriveMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'assistant') continue;
        const parts = textBlocks(msgs[i].content);
        if (parts.length > 0) return parts.join('\n');
      }
      return '';
    }

    function historyMessages(session, limit) {
      const out = [];
      for (const m of session.deriveMessages()) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const parts = textBlocks(m.content);
        if (parts.length === 0) continue;
        out.push({ role: m.role, text: parts.join('\n') });
      }
      return out.slice(Math.max(0, out.length - limit));
    }

    function readTitle(session) {
      try {
        const service = ctx.get('sessionTitle');
        const snapshot = service?.get(session);
        return typeof snapshot?.title === 'string' ? snapshot.title : undefined;
      } catch { return undefined; }
    }

    let chatTail = Promise.resolve();
    function enqueue(task) {
      const run = chatTail.then(task);
      chatTail = run.then(() => undefined, () => undefined);
      return run;
    }

    let guiCookie = '';
    let guiCookieAt = 0;
    const GUI_COOKIE_REFRESH_MS = 24 * 3600 * 1000;

    function connectionService() {
      try { return ctx.get('connection'); } catch { return undefined; }
    }

    function requestGuiCookie(tokenUrl) {
      return new Promise((resolve, reject) => {
        const u = new URL(tokenUrl);
        const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
          const raw = res.headers['set-cookie'] || [];
          const picked = raw.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('dsh-auth-'));
          res.resume();
          res.on('end', () => {
            if (picked) resolve(picked);
            else reject(new Error('换 GUI cookie 失败：HTTP ' + res.statusCode + '，响应没有 dsh-auth cookie'));
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('换 GUI cookie 超时')));
      });
    }

    async function mintGuiCookie(force) {
      if (!force && guiCookie && Date.now() - guiCookieAt < GUI_COOKIE_REFRESH_MS) return guiCookie;
      const conn = connectionService();
      if (!conn || typeof conn.authenticatedUrl !== 'function') throw new Error('GUI 鉴权不可用：进程内没有 connection 服务');
      const tokenUrl = conn.authenticatedUrl('http://127.0.0.1:' + cfg.guiPort + '/');
      guiCookie = await requestGuiCookie(tokenUrl);
      guiCookieAt = Date.now();
      log('GUI 鉴权 cookie 已就绪');
      return guiCookie;
    }

    async function guiRpc(method, payload) {
      const endpoint = String(method).replaceAll('.', '/');
      const argumentName = endpoint === 'session/list' ? '_request' : 'request';
      const base = 'http://127.0.0.1:' + cfg.guiPort + '/api/' + endpoint;
      const call = (forceCookie) => mintGuiCookie(forceCookie).then((cookie) => fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint,
          payload: { args: { [argumentName]: payload } },
        }),
      }));
      let res = await call(false);
      if (res.status === 401) {
        log('GUI cookie 失效（HTTP 401），重新获取');
        res = await call(true);
      }
      let data;
      try { data = await res.json(); } catch { throw new Error(method + ' 返回了非 JSON（HTTP ' + res.status + '）'); }
      if (data?.result?.ok !== true) {
        const err = data?.result?.error;
        const detail = [err?.code, err?.message].filter(Boolean).join(' ') || '未知错误';
        log('RPC ' + method + ' 被拒: ' + detail);
        const failure = new Error(method + ' 失败: ' + detail);
        failure.rpcCode = err?.code || '';
        throw failure;
      }
      return data.result.value;
    }

    async function runChat(text, sessionId, waitMs) {
      const agent = await resolveAgent(sessionId);
      let queued = false;
      try {
        await guiRpc('session.prompt', { sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text }] });
      } catch (error) {
        log('改用 followup 排队（' + (error?.message || error) + '）');
        agent.followup(makeUserMessage(text));
        queued = true;
      }
      let timer;
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('等待回复超时（' + Math.round(waitMs / 1000) + ' 秒）' + (queued ? '，消息已排进队列' : '，消息已送达'))), waitMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
      return { reply: extractAssistantText(agent.session), sessionId: agent.id, title: readTitle(agent.session) };
    }

    const wx = {
      token: '', baseurl: WX_BASE, cursor: '', account: '', qrUrl: '', lastError: '', lastContextToken: '',
      connected: false, contextStale: false, readyAt: 0, lastMessageAt: 0,
    };
    let stopped = false;

    function baseInfo() { return { channel_version: WX_CHANNEL_VERSION, bot_agent: 'DSH-wechat-bridge' }; }

    function wxHeaders(token) {
      const uin = Buffer.from(String(Math.floor(Math.random() * 4294967295)), 'utf-8').toString('base64');
      const headers = {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': uin,
        'iLink-App-Id': WX_APP_ID, 'iLink-App-ClientVersion': WX_CLIENT_VERSION,
      };
      if (token) headers.Authorization = 'Bearer ' + token;
      return headers;
    }

    async function wxFetch(method, url, body, token, timeoutMs) {
      const res = await fetch(url, {
        method, headers: wxHeaders(token),
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 40000),
      });
      return { status: res.status, text: await res.text() };
    }

    function loadPersisted() {
      try {
        const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
        if (saved?.token) {
          wx.token = saved.token;
          wx.baseurl = saved.baseurl || WX_BASE;
          wx.account = saved.account || saved.userId || '';
        }
      } catch { /* no saved token */ }
      loadSeen();
      try {
        wx.lastContextToken = fs.readFileSync(CONTEXT_FILE, 'utf-8').trim();
        if (wx.lastContextToken) log('已恢复上下文令牌，可主动推送');
      } catch { /* no context yet */ }
      loadOutbox();
    }

    function loadSeen() {
      try { for (const id of JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'))) seen.add(String(id)); } catch { /* no history */ }
    }

    function rememberSeen(id) {
      seen.add(id);
      if (seen.size > 400) {
        const recent = [...seen].slice(-200);
        seen.clear();
        for (const item of recent) seen.add(item);
      }
      try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen])); } catch { /* best effort */ }
    }

    function rememberContext(contextToken) {
      if (!contextToken || contextToken === wx.lastContextToken) return;
      wx.lastContextToken = contextToken;
      wx.contextStale = false;
      try { fs.writeFileSync(CONTEXT_FILE, contextToken); } catch { /* best effort */ }
      void flushOutbox();
    }

    function forgetContext() {
      wx.lastContextToken = '';
      try { fs.rmSync(CONTEXT_FILE, { force: true }); } catch { /* best effort */ }
    }

    let outbox = [];
    let flushing = false;

    function loadOutbox() {
      try {
        const saved = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf-8'));
        if (Array.isArray(saved)) outbox = saved.filter((item) => item && typeof item.text === 'string');
        if (outbox.length) log('待发队列已恢复: ' + outbox.length + ' 条');
      } catch { outbox = []; }
    }

    function persistOutbox() {
      try {
        if (outbox.length) fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox));
        else fs.rmSync(OUTBOX_FILE, { force: true });
      } catch { /* best effort */ }
    }

    function queueOutbox(text, label) {
      outbox.push({ text, label: label || '补发', at: Date.now() });
      if (outbox.length > 30) outbox.splice(0, outbox.length - 30);
      persistOutbox();
      log('已排队待发(' + outbox.length + ' 条): ' + text.slice(0, 40));
      emitEvent('queued', { count: outbox.length, text });
      return outbox.length;
    }

    async function flushOutbox() {
      if (flushing || outbox.length === 0) return;
      if (!wx.connected || !wx.account || !wx.lastContextToken) return;
      flushing = true;
      try {
        while (outbox.length > 0 && !stopped) {
          const item = outbox[0];
          const result = await wxSend(wx.account, wx.lastContextToken, item.text, item.label + '(补发)');
          if (!result.ok) {
            if (result.ret === -2) wx.contextStale = true;
            break;
          }
          outbox.shift();
          persistOutbox();
          emitEvent('sent', { ok: true, kind: 'flush', text: item.text, ret: result.ret, errmsg: '', messageId: result.messageId });
        }
        if (outbox.length === 0) log('待发队列已清空');
      } finally { flushing = false; }
    }

    const envelopes = new Map();
    function rememberEnvelope(messageId, message) {
      if (!messageId) return;
      envelopes.set(messageId, {
        from: message.from_user_id || '', context: message.context_token || '', runId: message.run_id || '', at: Date.now(),
      });
      if (envelopes.size > 60) {
        for (const key of [...envelopes.keys()].slice(0, envelopes.size - 40)) envelopes.delete(key);
      }
    }

    function persistToken() {
      try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: wx.token, baseurl: wx.baseurl, account: wx.account })); } catch { /* best effort */ }
    }
    function persistCursor() { try { fs.writeFileSync(CURSOR_FILE, wx.cursor); } catch { /* best effort */ } }

    async function requestQrCode() {
      const res = await wxFetch('POST', WX_BASE + '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, '', 30000);
      const parsed = JSON.parse(res.text);
      if (!parsed?.qrcode) throw new Error('网关未返回二维码: ' + res.text.slice(0, 200));
      wx.qrUrl = parsed.qrcode_img_content || '';
      try { fs.writeFileSync(QR_FILE, wx.qrUrl); } catch { /* best effort */ }
      log('微信授权链接（用手机微信打开）: ' + wx.qrUrl);
      return parsed.qrcode;
    }

    async function login() {
      try {
        const qrcode = await requestQrCode();
        while (!stopped) {
          let status = 'wait';
          let payload = null;
          try {
            const res = await wxFetch('GET', WX_BASE + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), null, '', 40000);
            payload = JSON.parse(res.text);
            status = payload?.status || 'wait';
          } catch { await sleep(3000); continue; }
          if (status === 'confirmed') {
            wx.token = payload.bot_token || '';
            wx.baseurl = payload.baseurl || WX_BASE;
            wx.account = payload.ilink_user_id || '';
            wx.cursor = '';
            wx.qrUrl = '';
            wx.lastError = '';
            persistToken();
            persistCursor();
            log('微信授权成功: ' + wx.account);
            return true;
          }
          if (status === 'expired' || status === 'verify_code_blocked') {
            note('二维码已失效（' + status + '），可在手机页面点“重新生成二维码”');
            return false;
          }
          await sleep(2000);
        }
        return false;
      } catch (error) {
        note('获取二维码失败: ' + (error?.message || error));
        return false;
      }
    }

    async function activateSession() {
      try {
        const res = await wxFetch('POST', wx.baseurl + '/ilink/bot/msg/notifystart', { base_info: baseInfo() }, wx.token, 15000);
        const parsed = JSON.parse(res.text);
        log('notifystart -> ' + res.text.slice(0, 120));
        if (parsed?.ret !== 0) return false;
        wx.cursor = '';
        persistCursor();
        return true;
      } catch (error) {
        log('notifystart 失败: ' + (error?.message || error));
        return false;
      }
    }

    async function notifyStop() {
      if (!wx.token) return;
      try { await wxFetch('POST', wx.baseurl + '/ilink/bot/msg/notifystop', { base_info: baseInfo() }, wx.token, 5000); } catch { /* shutdown */ }
    }

    function extractWechatText(message) {
      for (const item of message.item_list || []) {
        if (item.type === 1 && item.text_item?.text) return item.text_item.text;
        if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
      }
      return '';
    }

    async function wxSendItem(toUserId, contextToken, item, label, runId, summary) {
      const clientId = 'dsh-wechat-bridge-' + crypto.randomUUID();
      const msg = {
        from_user_id: '', to_user_id: toUserId || '', client_id: clientId,
        message_type: 2, message_state: 2, item_list: [item],
      };
      if (contextToken) msg.context_token = contextToken;
      if (runId) msg.run_id = runId;
      let last = { ok: false, ret: null, errmsg: '未发送', messageId: '' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await wxFetch('POST', wx.baseurl + '/ilink/bot/sendmessage', { msg, base_info: baseInfo() }, wx.token, 30000);
          let parsed = null;
          try { parsed = JSON.parse(res.text); } catch { parsed = null; }
          const messageId = parsed?.message_id === undefined ? '' : String(parsed.message_id);
          const ret = typeof parsed?.ret === 'number' ? parsed.ret : messageId ? 0 : null;
          const ok = ret === 0 || (ret === null && messageId !== '');
          log(label + '(' + String(summary || '消息').slice(0, 80) + ', ctx=' + (contextToken ? '有' : '无') + ', 第' + attempt + '次) -> ' + res.text.slice(0, 120));
          last = { ok, ret, errmsg: parsed?.errmsg || (ok ? '' : '未知错误'), messageId };
          if (ok) return last;
          if (ret === -2) return last;
          if (attempt < 3) await sleep(attempt * 1500);
        } catch (error) {
          const errmsg = String(error?.message || error);
          log(label + '失败(第' + attempt + '次): ' + errmsg);
          last = { ok: false, ret: null, errmsg, messageId: '' };
          if (attempt < 3) await sleep(attempt * 2000);
        }
      }
      if (!last.ok) note(label + '未送达: ' + (last.errmsg || 'ret=' + last.ret));
      return last;
    }

    async function wxSend(toUserId, contextToken, text, label, runId) {
      return wxSendItem(toUserId, contextToken, { type: 1, text_item: { text } }, label, runId, text.length + '字');
    }

    async function sendWechatFile(filePath, envelope) {
      if (!wx.connected || !wx.account) throw new Error('微信通道未连接');
      const toUserId = envelope?.from || wx.account;
      const contextToken = envelope?.context || wx.lastContextToken;
      const runId = envelope?.runId || '';
      const uploaded = await uploadWechatFile({
        filePath,
        allowedRoots: cfg.fileSendRoots,
        maxBytes: Math.min(Number(cfg.fileSendMaxBytes) || WECHAT_FILE_MAX_BYTES, WECHAT_FILE_MAX_BYTES),
        toUserId, fetchFn: fetch, log,
        requestUpload: async (request) => {
          const res = await wxFetch('POST', wx.baseurl + '/ilink/bot/getuploadurl', Object.assign({}, request, { base_info: baseInfo() }), wx.token, 30000);
          try { return JSON.parse(res.text); } catch { throw new Error('微信 getuploadurl 返回无效 JSON（HTTP ' + res.status + '）'); }
        },
      });
      let result = await wxSendItem(toUserId, contextToken, uploaded.item, 'sendfile', runId, uploaded.fileName + ' ' + uploaded.bytes + 'B');
      if (!result.ok && result.ret === -2 && contextToken && !envelope) {
        wx.contextStale = true;
        forgetContext();
        result = await wxSendItem(toUserId, '', uploaded.item, 'sendfile(无上下文)', '', uploaded.fileName);
      }
      if (result.ok) wx.contextStale = false;
      emitEvent('sent', {
        ok: result.ok, kind: 'file', text: uploaded.fileName, bytes: uploaded.bytes,
        ret: result.ret, errmsg: result.errmsg, messageId: result.messageId,
      });
      return Object.assign({}, result, { fileName: uploaded.fileName, bytes: uploaded.bytes });
    }

    async function sendWechatReply(message, text) {
      const result = await wxSend(message.from_user_id, message.context_token, text, 'sendmessage', message.run_id);
      emitEvent('sent', { ok: result.ok, kind: 'reply', text, ret: result.ret, errmsg: result.errmsg, messageId: result.messageId });
      return result.ok;
    }

    let pendingAnswer = null;

    function formatQuestion(question, index, total) {
      const lines = [];
      lines.push('❓ 需要你确认' + (total > 1 ? '（' + (index + 1) + '/' + total + '）' : ''));
      if (question.header) lines.push('【' + question.header + '】');
      lines.push(question.question);
      if (question.detail) {
        const detail = String(question.detail);
        lines.push('—— ' + (detail.length > 500 ? detail.slice(0, 500) + '…' : detail));
      }
      const options = question.options || [];
      options.forEach((option, i) => lines.push(String(i + 1) + '. ' + option.label + (option.description ? '（' + option.description + '）' : '')));
      if (options.length > 0) lines.push(question.multiSelect ? '↩ 回复编号可多选（如 1,3），也可直接打字。' : '↩ 回复编号（如 1），也可直接打字。');
      else lines.push('↩ 直接回复你的答案。');
      return lines.join('\n');
    }

    function parseAnswer(question, text) {
      const options = question.options || [];
      const trimmed = String(text).trim();
      const picked = [];
      if (options.length > 0) {
        for (const raw of trimmed.match(/\d+/g) || []) {
          const index = Number(raw) - 1;
          if (index >= 0 && index < options.length && !picked.includes(options[index].label)) picked.push(options[index].label);
          if (!question.multiSelect && picked.length > 0) break;
        }
        if (picked.length === 0) {
          const hit = options.find((option) => option.label === trimmed || option.label.includes(trimmed) || trimmed.includes(option.label));
          if (hit) picked.push(hit.label);
        }
      }
      if (picked.length > 0) return { id: question.id, selected: picked };
      return { id: question.id, selected: [], custom: trimmed };
    }

    function pushWechat(text, label, queue) {
      if (!wx.connected || !wx.account) {
        log('主动推送跳过：微信通道未连接');
        if (queue) queueOutbox(text, label || '主动推送');
        return Promise.resolve(false);
      }
      return pushWechatDetailed(text, label, queue).then((result) => result.ok);
    }

    async function pushWechatDetailed(text, label, queue) {
      const tag = label || '主动推送';
      if (!wx.connected || !wx.account) {
        if (queue) queueOutbox(text, tag);
        return { ok: false, ret: null, errmsg: '微信通道未连接', messageId: '', queued: Boolean(queue) };
      }
      let result = await wxSend(wx.account, wx.lastContextToken, text, tag);
      if (!result.ok && result.ret === -2 && wx.lastContextToken) {
        wx.contextStale = true;
        log('上下文令牌已过期（ret:-2 prepare failed），清除后改用无上下文投递');
        forgetContext();
        result = await wxSend(wx.account, '', text, tag + '(无上下文)');
      }
      if (!result.ok && result.ret === -2) wx.contextStale = true;
      if (result.ok) wx.contextStale = false;
      let queued = false;
      if (!result.ok && queue) { queueOutbox(text, tag); queued = true; }
      emitEvent('sent', {
        ok: result.ok, kind: 'push', text, ret: result.ret, errmsg: result.errmsg,
        messageId: result.messageId, queued,
      });
      return Object.assign({}, result, { queued });
    }

    const never = () => new Promise(() => {});

    async function askThroughWechat(request, signal) {
      if (!cfg.syncQuestions) return never();
      const answers = [];
      const total = request.questions.length;
      for (let index = 0; index < total; index++) {
        const question = request.questions[index];
        if (!(await pushWechat(formatQuestion(question, index, total)))) return never();
        const reply = await new Promise((resolve, reject) => {
          pendingAnswer = { resolve, reject };
          signal?.addEventListener('abort', () => {
            pendingAnswer = null;
            reject(new Error('该问题已在电脑端回答'));
          }, { once: true });
        });
        answers.push(parseAnswer(question, reply));
      }
      log('微信侧回答完成，共 ' + answers.length + ' 项');
      return { answers };
    }

    function installQuestionBridge() {
      const service = ctx.userQuestions;
      if (!service) {
        log('提问同步未启用：userQuestions 服务不可用');
        return () => {};
      }
      let target = service;
      while (target && !Object.getOwnPropertyDescriptor(target, 'provider')) target = Object.getPrototypeOf(target);
      if (!target) {
        target = service;
        log('提问同步警告：未在原型链上找到 provider 字段，退回服务对象本身');
      }
      let inner = target.provider;
      let wrapped = null;
      const wrap = (provider) => ({
        ask: (request) => {
          const controller = new AbortController();
          const viaUi = provider.ask(request).then((answer) => {
            void pushWechat('✅ 该问题已在电脑端回答，微信这边不用再回复了。');
            return answer;
          });
          const viaWechat = askThroughWechat(request, controller.signal);
          viaUi.catch(() => {});
          viaWechat.catch(() => {});
          return Promise.race([viaUi, viaWechat]).finally(() => {
            controller.abort();
            pendingAnswer = null;
          });
        },
      });
      Object.defineProperty(target, 'provider', {
        configurable: true,
        enumerable: true,
        get() {
          if (inner === undefined) return undefined;
          if (!wrapped) wrapped = wrap(inner);
          return wrapped;
        },
        set(value) { inner = value; wrapped = null; },
      });
      log(
        '提问同步已启用（电脑弹窗 + 微信，谁先回答用谁）· 挂载层=' +
          (target === service ? 'service' : 'prototype:' + (target.constructor?.name || '?')) +
          ' · 现有provider=' +
          (inner === undefined ? '尚未注册（等 UI 注册后自动生效）' : typeof inner),
      );
      return () => {
        Object.defineProperty(target, 'provider', {
          configurable: true, enumerable: true, writable: true, value: inner,
        });
      };
    }

    let wechatTurns = 0;
    let lastPushedReply = '';
    const WX_SESSION_FILE = path.join(cfg.stateDir, 'wechat-session.txt');
    let wxSession = '';
    const WX_CMD_NEW = ['/new', '/新对话', '新对话', '开新对话', '新会话', '开新会话'];
    const WX_CMD_LIST = ['/list', '/会话', '/列表', '会话列表'];
    const WX_CMD_WHO = ['/who', '/当前', '当前会话'];
    const WX_CMD_HELP = ['/help', '/帮助', '帮助'];

    function loadWxSession() {
      try {
        const saved = fs.readFileSync(WX_SESSION_FILE, 'utf-8').trim();
        if (saved) { wxSession = saved; log('微信绑定会话: ' + saved); }
      } catch { /* use configured default */ }
    }

    function saveWxSession(id) {
      wxSession = String(id || '');
      try {
        if (wxSession) fs.writeFileSync(WX_SESSION_FILE, wxSession);
        else fs.rmSync(WX_SESSION_FILE, { force: true });
      } catch { /* best effort */ }
    }

    function activeWechatSession() { return wxSession || cfg.session || ''; }
    function shortId(id) { return String(id || '').replace(/^session-/, '').slice(0, 8); }

    async function listSessions() {
      try {
        const value = await guiRpc('session.list', {});
        const items = Array.isArray(value?.items) ? value.items : [];
        const rows = items
          .filter((item) => item && item.origin !== 'subagent' && !item.parentSessionId && item.blank !== true)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, 9)
          .map((item) => ({
            id: item.sessionId,
            title: item.projections?.values?.title || '未命名',
            running: Boolean(item.running),
          }));
        if (rows.length) return rows;
      } catch (error) {
        log('读取会话列表失败，改用内存活跃列表: ' + (error?.message || error));
      }
      return (ctx.agents.roots() || [])
        .slice()
        .sort((a, b) => (b.session?.seq || 0) - (a.session?.seq || 0))
        .slice(0, 9)
        .map((agent) => ({ id: agent.id, title: readTitle(agent.session) || '未命名', running: false }));
    }

    function wxHelpText() {
      return [
        '📖 微信端指令',
        '/新对话   开一个全新会话，之后的消息都发到它',
        '/会话     列出活跃会话（带编号）',
        '/切换 2   切到第 2 个会话',
        '/当前     看现在连的是哪个会话',
        '/帮助     这份说明',
        '',
        '其它任何内容都会当成对话发给 AI。',
      ].join('\n');
    }

    async function createSessionForWechat() {
      let cwd;
      let presetId;
      const template = activeWechatSession();
      try {
        const value = await guiRpc('session.list', {});
        const items = Array.isArray(value?.items) ? value.items : [];
        const hit = items.find((item) => item?.sessionId === template);
        if (hit) {
          if (typeof hit.cwd === 'string' && hit.cwd) cwd = hit.cwd;
          if (typeof hit.agentPreset === 'string' && hit.agentPreset) presetId = hit.agentPreset;
        }
      } catch (error) {
        log('读取模板会话失败（改用默认值）: ' + (error?.message || error));
      }
      if (!cwd && cfg.newSessionCwd) cwd = cfg.newSessionCwd;
      const payload = {};
      if (cwd) payload.cwd = cwd;
      if (presetId) payload.agentPreset = presetId;
      const value = await guiRpc('session.create', payload);
      log('新建会话 ' + value.sessionId + ' · preset=' + (value.agentPreset || '默认') + ' · cwd=' + (cwd || '默认'));
      return value.sessionId;
    }

    async function handleWechatCommand(message, raw) {
      const text = raw.trim();
      const lower = text.toLowerCase();
      if (WX_CMD_HELP.includes(lower)) {
        await sendWechatReply(message, wxHelpText());
        return true;
      }
      if (WX_CMD_WHO.includes(lower)) {
        const id = activeWechatSession();
        let title = '';
        try { title = readTitle((await resolveAgent(id)).session) || ''; } catch { /* optional title */ }
        await sendWechatReply(
          message,
          '📍 当前会话：' + (title || '未命名') + '\n' + (id || '(最近活跃的会话)') +
            '\n\n发 /新对话 另开一路，发 /会话 看全部。',
        );
        return true;
      }
      if (WX_CMD_LIST.includes(lower)) {
        const items = await listSessions();
        if (!items.length) {
          await sendWechatReply(message, '一个会话都没有。发 /新对话 就能开一个。');
          return true;
        }
        const current = activeWechatSession();
        const lines = ['📋 最近会话（★ 是当前，▶ 正在跑）'];
        items.forEach((item, index) => {
          lines.push(
            (item.id === current ? '★' : '　') + (index + 1) + '. ' + (item.running ? '▶ ' : '') +
              item.title + '  [' + shortId(item.id) + ']',
          );
        });
        lines.push('', '发「/切换 2」换到第 2 个。');
        await sendWechatReply(message, lines.join('\n'));
        return true;
      }
      const switchMatch = /^(?:\/(?:use|switch|切换)|切换)\s*(\d{1,2})$/i.exec(text);
      if (switchMatch) {
        const items = await listSessions();
        const index = Number(switchMatch[1]) - 1;
        if (!items[index]) {
          await sendWechatReply(message, '没有第 ' + (index + 1) + ' 个会话。发 /会话 看看有哪些。');
          return true;
        }
        saveWxSession(items[index].id);
        lastPushedReply = '';
        log('微信切换会话 -> ' + items[index].id);
        await sendWechatReply(message, '✅ 已切到：' + items[index].title + '\n' + items[index].id);
        return true;
      }
      if (WX_CMD_NEW.includes(lower)) {
        try {
          const createdId = await createSessionForWechat();
          saveWxSession(createdId);
          lastPushedReply = '';
          await sendWechatReply(
            message,
            '✅ 已开新对话\n' + createdId +
              '\n\n之后的消息都发到这里。电脑端也能在会话列表里看到它。\n发 /会话 可以切回原来那个。',
          );
        } catch (error) {
          await sendWechatReply(message, '新建会话失败：' + (error?.message || error));
        }
        return true;
      }
      return false;
    }

    function summarize(text) {
      const clean = String(text).trim();
      if (clean.length <= cfg.summaryChars) return clean;
      return clean.slice(0, cfg.summaryChars) + '\n…（后面还有，完整内容看电脑或手机网页 :' + cfg.port + '）';
    }

    function isTargetAgent(agent) {
      if (!agent) return false;
      const target = activeWechatSession();
      if (target) return agent.id === target;
      return (ctx.agents.roots() || []).includes(agent);
    }

    function onAgentStatus(payload) {
      if (!cfg.syncReplies || payload?.status !== 'idle' || !isTargetAgent(payload.agent) || wechatTurns > 0) return;
      let reply = '';
      try { reply = extractAssistantText(payload.agent.session); } catch { return; }
      if (!reply || reply === lastPushedReply) return;
      lastPushedReply = reply;
      void pushWechat('💬 ' + summarize(reply));
    }

    async function handleWechatMessage(message, text) {
      const messageId = String(message.message_id ?? '');
      rememberEnvelope(messageId, message);
      wx.lastMessageAt = Date.now();
      emitEvent('message', {
        messageId, text, from: message.from_user_id || wx.account || '', relay: relayMode,
        answering: Boolean(pendingAnswer),
      });
      if (pendingAnswer) {
        const waiter = pendingAnswer;
        pendingAnswer = null;
        log('微信回答问题: ' + text.slice(0, 80));
        waiter.resolve(text);
        await sendWechatReply(message, '✅ 已收到你的回答：' + text);
        return;
      }
      if (await handleWechatCommand(message, text)) return;
      if (relayMode === 'cli') {
        log('微信消息 -> CLI: ' + text.slice(0, 120));
        return;
      }
      if (relayMode === 'off') {
        log('微信消息 -> 已忽略(relay=off): ' + text.slice(0, 120));
        return;
      }
      log('微信消息 -> 会话: ' + text.slice(0, 120));
      wechatTurns += 1;
      try {
        const result = await enqueue(() => runChat(text, activeWechatSession(), cfg.waitMsWechat));
        lastPushedReply = String(result.reply || '');
        await sendWechatReply(message, result.reply || '(空回复)');
      } catch (error) {
        await sendWechatReply(message, '(出错了: ' + (error?.message || error) + ')');
      } finally { wechatTurns -= 1; }
    }

    async function wechatLoop() {
      loadPersisted();
      loadWxSession();
      if (wx.token) log('复用已保存的微信凭证: ' + wx.account);
      while (!stopped) {
        if (!wx.token) {
          const ok = await login();
          if (!ok) {
            if (stopped) return;
            await sleep(30000);
            continue;
          }
        }
        if (!(await activateSession())) {
          if (stopped) return;
          await sleep(5000);
          continue;
        }
        wx.connected = true;
        wx.lastError = '';
        wx.readyAt = Date.now();
        log('微信通道已就绪');
        emitEvent('channel', { connected: true, account: wx.account, relay: relayMode });
        let failures = 0;
        while (!stopped) {
          let parsed = null;
          try {
            const res = await wxFetch(
              'POST', wx.baseurl + '/ilink/bot/getupdates',
              { get_updates_buf: wx.cursor, base_info: baseInfo() }, wx.token, 45000,
            );
            parsed = JSON.parse(res.text);
          } catch {
            await sleep(2000);
            continue;
          }
          if (typeof parsed?.ret === 'number' && parsed.ret !== 0) {
            if (parsed.errcode === -14) {
              note('微信会话已失效，正在重新获取二维码');
              wx.token = '';
              wx.connected = false;
              persistToken();
              emitEvent('channel', { connected: false, reason: 'token-expired' });
              break;
            }
            failures += 1;
            log('getupdates 异常(' + failures + '/3): ' + JSON.stringify(parsed).slice(0, 200));
            if (failures >= 3) {
              note('连续异常，丢弃游标并重新激活会话');
              wx.cursor = '';
              wx.connected = false;
              persistCursor();
              emitEvent('channel', { connected: false, reason: 'cursor-reset' });
              await sleep(3000);
              break;
            }
            await sleep(4000);
            continue;
          }
          failures = 0;
          if (parsed?.get_updates_buf) {
            wx.cursor = parsed.get_updates_buf;
            persistCursor();
          }
          for (const message of parsed?.msgs || []) {
            if (message.message_type !== 1) continue;
            const text = extractWechatText(message);
            if (!text) continue;
            const messageId = String(message.message_id ?? '');
            if (messageId && seen.has(messageId)) continue;
            if (messageId) rememberSeen(messageId);
            rememberContext(message.context_token);
            const createdAt = Number(message.create_time_ms || 0);
            if (createdAt > 0 && Date.now() - createdAt > cfg.staleMs) {
              const minutes = Math.round((Date.now() - createdAt) / 60000);
              log('跳过过期消息(' + minutes + ' 分钟前): ' + text.slice(0, 40));
              rememberEnvelope(messageId, message);
              emitEvent('stale', { messageId, text, minutes });
              continue;
            }
            void handleWechatMessage(message, text);
          }
        }
      }
    }

    function readBody(req) {
      return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 32768) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', () => resolve(''));
      });
    }

    function controlAllowed(req) {
      if (cfg.controlToken) {
        const supplied = req.headers['x-wx-token'];
        if (typeof supplied === 'string' && supplied === cfg.controlToken) return true;
      }
      if (cfg.controlAllowRemote) return true;
      const ip = req.socket?.remoteAddress || '';
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }

    function bridgeSnapshot() {
      return {
        enabled: !!cfg.wechat, connected: wx.connected, account: wx.account, qrUrl: wx.qrUrl,
        error: wx.lastError, relay: relayMode, canPush: Boolean(wx.connected && wx.account),
        contextToken: Boolean(wx.lastContextToken), contextStale: wx.contextStale, pending: outbox.length,
        readyAt: wx.readyAt, lastMessageAt: wx.lastMessageAt, session: activeWechatSession(),
        defaultSession: cfg.session, port: cfg.port, guiPort: cfg.guiPort, seq: eventBus.seq,
        listeners: eventBus.subscribers.size, stateDir: cfg.stateDir, pid: process.pid,
      };
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const sessionParam = url.searchParams.get('session') || '';
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };
      const control = () => {
        if (controlAllowed(req)) return true;
        json(403, { ok: false, error: '控制接口仅限本机（或配置 controlToken / controlAllowRemote）' });
        return false;
      };
      try {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/remote')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(PAGE);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/bridge') {
          if (!control()) return;
          json(200, Object.assign({ ok: true }, bridgeSnapshot()));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          if (!control()) return;
          const since = Number(url.searchParams.get('since') || 0);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          const send = (event) => { res.write('data: ' + JSON.stringify(event) + '\n\n'); };
          send({ seq: eventBus.seq, type: 'hello', at: Date.now(), state: bridgeSnapshot() });
          if (Number.isFinite(since) && since > 0) {
            for (const event of eventBus.buffer) if (event.seq > since) send(event);
          }
          eventBus.subscribers.add(send);
          const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { /* cleanup on close */ }
          }, 15000);
          const cleanup = () => {
            clearInterval(ping);
            eventBus.subscribers.delete(send);
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          res.on('error', cleanup);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/events-since') {
          if (!control()) return;
          const since = Number(url.searchParams.get('since') || 0);
          const events = eventBus.buffer.filter((event) => event.seq > (Number.isFinite(since) ? since : 0));
          json(200, { ok: true, seq: eventBus.seq, events });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/send') {
          if (!control()) return;
          let payload = {};
          try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { payload = {}; }
          const text = String(payload.text || '').trim();
          if (!text) { json(400, { ok: false, error: 'text is required' }); return; }
          const replyTo = String(payload.replyTo || '');
          const envelope = replyTo ? envelopes.get(replyTo) : null;
          if (replyTo && !envelope) {
            json(404, { ok: false, error: '没有这条消息的投递信息: ' + replyTo });
            return;
          }
          const result = envelope
            ? await wxSend(envelope.from, envelope.context, text, 'CLI回复', envelope.runId)
            : await pushWechatDetailed(text, 'CLI推送', payload.queue !== false);
          if (envelope) {
            emitEvent('sent', {
              ok: result.ok, kind: 'cli-reply', text, ret: result.ret,
              errmsg: result.errmsg, messageId: result.messageId,
            });
          }
          json(result.ok ? 200 : 502, {
            ok: result.ok, ret: result.ret, errmsg: result.errmsg, messageId: result.messageId,
            queued: Boolean(result.queued), pending: outbox.length,
            hint: !result.ok && result.ret === -2
              ? result.queued
                ? '上下文令牌已过期：已排进待发队列，你在微信里说一句话后会自动补发'
                : '上下文令牌已过期：先在微信里给 bot 发任意一句话，恢复后即可主动推送'
              : undefined,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/send-file') {
          if (!control()) return;
          let payload = {};
          try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { payload = {}; }
          const filePath = String(payload.path || '');
          if (!filePath) { json(400, { ok: false, error: 'path is required' }); return; }
          const replyTo = String(payload.replyTo || '');
          const envelope = replyTo ? envelopes.get(replyTo) : null;
          if (replyTo && !envelope) {
            json(404, { ok: false, error: '没有这条消息的投递信息: ' + replyTo });
            return;
          }
          try {
            const result = await sendWechatFile(filePath, envelope);
            json(result.ok ? 200 : 502, {
              ok: result.ok, ret: result.ret, errmsg: result.errmsg, messageId: result.messageId,
              fileName: result.fileName, bytes: result.bytes,
              hint: !result.ok && result.ret === -2
                ? '微信会话上下文已过期；请先在手机微信里给 bot 发一句话，再重试文件发送'
                : undefined,
            });
          } catch (error) {
            const message = String(error?.message || error);
            log('发送文件失败: ' + message);
            json(/路径|目录|文件|空文件|上限/.test(message) ? 400 : 502, { ok: false, error: message });
          }
          return;
        }
        if (url.pathname === '/api/outbox') {
          if (!control()) return;
          if (req.method === 'GET') {
            json(200, {
              ok: true, pending: outbox.length,
              items: outbox.map((item) => ({ text: item.text, label: item.label, at: item.at })),
            });
            return;
          }
          if (req.method === 'POST') {
            let action = '';
            try { action = String(JSON.parse((await readBody(req)) || '{}').action || ''); } catch { action = ''; }
            if (action === 'clear') {
              const dropped = outbox.length;
              outbox = [];
              persistOutbox();
              log('待发队列已清空（CLI 请求，丢弃 ' + dropped + ' 条）');
              json(200, { ok: true, dropped });
              return;
            }
            if (action === 'flush') {
              await flushOutbox();
              json(200, { ok: true, pending: outbox.length });
              return;
            }
            json(400, { ok: false, error: 'action 只能是 clear 或 flush' });
            return;
          }
        }
        if (url.pathname === '/api/relay') {
          if (!control()) return;
          if (req.method === 'GET') {
            json(200, { ok: true, relay: relayMode, modes: RELAY_MODES });
            return;
          }
          if (req.method === 'POST') {
            let mode = '';
            try { mode = String(JSON.parse((await readBody(req)) || '{}').relay || ''); } catch { mode = ''; }
            if (!RELAY_MODES.includes(mode)) {
              json(400, { ok: false, error: 'relay 只能是 ' + RELAY_MODES.join(' / ') });
              return;
            }
            saveRelay(mode);
            log('消息去向(relay) -> ' + mode);
            json(200, { ok: true, relay: mode });
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/bind-session') {
          if (!control()) return;
          let payload = {};
          try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { payload = {}; }
          const target = String(payload.sessionId || '');
          const index = Number(payload.index);
          let picked = target;
          if (!picked && Number.isFinite(index) && index >= 1) {
            const items = await listSessions();
            if (!items[index - 1]) { json(404, { ok: false, error: '没有第 ' + index + ' 个会话' }); return; }
            picked = items[index - 1].id;
          }
          if (!picked) { json(400, { ok: false, error: '需要 sessionId 或 index' }); return; }
          saveWxSession(picked);
          lastPushedReply = '';
          log('CLI 切换会话 -> ' + picked);
          emitEvent('session', { session: picked });
          json(200, { ok: true, session: picked });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          if (!control()) return;
          const items = await listSessions();
          json(200, { ok: true, current: activeWechatSession(), sessions: items });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/log') {
          if (!control()) return;
          const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 40, 1), 2000);
          let lines = [];
          try { lines = fs.readFileSync(LOG_FILE, 'utf-8').split(/\r?\n/).filter(Boolean); } catch { lines = []; }
          json(200, { ok: true, lines: lines.slice(-tail) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const agent = await resolveAgent(sessionParam);
          const roots = ctx.agents.roots() || [];
          const sessions = roots.slice()
            .sort((a, b) => (b.session?.seq || 0) - (a.session?.seq || 0))
            .slice(0, 20)
            .map((r) => ({ id: r.id, title: readTitle(r.session) }));
          json(200, {
            ok: true, sessionId: agent.id, title: readTitle(agent.session),
            defaultSession: cfg.session, sessions,
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/history') {
          const agent = await resolveAgent(sessionParam);
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
          json(200, { ok: true, messages: historyMessages(agent.session, limit) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/wechat-status') {
          json(200, {
            ok: true, enabled: !!cfg.wechat, connected: wx.connected, account: wx.account,
            qrUrl: wx.qrUrl, error: wx.lastError, relay: relayMode,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/wechat-relogin') {
          wx.token = '';
          wx.connected = false;
          wx.cursor = '';
          wx.lastError = '';
          persistToken();
          persistCursor();
          log('收到重新授权请求');
          emitEvent('channel', { connected: false, reason: 'relogin-requested' });
          json(200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/new-session') {
          try {
            const body = await readBody(req);
            let bind = false;
            try { bind = Boolean(JSON.parse(body || '{}').bind); } catch { bind = false; }
            const createdId = await createSessionForWechat();
            if (bind) { saveWxSession(createdId); lastPushedReply = ''; }
            json(200, { ok: true, sessionId: createdId, bound: bind });
          } catch (error) {
            json(500, { ok: false, error: String(error?.message || error) });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readBody(req);
          let text = '';
          try { text = String(JSON.parse(body).text || '').trim(); } catch { text = ''; }
          if (!text) { json(400, { ok: false, error: 'text is required' }); return; }
          const result = await enqueue(() => runChat(text, sessionParam, cfg.waitMsWeb));
          json(200, { ok: true, reply: result.reply, sessionId: result.sessionId, title: result.title });
          return;
        }
        json(404, { ok: false, error: 'not found' });
      } catch (error) {
        json(500, { ok: false, error: error?.message || String(error) });
      }
    });

    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 65000;
    ctx.on('agent/status', onAgentStatus);

    ctx.effect(() => {
      loadRelay();
      const restoreQuestions = installQuestionBridge();
      let listenTries = 0;
      let listenTimer = null;
      const startListen = () => {
        listenTries += 1;
        server.listen(cfg.port, cfg.host);
      };
      const onListenError = (error) => {
        if (error?.code === 'EADDRINUSE' && listenTries < 6 && !stopped) {
          log('端口 ' + cfg.port + ' 暂被占用，第 ' + listenTries + ' 次重试中');
          listenTimer = setTimeout(startListen, 800 * listenTries);
          return;
        }
        log('HTTP 服务器错误: ' + (error?.message || error));
      };
      server.on('error', onListenError);
      server.on('listening', () => {
        const addresses = lanAddresses();
        const shown = addresses.length > 0 ? addresses[0] : '<本机IP>';
        log('远程网页已就绪: http://' + shown + ':' + cfg.port + '/  (本机地址: ' + addresses.join(', ') + ')');
        log('CLI 控制面已就绪: http://127.0.0.1:' + cfg.port + '/api/bridge  · relay=' + relayMode);
      });
      startListen();
      if (cfg.wechat) void wechatLoop().catch((error) => note('微信通道退出: ' + (error?.message || error)));
      return () => {
        stopped = true;
        if (listenTimer) clearTimeout(listenTimer);
        restoreQuestions();
        if (pendingAnswer) {
          pendingAnswer.reject(new Error('远程通道已停止'));
          pendingAnswer = null;
        }
        void notifyStop();
        try { emitEvent('bye', { reason: 'bridge-stopped' }); } catch { /* best effort */ }
        eventBus.subscribers.clear();
        try { server.closeAllConnections?.(); } catch { /* best effort */ }
        server.close();
        server.off('error', onListenError);
        resumed.clear();
        log('远程通道已停止');
      };
    }, 'wechat-bridge');
  },
};
