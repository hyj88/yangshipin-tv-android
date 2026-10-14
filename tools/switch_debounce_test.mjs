#!/usr/bin/env node
/* ============================================================
   v1.12 换台防抖的直接验证

   不依赖 switch_throttle_test 的那套起点假设（那一版对
   「playing 起点是第0 台」有隐含前提，换台兜底逻辑会让它失效）。
   这里从页面里直接读状态，验三件事：
     ① 连按 N 次：光标跟到底，站点【一次都没被碰】
     ② 停手后：落到最后一台
     ③ 单按一次：防抖窗口过后就换（窗口多长能量出来）
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = 9222;
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a],
  { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

let ws, seq = 0; const pend = new Map();
const l = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/json`)).text()))
  .filter(t => t.type === 'page')[0];
ws = new WebSocket(l.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const ev = expr => {
  const id = ++seq;
  return new Promise(res => {
    pend.set(id, m => res(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
};
const snap = () => ev('JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),pend:__yspTV.switchPending(),deb:__yspTV.switchDebounce()})').then(JSON.parse);
const key = k => adb('shell', 'input', 'keyevent', k);

/* ⚠️ 走 __yspTV.move() 而不是 adb input keyevent：
     站点的 WASM 播放器在起播后会抢走键盘焦点，后续的 DPAD 事件被它吃掉 ——
     表现为「只有第一按被收到，idx 停在 1」。那是站点的行为，不是被测代码的行为，
     拿它当断言会得到一堆与防抖无关的假失败。
     MainActivity 那边就是 keyevent → __yspTV.move(d) 这么转的，
     所以直接调 move() 验的是同一条逻辑，只是不经过焦点这一层。*/
const move = d => ev(`__yspTV.move(${d})`);

const results = [];
const ok = (n, c, d = '') => { results.push({ n, ok: !!c, d });
  console.log(`  ${c ? '✓' : '✗'} ${n}${d ? '   — ' + d : ''}`); };

console.log('\n=== v1.12 换台防抖 ===\n');
const n = await ev('__yspTV.count()');
console.log(`  站点频道数 ${n}，防抖窗口 ${await ev('__yspTV.switchDebounce()')}ms\n`);

// 先关掉阀门：只看防抖这一层的效果
await ev('__yspTV.setSwitchGap(0)');
await sleep(300);
await ev('__yspTV.closePanel()');
await sleep(500);

/* ⚠️ 必须自己把光标归位：这个套件常紧跟在 switch_throttle_test 后面跑，
   而那个会把光标推到二十几台（它自己的用例就是这么设计的）。
   起点不是第 0 台的话，「连按 5 次 = idx+5」这类断言全部对不上 ——
   看起来像防抖坏了，其实是被前一个套件留下的状态污染了。 */
await ev('__yspTV.closePanel()');
await ev('__yspTV.setSwitchGap(0)');      // 别让阀门把回位吃掉
await ev('__yspTV.move(-9999)');          // 大跨度回顶（面板收起时落到首台）
await sleep(1800);                       // 等它真的发车并落定
await ev('__yspTV.move(0)');              // move(0) 是空操作，但会确保 idx 被刷新
await sleep(300);
let s0 = await snap();
ok('起点：面板收起、光标在第 0 台', s0.idx === 0, JSON.stringify(s0));

/* ---- ① 连按 5 次：光标跟到底，站点一次都不被碰 ---- */
const t0 = Date.now();
for (let i = 0; i < 5; i++) { await move(1); await sleep(110); }
const mid = await snap();
ok('连按 5 次：光标全部跟上（+5）', mid.idx === 5, `idx=${mid.idx} 期望 5`);
ok('连按 5 次：按键期间站点一次都没被惊动（playing 原地不动）',
  mid.playing === s0.playing, `playing=${mid.playing} 起点 ${s0.playing}`);

/* ---- ② 停手后落到最后一台 ---- */
await sleep(600);
const debounced = await snap();
ok('停手 ~600ms 后站点才动，且直接落到最后一台（idx=5）',
  debounced.playing === 5, `playing=${debounced.playing} 期望 5`);

/* ---- ③ 单按一次：防抖窗口过后就换，且延迟≈窗口而不是更大 ---- */
await sleep(2200);                    // 等阀门（这里关着，所以没影响）
await ev('__yspTV.setSwitchGap(1500)');
await sleep(1800);
const s1 = await snap();
const t1 = Date.now();
await move(1);
let elapsed = -1;
for (let k = 0; k < 30; k++) {
  await sleep(80);
  const st = await snap();
  if (st.playing !== s1.playing) { elapsed = Date.now() - t1; break; }
}
const debMs = await ev('__yspTV.switchDebounce()');
ok('单按一次：延迟≈防抖窗口（不会像固定 1 秒那样拖长）',
  elapsed > 0 && elapsed < debMs + 1200,
  `实测 ${elapsed}ms，防抖 ${debMs}ms`);

/* ---- ④ 按回当前台：应撤单，不换 ---- */
await sleep(2200);
const s2 = await snap();
await move(-1);                         // UP → 往回
await sleep(80);
await move(1);                          // 又 DOWN → 按回当前正在播的那台
await sleep(1500);
const s3 = await snap();
ok('连按「回退再前进」回到当前台：站点没被换走',
  s3.playing === s2.playing, `playing ${s2.playing} → ${s3.playing}`);

console.log('\n=== 汇总 ===');
const pass = results.filter(r => r.ok).length;
console.log(`  ${pass} 过 / ${results.length - pass} 失败`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
