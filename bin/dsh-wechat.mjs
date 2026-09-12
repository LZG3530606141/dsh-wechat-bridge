#!/usr/bin/env node
/**
 * dsh-wechat —— 微信命令行（DSH wechat-bridge 控制面客户端）
 *
 * 它不自己连接微信，而是复用常驻在 DSH 进程里的 wechat-bridge 插件：
 * 凭证、长轮询、去重、上下文令牌都由插件管理，这里只提供终端界面。
 *
 * 常用：
 *   dsh-wechat status
 *   dsh-wechat listen
 *   dsh-wechat send 你好
 *   dsh-wechat relay cli
 *   dsh-wechat listen --exec "..." --reply
 *
 * 环境变量：
 *   DSH_WECHAT_BRIDGE  控制面地址（默认 http://127.0.0.1:8848）
 *   DSH_WECHAT_TOKEN   远程访问令牌（对应插件 config.controlToken）
 *   DSH_WECHAT_PORT    本机控制面端口（默认 8848）
 *   NO_COLOR           关闭颜色
 *
 * 兼容旧的 WX_BRIDGE、WX_TOKEN、WX_PORT，但新部署应使用 DSH_WECHAT_*。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const VERSION = '0.1.0';
const CLI = 'dsh-wechat';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? '\u001b[' + code + 'm' + text + '\u001b[0m' : String(text));
const C = {
  dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'),
  yellow: paint('33'), blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
};

function out(line = '') { process.stdout.write(line + '\n'); }
function errOut(line) { process.stderr.write(line + '\n'); }
function fail(message, code = 1) { errOut(C.red('✗ ') + message); process.exit(code); }
function stamp(at) {
  const d = at ? new Date(at) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function ago(at) {
  if (!at) return '从未';
  const ms = Date.now() - Number(at);
  if (ms < 0) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

function parseArgs(argv, booleanKeys = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (item.startsWith('--')) {
      const body = item.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (booleanKeys.includes(body)) { flags[body] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[body] = true;
      else { flags[body] = next; i += 1; }
      continue;
    }
    if (item.startsWith('-') && item.length > 1 && !/^-\d/.test(item)) { flags[item.slice(1)] = true; continue; }
    positional.push(item);
  }
  return { flags, positional };
}

function bridgeBase(flags) {
  if (flags.bridge) return String(flags.bridge).replace(/\/+$/, '');
  const configured = process.env.DSH_WECHAT_BRIDGE || process.env.WX_BRIDGE;
  if (configured) return configured.replace(/\/+$/, '');
  const port = flags.port || process.env.DSH_WECHAT_PORT || process.env.WX_PORT || 8848;
  return 'http://127.0.0.1:' + port;
}

function controlHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.DSH_WECHAT_TOKEN || process.env.WX_TOKEN;
  if (token) headers['x-wx-token'] = token;
  return headers;
}

function hint(kind) {
  if (kind !== 'bridge-down') return '';
  return [
    '  可能原因：',
    '    1) DSH 没在跑 —— wechat-bridge 是 DSH 进程里的插件，DSH 不开它就不存在',
    '    2) 端口不是 8848 —— 见 $DSH_HOME/cordis.patch.yml 里 wechat-bridge 的 config.port',
    '    3) 插件被停用 —— 同一份配置里 wechat-bridge 配置被注释或关闭',
  ].join('\n');
}

async function api(base, method, route, body, timeoutMs = 20000) {
  let res;
  try {
    res = await fetch(base + route, {
      method,
      headers: controlHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = String(error?.message || error);
    if (/timed out|aborted/i.test(reason)) throw new Error('控制面无响应（' + timeoutMs + 'ms 超时）: ' + base + route);
    throw new Error('连不上控制面 ' + base + '：' + reason + '\n' + hint('bridge-down'));
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('控制面返回了非 JSON（HTTP ' + res.status + '）: ' + text.slice(0, 200)); }
  if (res.status === 403) {
    throw new Error(
      (data?.error || '控制接口拒绝访问') +
      '\n  · 本机调用请用 127.0.0.1（不是局域网 IP）' +
      '\n  · 远程调用需在插件 config 里设 controlToken，再 setx DSH_WECHAT_TOKEN <令牌>',
    );
  }
  if (data && data.ok === false) {
    const error = new Error(data.error || data.errmsg || 'HTTP ' + res.status);
    error.payload = data;
    throw error;
  }
  return data;
}

const DEFAULT_TYPES = ['message', 'sent', 'channel', 'relay', 'session', 'stale', 'queued', 'bye'];

async function subscribe(base, since, onEvent, onNotice) {
  let cursor = Number(since) || 0;
  let backoff = 1000;
  for (;;) {
    let res;
    try { res = await fetch(base + '/api/events?since=' + cursor, { headers: controlHeaders() }); }
    catch (error) {
      onNotice('连接中断，' + Math.round(backoff / 1000) + ' 秒后重连（' + String(error?.message || error) + '）');
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 15000);
      continue;
    }
    if (res.status === 403) {
      let payload = null;
      try { payload = JSON.parse(await res.text()); } catch { payload = null; }
      throw new Error(payload?.error || '控制接口拒绝访问（403）');
    }
    if (!res.ok || !res.body) {
      onNotice('事件流不可用（HTTP ' + res.status + '），' + Math.round(backoff / 1000) + ' 秒后重试');
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 15000);
      continue;
    }
    backoff = 1000;
    let buffer = '';
    try {
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            let event;
            try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (typeof event?.seq === 'number' && event.seq > cursor) cursor = event.seq;
            await onEvent(event);
          }
        }
      }
    } catch (error) { onNotice('事件流断开：' + String(error?.message || error)); }
    onNotice('已断开，1 秒后重连（seq=' + cursor + '）');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function renderEvent(event, options) {
  const time = C.gray(stamp(event.at));
  if (event.type === 'message') {
    const tag = event.answering ? C.magenta('答问') : C.cyan('微信');
    const body = options.wide ? event.text : event.text.replace(/\s+/g, ' ');
    return time + ' ' + tag + ' ' + C.bold('›') + ' ' + body;
  }
  if (event.type === 'sent') {
    const kindText = event.kind === 'reply' ? '回复' : event.kind === 'cli-reply' ? 'CLI回复' : event.kind === 'push' ? '推送' : event.kind === 'flush' ? '补发' : '发送';
    const mark = event.ok ? C.green('‹') : event.queued ? C.yellow('⧗') : C.red('✗');
    const body = options.wide ? event.text : String(event.text || '').replace(/\s+/g, ' ');
    const trailer = event.ok ? '' : event.queued ? C.yellow('  [已排队，等窗口重开后补发]') : C.red('  [' + (event.errmsg || 'ret=' + event.ret) + ']');
    return time + ' ' + C.gray(kindText) + ' ' + mark + ' ' + body + trailer;
  }
  if (event.type === 'queued') return time + ' ' + C.yellow('⧗ 待发队列 ' + event.count + ' 条');
  if (event.type === 'channel') return event.connected ? time + ' ' + C.green('● 通道已连接') + C.gray(' ' + (event.account || '')) : time + ' ' + C.red('○ 通道断开') + C.gray(' ' + (event.reason || ''));
  if (event.type === 'relay') return time + ' ' + C.yellow('⇄ 消息去向 -> ' + event.relay);
  if (event.type === 'session') return time + ' ' + C.yellow('⌂ 绑定会话 -> ' + event.session);
  if (event.type === 'stale') return time + ' ' + C.gray('… 跳过过期消息(' + event.minutes + ' 分钟前): ' + String(event.text).slice(0, 40));
  if (event.type === 'bye') return time + ' ' + C.red('■ 通道已停止（DSH 重载或退出）');
  if (event.type === 'log') return time + ' ' + C.gray(event.line);
  return time + ' ' + C.gray(event.type + ' ' + JSON.stringify(event).slice(0, 200));
}

function relayLabel(relay) {
  if (relay === 'cli') return C.cyan('cli') + C.gray('   （消息只进 CLI，不自动喂给 AI）');
  if (relay === 'off') return C.gray('off') + C.gray('   （只记录，不作答）');
  return C.green('session') + C.gray(' （照常驱动 DSH 会话）');
}

async function cmdStatus(base, flags) {
  const data = await api(base, 'GET', '/api/bridge');
  if (flags.json) { out(JSON.stringify(data, null, 2)); return; }
  const dot = data.connected ? C.green('●') : C.red('○');
  out('');
  out('  ' + dot + ' 微信通道  ' + (data.connected ? C.green('已连接') : C.red('未连接')));
  out('  ' + C.gray('账号     ') + (data.account || C.gray('(未授权)')));
  out('  ' + C.gray('消息去向 ') + relayLabel(data.relay));
  out('  ' + C.gray('绑定会话 ') + (data.session || C.gray('(最近活跃的会话)')));
  out('  ' + C.gray('主动推送 ') + (data.canPush ? data.contextStale ? C.yellow('窗口已关（去微信里回一句话即可恢复）') : data.contextToken ? C.green('可用') : C.yellow('未知（还没有对话上下文，发出去才知道）') : C.red('不可用（通道未连接）')));
  if (data.pending) out('  ' + C.gray('待发队列 ') + C.yellow(data.pending + ' 条') + C.gray('  （' + CLI + ' outbox 查看）'));
  out('  ' + C.gray('最近消息 ') + ago(data.lastMessageAt));
  out('  ' + C.gray('通道就绪 ') + ago(data.readyAt));
  out('  ' + C.gray('监听者   ') + data.listeners + ' 个   ' + C.gray('事件序号 ') + data.seq);
  out('  ' + C.gray('控制面   ') + base + C.gray('  · DSH pid ' + data.pid));
  if (data.qrUrl) { out(''); out('  ' + C.yellow('需要重新授权，用手机微信打开：')); out('  ' + data.qrUrl); }
  if (data.error) out('  ' + C.red('最近错误 ') + data.error);
  out('');
}

async function cmdListen(base, flags) {
  const types = flags.types ? String(flags.types).split(',').map((value) => value.trim()).filter(Boolean) : DEFAULT_TYPES.slice();
  if (flags.log && !types.includes('log')) types.push('log');
  const filter = flags.filter ? new RegExp(String(flags.filter), 'i') : null;
  const wide = Boolean(flags.wide);
  const execCmd = flags.exec ? String(flags.exec) : '';
  const replyBack = Boolean(flags.reply);
  const quiet = Boolean(flags.quiet);
  if (replyBack && !execCmd) fail('--reply 需要配合 --exec 使用');
  if (!flags.json && !quiet) {
    const state = await api(base, 'GET', '/api/bridge');
    out('');
    out('  ' + (state.connected ? C.green('● 已连接 ') : C.red('○ 未连接 ')) + C.gray(state.account || '') + '   去向=' + String(state.relay) + (execCmd ? '   exec=on' + (replyBack ? ' reply=on' : '') : ''));
    if (state.relay === 'session' && execCmd) out('  ' + C.yellow('提示：relay=session 时消息同时会喂给 AI。想让 CLI 独占，先跑 ' + CLI + ' relay cli'));
    out('  ' + C.gray('Ctrl+C 退出') + '\n');
  }
  const handle = async (event) => {
    if (event.type === 'hello' || !types.includes(event.type)) return;
    if (filter && event.type === 'message' && !filter.test(String(event.text || ''))) return;
    if (flags.json) out(JSON.stringify(event)); else out(renderEvent(event, { wide }));
    if (event.type === 'message' && execCmd) await runExec(base, execCmd, event, replyBack, flags);
  };
  await subscribe(base, flags.since || 0, handle, (message) => {
    if (flags.json) out(JSON.stringify({ type: 'notice', at: Date.now(), message }));
    else if (!quiet) out(C.gray(stamp() + ' ⟳ ' + message));
  });
}

function runExec(base, command, event, replyBack, flags) {
  return new Promise((resolve) => {
    let child;
    try {
      const eventEnv = {
        DSH_WECHAT_TEXT: String(event.text || ''),
        DSH_WECHAT_MESSAGE_ID: String(event.messageId || ''),
        DSH_WECHAT_FROM: String(event.from || ''),
        DSH_WECHAT_SEQ: String(event.seq || ''),
        DSH_WECHAT_AT: String(event.at || ''),
      };
      child = spawn(command, { shell: true, env: Object.assign({}, process.env, eventEnv), stdio: ['ignore', replyBack ? 'pipe' : 'inherit', 'pipe'] });
    } catch (error) { errOut(C.red('exec 启动失败: ') + String(error?.message || error)); resolve(); return; }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (error) => { errOut(C.red('exec 出错: ') + String(error?.message || error)); resolve(); });
    child.on('close', async (code) => {
      if (code !== 0 && stderr.trim() && !flags.json) errOut(C.gray('exec stderr: ') + stderr.trim().slice(0, 500));
      if (replyBack) {
        const reply = stdout.trim();
        if (!reply) { if (!flags.json) out(C.gray(stamp() + ' ⟳ exec 无输出，不回复')); }
        else {
          try { await api(base, 'POST', '/api/send', { text: reply, replyTo: event.messageId }, 60000); }
          catch (error) { errOut(C.red('回复失败: ') + String(error?.message || error)); }
        }
      }
      resolve();
    });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function cmdSend(base, flags, positional) {
  let text = positional.join(' ');
  if (flags.stdin || (!text && !process.stdin.isTTY)) text = (await readStdin()).trim();
  if (!text) fail('要发什么？例：' + CLI + ' send 今天的进度\n  也可以：echo 内容 | ' + CLI + ' send --stdin');
  const body = { text };
  if (flags['reply-to']) body.replyTo = String(flags['reply-to']);
  if (flags['no-queue']) body.queue = false;
  try {
    const data = await api(base, 'POST', '/api/send', body, 90000);
    if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 已投递') + C.gray('  message_id=' + (data.messageId || '-')));
  } catch (error) {
    const payload = error.payload || {};
    if (payload.queued) {
      if (flags.json) out(JSON.stringify(payload));
      else {
        out(C.yellow('⧗ 暂时发不出去，已排进待发队列') + C.gray('  队列 ' + (payload.pending || 1) + ' 条'));
        out(C.gray('  原因: ' + (payload.errmsg || 'ret=' + payload.ret)));
        out(C.gray('  你在微信里给 bot 说任意一句话，它会自动补发（' + CLI + ' outbox 可查看）'));
      }
      return;
    }
    let message = error.message;
    if (payload.hint) message += '\n  ' + C.yellow(payload.hint);
    fail(message);
  }
}

async function cmdSendFile(base, flags, positional) {
  const input = positional.join(' ').trim();
  if (!input) fail('要发送哪个文件？例：' + CLI + ' send-file C:\\Users\\HP\\Documents\\report.pdf');
  const filePath = path.resolve(input);
  let stat;
  try { stat = fs.statSync(filePath); } catch { fail('文件不存在或无法访问: ' + filePath); }
  if (!stat.isFile()) fail('只能发送普通文件: ' + filePath);
  const body = { path: filePath };
  if (flags['reply-to']) body.replyTo = String(flags['reply-to']);
  if (!flags.json) errOut(C.gray('… 正在加密并上传 ' + path.basename(filePath) + '（' + stat.size + ' bytes）'));
  try {
    const data = await api(base, 'POST', '/api/send-file', body, 120000);
    if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 文件已投递到微信') + C.gray('  ' + data.fileName + ' · message_id=' + (data.messageId || '-')));
  } catch (error) {
    const payload = error.payload || {};
    let message = error.message;
    if (payload.hint) message += '\n  ' + C.yellow(payload.hint);
    fail(message);
  }
}

async function cmdOutbox(base, flags, positional) {
  const action = positional[0] || '';
  if (action === 'clear') {
    const data = await api(base, 'POST', '/api/outbox', { action: 'clear' });
    if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 已清空待发队列') + C.gray('  丢弃 ' + data.dropped + ' 条'));
    return;
  }
  if (action === 'flush') {
    const data = await api(base, 'POST', '/api/outbox', { action: 'flush' }, 90000);
    if (flags.json) out(JSON.stringify(data));
    else if (data.pending === 0) out(C.green('✓ 待发队列已清空（全部送达）'));
    else out(C.yellow('⧗ 还有 ' + data.pending + ' 条发不出去（投递窗口仍关闭）'));
    return;
  }
  const data = await api(base, 'GET', '/api/outbox');
  if (flags.json) { out(JSON.stringify(data, null, 2)); return; }
  if (!data.pending) { out(C.gray('待发队列是空的。')); return; }
  out('');
  out('  ' + C.yellow('待发 ' + data.pending + ' 条') + C.gray('（等微信投递窗口重开后自动补发）'));
  for (const item of data.items) out('  ' + C.gray(stamp(item.at) + ' [' + item.label + '] ') + String(item.text).replace(/\s+/g, ' ').slice(0, 90));
  out('');
  out(C.gray('  ' + CLI + ' outbox flush  立刻重试   ·   ' + CLI + ' outbox clear  丢弃'));
  out('');
}

async function cmdChat(base, flags, positional) {
  let text = positional.join(' ');
  if (flags.stdin || (!text && !process.stdin.isTTY)) text = (await readStdin()).trim();
  if (!text) fail('要说什么？例：' + CLI + ' chat 帮我看下今天的进度');
  const seconds = Math.min(Math.max(Number(flags.timeout) || 300, 5), 1800);
  const route = '/api/chat' + (flags.session ? '?session=' + encodeURIComponent(String(flags.session)) : '');
  if (!flags.json) errOut(C.gray('… 已发给会话，等回复（最长 ' + seconds + ' 秒）'));
  const data = await api(base, 'POST', route, { text }, seconds * 1000 + 5000);
  if (flags.json) out(JSON.stringify(data));
  else { out(''); out(data.reply || C.gray('(空回复)')); out(''); out(C.gray('— ' + (data.title || '未命名') + ' · ' + data.sessionId)); }
}

async function cmdSessions(base, flags) {
  const data = await api(base, 'GET', '/api/sessions', undefined, 30000);
  if (flags.json) { out(JSON.stringify(data, null, 2)); return; }
  if (!data.sessions?.length) { out(C.gray('一个会话都没有。跑 ' + CLI + ' new 就能开一个。')); return; }
  out('');
  data.sessions.forEach((item, index) => {
    const current = item.id === data.current ? C.green('★') : ' ';
    const running = item.running ? C.yellow('▶ ') : '';
    out('  ' + current + ' ' + C.bold(String(index + 1)) + '. ' + running + item.title + C.gray('  [' + String(item.id).replace(/^session-/, '').slice(0, 8) + ']'));
  });
  out(''); out(C.gray('  ' + CLI + ' switch 2  切到第 2 个')); out('');
}

async function cmdSwitch(base, flags, positional) {
  const target = positional[0];
  if (!target) fail('要切到哪个？' + CLI + ' sessions 看编号，然后 ' + CLI + ' switch 2');
  const body = /^\d{1,2}$/.test(target) ? { index: Number(target) } : { sessionId: target };
  const data = await api(base, 'POST', '/api/bind-session', body, 30000);
  if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 已切到 ') + data.session);
}

async function cmdNew(base, flags) {
  const bind = flags.bind !== false && flags.bind !== 'false';
  const data = await api(base, 'POST', '/api/new-session', { bind }, 60000);
  if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 新会话 ') + data.sessionId + (data.bound ? C.gray('  （微信/CLI 已切到它）') : ''));
}

async function cmdRelay(base, flags, positional) {
  const mode = positional[0];
  if (!mode) {
    const data = await api(base, 'GET', '/api/relay');
    if (flags.json) out(JSON.stringify(data));
    else {
      out(''); out('  当前消息去向: ' + relayLabel(data.relay)); out('');
      out('  ' + C.gray(CLI + ' relay session') + '  微信消息照常驱动 DSH 会话（默认）');
      out('  ' + C.gray(CLI + ' relay cli    ') + '  微信消息只广播给 ' + CLI + ' listen，由你自己回');
      out('  ' + C.gray(CLI + ' relay off    ') + '  只记录，不作答'); out('');
    }
    return;
  }
  const data = await api(base, 'POST', '/api/relay', { relay: mode });
  if (flags.json) out(JSON.stringify(data)); else out(C.green('✓ 消息去向 -> ') + data.relay);
}

async function cmdLog(base, flags) {
  const tail = Number(flags.tail) || 40;
  const data = await api(base, 'GET', '/api/log?tail=' + tail, undefined, 30000);
  for (const line of data.lines) out(C.gray(line));
  if (flags.f || flags.follow) {
    out(C.gray('— 跟随中，Ctrl+C 退出 —'));
    await subscribe(base, 0, async (event) => { if (event.type === 'log') out(C.gray(stamp(event.at) + ' ' + event.line)); }, () => {});
  }
}

function readStateFile(name) {
  const home = process.env.DSH_HOME || path.resolve(os.homedir(), '.dsh');
  try { return fs.readFileSync(path.join(home, 'wechat-bridge', name), 'utf-8').trim(); }
  catch { return ''; }
}

async function cmdQr(base, flags) {
  const data = await api(base, 'GET', '/api/bridge');
  if (flags.json) { out(JSON.stringify({ ok: true, connected: data.connected, qrUrl: data.qrUrl })); return; }
  if (data.connected && !data.qrUrl) {
    out(C.green('✓ 通道已连接，不需要扫码') + C.gray('  ' + data.account));
    out(C.gray('  要换账号：' + CLI + ' relogin'));
    return;
  }
  const url = data.qrUrl || readStateFile('wechat-qr.txt');
  if (!url) fail('还没有授权链接。先跑 ' + CLI + ' relogin，几秒后再看 ' + CLI + ' qr');
  out(''); out('  ' + C.yellow('用手机微信打开这个链接完成授权：')); out('  ' + C.bold(url)); out('');
  out(C.gray('  链接会过期；过期就再跑一次 ' + CLI + ' relogin。')); out('');
}

async function cmdRelogin(base, flags) {
  await api(base, 'POST', '/api/wechat-relogin', {}, 20000);
  if (flags.json) { out(JSON.stringify({ ok: true })); return; }
  out(C.green('✓ 已清除凭证，正在申请新二维码'));
  out(C.gray('  几秒后跑 ' + CLI + ' qr 拿授权链接'));
}

async function cmdDoctor(base) {
  out('');
  let state;
  try { state = await api(base, 'GET', '/api/bridge'); out('  ' + C.green('✓') + ' 控制面可达      ' + base); }
  catch (error) {
    out('  ' + C.red('✗') + ' 控制面不可达    ' + base);
    out(String(error.message).split('\n').map((line) => '    ' + C.gray(line)).join('\n')); out(''); return;
  }
  out('  ' + (state.connected ? C.green('✓') : C.red('✗')) + ' 微信通道        ' + (state.connected ? '已连接 ' + state.account : '未连接（' + CLI + ' qr 重新授权）'));
  out('  ' + (state.contextToken && !state.contextStale ? C.green('✓') : C.yellow('!')) + ' 主动推送        ' + (state.contextStale ? '投递窗口已关 —— 在微信里给 bot 发任意一句话即可恢复（排队的会自动补发）' : state.contextToken ? '有上下文令牌' : '还没有对话上下文：' + CLI + ' send 会先排队，等你在微信里说一句话后补发'));
  if (state.pending) out('  ' + C.yellow('!') + ' 待发队列        ' + state.pending + ' 条等补发（' + CLI + ' outbox）');
  try {
    const res = await fetch('http://127.0.0.1:' + state.guiPort + '/', { signal: AbortSignal.timeout(4000) });
    out('  ' + (res.ok ? C.green('✓') : C.yellow('!')) + ' DSH Web GUI     127.0.0.1:' + state.guiPort);
  } catch { out('  ' + C.yellow('!') + ' DSH Web GUI     127.0.0.1:' + state.guiPort + ' 不可达（' + CLI + ' chat / ' + CLI + ' new 会失败）'); }
  try {
    const sessions = await api(base, 'GET', '/api/sessions', undefined, 20000);
    out('  ' + C.green('✓') + ' 会话列表        ' + sessions.sessions.length + ' 个，当前 ' + (sessions.current || '(最近活跃)'));
  } catch (error) { out('  ' + C.yellow('!') + ' 会话列表        ' + String(error.message).split('\n')[0]); }
  out('  ' + C.green('✓') + ' 消息去向        ' + state.relay); out('');
}

async function cmdRepl(base, flags) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan(CLI + '> ') });
  out(C.gray('输入内容直接发给绑定的 DSH 会话；/quit 退出，/status 看状态。'));
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/quit' || text === '/exit') break;
    try {
      if (text === '/status') await cmdStatus(base, {});
      else if (text.startsWith('/send ')) await cmdSend(base, {}, [text.slice(6)]);
      else await cmdChat(base, flags, [text]);
    } catch (error) { errOut(C.red('✗ ') + String(error?.message || error)); }
    rl.prompt();
  }
  rl.close();
}

function usage() {
  out([
    '',
    C.bold('  ' + CLI) + C.gray(' — 微信命令行（DSH wechat-bridge 控制面）  v' + VERSION),
    '',
    C.bold('  实时'),
    '    ' + CLI + ' listen                    实时刷微信消息（Ctrl+C 退出）',
    '      --json                             每行一条 JSON，方便管道处理',
    '      --filter <正则>                    只看匹配的消息',
    '      --types message,sent              只看这些事件（默认全部业务事件）',
    '      --log                              连 bridge 日志一起刷',
    '      --wide                             消息保留原始换行',
    '      --exec <命令>                      收到消息就执行；正文在 $env:DSH_WECHAT_TEXT',
    '      --reply                            配合 --exec：把命令 stdout 发回微信',
    '      --since <seq>                      从这个事件序号之后补拿',
    '',
    C.bold('  收发'),
    '    ' + CLI + ' send <文本...>            主动往微信发一条',
    '      --reply-to <messageId>             回到那条消息所在的对话线程',
    '      --stdin                            正文从标准输入读',
    '      --no-queue                         发不出去就直接报错，不排队',
    '    ' + CLI + ' send-file <绝对路径>      流式加密上传并发送到手机微信（最大 100 MiB）',
    '      --reply-to <messageId>             回到那条消息所在的对话线程',
    '    ' + CLI + ' outbox [flush|clear]      待发队列：查看 / 立刻重试 / 丢弃',
    '    ' + CLI + ' chat <文本...>            发给 DSH 会话并等回复（等于在微信里说这句）',
    '      --session <id>  --timeout <秒>',
    '    ' + CLI + ' repl                     交互式，一行一句地聊',
    '',
    C.bold('  会话与开关'),
    '    ' + CLI + ' status                   通道状态',
    '    ' + CLI + ' sessions                 会话列表',
    '    ' + CLI + ' switch <n|sessionId>     切换绑定的会话',
    '    ' + CLI + ' new [--bind]             新建会话（默认同时切过去）',
    '    ' + CLI + ' relay [session|cli|off]  微信消息的去向',
    '    ' + CLI + ' log [--tail N] [-f]      bridge 日志',
    '    ' + CLI + ' qr / ' + CLI + ' relogin 授权链接 / 重新授权',
    '    ' + CLI + ' doctor                   体检：控制面、通道、GUI、会话',
    '',
    C.gray('  环境变量: DSH_WECHAT_BRIDGE 控制面地址 · DSH_WECHAT_TOKEN 远程令牌 · DSH_WECHAT_PORT 本机端口 · NO_COLOR 关颜色'),
    C.gray('  兼容旧变量: WX_BRIDGE · WX_TOKEN · WX_PORT'),
    '',
  ].join('\n'));
}

const BOOLEAN_FLAGS = ['json', 'log', 'wide', 'reply', 'stdin', 'bind', 'quiet', 'follow', 'help', 'version', 'no-bind', 'no-queue'];

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const { flags, positional } = parseArgs(command ? argv.slice(1) : argv, BOOLEAN_FLAGS);
  if (flags.version) { out(VERSION); return; }
  if (!command || command === 'help' || flags.help) { usage(); return; }
  const base = bridgeBase(flags);
  switch (command) {
    case 'status': case 'st': return cmdStatus(base, flags);
    case 'listen': case 'watch': return cmdListen(base, flags);
    case 'send': return cmdSend(base, flags, positional);
    case 'send-file': case 'file': return cmdSendFile(base, flags, positional);
    case 'outbox': case 'queue': return cmdOutbox(base, flags, positional);
    case 'chat': case 'ask': return cmdChat(base, flags, positional);
    case 'repl': return cmdRepl(base, flags);
    case 'sessions': case 'ls': return cmdSessions(base, flags);
    case 'switch': case 'use': return cmdSwitch(base, flags, positional);
    case 'new': return cmdNew(base, flags);
    case 'relay': return cmdRelay(base, flags, positional);
    case 'log': case 'logs': return cmdLog(base, flags);
    case 'qr': return cmdQr(base, flags);
    case 'relogin': return cmdRelogin(base, flags);
    case 'doctor': return cmdDoctor(base);
    default: usage(); fail('不认识的命令: ' + command);
  }
}

process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
main().catch((error) => { fail(String(error?.message || error)); });
