import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const FORBIDDEN_PACKAGE_FILES = ['desktop.mjs', 'desktop.ps1'];
const SENSITIVE_NAMES = [
  'wechat-token.json',
  'wechat-cursor.txt',
  'wechat-seen.json',
  'wechat-qr.txt',
  'wechat-context.txt',
  'wechat-session.txt',
  'wechat-relay.txt',
  'wechat-outbox.json',
  'bridge.log',
];

function walk(dir) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === '.dsh-smoke') continue;
    const target = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(target));
    else out.push(target);
  }
  return out;
}

test('manifest follows the DSH bundle contract and uses a narrow allowlist', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@lzg3530606141/dsh-wechat-bridge');
  assert.equal(pkg.repository.url, 'git+https://github.com/lzg3530606141/dsh-wechat-bridge.git');
  assert.ok(pkg.keywords.includes('dsh-plugin'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './src/index.mjs');
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } });
  assert.equal(pkg.bin['dsh-wechat'], './bin/dsh-wechat.mjs');
  assert.equal(pkg.bin.wx, undefined);
  assert.match(pkg.engines.dsh, /0\.1\.5-rc\.1/);
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
  assert.ok(pkg.files.every((entry) => !entry.includes('*')));
  for (const forbidden of FORBIDDEN_PACKAGE_FILES) assert.ok(!pkg.files.some((entry) => entry.endsWith(forbidden)));
  for (const sensitive of SENSITIVE_NAMES) assert.ok(!pkg.files.some((entry) => entry.endsWith(sensitive)));
});

test('bundle patch references the package and keeps secure defaults', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /name:\s+['"]@lzg3530606141\/dsh-wechat-bridge['"]/);
  assert.match(patch, /host:\s+127\.0\.0\.1/);
  assert.match(patch, /session:\s+''/);
  assert.match(patch, /controlToken:\s+''/);
  assert.match(patch, /controlAllowRemote:\s+false/);
  assert.match(patch, /dshHomePath\('wechat-bridge'\)/);
});

test('repository contains no desktop automation or obvious committed runtime state', () => {
  const files = walk(root);
  const names = files.map((file) => path.basename(file).toLowerCase());
  for (const forbidden of FORBIDDEN_PACKAGE_FILES) assert.ok(!names.includes(forbidden));
  for (const sensitive of SENSITIVE_NAMES) assert.ok(!names.includes(sensitive));

  const source = files
    .filter((file) => /\.(?:mjs|js|json|md|yml|yaml|gitignore)$/i.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /new URL\(['"]\.\/desktop\.mjs/);
  assert.doesNotMatch(source, /case ['"]desktop['"]/);
  assert.doesNotMatch(source, /bot_token\s*[:=]\s*['"][^'"]+['"]/i);
  assert.doesNotMatch(source, /Authorization\s*:\s*['"]Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i);
  assert.doesNotMatch(source, /session-[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  assert.doesNotMatch(source, /https?:\/\/[^\s'"]+(?:qrcode|qr_url)=[^\s'"]+/i);

  const runtimeSource = read('src/index.mjs') + '\n' + read('bin/dsh-wechat.mjs');
  assert.doesNotMatch(runtimeSource, /remote-bridge/i);
  assert.doesNotMatch(runtimeSource, /\.dsh['"],\s*['"]remote-bridge/);
  assert.doesNotMatch(runtimeSource, /readFileSync\([^\n]*(?:legacyBrand|remote-bridge)/);
  assert.doesNotMatch(runtimeSource, /path\.join\(os\.homedir\(\),\s*['"]\.dsh['"]/);
  assert.doesNotMatch(runtimeSource, /import\(['"]data:text\/javascript/);
});
