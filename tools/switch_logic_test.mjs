#!/usr/bin/env node
/* ============================================================
   v1.13 换台手感优化 —— 逻辑级验证（不需要设备）

   为什么要有这个：设备端套件（switch_debounce / switch_throttle）要一台
   电视或模拟器，而"改完立刻知道有没有把逻辑写坏"这件事不该等设备。
   这里用一份极简 DOM 桩把 inject.js 真跑起来，盯的是【状态机】而不是像素：

     ① 单按一次：气泡立刻出新台名；250ms 内站点一次都没被碰；到点只碰一次
     ② 连按 5 次：光标跟到底，按键期间站点零次被碰；停手只发一车、直达末台
     ③ 阀门提前解锁：站点一出画（且过硬下限）就发，不等满 1.5s
     ④ 提前解锁兜底：一直判不出就绪 → 到点照发，不会死等
     ⑤ 按回当前台：撤单 + 撤防抖，站点零次被碰
     ⑥ 一次按键只算一次 rows()（早先是 4 次，每遍一次强制重排）
     ⑦ 收起态不写光标 class（面板在屏幕外，画了也看不见）
     ⑧ 换台气泡守到出画才撤

   跑法：node tools/switch_logic_test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const results = [];
const ok = (n, c, d = '') => { results.push({ n, ok: !!c, d });
  console.log(`  ${c ? '✓' : '✗'} ${n}${d ? '   — ' + d : ''}`); };

/* ================= 极简 DOM 桩 ================= */
let elSeq = 0;
function mkClassList() {
  const s = new Set();
  return { add: (...c) => c.forEach(x => s.add(x)),
           remove: (...c) => c.forEach(x => s.delete(x)),
           contains: c => s.has(c) };
}
function mkEl(tag) {
  const el = {
    tagName: tag, id: '', children: [], parentNode: null,
    style: { setProperty() {} }, innerText: '', textContent: '',
    className: '', classList: mkClassList(), _attrs: {},
    listeners: {}, dispatched: [],
    clientHeight: 300, scrollTop: 0, scrollHeight: 420,
    _visible: true, rectCalls: 0,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; },
    querySelector() { return null; },
    getBoundingClientRect() { this.rectCalls++; return { top: 0, left: 0, right: 120, bottom: 20, width: 120, height: 20 }; },
    addEventListener() {}, dispatchEvent(ev) { this.dispatched.push(ev.type); return true; },
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    get offsetParent() { return this._visible ? this.parentNode : null; }
  };
  return el;
}

/* 站点频道列表：40 行，第 5 行带 tvSelect（= 正在播放） */
const NROWS = 40, PLAYING0 = 5;
const rows = [];
for (let i = 0; i < NROWS; i++) {
  const r = mkEl('div');
  r.innerText = '频道' + String(i).padStart(2, '0');
  if (i === PLAYING0) r.classList.add('tvSelect');
  rows.push(r);
}
/* 站点行为仿真：谁被 click，tvSelect 就挪到谁身上 */
rows.forEach(r => {
  const raw = r.dispatchEvent;
  r.dispatchEvent = ev => {
    const out = raw.call(r, ev);
    if (ev.type === 'click') {
      rows.forEach(x => x.classList.remove('tvSelect'));
      r.classList.add('tvSelect');
    }
    return out;
  };
});

const list = mkEl('div');           // .tv-main-con-r-list-left
list.children = rows.slice();
rows.forEach(r => { r.parentNode = list; });

const root = mkEl('div');           // .tv-main-con
const panel = mkEl('div');          // .tv-main-con-r
const panelList = mkEl('div');      // .tv-main-con-r-list
panel.children = [panelList]; panelList.parentNode = panel;

const video = mkEl('video');        // .tv-main-con-l video —— 默认"没出画"
Object.assign(video, { readyState: 0, networkState: 0, paused: true, currentTime: 0, videoWidth: 0 });

let toastEl = null;
const documentStub = {
  documentElement: mkEl('html'),
  body: mkEl('body'),
  addEventListener() {},
  createElement: mkEl,
  getElementById(id) { return id === 'ysp-toast' ? toastEl : null; },
  querySelector(sel) {
    if (sel === '.tv-main-con-r-list-left') return list;
    if (sel === '.tv-main-con') return root;
    if (sel === '.tv-main-con-r') return panel;
    if (sel === '.tv-main-con-l video') return video;
    if (sel === '#app') return null;
    return null;
  },
  querySelectorAll() { return []; }
};
/* 站点把 toast 挂到 body 上 */
documentStub.body.appendChild = c => { c.parentNode = documentStub.body; if (c.id === 'ysp-toast') toastEl = c; return c; };

class MutationObserverStub { observe() {} disconnect() {} }
class MouseEventStub { constructor(type, o) { this.type = type; this.bubbles = o && o.bubbles; } }

const windowStub = { addEventListener() {} };
const sandbox = {
  window: windowStub, document: documentStub,
  navigator: { maxTouchPoints: 0 },
  localStorage: { getItem: () => null, setItem() {} },
  MutationObserver: MutationObserverStub, MouseEvent: MouseEventStub,
  console
};

const src = readFileSync(path.join(ROOT, 'tools', 'inject.js'), 'utf8');
new Function('window', 'document', 'navigator', 'localStorage',
             'MutationObserver', 'MouseEvent', 'console', src)
  .call(sandbox, ...['window', 'document', 'navigator', 'localStorage',
                     'MutationObserver', 'MouseEvent', 'console'].map(k => sandbox[k]));

const T = windowStub.__yspTV;
if (!T) { console.error('✗ __yspTV 没装上'); process.exit(1); }

/* 站点被碰了几次 = 频道行上派生的 mousedown/mouseup/click 总数 */
const siteTouches = () => rows.reduce((n, r) => n + r.dispatched.length, 0);
const focusRow = () => { const i = rows.findIndex(r => r.classList.contains('ysp-focus')); return i; };
const toastShown = () => !!(toastEl && toastEl.classList.contains('show'));
const toastText = () => (toastEl && toastEl.textContent) || '';
const settle = () => Object.assign(video,
  { readyState: 4, networkState: 1, paused: false, currentTime: 3.5, videoWidth: 1920 });
const unsettle = () => Object.assign(video,
  { readyState: 0, networkState: 0, paused: true, currentTime: 0, videoWidth: 0 });

/* ================= 开跑 ================= */
(async () => {
  console.log('\n=== v1.13 换台手感（逻辑级） ===\n');
  console.log(`  频道 ${T.count()} 个，起点 playing=${T.playing()} idx=${T.index()}\n`);

  /* ---- ⑦ 收起态不写光标 class（趁 1.5s 的 boot 重试还没来）---- */
  const f0 = focusRow();
  T.move(1);
  await sleep(60);
  ok('⑦ 收起态 move() 不写光标 class（面板在屏幕外，画了也看不见）',
    focusRow() === f0, `focus ${f0} → ${focusRow()}`);

  /* ---- ⑥ 一次按键只算一次 rows() ---- */
  const before = rows.reduce((n, r) => n + r.rectCalls, 0);
  T.move(1);
  await sleep(30);
  const after = rows.reduce((n, r) => n + r.rectCalls, 0);
  ok('⑥ 一次 move() 只算一次 rows()（=40 次量行，早先是 4 遍=160 次）',
    after - before === NROWS, `本次量行 ${after - before} 次，期望 ${NROWS}`);

  /* ---- ① 单按一次 ---- */
  await sleep(2600);                       // 等阀门干净
  unsettle();
  const t0 = siteTouches();
  T.move(1);
  ok('① 气泡立刻出新台名（按键不等画面）',
    toastShown() && toastText() === '频道' + String(T.index()).padStart(2, '0'),
    `toast=${JSON.stringify(toastText())} idx=${T.index()}`);
  await sleep(200);
  ok('① 250ms 防抖窗口内站点一次都没被碰', siteTouches() === t0, `触碰 ${siteTouches() - t0} 次`);
  await sleep(500);
  ok('① 窗口过后只碰一次，且落在目标台',
    siteTouches() - t0 === 3 && T.playing() === T.index(),
    `触碰 ${siteTouches() - t0} 次（mousedown/mouseup/click），playing=${T.playing()}`);

  /* ---- ⑧ 气泡守到出画 ---- */
  ok('⑧ 出画前气泡不撤（早先 1.6s 就没了，画面要 1.3–1.6s）',
    toastShown(), `show=${toastShown()}`);
  settle();
  await sleep(1400);
  ok('⑧ 一出画气泡就撤（留 900ms 看清台名）', !toastShown(), `show=${toastShown()}`);

  /* ---- ⑧-b 页面上没有 <video>（自定义源页复用 inject.js，那边是原生播放器）---- */
  const realQS = documentStub.querySelector.bind(documentStub);
  documentStub.querySelector = sel => (sel === '.tv-main-con-l video') ? null : realQS(sel);
  T.move(1);
  await sleep(1900);
  ok('⑧ 没有 <video> 的页面：气泡按 1.6s 正常节奏撤，不白等 6 秒',
    !toastShown(), `show=${toastShown()}`);
  documentStub.querySelector = realQS;

  /* ---- ② 连按 5 次 ---- */
  await sleep(2600);
  unsettle();
  const b2 = siteTouches();
  const from = T.playing();
  for (let i = 0; i < 5; i++) { T.move(1); await sleep(110); }
  ok('② 连按 5 次：光标跟到底（+5）', T.index() === from + 5, `idx=${T.index()} 期望 ${from + 5}`);
  ok('② 连按 5 次：按键期间站点零次被碰', siteTouches() === b2, `触碰 ${siteTouches() - b2} 次`);
  await sleep(700);
  ok('② 停手后只发一车、直达末台',
    siteTouches() - b2 === 3 && T.playing() === from + 5,
    `触碰 ${siteTouches() - b2} 次，playing=${T.playing()} 期望 ${from + 5}`);

  /* ---- ③ 阀门提前解锁 ---- */
  await sleep(2600);
  unsettle();
  const b3 = siteTouches();
  T.move(1);                                // 立刻发车（阀门干净），阀门压上
  await sleep(400);
  T.move(1);                                // 排队：等防抖窗口过去车才真进阀门
  let armedAt = null, deadlineAt = null;
  for (let k = 0; k < 20; k++) {
    await sleep(40);
    if (T.switchPending() >= 0) {
      armedAt = Date.now();
      deadlineAt = armedAt + T.switchGateLeft();   // 老逻辑会一直傻等到这一刻
      break;
    }
  }
  await sleep(600);                         // 累计已过硬下限(900ms)
  settle();                                 // 站点"出画"了
  let unlocked = null;
  for (let k = 0; k < 60; k++) {
    await sleep(50);
    if (siteTouches() > b3 + 3) { unlocked = Date.now(); break; }
  }
  ok('③ 阀门提前解锁：一出画（且过硬下限）就发，不必傻等到点',
    unlocked !== null && unlocked < deadlineAt - 50 && unlocked >= armedAt + 800,
    `排队后 ${unlocked - armedAt}ms 发出（硬下限 900ms，阀门还剩 ${deadlineAt - armedAt}ms）`);
  await sleep(2600);

  /* ---- ④ 提前解锁兜底 ---- */
  unsettle();
  const b4 = siteTouches();
  T.move(1);
  await sleep(400);
  T.move(1);                                // 排队，但这次永远不settle
  let armed4 = null, deadline4 = null;
  for (let k = 0; k < 20; k++) {
    await sleep(40);
    if (T.switchPending() >= 0) {
      armed4 = Date.now();
      deadline4 = armed4 + T.switchGateLeft();
      break;
    }
  }
  let fell = null;
  for (let k = 0; k < 80; k++) {
    await sleep(50);
    if (siteTouches() > b4 + 3) { fell = Date.now(); break; }
  }
  ok('④ 兜底：一直判不出就绪 → 老老实实到点才发，不会提前也不会死等',
    fell !== null && fell >= deadline4 - 120 && fell < deadline4 + 600,
    `排队后 ${fell - armed4}ms 发出（阀门 ${deadline4 - armed4}ms）`);
  await sleep(2600);

  /* ---- ⑤ 按回当前台 ---- */
  settle();
  await sleep(400);
  const b5 = siteTouches();
  const cur5 = T.playing();
  T.move(-1);
  await sleep(80);
  T.move(1);                                // 又按回正在播的那一台
  await sleep(700);
  ok('⑤ 按回当前台：撤单 + 撤防抖，站点零次被碰',
    siteTouches() === b5 && T.playing() === cur5,
    `触碰 ${siteTouches() - b5} 次，playing ${cur5} → ${T.playing()}`);

  /* ================= 汇总 ================= */
  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.ok).length;
  console.log(`  ${pass} 过 / ${results.length - pass} 失败`);
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.n}   — ${r.d}`));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试崩了:', e); process.exit(1); });
