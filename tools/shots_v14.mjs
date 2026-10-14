#!/usr/bin/env node
/* ============================================================
   v1.4 实机证据截图 —— 镜像自动顺延

   这一版的新东西**全在状态层**（用户看到的那几行字），而状态层是原生 View，
   网页里读不到、`__yspUI` 也探不到。所以这里两条腿一起走：
     · adb screencap  —— 拍用户真正看到的画面（截图本身）
     · uiautomator dump —— 把原生的 text 读出来**当断言**，不靠肉眼

   ------------------------------------------------------------------
   为什么要一个「挂住的服务器」，而不是直接堆三条死链
   ------------------------------------------------------------------
   顺延的现场是这样的：第 1 路失败 → 状态层写「这个台的第 1/3 路地址…」→
   250ms 后换第 2 路。如果第 2 路**立刻**失败，那段说明只活 250ms，
   截图脚本就变成抛硬币（这不是假设 —— v1.4 的开发过程中就因为这个
   发现了一个真 bug：play() 会用「正在连接…」把说明顶掉，而推进只隔 250ms，
   等于那三行字从来没出现过）。
   要让窗口足够长、又不引入外网依赖，用 `adb reverse` 把设备自己
   127.0.0.1:7000 打到宿主机上一个**只 accept、不写一个字节**的 TCP 服务，
   播放器就会一直等，直到 15 秒的看门狗把它判失败。
   于是时间线是确定且宽裕的：
     点第 1 路 ──立刻 ECONNREFUSED──► 状态层写「第 1/3 路」──► 换第 2 路
                                                   ▲
                                            截图窗口 ≈ 15 秒
   前置：debug APK 已装、emulator-5554 在线。脚本自己拉起 Activity、端口转发、反向转发。

   用法：node tools/shots_v14.mjs
   ============================================================ */
import { execFileSync, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = process.env.PORT || '9222';
const OUT = `${ROOT}/dist/shots_v14`;
const STALL_PORT = 7000;

mkdirSync(OUT, { recursive: true });

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim(); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const logcat = (f = 'YSPTV:V') => { try { return adb('logcat', '-d', '-s', f); } catch { return ''; } };

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\u2713' : '\u2717'} ${name}${extra ? '   ' + extra : ''}`);
}

function shot(name) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const p = `${OUT}/${name}.png`;
  writeFileSync(p, buf);
  console.log(`  📷 ${p}  (${buf.length} 字节)`);
  return p;
}

/* 原生 View 树里的文字 —— 状态层是原生 View，只有这条路能「读」到它。
   ⚠️ 别用 screencap + OCR：那既慢又要引入识别误差，而 text 属性本来就是准的。 */
function uiTexts() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui_v14.xml');
  const xml = sh(`"${ADB}" -s ${SERIAL} shell cat /sdcard/ui_v14.xml`);
  return [...xml.matchAll(/text="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
}
const uiHas = (sub) => uiTexts().some(t => t.includes(sub));

/* ---------- 挂住的 TCP 服务：accept 之后一个字节都不写 ---------- */
let stallHits = 0;
const stall = net.createServer(sock => {
  stallHits++;
  sock.on('error', () => {});
  // 故意不 write、不 end —— 让播放器一直等 HTTP 响应
});
stall.listen(STALL_PORT, '127.0.0.1');

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
await sleep(1500);

const pid = sh(`"${ADB}" -s ${SERIAL} shell pidof com.ysptv.player`).split('\n').pop().trim();
sh(`"${ADB}" -s ${SERIAL} forward --remove-all`);
sh(`"${ADB}" -s ${SERIAL} reverse --remove-all`);
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
await cdp(/android_asset/);
for (let i = 0; i < 30; i++) { if ((await ev('typeof __yspUI==="object" ? __yspUI.count() : -1')) > 0) break; await sleep(500); }

/* ---------- 0. 反向转发 + 局域网导入页（顺带复验 v1.3 那张页面还在） ---------- */
console.log('\n### 0. 起局域网服务 + 反向转发（挂住的服务器）');
adb('reverse', `tcp:${STALL_PORT}`, `tcp:${STALL_PORT}`);
await ev('__yspUI.openManage()');
await sleep(1200);
const lan = await ev('__yspUI.lanUrl()');
console.log('  局域网地址:', lan);
const devPort = +lan.match(/:(\d+)\//)[1];
sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
adb('forward', 'tcp:8099', `tcp:${devPort}`);

const postRaw = (path, body) => fetch('http://127.0.0.1:8099' + path, {
  method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: body || '',
}).then(r => r.json()).catch(e => ({ err: String(e) }));

{
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1180 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const p = `${OUT}/04-导入页-仍可用.png`;
  await page.screenshot({ path: p, fullPage: true });
  console.log(`  📷 ${p}`);
  await browser.close();
}

/* ---------- 1. 造一个「同台三路、第 2 路挂住」的现场 ---------- */
console.log('\n### 1. 造现场：同一个台名下面挂三路地址');
// ⚠️⚠️ 顺序不能反：**先导入，再收浮层**。
//    `closeManage()` 在 custom.js 里会顺手 `bridge('lanStop')` —— 把局域网服务一起停掉。
//    所以一旦先收浮层，后面的 `/api/add` 就是 ECONNREFUSED
//    （第一版就是这么写的，现象是「导入: {"err":"TypeError: fetch failed"}」，
//     三条源一条都没进去，于是后面 11 条断言全挂，看着像顺延功能坏了）。
await postRaw('/api/clear', '');
await sleep(800);
const A = 'http://127.0.0.1:1/demo-a.m3u8';                       // 立刻 ECONNREFUSED
const B = `http://127.0.0.1:${STALL_PORT}/demo-b.m3u8`;           // 连上就不说话 → 15 秒看门狗
const Cc = 'http://127.0.0.1:2/demo-c.m3u8';                      // 立刻 ECONNREFUSED
// ⚠️ 三条写成**三种不同的写法**，顺带证明归一化真的把它们算成一个台
//    （空格、半角括号带画质后缀、破折号 + 中文画质词，都是真清单里出现过的写法）。
const NAME_BASE = '演示台·顺延';
const m3u = ['#EXTM3U',
  `#EXTINF:-1,${NAME_BASE}`, A,
  `#EXTINF:-1,演示台 顺延 (720p)`, B,
  `#EXTINF:-1,演示台-顺延 高清`, Cc,
  ''].join('\n');
const addRes = await postRaw('/api/add', m3u);
await sleep(1200);
const st1 = await json(`JSON.stringify({ n: __yspUI.count(), urls: __yspUI.urls(), names: __yspUI.names() })`);
console.log('  导入:', JSON.stringify(addRes).slice(0, 120));
ok('三路地址都进了列表', [A, B, Cc].every(u => st1.urls.includes(u)), `n=${st1.n}`);

// 导入做完了，现在才收浮层（顺序的理由见上面）。
// CustomActivity 在浮层开着时【刻意】不做顺延（那是「我要接管」的信号），
// 漏了这一步的话下面所有「顺延」断言都会失败，而且看起来像功能没实现 ——
// v1.4 开发期真踩过一次，所以这里既关掉、又断言关掉了。
await ev('__yspUI.closeManage()');
await sleep(700);
const mgOpen = await ev('__yspUI.isManageOpen()');
ok('前置：源管理浮层已收起（浮层开着时设计上就不顺延）',
  mgOpen === false, `isManageOpen=${mgOpen}`);

/* ---------- 2. 点第 1 路 → 拍「这个台的第 1/3 路地址…」 ---------- */
console.log('\n### 2. 点第 1 路（死）→ 顺延中，状态层应一直挂着说明');
adb('logcat', '-c');
await ev(`(function(){ __yspUI.rpc('pick', ${JSON.stringify(A)}); return 1; })()`);
{
  let lg = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { await sleep(300); lg = logcat(); if (/镜像顺延 2\/3/.test(lg)) break; }
  ok('确实发生了顺延：第 1 路不通 → 换第 2 路', /镜像顺延 2\/3/.test(lg),
    (lg.split('\n').filter(l => /镜像顺延/.test(l)).pop() || '没等到顺延记录').replace(/^.*?YSPTV\s*:\s*/, '').trim());
  ok('刚才那个挂住的地址真的被连上了（证明 15 秒窗口是真的，不是等到超时才截图）',
    stallHits > 0, `stallHits=${stallHits}`);

  // ⚠️ 这三条就是本版修掉的那个 bug 的现场断言。
  //    改之前 play() 会在 250ms 后用「正在连接…」把说明顶掉 ——
  //    也就是说下面这些 text 一个都不会在屏上出现。
  const texts = uiTexts();
  const joined = texts.join(' | ');
  // ⚠️ 期望是「第 **2**/3 路」，不是「第 1/3 路」。
  //    代码里 nth = mirrorTried.size() + 1，指的是**正在试**的那一路；
  //    「第 1 路不通」这件事写在副标题里（台名 + 那一路的地址 + 失败原因）。
  //    所以完整的用户视角是：标题「在试第 2 路」+ 正文「第 1 路 demo-a 不通，自动换下一路」。
  //    （第一版断言写成了「第 1/3 路」，于是明明是对的也被判红。）
  ok('状态层标题是「这个台的第 2/3 路地址…」（nth = 正在试的那一路）',
    joined.includes('这个台的第 2/3 路地址'), joined.slice(0, 160));
  ok('状态层正文点明了**是哪一路**不通（demo-a.m3u8），而不是只说「换了一路」',
    joined.includes('127.0.0.1:1/demo-a.m3u8'));
  ok('状态层里有「这一路不通，自动换同一个台的下一路」（这是用户唯一能看出台为什么自己变了的地方）',
    joined.includes('这一路不通，自动换同一个台的下一路'));
  ok('状态层里有「按「菜单」键可以直接换别的台」（顺延不是死循环，随时能接管）',
    joined.includes('按「菜单」键可以直接换别的台'));
  ok('状态层里没有被「正在连接…」顶掉', !joined.includes('正在连接…'));
  shot('01-顺延中-这个台的第1路不通');
}

/* ---------- 3. 等第 2 路超时 → 第 3 路也死 → 拍最终报错 ---------- */
console.log('\n### 3. 等第 2 路 15 秒超时 → 试完第 3 路 → 最终报错');
{
  let lg = '';
  const t0 = Date.now();
  // 第 2 路要等满 15 秒看门狗，再顺延到第 3 路（立刻失败），然后才是最终报错
  while (Date.now() - t0 < 45000) {
    await sleep(500); lg = logcat();
    if (/播放失败: 演示台/.test(lg) && /本轮已试 3 路/.test(lg)) break;
  }
  const failLines = lg.split('\n').filter(l => /播放失败/.test(l));
  // ⚠️ 用索引取最后一条，**别用 pop()** —— pop 会把它从数组里删掉，
  //    于是下面那条「只报一次」数到的就变成 0 了（第一版就是这么写的，白红一条）。
  const lastFail = failLines.length ? failLines[failLines.length - 1] : '';
  ok('三路都试完了才报失败（不是第一路不通就报）', /本轮已试 3 路/.test(lg),
    (lastFail || '没有最终失败记录').replace(/^.*?YSPTV\s*:\s*/, '').trim());
  ok('报失败只报一次', failLines.length === 1, `播放失败 记了 ${failLines.length} 次`);

  const joined = uiTexts().join(' | ');
  ok('最终文案说明了「同台一共几路、已经试过几路」',
    joined.includes('这个台一共 3 路地址') && joined.includes('已经试过 3 路，都不通'),
    joined.slice(0, 200));
  ok('最终文案给了两条出路（确认重试 / 菜单换源）',
    joined.includes('按「确认」重试') && joined.includes('按「菜单」换一条源'));
  ok('最终报错时状态层里也没有残留的「第 x/3 路」顺延文案',
    !joined.includes('路地址…'));
  shot('02-三路全不通-最终报错');
}

/* ---------- 4. 列表里死掉的那些打上了标记 ---------- */
console.log('\n### 4. 源列表里，刚才失败的三路都被打了标记');
{
  await ev('(function(){ window.__yspTV.openPanel(); return 1; })()');
  await sleep(900);
  const bads = await json('JSON.stringify(__yspUI.badUrls())');
  ok('三路失败的地址都被记下来了（这就是列表里变暗 + ⚠ 的数据源）',
    [A, B, Cc].every(u => bads.includes(u)), `badUrls ${bads.length} 条`);
  // ⚠️ 刻意【不】断言 labels() 里有 ⚠：⚠ 是 ::after 画的伪元素，
  //    伪元素内容不进 innerText，所以 labels() 里永远看不到它 ——
  //    这是当初选 ::after（而不是插一个 span）的原因之一，写断言时要认这个事实，
  //    否则会写出一个「无论如何都通过」的假断言。标记本身只能靠截图看。
  shot('03-失败地址在列表里被标记');
}

/* ---------- 收尾 ---------- */
console.log('\n### 5. 收尾：清空 + 恢复示例源 + 拆掉转发');
await ev('__yspUI.rpc("clear")');
await sleep(900);
// v1.9：seeds 桥已删（产品不再内置示例源），这里不再往回塞东西。
// 收尾态就是「零源 + 清单地址留着」，那才是当前的还原态。
await sleep(1400);
console.log('  收尾后源数量:', await ev('__yspUI.count()'));
sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
sh(`"${ADB}" -s ${SERIAL} reverse --remove-all`);
stall.close();

console.log(`\n${'='.repeat(58)}`);
console.log(`  v1.4 截图脚本自检：通过 ${pass} / ${pass + fail}`);
if (fail) console.log(`  失败 ${fail}`);
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);
