#!/usr/bin/env node
/* ============================================================
   v1.3 实机证据截图

   为什么要单独一个脚本：这一版的产出物有一半在「手机/电脑上看的那一页」
   （局域网导入页新增的「从网址导入」），而 TV 端的 screencap 拍不到那一页。
   所以这里两条腿一起走：
     · 手机侧：Playwright 打开电视吐出来的导入页，截整页
     · 电视侧：adb screencap，截「源管理」浮层（新的「刷新远程清单」+ 记住的地址）
                和真清单导入之后的分组 tab

   前置：debug APK 已装、`emulator-5554` 在线。脚本自己拉起 Activity 和端口转发。

   用法：node tools/shots_v13.mjs
   ============================================================ */
import { execFileSync, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = process.env.PORT || '9222';
const OUT = `${ROOT}/dist/shots_v13`;
const REAL_LIST = 'https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_all.m3u8';

mkdirSync(OUT, { recursive: true });

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim(); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };

function shot(name) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const p = `${OUT}/${name}.png`;
  writeFileSync(p, buf);
  console.log(`  📷 ${p}  (${buf.length} 字节)`);
  return p;
}

/* ---------- CDP ---------- */
let ws, seq = 0;
const pending = new Map();
async function cdp(pageMatch) {
  let targets = null;
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { targets = await r.json(); break; } }
    catch (e) {}
    await sleep(500);
  }
  if (!targets) throw new Error('连不上 CDP ' + PORT);
  const page = targets.find(t => t.type === 'page' && pageMatch.test(t.url));
  if (!page) throw new Error('找不到目标页面：' + JSON.stringify(targets.map(t => t.url)));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  console.log('  目标页面:', page.url);
}
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error('JS 异常: ' + (res.exceptionDetails.exception?.description || ''));
  return res.result ? res.result.value : undefined;
}
const json = async (e) => { const v = await ev(e); return typeof v === 'string' ? JSON.parse(v) : v; };

/* ============================================================ */
adb('shell', 'am', 'force-stop', 'com.ysptv.player');
adb('shell', 'am', 'start', '-n', 'com.ysptv.player/.CustomActivity');
await sleep(1200);

const pid = sh(`"${ADB}" -s ${SERIAL} shell pidof com.ysptv.player`).split('\n').pop().trim();
sh(`"${ADB}" -s ${SERIAL} forward --remove-all`);
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
await cdp(/android_asset/);
for (let i = 0; i < 30; i++) { if ((await ev('typeof __yspUI==="object" ? __yspUI.count() : -1')) > 0) break; await sleep(500); }

/* ---------- 1. 先把真清单导进去（这样浮层和 tab 里都有内容） ---------- */
console.log('\n### 1. 打开源管理（顺带把局域网服务带起来）');
await ev('__yspUI.openManage()');
await sleep(1200);
let lan = await ev('__yspUI.lanUrl()');
console.log('  局域网地址:', lan);
const devPort = +lan.match(/:(\d+)\//)[1];
sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
adb('forward', 'tcp:8099', `tcp:${devPort}`);

const post = (path, body) => fetch('http://127.0.0.1:8099' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  body: body || '',
}).then(r => r.json()).catch(e => ({ err: String(e) }));

console.log('\n### 2. 手机侧：导入页截图（拍那张新增的「从网址导入」卡片）');
{
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1180 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const p = `${OUT}/01-导入页-从网址导入.png`;
  await page.screenshot({ path: p, fullPage: true });
  const info = await page.evaluate(() => ({
    title: document.querySelector('h1').textContent,
    hasUrl: !!document.getElementById('rurl'),
    remote: (document.getElementById('rurls') || {}).textContent || '',
    count: document.getElementById('count').textContent,
  }));
  console.log(`  📷 ${p}`);
  console.log('  页面自述:', JSON.stringify(info));
  await browser.close();
}

console.log('\n### 3. 电视侧：源管理浮层（新的「刷新远程清单」+ 记住的地址）');
const r0 = await post('/api/addurl', 'url=' + encodeURIComponent(REAL_LIST));
console.log('  真清单导入:', JSON.stringify(r0).slice(0, 150));
await sleep(2000);
await ev('__yspUI.openManage()');
await sleep(1200);
const menu = await json('JSON.stringify({ items: __yspUI.menuLabels(), remote: __yspUI.remoteUrl(), n: __yspUI.count() })');
console.log('  菜单:', menu.items.join(' | '));
console.log('  源数量:', menu.n, ' 记住的地址:', menu.remote);
shot('02-源管理-刷新远程清单');

console.log('\n### 4. 电视侧：真清单导入后的分组 tab（选台面板）');
await ev('__yspUI.closeManage()');
await sleep(600);
await ev('(function(){ window.__yspTV.openPanel(); return 1; })()');
await sleep(900);
// 往右切几组，让 tab 条幅滚起来（tab 跟随选中项是 v1.2 修的，这里顺带复验）
for (let i = 0; i < 4; i++) { adb('shell', 'input', 'keyevent', '22'); await sleep(500); }
const tabState = await json(`JSON.stringify({
  groups: __yspUI.groups(), cur: __yspUI.currentGroup(), idx: __yspUI.currentGroupIndex(),
  scrollLeft: Math.round(document.getElementById('yspTabs').scrollLeft),
  max: document.getElementById('yspTabs').scrollWidth - document.getElementById('yspTabs').clientWidth
})`);
console.log('  分组数:', tabState.groups.length, ' 当前:', tabState.cur,
            ' scrollLeft:', tabState.scrollLeft, '/', tabState.max);
shot('03-真清单导入后-分组tab');
await sleep(300);
shot('04-真清单导入后-列表与正在播放');

/* ---------- 收尾：清干净 ---------- */
console.log('\n### 5. 收尾（清空 + 恢复示例源，清单地址故意留着）');
await ev('__yspUI.rpc("clear")');
await sleep(1000);
// v1.9：seeds 桥已删（产品不再内置示例源），这里不再往回塞东西。
// 收尾态就是「零源 + 清单地址留着」，那才是当前的还原态。
await sleep(1400);
console.log('  收尾后源数量:', await ev('__yspUI.count()'),
            ' 记住的地址:', (await ev('__yspUI.remoteUrl()')).slice(0, 60) + '…');
sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
console.log('\n完成。截图目录：' + OUT);
process.exit(0);
