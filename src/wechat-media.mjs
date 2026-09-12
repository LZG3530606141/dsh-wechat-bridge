import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WECHAT_FILE_MAX_BYTES = 100 * 1024 * 1024;
const WECHAT_CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const WECHAT_CDN_BASE = 'https://' + WECHAT_CDN_HOST + '/c2c';
const HASH_BUFFER_BYTES = 256 * 1024;
const UPLOAD_BUFFER_BYTES = 256 * 1024;

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate, root) {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sameFileSnapshot(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (left.ino === undefined || right.ino === undefined || left.ino === right.ino)
  );
}

function encryptedSize(plaintextSize) {
  return (Math.floor(plaintextSize / 16) + 1) * 16;
}

function uploadTimeoutMs(bytes) {
  // 至少按 256 KiB/s 给出上传窗口，并限制在 30 秒到 10 分钟之间。
  return Math.max(30000, Math.min(600000, Math.ceil(bytes / (256 * 1024)) * 1000 + 15000));
}

export function safeWechatFileName(value) {
  const normalized = String(value || '')
    .replace(/[\\/\u0000-\u001f\u007f]+/gu, '_')
    .trim()
    .slice(0, 255);
  return normalized || 'attachment';
}

async function hashFile(realPath) {
  const hash = crypto.createHash('md5');
  const stream = fs.createReadStream(realPath, { highWaterMark: HASH_BUFFER_BYTES });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareWechatFile(filePath, options = {}) {
  if (!path.isAbsolute(filePath)) throw new Error('文件路径必须是绝对路径');
  const maxBytes = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : WECHAT_FILE_MAX_BYTES;
  if (maxBytes < 1 || maxBytes > WECHAT_FILE_MAX_BYTES) throw new Error('微信文件大小上限配置无效');

  let realPath;
  try {
    realPath = fs.realpathSync.native(filePath);
  } catch {
    throw new Error('文件不存在或无法访问: ' + filePath);
  }
  const roots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0 ? options.allowedRoots : [os.homedir()];
  const allowed = roots.some((root) => {
    try {
      return isWithin(realPath, fs.realpathSync.native(path.resolve(root)));
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error('文件不在允许发送的目录中');

  const snapshot = fs.statSync(realPath);
  if (!snapshot.isFile()) throw new Error('只能发送普通文件');
  if (snapshot.size < 1) throw new Error('不能发送空文件');
  if (snapshot.size > maxBytes) throw new Error('文件超过微信发送上限 ' + Math.floor(maxBytes / 1024 / 1024) + ' MiB');

  // 第一遍流式读取只计算明文 MD5，不保存文件内容。
  const plaintextMd5 = await hashFile(realPath);
  const afterHash = fs.statSync(realPath);
  if (!sameFileSnapshot(snapshot, afterHash)) throw new Error('计算文件摘要时文件发生变化，请重试');

  return {
    realPath,
    snapshot,
    fileName: safeWechatFileName(path.basename(realPath)),
    plaintextSize: snapshot.size,
    plaintextMd5,
    ciphertextSize: encryptedSize(snapshot.size),
    keyHex: crypto.randomBytes(16).toString('hex'),
    filekey: crypto.randomBytes(16).toString('hex'),
  };
}

export function resolveWechatCdnUploadUrl(upload, filekey) {
  const raw = upload?.upload_full_url?.trim()
    ? upload.upload_full_url
    : upload?.upload_param
      ? WECHAT_CDN_BASE + '/upload?encrypted_query_param=' + encodeURIComponent(upload.upload_param) + '&filekey=' + encodeURIComponent(filekey)
      : '';
  if (!raw) throw new Error('微信服务未返回附件上传地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== WECHAT_CDN_HOST || url.username || url.password || url.port) {
    throw new Error('微信附件上传地址不是受信任的 CDN HTTPS 地址');
  }
  return url.toString();
}

function createEncryptedBody(prepared) {
  const current = fs.statSync(prepared.realPath);
  if (!sameFileSnapshot(prepared.snapshot, current)) throw new Error('上传前文件发生变化，请重试');
  const source = fs.createReadStream(prepared.realPath, { highWaterMark: UPLOAD_BUFFER_BYTES });
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(prepared.keyHex, 'hex'), null);
  cipher.setAutoPadding(true);
  return source.pipe(cipher);
}

async function uploadCiphertext(uploadUrl, prepared, fetchFn, log) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 每次尝试都重新打开文件和 Cipher；流是一次性的，不能用于重试。
      const body = createEncryptedBody(prepared);
      const response = await fetchFn(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(prepared.ciphertextSize),
        },
        body,
        duplex: 'half',
        signal: AbortSignal.timeout(uploadTimeoutMs(prepared.ciphertextSize)),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 500) {
        throw new Error('微信附件上传被 CDN 拒绝（HTTP ' + response.status + '）');
      }
      if (!response.ok) throw new Error('微信附件上传失败（HTTP ' + response.status + '）');
      const encryptedQueryParam = response.headers.get('x-encrypted-param')?.trim();
      if (!encryptedQueryParam) throw new Error('微信附件上传响应缺少下载参数');
      return encryptedQueryParam;
    } catch (error) {
      lastError = error;
      if (/被 CDN 拒绝|文件发生变化/.test(String(error?.message || error)) || attempt >= 3) break;
      log?.('微信附件上传失败，第 ' + attempt + ' 次重试前等待: ' + String(error?.message || error));
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('微信附件上传失败');
}

export async function uploadWechatFile(options) {
  const prepared = await prepareWechatFile(options.filePath, {
    allowedRoots: options.allowedRoots,
    maxBytes: options.maxBytes,
  });
  const upload = await options.requestUpload({
    filekey: prepared.filekey,
    media_type: 3,
    to_user_id: options.toUserId,
    rawsize: prepared.plaintextSize,
    rawfilemd5: prepared.plaintextMd5,
    filesize: prepared.ciphertextSize,
    no_need_thumb: true,
    aeskey: prepared.keyHex,
  });
  const failed = [upload?.ret, upload?.errcode].some((code) => typeof code === 'number' && code !== 0);
  if (failed) throw new Error('微信获取附件上传地址失败: ' + (upload.errmsg || 'ret=' + (upload.ret ?? upload.errcode)));
  const uploadUrl = resolveWechatCdnUploadUrl(upload, prepared.filekey);
  const encryptedQueryParam = await uploadCiphertext(uploadUrl, prepared, options.fetchFn || fetch, options.log);
  return {
    fileName: prepared.fileName,
    bytes: prepared.plaintextSize,
    item: {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: encryptedQueryParam,
          aes_key: Buffer.from(prepared.keyHex, 'utf8').toString('base64'),
          encrypt_type: 1,
        },
        file_name: prepared.fileName,
        len: String(prepared.plaintextSize),
      },
    },
  };
}
