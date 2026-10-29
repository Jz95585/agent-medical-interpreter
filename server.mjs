import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {apiFetch} from './src/api.mjs';
import {publicAssets, mimeTypes, parseRange} from './src/static.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));

// 加载 .env（键只存在服务端，不随前端分发）
if (fs.existsSync(path.join(base, '.env'))) {
  for (const line of fs.readFileSync(path.join(base, '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Z_]+$/.test(k) || process.env[k] !== undefined) continue;
    let v = line.slice(i + 1).trim();
    // 容错：剥掉手写的成对引号
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

const port = Number(process.env.PORT || 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PORT 必须在 1024-65535 之间');
// 公网部署：设置 BIND=0.0.0.0，并通过 ALLOWED_HOSTS 声明允许的 Host 头（逗号分隔，如 yourdomain.com,1.2.3.4:8790）
const bindHost = process.env.BIND || '127.0.0.1';
// ALLOWED_HOSTS 三种写法：精确匹配（host[:port]）、后缀通配（以 . 开头，如 .cpolar.top）、* 全放行
// * 仅建议在"本机服务 + 内网穿透"场景使用（服务只监听 127.0.0.1，外网流量必须经过你自己的隧道客户端）
const hostEntries = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowAll = hostEntries.includes('*');
const hostExact = new Set(hostEntries.filter(h => !h.startsWith('.') && h !== '*')
  .concat([`${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${port}`, `localhost:${port}`, `[::1]:${port}`]));
const hostSuffix = hostEntries.filter(h => h.startsWith('.'));
const hostAllowed = (host) => allowAll || hostExact.has(host) || hostSuffix.some(sfx => host.endsWith(sfx));
const assets = publicAssets(path.join(base, 'public'));

http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host || '')) { res.writeHead(403); res.end('Forbidden'); return; }
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);

    // API 路由
    if (url.pathname.startsWith('/api/')) {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2000000) { res.writeHead(413); res.end('{"error":"请求过大"}'); return; }
        chunks.push(chunk);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        signal: ctrl.signal,
      });
      const response = await apiFetch(request, process.env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); }
      res.end();
      return;
    }

    // 静态资源
    const filename = assets.get(url.pathname);
    if (!filename) { res.writeHead(404); res.end('Not found'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, {Allow: 'GET, HEAD'}); res.end(); return; }
    const file = path.join(base, 'public', filename);
    const size = fs.statSync(file).size;
    const headers = {
      'Content-Type': mimeTypes[filename.split('.').at(-1)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    const stream = fs.createReadStream(file);
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    console.error('[server]', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, {'Content-Type': 'application/json'});
    res.end('{"error":"请求未完成"}');
  }
}).listen(port, bindHost, () => {
  console.log('Agent Medical Interpreter Demo  http://127.0.0.1:' + port + `（监听 ${bindHost}）`);
  console.log('模型: ' + (process.env.AMI_MODEL || '未配置') + (process.env.DRY_RUN === '1' ? '（DRY_RUN 干跑模式）' : ''));
});
