import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const projectDir = resolve('C:/Users/Administrator/Documents/Codex/2026-06-23/https-messenger-abeto-co/outputs/slg-messenger-style');
const outDir = resolve('D:/CodexWork/wechat-acceptance');
const screenshotPath = join(outDir, 'messenger-abeto-real-screenshot-fixed.png');
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
]);

function quantizedColorCount(png, step = 12) {
  const colors = new Set();
  let nonTransparent = 0;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const i = (png.width * y + x) << 2;
      const a = png.data[i + 3];
      if (a < 16) continue;
      nonTransparent += 1;
      const r = png.data[i] >> 4;
      const g = png.data[i + 1] >> 4;
      const b = png.data[i + 2] >> 4;
      colors.add(`${r},${g},${b}`);
    }
  }
  return { colors: colors.size, nonTransparent };
}

mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = resolve(projectDir, `.${pathname}`);
  if (!file.startsWith(projectDir) || !existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime.get(extname(file)) ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((resolveListen) => server.listen(18773, '127.0.0.1', resolveListen));

const remotePort = 18774;
const profileDir = join(outDir, 'edge-profile-screenshot-diagnose');
const edge = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--allow-running-insecure-content',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${remotePort}`,
  '--window-size=1440,1000',
  `--user-data-dir=${profileDir}`,
  'http://127.0.0.1:18773/index.html',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function waitForDebugTarget() {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10000) {
    try {
      const targets = await json(`http://127.0.0.1:${remotePort}/json`);
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error('Edge debug target not ready');
}

const wsUrl = await waitForDebugTarget();
const ws = new WebSocket(wsUrl);
await new Promise((resolveOpen, rejectOpen) => {
  ws.addEventListener('open', resolveOpen, { once: true });
  ws.addEventListener('error', rejectOpen, { once: true });
});

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (
    message.method === 'Runtime.consoleAPICalled'
    || message.method === 'Runtime.exceptionThrown'
    || message.method === 'Log.entryAdded'
    || message.method === 'Network.loadingFailed'
    || message.method === 'Network.responseReceived'
  ) {
    events.push(message);
  }
});

function call(method, params = {}) {
  const callId = ++id;
  ws.send(JSON.stringify({ id: callId, method, params }));
  return new Promise((resolveCall) => pending.set(callId, resolveCall));
}

await call('Runtime.enable');
await call('Log.enable');
await call('Network.enable');
await call('Page.enable');
await call('Page.bringToFront');
await new Promise((resolveWait) => setTimeout(resolveWait, 2500));

const evalResult = await call('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const canvas = document.querySelector('#world');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const pixels = [];
    if (gl && canvas) {
      const sample = new Uint8Array(4);
      const points = [
        [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
        [Math.floor(canvas.width * 0.35), Math.floor(canvas.height * 0.55)],
        [Math.floor(canvas.width * 0.65), Math.floor(canvas.height * 0.45)],
        [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.75)]
      ];
      for (const [x, y] of points) {
        gl.readPixels(x, canvas.height - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
        pixels.push([x, y, sample[0], sample[1], sample[2], sample[3]]);
      }
    }
    return {
      title: document.title,
      canvas: canvas ? { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, width: canvas.width, height: canvas.height } : null,
      webgl: !!gl,
      bg: getComputedStyle(document.body).background,
      dataset: { ...document.body.dataset },
      pixels,
      text: document.body.innerText.slice(0, 200)
    };
  })()`,
});

const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const pngBytes = Buffer.from(capture.result.data, 'base64');
writeFileSync(screenshotPath, pngBytes);
const png = PNG.sync.read(pngBytes);
const complexity = quantizedColorCount(png);

ws.close();
edge.kill();
server.close();

console.log(JSON.stringify({
  screenshotPath,
  eval: evalResult.result?.result?.value,
  events,
  png: { width: png.width, height: png.height, bytes: pngBytes.length, ...complexity },
}, null, 2));
