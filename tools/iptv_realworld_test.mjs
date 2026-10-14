#!/usr/bin/env node
/* ============================================================
   真实第三方 IPTV 列表 —— 端到端可用性验证

   对象（默认）：best-fan/iptv-sources 的 cn_all.m3u8（聚合了央视频道/卫视等）

   要回答的三个问题：
     A. 这份清单本身长什么样（条目/分组/镜像/有没有超上限）
     B. App 到底能不能把它吃进去（走**局域网页**这条真实导入通道，不是走后门塞数据）
     C. 里头挑出来的流，框架 MediaPlayer 真能播吗（以及播不了时会不会把播放器带坏）

   用法:
     node tools/iptv_realworld_test.mjs
     node tools/iptv_realworld_test.mjs <列表URL或本地文件> --play 8
     ANDROID_SERIAL=emulator-5554 node tools/iptv_realworld_test.mjs
   ============================================================ */
import { execFileSync, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME = process.env.HOME;
const ADB = `${HOME}/Library/Android/sdk/platform-tools/adb`;
const SHOTS = path.join(ROOT, 'tools', 'shots');
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = +(process.env.PORT || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const LAN_PORT = 8099;                 // 本机侧转发口（设备侧是随机端口）
const DELAY = 450;

const DEFAULT_LIST = 'https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_all.m3u8';
// 参数解析要能容忍「flag 在前、URL 在后」：直接取 argv[2] 会把 --play 的值当 URL。
const RAW = process.argv.slice(2);
const flag = (name, def) => {
  const i = RAW.indexOf('--' + name);
  return (i >= 0 && RAW[i + 1] != null) ? RAW[i + 1] : def;
};
const LIST = RAW.find((a, i) => !a.startsWith('--') && !(i > 0 && RAW[i - 1].startsWith('--'))) || DEFAULT_LIST;
const PLAY_N = +flag('play', 6);
const CANDIDATES = +flag('probe', 30);   // 先在宿主上探这么多条，挑活的去播

mkdirSync(SHOTS, { recursive: true });

/* ---------- 通用 ---------- */
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}
function logcat(filter = 'YSPTV:V') {
  try { return adb('logcat', '-d', '-s', filter); } catch { return ''; }
}

let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra = '') {
  (cond ? pass++ : fail++);
  const line = `${cond ? '  \u2713' : '  \u2717'} ${name}${extra ? '   ' + extra : ''}`;
  console.log(line); lines.push(line);
}
function section(t) { reached.push(t); console.log(`\n${t}`); lines.push(`\n${t}`); }
function note(t) { console.log(`    · ${t}`); lines.push(`    · ${t}`); }
/* 章节台账。存在的理由很具体：这份脚本是**顺序执行、遇异常直接崩**的，
   中途 ReferenceError 时进程会在那一行退出，前面已经打过的 ✓ 全都留在屏幕上，
   结尾的汇总行却根本不会打印 —— 看上去就是「一大片绿 + 没报错」。
   C2 就真发生过一次（引用了上一个块里的 const），如果没有这张台账，
   这一轮就会被当成通过。所以收尾时强制核对每个章节都到过。 */
const reached = [];
const EXPECTED_SECTIONS = [
  'A. 清单本体', 'B. App 导入', 'C. 真播', 'C2. 镜像自动顺延', 'D. 收尾',
];

/* ---------- CDP ---------- */
let ws, seq = 0;
const pending = new Map();
async function cdpConnect() {
  let targets = null, lastErr = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(CDP + '/json');
      if (r.ok) { targets = await r.json(); break; }
      lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = String(e && e.message || e); }
    await sleep(500);
  }
  if (!targets) {
    console.error(`\n连不上 WebView 调试端口 ${CDP}（试了 20 次）：${lastErr}`);
    console.error('先把环境备好：bash tools/tv-emu.sh debug');
    process.exit(1);
  }
  const page = targets.find(t => t.type === 'page' && /android_asset/.test(t.url));
  if (!page) {
    console.error('找不到自定义源页 target。当前 targets:\n' +
      targets.map(t => `  ${t.type}  ${t.url}`).join('\n'));
    console.error('提示：先 am start com.ysptv.player/.CustomActivity，再重建转发。');
    process.exit(1);
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
}
function send(method, params = {}) {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  return res.result ? res.result.value : undefined;
}
async function json(expr) { const v = await ev(expr); return typeof v === 'string' ? JSON.parse(v) : v; }
async function key(code) { adb('shell', 'input', 'keyevent', String(code)); await sleep(DELAY); }
function shot(name) {
  const p = path.join(SHOTS, name + '.png');
  writeFileSync(p, execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 }));
  return p;
}

/* ---------- 清单解析（宿主侧，判「本体现在长什么样」） ---------- */
function parseList(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (/^#EXTINF/i.test(s)) { out.push({ inf: s }); continue; }
    if (s.startsWith('#')) continue;
    const last = out[out.length - 1];
    if (last && !last.url) last.url = s;
  }
  return out.filter(i => i.url).map(i => ({
    name: ((i.inf.match(/,(.+)$/) || [])[1] || '').trim(),
    group: ((i.inf.match(/group-title="([^"]*)"/) || [])[1] || '').trim(),
    url: i.url,
  }));
}

/* ---------- 宿主侧探活（只用来挑「值得去设备上试」的流） ---------- */
async function probeAlive(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: ac.signal,
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Accept: '*/*' },
    });
    if (!r.ok) return false;
    const b = await r.text();
    return /^#EXTM3U/i.test(b.trim());
  } catch { return false; } finally { clearTimeout(t); }
}

/* ============================================================ */
/* A. 清单本体                                                   */
/* ============================================================ */
section('A. 清单本体（离线，不碰设备）');

let text;
if (/^https?:\/\//i.test(LIST)) {
  const r = await fetch(LIST, { redirect: 'follow' });
  ok('清单能下载', r.ok, `HTTP ${r.status}`);
  text = await r.text();
} else {
  ok('本地清单存在', existsSync(LIST), LIST);
  text = readFileSync(LIST, 'utf8');
}
const items = parseList(text);
console.log(`    来源: ${LIST}`);
console.log(`    字节: ${Buffer.byteLength(text)}   条目: ${items.length}`);

ok('解析出条目', items.length > 0, `${items.length} 条`);
ok('条目数在 App 的 2000 条上限之内', items.length <= 2000,
  `${items.length} / 2000` + (items.length > 2000 ? '  ⚠️ 会被截断' : ''));
ok('全部条目都有 url', items.every(i => !!i.url), `${items.filter(i => !i.url).length} 条缺地址`);

const groups = [...new Set(items.map(i => i.group || '(无分组)'))];
console.log(`    分组(${groups.length}): ${groups.slice(0, 12).join(' / ')}${groups.length > 12 ? ' …' : ''}`);
ok('清单带 group-title 分组', groups.length >= 2, `${groups.length} 个组`);

const nameCount = {};
items.forEach(i => { const n = i.name || '(无名)'; nameCount[n] = (nameCount[n] || 0) + 1; });
const mirrors = Object.entries(nameCount).filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
console.log(`    频道名去重后 ${Object.keys(nameCount).length} 个；` +
  `${mirrors.length} 个台有多路镜像` + (mirrors.length ? `（最多 ${mirrors[0][0]}×${mirrors[0][1]}）` : ''));
ok('确认「一个台多路镜像」的结构', mirrors.length > 0,
  mirrors.slice(0, 5).map(([k, v]) => `${k}×${v}`).join('  ') || '（无镜像，说明是平铺列表）');

const urlSet = new Set(items.map(i => i.url));
const UNIQ = urlSet.size;               // App 按 url 去重，这才是「导入后应该有多少条」
console.log(`    地址去重后 ${UNIQ} 条（清单里有 ${items.length - UNIQ} 条是重复地址，App 会跳过）`);
ok('交叉检查：地址去重没有异常丢失', UNIQ > 0, `去重后 ${UNIQ} 条地址`);

/* ============================================================ */
/* B. 能不能吃进去（走局域网页这条真实通道）                      */
/* ============================================================ */
section('B. App 导入（走局域网页 /api/add，即用户真实走的那条路）');

// 确保自定义源页在前台
const fgBefore = sh(`"${ADB}" -s ${SERIAL} shell dumpsys window`).match(/mCurrentFocus=Window\{[^}]*\}/);
if (!/CustomActivity/.test(fgBefore ? fgBefore[0] : '')) {
  adb('shell', 'am', 'start', '-n', 'com.ysptv.player/.CustomActivity');
  await sleep(9000);
}
await cdpConnect();
// ⚠️ v1.9 新增：先把源管理浮层收掉再往下走。
//    1.9 之前 App 有内置示例源，开局永远不是零源，浮层不会自己开；
//    1.9 起零源时 CustomActivity.onPageReady() 会**自动打开源管理**
//    （把用户直接送到添加流程）。而本套件后面有两处硬前提会被它打破：
//      · 「面板已展开」—— 浮层开着时 .tv-main-con-r 是 display:none，
//        量到的 tab 条幅宽恒为 0，于是「必须横滚」和「选中项跟滚」全假失败；
//      · 「匿名死链不触发镜像顺延」—— CustomActivity 在浮层开着时【刻意】
//        不做顺延，日志里会出现「源管理浮层开着，跳过镜像顺延」。
//    C2 节自己也关了一次，但关得比这晚，前面几节已经受害。
await ev(`(function(){ __yspUI.closeManage(); return 1; })()`);
await sleep(700);
const mgAtStart = await json(`JSON.stringify(__yspUI.isManageOpen())`);
if (mgAtStart !== false) {
  console.log(`    ⚠️ 开局源管理浮层没收掉（isManageOpen=${mgAtStart}），后续几节会假失败`);
}
// ⚠️ 用 count()/urls()（直接读 SRC），不要用 labels() —— labels() 走的是面板行，
//    面板收起/自动隐藏时会变，断言会莫名其妙地飘。
const srcNow = await json(`JSON.stringify({n: __yspUI.count(), groups: __yspUI.groups()})`);
console.log(`    导入前：源 ${srcNow.n} 条，分组 ${JSON.stringify(srcNow.groups)}`);

// 开局域网服务，拿设备侧端口
await ev(`(function(){ __yspUI.rpc('lanStart'); return 1; })()`);
let lanUrl = '';
for (let i = 0; i < 24; i++) {
  await sleep(250);
  lanUrl = await ev('__yspUI.lanUrl()');
  if (/^http:\/\//.test(lanUrl || '')) break;
}
const mPort = (lanUrl || '').match(/:(\d+)\//);
ok('局域网导入服务已给出可访问地址', !!mPort, lanUrl || '(不是)');
if (!mPort) { console.log('\n没有局域网地址，后面的导入测不了，终止。'); process.exit(1); }
let devPort = +mPort[1];
const BASE = `http://127.0.0.1:${LAN_PORT}`;

/**
 * 重建 adb 转发，并在必要时重新问设备要一次局域网端口。
 *
 * ⚠️ 为什么需要：C 段「真播」要连着起播十几路流，跑几分钟。期间 adb forward
 *    可能被回收（设备侧 / adbd 重启），也可能是 CustomActivity 被系统重建后
 *    换了随机端口。原来 C2 直接沿用开头那个转发，于是 fetch 全是
 *    「TypeError: fetch failed」——看上去像 App 挂了，其实是本机转发断了。
 */
async function ensureForward() {
  sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:${LAN_PORT}`);
  adb('forward', `tcp:${LAN_PORT}`, `tcp:${devPort}`);
  const alive = await fetch(BASE + '/api/list', { cache: 'no-store' })
    .then(r => r.ok).catch(() => false);
  if (alive) return true;
  // 转发这条路不通 → 端口多半变了，重新问一次
  const u = await ev('__yspUI.lanUrl()');
  const m = (u || '').match(/:(\d+)\//);
  if (!m) return false;
  devPort = +m[1];
  sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:${LAN_PORT}`);
  adb('forward', `tcp:${LAN_PORT}`, `tcp:${devPort}`);
  return fetch(BASE + '/api/list', { cache: 'no-store' }).then(r => r.ok).catch(() => false);
}
const fwdOk = await ensureForward();
ok('本机 → 设备的端口转发可用（后面几节全靠它调 /api/*）', fwdOk,
  fwdOk ? `127.0.0.1:${LAN_PORT} → 设备:${devPort}` : '转发建不起来');

const page = await fetch(BASE + '/').then(r => r.text()).catch(e => '');
ok('导入页能打开', /<form|<!DOCTYPE/i.test(page), `${page.length} 字节`);

// 先清空，保证「导入了多少条」这个数干净
await fetch(BASE + '/api/clear', { method: 'POST' }).catch(() => {});
await sleep(800);
const afterClear = await json(`JSON.stringify({n: __yspUI.count()})`);
ok('清空生效（起点干净）', afterClear.n === 0, `剩 ${afterClear.n} 条`);

// 真·导入整份列表
const res = await fetch(BASE + '/api/add', {
  method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
}).then(r => r.json()).catch(e => ({ ok: false, msg: String(e) }));
ok('导入接口返回成功', res.ok === true, JSON.stringify(res).slice(0, 160));
await sleep(1500);

const after = await json(`JSON.stringify({
  n: __yspUI.count(),
  groups: __yspUI.groups(),
  urls: __yspUI.urls().length
})`);
ok('导入后源数量 == 地址去重后的条数', after.n === UNIQ,
  `${after.n} vs ${UNIQ}（清单 ${items.length} 条，重复 ${items.length - UNIQ} 条被 App 去重）`);
ok('地址条数也对得上', after.urls === UNIQ, `urls=${after.urls}`);

const wantGroups = groups.filter(g => g && g !== '(无分组)');
const gotGroups = after.groups.filter(g => g !== '全部');
const missing = wantGroups.filter(g => !gotGroups.includes(g));
ok('清单里的分组都变成了 tab', missing.length === 0,
  missing.length ? '缺: ' + missing.join(',') : `${gotGroups.length} 个 tab`);

// 分组 tab 溢出：真实清单有 10 个分组，tab 条幅只有面板宽（192px），
// 必然是横滚的。这里断言「选中项真的跟着滚进了可见区」——
// 少了这一步就是「tab 栏看着像冻住了」，用户不知道自己在第几组。
{
  // 量之前必须让面板是展开的：收起态下整块面板左移出屏，量出来的位置没意义
  await sleep(6500);                      // 等自动隐藏把面板收掉
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    adb('shell', 'input', 'keyevent', '23');   // OK（收起态下 = 弹面板）
    await sleep(700);
    opened = await ev('window.__yspTV.isPanelOpen()');
  }
  ok('面板已展开（否则量到的都不是用户看到的画面）', opened === true);

  const strip = await json(`(function(){
    var t = document.getElementById('yspTabs');
    var p = document.getElementById('yspPanel').getBoundingClientRect();
    return JSON.stringify({
      count: t.children.length,
      clientW: t.clientWidth, scrollW: t.scrollWidth,
      overflowX: getComputedStyle(t).overflowX,
      panel: {l: Math.round(p.left), r: Math.round(p.right)}
    });
  })()`);
  note(`tab 条幅：${strip.count} 个 tab，可视宽 ${strip.clientW}px，内容宽 ${strip.scrollW}px（需横滚）`);
  ok('分组多到必须横滚（这就是本用例的前提）', strip.scrollW > strip.clientW,
    `${strip.scrollW} > ${strip.clientW}`);
  ok('条幅本身允许横向滚动（CSS 没把它裁死）', strip.overflowX === 'auto' || strip.overflowX === 'scroll',
    `overflow-x: ${strip.overflowX}`);

  // 逐组切过去，每一组都断言「选中的 tab 落在面板可见 x 区间内」
  const total = strip.count;
  let offscreen = [];
  for (let n = 0; n < total - 1; n++) {
    await key(22);                        // RIGHT
    const st = await json(`(function(){
      var tabs = document.getElementById('yspTabs');
      var p = document.getElementById('yspPanel').getBoundingClientRect();
      var on = tabs.querySelector('.on');
      var b = on ? on.getBoundingClientRect() : null;
      return JSON.stringify({
        g: __yspUI.currentGroup(), gi: __yspUI.currentGroupIndex(),
        onText: on ? on.textContent : null,
        scrollLeft: Math.round(tabs.scrollLeft),
        inView: b ? (b.left >= p.left - 1 && b.right <= p.right + 1) : false
      });
    })()`);
    if (!st.inView) offscreen.push(`第${st.gi}组「${st.g}」`);
    if (n < 3 || n === total - 2) {
      note(`切到第 ${st.gi} 组「${st.g}」 选中 tab=「${st.onText}」 可见=${st.inView} scrollLeft=${st.scrollLeft}`);
    }
    ok(`第 ${st.gi} 组：选中 tab 滚进了可见区`, st.inView, `x 越界=${!st.inView}`);
    ok(`第 ${st.gi} 组：选中 tab 的文字 == 当前分组`, st.onText === st.g, `tab=「${st.onText}」group=「${st.g}」`);
  }
  ok('没有任何一个分组的选中 tab 被留在屏外（本用例的核心）', offscreen.length === 0,
    offscreen.length ? '被裁掉的: ' + offscreen.join(' ') : `${total} 个 tab 全都跟得上`);

  // 切到最后再切回来，scrollLeft 要能回到 0（不是单向卡死）
  const back0 = await json(`(function(){
    var t = document.getElementById('yspTabs');
    return JSON.stringify({sl: Math.round(t.scrollLeft)});
  })()`);
  note(`切到最后一组时 scrollLeft=${back0.sl}（>0 说明确实滚过去了）`);
  ok('切到后面的分组时条幅确实滚动了', back0.sl > 0, `scrollLeft=${back0.sl}`);
  shot('iptv_tabs_scrolled');            // 趁还在最后一组截图，能看见条幅确实滚过去了
  for (let n = 0; n < total - 1; n++) await key(21);   // LEFT 一路回第 0 组
  const home = await json(`(function(){
    var t = document.getElementById('yspTabs');
    var on = t.querySelector('.on');
    return JSON.stringify({sl: Math.round(t.scrollLeft), g: __yspUI.currentGroup(), onText: on?on.textContent:null});
  })()`);
  ok('切回第 0 组后条幅滚回最左', home.sl === 0 && home.onText === '全部',
    `scrollLeft=${home.sl} on=「${home.onText}」`);
}

// 2000 条上限：人造一份超长列表，确认是「截断」而不是「崩 / 卡死」
{
  let big = '#EXTM3U\n';
  for (let i = 0; i < 3000; i++) big += `#EXTINF:-1 group-title="压力测试",压测台${i}\nhttp://127.0.0.1:1/p${i}.m3u8\n`;
  const r2 = await fetch(BASE + '/api/clear', { method: 'POST' }).catch(() => {});
  await sleep(600);
  const t0 = Date.now();
  const r3 = await fetch(BASE + '/api/add', {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: big,
  }).then(r => r.json()).catch(e => ({ ok: false, msg: String(e) }));
  const dt = Date.now() - t0;
  await sleep(2500);
  const n3 = await json(`JSON.stringify({n: __yspUI.count()})`);
  ok('3000 条压力导入不报错、不卡死', r3.ok === true, `${dt}ms  ${JSON.stringify(r3).slice(0, 120)}`);
  ok('超过 2000 条时被上限截断（不是无限吃）', n3.n <= 2000 && n3.n >= 1900,
    `落库 ${n3.n} 条（上限 2000）`);
  note(`截断行为：清单 ${3000} 条 → 落库 ${n3.n} 条，耗时 ${dt}ms`);
}

/* ============================================================ */
/* C. 真播                                                       */
/* ============================================================ */
section('C. 真播（框架 MediaPlayer 能不能吃这份清单里的流）');

// 重新导入正式列表
await fetch(BASE + '/api/clear', { method: 'POST' }).catch(() => {});
await sleep(600);
await fetch(BASE + '/api/add', {
  method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
}).catch(() => {});
await sleep(1500);

// 宿主侧先探活，挑出「本来就该能播」的流 —— 不然测的就是网络而不是播放器
const cand = items.slice(0, CANDIDATES);
console.log(`    先在宿主上探活前 ${cand.length} 条，挑活的去设备上试…`);
const alive = [];
let cur = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cur < cand.length) {
    const i = cur++;
    if (await probeAlive(cand[i].url)) alive.push(cand[i]);
  }
}));
console.log(`    宿主侧探活结果：${alive.length}/${cand.length} 条拿到合法 HLS 清单`);
ok('宿主侧至少有 3 条可用（否则网络问题，不是播放器问题）', alive.length >= 3, `${alive.length} 条`);
if (alive.length < 3) { console.log('\n网络侧不通，C 段跳过。'); }

const pristine = await json(`JSON.stringify({groups:__yspUI.groups(), n:__yspUI.count()})`);
ok('整份列表已就位，准备开播', pristine.n === UNIQ, `${pristine.n} 条（去重后应为 ${UNIQ}）`);

/** 把 URL 的主机名抠出来 —— 真播失败时要一眼看出是哪一家 CDN，别只印个台名 */
const hostOf = (u) => (String(u).match(/^https?:\/\/([^/]+)/) || [, '?'])[1];
const played = [];

/* ⚠️ 曾经在这里按「裸 IP」筛过一轮（理由是「运营商网内地址、模拟器 NAT 到不了」），
   后来被数据打回来了，记下来免得有人再走一遍：
     120.198.95.220:9901 这条主机上，CCTV1 **出画了**、CCTV2 起不来 ——
   同一个 host:port，一好一坏，说明「到不了」这个假设不成立；
   而那一轮按裸 IP 筛完，候选从 6 条掉到 1 条，等于把用例测没了。
   结论：**不许按地址形态预先免检**，只按「当场到底播没播出来」判定。 */
/** 试播一条：返回 'ok' / 失败原因。抽成函数是为了下面能「失败后重试一次」。 */
async function tryPlay(it) {
  adb('logcat', '-c');
  await ev(`(function(){ __yspUI.rpc('pick', ${JSON.stringify(it.url)}); return 1; })()`);
  const t0 = Date.now();
  let verdict = '20 秒内既没起播也没报错（卡住）';
  let started = 0;
  while (Date.now() - t0 < 20000) {
    await sleep(500);
    const lg = logcat();
    if (/播放失败/.test(lg)) { verdict = '播放失败'; break; }
    if (/起播成功/.test(lg)) {
      if (!started) started = Date.now();
      else if (Date.now() - started > 4000) { verdict = 'ok'; break; }
    }
  }
  return verdict;
}

for (const it of alive.slice(0, PLAY_N)) {
  let verdict = await tryPlay(it);
  let retried = false;
  // 只重试一次，而且**要说出来**：这份清单的流来自各家电视频道 CDN，
  // 模拟器走 SLIRP NAT，偶发半路超时是常事，而本用例要判的是
  // 「App 的播放器能不能吃这些流」，不是「这一秒网络好不好」。
  // 重试仍失败才算 App 侧问题 —— 那时 verdict 里会带上主机名，便于归因。
  if (verdict !== 'ok') {
    retried = true;
    console.log(`      ↻ ${it.name} ${verdict} —— 重试一次（主机 ${hostOf(it.url)}）`);
    verdict = await tryPlay(it);
  }
  const isOk = verdict === 'ok';
  played.push({ ...it, verdict, retried });
  console.log(`    ${isOk ? '▶ 出画' : '✗ 失败'}  ${it.name}  ${it.group}  — ${verdict}`
    + (isOk && retried ? '（重试后成功）' : '')
    + (isOk ? '' : `  [${hostOf(it.url)}]`));
}
const okCount = played.filter(p => p.verdict === 'ok').length;
const retriedN = played.filter(p => p.retried).length;
ok(`设备端真播成功率（宿主侧已探活，失败会重试一次）`, okCount === played.length,
  `${okCount}/${played.length}`
  + (retriedN ? `（其中 ${retriedN} 条重试过一次）` : '')
  + (okCount === played.length ? '' : '  ⚠️ 重试后仍不通 = App 侧问题（方括号里是流的主机）'));

/* ---- 「挑一条已知能出画的地址」：§18 的播放器守卫和 C2 的镜像顺延都要用它 ----
   所以提在顶层算一次。起因：这段原本写在 §18 那个 { } 块里，C2 引用它就 ReferenceError，
   整个进程崩在 C2 上 —— 而崩的样子是「前面全绿、C2 一行没跑」，最容易被误读成通过。

   ⚠️ 不能用 `alive[0]`（宿主侧探活的第一条）：那是**错的**。
      「宿主能拿到清单」不等于「设备能播出画面」。实测就踩到了 ——
      alive[0] 正好是那条裸 IP 的流，设备本来播不了，
      于是守卫连着三次报「换回可用源仍然起不来」，看着像 §18 回归了，
      其实是守卫自己挑了一条播不了的源。
      要测「播放器有没有被毒死」，回退目标必须是**设备上确认出过画**的那一条。

   ⚠️ 还必须是**这一次、没有重试就出画**的那一条，而且挑**最近的一条**。踩过两次：
      ① 挑中 CCTV2 —— 它第一轮是靠重试才出画的，回退又起不来 → 守卫报红。
      ② 挑中 CCTV-1 (720p) —— 一次就出画，但那是两分钟前的事；
         这类聚合清单里的地址大多带**会过期的 token／防盗链参数**，放一会儿就 403 了。
         用「早先能播」的地址去证明「现在播放器也没坏」同样不成立。
   手工复验（播 A → 播死链 → 立刻回退 A）是全部出画的，说明播放器没被毒死。
   所以：取 ok 里**最后一条**（token 最新）。 */
const back = played.filter(p => p.verdict === 'ok' && !p.retried).pop()
          || played.filter(p => p.verdict === 'ok').pop();

if (okCount > 0) {
  const p = shot('iptv_playing');
  const st = sh(`ffmpeg -loglevel error -i "${p}" -vf "crop=1200:600:360:240,signalstats,metadata=print:file=-" -f null -`);
  const g = k => { const m = st.match(new RegExp('signalstats\\.' + k + '=([\\d.]+)')); return m ? +m[1] : null; };
  ok('截图确认画面非黑屏/非纯色', (g('YAVG') || 0) > 40 && (g('YMAX') - g('YMIN')) > 60,
    `YAVG=${g('YAVG')}  YMAX-YMIN=${g('YMAX') - g('YMIN')}  图=${p}`);
}

// 死链路径：播放器必须扛得住，界面要打标记，而且还能接着换台
{
  // ⚠️ 别用 10.255.255.1 这类黑洞地址：Linux 的 SYN 重传要一两分钟才放弃，
  //    15 秒的起播看门狗虽然会兜底，但取样窗口一不留神就过了 → 用例本身变成抛硬币。
  //    改成设备本机的 1 端口：立刻 ECONNREFUSED，判定是确定的。
  //    （真机上这一条同样成立 —— 本机没人监听 1 端口。）
  const dead = 'http://127.0.0.1:1/dead-iptv-test.m3u8';
  const addRes = await fetch(BASE + '/api/add', {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: dead,
  }).then(r => r.json()).catch(e => ({ ok: false, msg: String(e) }));
  await sleep(1000);
  const urls = await json(`JSON.stringify(__yspUI.urls())`);
  // pick() 是拿 url 反查当前源列表的；不在表里会静默不播 —— 那会让本用例假通过
  ok('死链源确实进了列表（否则 pick 会静默无动作）', urls.includes(dead),
    `add=${JSON.stringify(addRes).slice(0, 130)}`);

  adb('logcat', '-c');
  await ev(`(function(){ __yspUI.rpc('pick', ${JSON.stringify(dead)}); return 1; })()`);
  let sawFail = false, lastLog = '';
  for (let i = 0; i < 60; i++) {              // 最多 30 秒：15s 看门狗 + 余量
    await sleep(500);
    lastLog = logcat();
    if (/播放失败/.test(lastLog)) { sawFail = true; break; }
  }
  ok('连不上的源会被判失败（不是无声卡死）', sawFail,
    sawFail ? lastLog.split('\n').filter(l => /播放失败/.test(l)).pop().trim()
            : '30 秒内没有失败记录；最后的日志: ' + (lastLog.trim().split('\n').pop() || '(空)'));
  const bads = await json(`JSON.stringify(__yspUI.badUrls())`);
  ok('失败的源在界面上被打了标记', bads.includes(dead), `badUrls=${bads.length} 条`);

  // v1.4 加了「镜像自动顺延」之后，这条死链必须【仍然】一路都不试就报失败。
  // 理由是它没有台名（POST /api/add 裸地址、名字为 null），而 Mirrors 的规则是
  // 「没有台名的源不参与镜像分组」——否则所有匿名源会因为 key 都是 "" 而被当成
  // 同一个台，顺延时把互不相干的地址当镜像，用户点 A 会播出 B。
  // 这条要是破了，下面那个 §18 守卫也就没意义了：它会顺延到某个同名台上去，
  // 「换回可用源还能播」就不再是在验证播放器有没有被毒死。
  {
    const hops = lastLog.split('\n').filter(l => /镜像顺延/.test(l));
    ok('匿名死链不触发镜像顺延（没台名就不做同台假设）', hops.length === 0,
      hops.length ? hops.slice(-2).join(' | ') : '（本窗口内无顺延记录）');
  }

  // 播放器有没有被这条死链带坏 —— 换回一条活的必须还能播
  // （回退目标 `back` 怎么挑、为什么这么挑，见它定义处的长注释，§18 和 C2 共用同一条）
  if (back) {
    console.log(`    · 死链回退目标：${back.name}（本次${back.retried ? '靠重试' : '一次就'}出画，`
      + `列表里第 ${played.indexOf(back) + 1} 条 → 取最近的一条，token 最新）`);
    adb('logcat', '-c');
    await ev(`(function(){ __yspUI.rpc('pick', ${JSON.stringify(back.url)}); return 1; })()`);
    let recovered = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) { await sleep(500); if (/起播成功/.test(logcat())) { recovered = true; break; } }
    ok('死链之后还能正常起播（播放器没被毒死，§18 的守卫在这份真实清单上也成立）',
      recovered, recovered ? '' : `换回 ${back.name} 仍然起不来`);
  } else {
    note('这一轮没有任何一条设备上出过画，死链回退用例跳过（否则等于拿一条播不了的源去证明播放器没坏）');
  }
  // 清掉这条人为的死链，别留在列表里（它已经不是正在播的那条，del 允许）
  await ev(`(function(){ __yspUI.rpc('del', ${JSON.stringify(dead)}); return 1; })()`);
  await sleep(600);
}

/* ============================================================ */
/* C2. 镜像自动顺延：拿真清单的真地址再验一次                      */
/* ============================================================ */
{
  section('C2. 镜像自动顺延（真清单的真地址）');
  // 做法：把一条**本次已经出过画**的地址的台名，原样抄给一条确定不通的地址，
  // 人为造出「同一个台、第一路是死的」。然后点那条死的。
  //
  // ⚠️ 三个坑，都踩过或想清楚了才敢这么写：
  //   ① 台名必须**抄** back.name，不能另外编一个。编个新台名的话这一族只有它
  //      自己、没有兄弟可顺延，用例会因为「本来就没得试」而假通过。
  //   ② 不能直接引用 back.url 本身当第 2 路：SourceStore.merge 按 URL 去重，
  //      同一条地址加第二次会被当重复直接跳过，结果还是一个单路台。
  //   ③ 这里只断言「发生了顺延」，不断言顺延到哪一条 —— 真清单里 CCTV-1 一族
  //      有 6 路，挑中的是清单顺序上第一条没试过的，不一定是 back。
  //      硬断言具体目标就是把用例绑死在清单内容上。
  if (!back) {
    note('这一轮没有任何一条已知能出画的地址，C2 跳过（顺延的落点没法有意义）');
  } else {
    // C 段真播跑了几分钟，开头那条 adb 转发大概率已经失效 —— 先修好再动手，
    // 否则下面这次 /api/add 会返回 fetch failed，用例会以「App 坏了」的面貌失败。
    ok('C2 开局端口转发仍然是通的', await ensureForward());
    // ⚠️ 前置：源管理浮层必须是收着的。CustomActivity 在浮层开着时【刻意】不做顺延
    //    （那是「我要接管」的信号）。本套件全程不开浮层，但开局如果一条源都没有，
    //    CustomActivity.onPageReady() 会自己把浮层打开 —— 那种情况下这一节会假失败。
    await ev(`(function(){ __yspUI.closeManage(); return 1; })()`);
    await sleep(600);
    const mgOpen = await json(`JSON.stringify(__yspUI.isManageOpen())`);
    ok('前置：源管理浮层已收起（浮层开着时设计上就不顺延）', mgOpen === false, `isManageOpen=${mgOpen}`);

    const mirDead = 'http://127.0.0.1:1/mirror-real-back.m3u8';
    const body = '#EXTM3U\n#EXTINF:-1,' + back.name + '\n' + mirDead + '\n';
    const r = await fetch(BASE + '/api/add', {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body,
    }).then(x => x.json()).catch(e => ({ ok: false, msg: String(e) }));
    await sleep(1000);
    const mirUrls = await json(`JSON.stringify(__yspUI.urls())`);
    ok('人造的镜像源进了列表（台名与 back 同族）', mirUrls.includes(mirDead),
      `back.name=${JSON.stringify(back.name)}  add=${JSON.stringify(r).slice(0, 100)}`);

    adb('logcat', '-c');
    await ev(`(function(){ __yspUI.rpc('pick', ${JSON.stringify(mirDead)}); return 1; })()`);
    let lg = '';
    const tm = Date.now();
    while (Date.now() - tm < 25000) { await sleep(500); lg = logcat(); if (/镜像顺延/.test(lg)) break; }
    const hops = lg.split('\n').filter(l => /镜像顺延/.test(l));
    ok('同一台的第 1 路不通 → 自动顺延到别的路（真清单的真地址上成立）',
      hops.length > 0,
      hops.length ? hops[hops.length - 1].replace(/^.*?YSPTV\s*:\s*/, '').trim()
                  : '25 秒内没有出现顺延记录');

    await ev(`(function(){ __yspUI.rpc('del', ${JSON.stringify(mirDead)}); return 1; })()`);
    await sleep(600);
  }
}

/* ============================================================ */
/* D. 收尾：清空测试源（v1.9 起 App 不再内置示例源）             */
/* ============================================================ */
section('D. 收尾');
// 同C2：清空前先把转发修好，否则 /api/clear 静默失败、最后一条断言必然假红。
ok('收尾：端口转发仍然通（否则清空那一步等于没做）', await ensureForward());
const cleared = await fetch(BASE + '/api/clear', { method: 'POST' })
  .then(r => r.json()).catch(e => ({ ok: false, msg: String(e) }));
ok('清空接口调用成功', cleared.ok === true, JSON.stringify(cleared).slice(0, 100));
await sleep(600);
// v1.9：这里原来调 rpc('seeds') 把内置示例源塞回来当"还原成常规状态"。
// 那个桥已经删掉了（产品里不再有示例源），再调只会走进 runMenu 的 default 分支。
// 现在的还原态就是"零源" —— 而这恰恰是一条该被断言的事实：
// 清空之后不该有任何东西自动填回来。
await sleep(1200);
const seedRestore = await json(`JSON.stringify({n: __yspUI.count(), groups: __yspUI.groups()})`);
ok('收尾：清空后停在零源（v1.9 没有示例源会被自动填回来）',
  seedRestore.n === 0,
  `${seedRestore.n} 条 ${JSON.stringify(seedRestore.groups)}`);
sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:${LAN_PORT}`);

/* 台账核对：这一条必须放在所有 ok() 之后、汇总之前 —— 见 EXPECTED_SECTIONS 处的说明。 */
{
  const missing = EXPECTED_SECTIONS.filter(p => !reached.some(s => s.startsWith(p)));
  ok('每个章节都真的跑到了（脚本半路崩掉时，前面的绿不算数）',
    missing.length === 0,
    missing.length ? `没跑到：${missing.join('、')}（实际到过 ${reached.length} 个章节）`
                   : `已到 ${reached.length} 个章节`);
}

/* ============================================================ */
console.log(`\n${'='.repeat(58)}`);
console.log(`  TCP 真实列表验证：通过 ${pass} / ${pass + fail}`);
if (fail) console.log(`  失败 ${fail}`);
console.log('='.repeat(58));
writeFileSync(path.join(SHOTS, 'iptv_realworld_result.txt'), lines.join('\n') + '\n');
writeFileSync('/tmp/iptv_realworld_played.json', JSON.stringify({ items: items.length, groups, played }, null, 1));
process.exit(fail ? 1 : 0);
