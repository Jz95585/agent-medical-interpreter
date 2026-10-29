// 静态资源索引与 MIME 表
import fs from 'node:fs';
import path from 'node:path';

const mimeTypes = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

function publicAssets(dir) {
  const map = new Map();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) map.set('/' + name, name);
    }
  }
  map.set('/', 'index.html');
  return map;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) return false;
  const start = m[1] === '' ? 0 : Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) return false;
  return {start, end};
}

export {publicAssets, mimeTypes, parseRange};
