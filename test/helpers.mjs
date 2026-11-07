import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 以干跑模式启动真实服务端，测试不消耗 LLM 额度
export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {...process.env, DRY_RUN: '1', BIND: '127.0.0.1', PORT: String(port), ...extraEnv},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  proc.stderr.on('data', d => stderr.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) return {base, port, proc, stop: () => proc.kill(), stderr};
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('服务端启动超时：' + stderr.join(''));
}

export function post(base, pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
}
