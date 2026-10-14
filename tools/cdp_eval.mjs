#!/usr/bin/env node
/* ============================================================
   通用 CDP 取值工具 —— 在目标 WebView 里跑一段表达式并打印结果

   用途：调试 phone / TV 两个模拟器上的页面状态（不必每次改测试脚本）

   用法：
     node tools/cdp_eval.mjs "window.__yspTV.index()"
     node tools/cdp_eval.mjs --port 9223 --serial emulator-5556 "window.__yspTV.index()"
     PORT=9223 node tools/cdp_eval.mjs "..."

   端口约定：9222 = TV(emulator-5554)  9223 = 手机(emulator-5556)
   ============================================================ */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
let port = process.env.PORT || '9222';
let serial = process.env.ANDROID_SERIAL || '';
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = argv[++i];
  else if (argv[i] === '--serial') serial = argv[++i];
  else rest.push(argv[i]);
}
const expr = rest.join(' ');
if (!expr) { console.error('用法: node tools/cdp_eval.mjs "表达式"'); process.exit(2); }

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adb = (...a) => execFileSync(ADB, serial ? ['-s', serial, ...a] : a,
  { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// 优先挑央视频页；但探针会把 WebView 导到 about:blank，所以要有兜底
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url))
          || targets.find(t => t.type === 'page');
if (!page) { console.error('找不到页面目标：', JSON.stringify(targets)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params) {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}

const r = await send('Runtime.evaluate', {
  expression: expr, returnByValue: true, awaitPromise: true,
});
ws.close();
if (r.result && r.result.exceptionDetails) {
  console.error('JS 异常:', JSON.stringify(r.result.exceptionDetails, null, 2));
  process.exit(1);
}
const v = r.result && r.result.result && r.result.result.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
