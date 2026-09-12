import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { uploadWechatFile, resolveWechatCdnUploadUrl, safeWechatFileName } from '../src/wechat-media.mjs';

async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('streams, encrypts, and describes a WeChat file upload', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filePath = path.join(temp, '报告.pdf');
  const source = Buffer.from('deepseek-harness-wechat-file-test');
  fs.writeFileSync(filePath, source);

  let uploadRequest;
  let sentCiphertext;
  let sawStream = false;
  let contentLength = '';
  const result = await uploadWechatFile({
    filePath,
    allowedRoots: [temp],
    maxBytes: 1024,
    toUserId: 'user-for-test',
    requestUpload: async (request) => {
      uploadRequest = request;
      return { ret: 0, upload_param: 'test-param' };
    },
    fetchFn: async (url, init) => {
      assert.equal(new URL(url).hostname, 'novac2c.cdn.weixin.qq.com');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.duplex, 'half');
      sawStream = init.body instanceof Readable;
      contentLength = init.headers['Content-Length'];
      sentCiphertext = await collect(init.body);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-token' } });
    },
  });

  assert.equal(sawStream, true);
  assert.equal(uploadRequest.media_type, 3);
  assert.equal(uploadRequest.rawsize, source.length);
  assert.equal(uploadRequest.rawfilemd5, crypto.createHash('md5').update(source).digest('hex'));
  assert.equal(uploadRequest.filesize, sentCiphertext.length);
  assert.equal(contentLength, String(sentCiphertext.length));
  assert.equal(uploadRequest.to_user_id, 'user-for-test');
  assert.equal(result.item.type, 4);
  assert.equal(result.item.file_item.file_name, '报告.pdf');
  assert.equal(result.item.file_item.len, String(source.length));
  assert.equal(result.item.file_item.media.encrypt_query_param, 'download-token');

  const keyHex = Buffer.from(result.item.file_item.media.aes_key, 'base64').toString('utf8');
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(sentCiphertext), decipher.final()]), source);
});

test('retries transient upload errors and validates paths and hosts', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filePath = path.join(temp, 'file.bin');
  fs.writeFileSync(filePath, Buffer.from('retry test'));

  let attempts = 0;
  const retried = await uploadWechatFile({
    filePath,
    allowedRoots: [temp],
    maxBytes: 1024,
    toUserId: 'user-for-test',
    requestUpload: async () => ({ ret: 0, upload_param: 'retry-param' }),
    fetchFn: async (_url, init) => {
      attempts += 1;
      await collect(init.body);
      if (attempts === 1) throw new Error('simulated transient failure');
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'retry-token' } });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(retried.item.file_item.media.encrypt_query_param, 'retry-token');
  assert.equal(safeWechatFileName('../bad\\name\u0000.pdf'), '.._bad_name_.pdf');
  assert.throws(() => resolveWechatCdnUploadUrl({ upload_full_url: 'https://example.com/upload' }, 'key'), /不是受信任/);
  await assert.rejects(
    uploadWechatFile({ filePath, allowedRoots: [path.join(temp, 'other')], toUserId: 'x', requestUpload: async () => ({}) }),
    /允许发送的目录/,
  );

  const oversized = path.join(temp, 'oversized.bin');
  fs.writeFileSync(oversized, Buffer.alloc(1025));
  await assert.rejects(
    uploadWechatFile({ filePath: oversized, allowedRoots: [temp], maxBytes: 1024, toUserId: 'x', requestUpload: async () => ({}) }),
    /发送上限/,
  );
});
