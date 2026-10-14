#!/usr/bin/env node
/* 严谨版敲击实验台 v2。
   v1 死在自己的方法论上：location.reload() 之后站点不肯自动播（无用户手势），
   「等健康」永远等不到，6 轮全部误判成「起不来」。
   v2 改用 force-stop + am start 冷启动 App —— 这才是用户真实路径，且确实会自动播。
   另外每轮都强制校验起点在列表中段，避免在末行按出一堆 clamp 空操作。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PKG = 'com.ysptv.player';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

async function cdp() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  let errCount = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errCount++;
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errCount++;
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 25000);
    pending.set(id, m => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),rows:__yspTV.count(),pend:__yspTV.switchPending(),rs:v.readyState,ns:v.networkState,src:(v.src||'').length,paused:v.paused,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
  return { ws, send, ev, snap, errs: () => errCount };
}
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

/* 冷启动 App 并等它真正播起来 */
async function coldStart() {
  adb('shell', 'am', 'force-stop', PKG);
  await sleep(1200);
  adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity');
  await sleep(2500);
  const pid = adb('shell', 'pidof', PKG).trim();
  adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    let c = null;
    try { c = await cdp(); } catch (e) {}
    if (!c) continue;
    let prevCt = -1;
    for (let k = 0; k < 12; k++) {
      await sleep(500);
      const h = await c.snap();
      if (h.rs >= 3 && h.paused === false && h.ct > prevCt && h.ct > 0.5) return c;
      prevCt = h.ct;
      if (isDead(h) && k > 6) break;
    }
    c.ws.close();
  }
  return null;
}

const TRIALS = Number(process.argv[2] || 6);
const stats = { dead: 0, ok: 0, skip: 0 };
for (let t = 1; t <= TRIALS; t++) {
  const c = await coldStart();
  if (!c) { stats.skip++; console.log(`第 ${t} 轮：冷启动后起不来，跳过`); continue; }
  await c.send('Runtime.enable');
  const base = await c.snap();
  // 起点必须在列表中段
  let start = base;
  if (base.playing < 5 || base.playing > base.rows - 6) {
    await c.ev('__yspTV.switchTab(0)');
    await sleep(4000);
    const s2 = await c.snap();
    if (isDead(s2)) { stats.dead++; console.log(`第 ${t} 轮：死于切 tab（起点 ${base.playing}/${base.rows}）`); c.ws.close(); continue; }
    start = s2;
  }
  const errBefore = c.errs();
  if (process.env.GAP) { await c.ev(`__yspTV.setSwitchGap(${Number(process.env.GAP)})`); }   // 对照组：GAP=0 即修复前行为
  for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
  // 等它落定（最多 12s）
  let fin = null, deadRun = 0;
  for (let k = 0; k < 24; k++) {
    await sleep(500);
    fin = await c.snap();
    if (fin.pend === -1 && fin.rs >= 3 && fin.ct > 0.5) break;
    // 判死要连续 3 次：换台途中 readyState 会瞬时掉 0，单次采样是假阳性
    if (isDead(fin)) { deadRun++; } else { deadRun = 0; }
  }
  const dead = deadRun >= 3;
  if (dead) stats.dead++; else stats.ok++;
  console.log(`第 ${t} 轮：${dead ? '死亡' : '存活'}  起点 ${start.playing}/${start.rows} → 终点 ${fin.playing}/${fin.rows}  rs=${fin.rs} ct=${fin.ct}  新增错误 ${c.errs() - errBefore} 条`);
  c.ws.close();
}
console.log(`\n汇总（${TRIALS} 轮）：连按死 ${stats.dead} | 全活 ${stats.ok} | 跳过 ${stats.skip}`);
