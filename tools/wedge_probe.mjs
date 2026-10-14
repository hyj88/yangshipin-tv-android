#!/usr/bin/env node
/* 抓「快按敲死播放器」时站点控制台的报错。
   流程：重载页面拿到干净播放器 → 等它真正播起来 → 6 连按 →  dump 捕获到的
   console.error / 未捕获异常 / Promise rejection。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.log('找不到页面 target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
const errs = [];

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errs.push({ k: 'console.' + m.params.type, t: Math.round(m.params.timestamp || 0), txt: (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300) });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errs.push({ k: 'uncaught', t: 0, txt: (d.exception?.description || d.text || '').slice(0, 400) });
  }
};

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 15000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const vstate = () => ev(`(function(){var v=document.querySelector('video');return JSON.stringify({src:(v.src||'').slice(0,18),rs:v.readyState,ns:v.networkState,paused:v.paused,ct:Math.round(v.currentTime*10)/10});})()`);

try {
  await send('Runtime.enable');
  console.log('重载页面…');
  await ev('location.reload()');
  await sleep(9000);
  console.log('重载后视频状态:', await vstate());
  console.log('\n开始 6 连按（间隔 120ms）…');
  errs.length = 0;
  for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
  await sleep(8000);
  console.log('6 连按后视频状态:', await vstate());
} catch (e) { console.log('出错：', e.message); }

console.log(`\n=== 捕获到 ${errs.length} 条错误/警告 ===`);
errs.forEach(r => console.log(`  [${r.k}] ${r.txt}`));
if (!errs.length) console.log('  （一条都没有 —— 站点把异常吞了，或崩溃发生在它自己的 worker 里）');
ws.close();
