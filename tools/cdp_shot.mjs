#!/usr/bin/env node
/* CDP 精确区域截图： node cdp_shot.mjs <outName> <x> <y> <w> <h> [scale]
   坐标单位是 CSS px（设备上是 914x411） */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = path.join(ROOT, 'tools', 'shots');
mkdirSync(SHOTS, { recursive: true });

const [name, x, y, w, h, scale] = process.argv.slice(2);
const clip = { x: +x, y: +y, width: +w, height: +h, scale: +(scale || 1) };

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.error('无页面目标'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip });
const out = path.join(SHOTS, name + '.png');
writeFileSync(out, Buffer.from(r.result.data, 'base64'));
console.log('saved', out, `clip=${JSON.stringify(clip)}`);
ws.close();
