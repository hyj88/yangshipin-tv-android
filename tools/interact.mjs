import { chromium } from 'playwright-core';
import fs from 'node:fs';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DIR = path.dirname(new URL(import.meta.url).pathname);
const css = fs.readFileSync(DIR + '/inject.css', 'utf8');
const js  = fs.readFileSync(DIR + '/inject.js', 'utf8');

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-gpu','--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
const errs = []; page.on('pageerror', e => errs.push('ERR ' + e.message));

await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(4500);
await page.addStyleTag({ content: css });
await page.addScriptTag({ content: js });
await page.waitForTimeout(2500);

const snap = () => page.evaluate(() => {
  const v = document.querySelector('video');
  const A = window.__yspTV;
  const pl = document.querySelector('.tv-main-con-l').getBoundingClientRect();
  const pn = document.querySelector('.tv-main-con-r').getBoundingClientRect();
  const t  = document.getElementById('ysp-toast');
  return {
    panelOpen: A.isPanelOpen(), rows: A.count(), idx: A.index(), tab: A.currentTab(),
    playing: (document.querySelector('.tvSelect span') || {}).innerText?.trim() || null,
    focus:   (document.querySelector('.ysp-focus span') || {}).innerText?.trim() || null,
    player:  [Math.round(pl.x), Math.round(pl.width), Math.round(pl.height)],
    panelX:  Math.round(pn.x), panelW: Math.round(pn.width),
    videoSrc: v ? (v.currentSrc || '').slice(30, 62) : null,
    toast: t ? (t.classList.contains('show') ? t.textContent : null) : null,
  };
});
const ok = (c, m) => console.log(`   ${c ? '✅' : '❌'} ${m}`);

console.log('### 1. 初始状态：面板应收起，视频铺满整屏');
let s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.panelOpen === false, '面板默认收起');
ok(s.player[1] === 1920 && s.player[2] === 1080, `播放器占满整屏 (${s.player})`);
ok(s.panelX < 0, `面板滑出屏幕外 (x=${s.panelX})`);
ok(s.rows === 40, `可见行 40（央视频道），实际 ${s.rows}`);
await page.screenshot({ path: '/tmp/n1_closed.png' });

console.log('\n### 2. 面板收起时按【下】→ 应直接换台');
const src0 = (await snap()).videoSrc;
await page.evaluate(() => window.__yspTV.move(1));
await page.waitForTimeout(700);
const t2 = await snap();          // 气泡 1.6s 后淡出，必须在窗口内取样
await page.waitForTimeout(4300);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.playing === 'CCTV2', `正在播放 → CCTV2，实际 ${s.playing}`);
ok(s.videoSrc !== src0, `视频流已切换 (${src0} -> ${s.videoSrc})`);
ok(s.panelOpen === false, '换台后面板仍保持收起');
ok(!!t2.toast, `弹出提示气泡：「${t2.toast}」`);
await page.screenshot({ path: '/tmp/n2_browse.png' });

console.log('\n### 3. 再按【下】→ 继续换下一台');
await page.evaluate(() => window.__yspTV.move(1)); await page.waitForTimeout(5000);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.playing === 'CCTV3', `正在播放 → CCTV3，实际 ${s.playing}`);

console.log('\n### 4. 按【确认】→ 面板应从左侧弹出，光标落在正在播放那一路');
await page.evaluate(() => window.__yspTV.activate()); await page.waitForTimeout(1500);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.panelOpen === true, '面板已弹出');
ok(s.panelX === 0, `面板贴在左侧 (x=${s.panelX}, w=${s.panelW})`);
ok(s.focus === 'CCTV3', `光标落在正在播放的 CCTV3，实际 ${s.focus}`);
await page.screenshot({ path: '/tmp/n3_panel.png' });

console.log('\n### 5. 面板内按【下】→ 只移光标，不换台');
const srcP = (await snap()).videoSrc;
await page.evaluate(() => window.__yspTV.move(1)); await page.waitForTimeout(1200);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.focus === 'CCTV4', `光标 → CCTV4，实际 ${s.focus}`);
ok(s.videoSrc === srcP, '视频流未变（面板内只移光标）');
ok(s.playing === 'CCTV3', '正在播放仍是 CCTV3');

console.log('\n### 6. 面板内按【确认】→ 选中并自动收起');
await page.evaluate(() => window.__yspTV.activate()); await page.waitForTimeout(5500);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(s.playing === 'CCTV4', `已切到 CCTV4，实际 ${s.playing}`);
ok(s.panelOpen === false, '面板已收起');
ok(s.player[1] === 1920, '视频恢复铺满整屏');
await page.screenshot({ path: '/tmp/n4_after_select.png' });

console.log('\n### 7. 自动隐藏：弹出面板后 6.5 秒不动 → 应自动收起');
await page.evaluate(() => window.__yspTV.activate());
await page.waitForTimeout(800);
ok((await snap()).panelOpen === true, '面板已弹出');
await page.waitForTimeout(6500);
s = await snap();
ok(s.panelOpen === false, `6.5 秒无操作后面板自动隐藏（panelOpen=${s.panelOpen}）`);

console.log('\n### 8. 左右切 tab（面板收起状态）');
await page.evaluate(() => window.__yspTV.switchTab(1)); await page.waitForTimeout(5000);
s = await snap(); console.log('  ', JSON.stringify(s));
const labels = await page.evaluate(() => window.__yspTV.labels().slice(0, 6));
console.log('   前6台:', JSON.stringify(labels));
ok(s.rows === 33, `卫视可见行 33，实际 ${s.rows}`);
ok(s.tab === 1, '当前为 卫视 tab');
ok(!/CCTV/.test(labels.join(',')), '卫视名单无 CCTV 混入');

console.log('\n### 9. 新 tab 内按【下】→ 应换到该组第一台');
await page.evaluate(() => window.__yspTV.move(1)); await page.waitForTimeout(5500);
s = await snap(); console.log('  ', JSON.stringify(s));
ok(/卫视/.test(s.playing || ''), `已换到卫视：${s.playing}`);

console.log('\n### 10. 边界钳制（面板展开态）');
await page.evaluate(() => window.__yspTV.togglePanel(true)); await page.waitForTimeout(1200);
await page.evaluate(() => window.__yspTV.move(-99)); await page.waitForTimeout(600);
ok((await snap()).idx === 0, '上界钳制在 0');
await page.evaluate(() => window.__yspTV.move(99)); await page.waitForTimeout(600);
s = await snap(); ok(s.idx === s.rows - 1, `下界钳制在 ${s.rows - 1}（实际 ${s.idx}）`);
await page.screenshot({ path: '/tmp/n5_panel_bottom.png' });

/* ---- 11. 行对齐：真机电视就是 1920x1080，这里量到的就是电视上的效果 ---- */
console.log('\n### 11. 列表行对齐（1920x1080，上下边缘不留半行）');
const align = () => page.evaluate(() => {
  const l = document.querySelector('.tv-main-con-r-list-left');
  if (!l) return null;
  const lb = l.getBoundingClientRect();
  const cs = getComputedStyle(l);
  const rs = [...l.children].filter(r => r.offsetParent !== null);
  if (!rs.length) return null;
  const rowH = rs[0].getBoundingClientRect().height;
  const base = l.scrollTop + (rs[0].getBoundingClientRect().top - lb.top);
  let topGap = 1e9, topLabel = '', botGap = 1e9, botLabel = '';
  const bb = lb.top + lb.height;
  for (const r of rs) {
    const g1 = r.getBoundingClientRect().top - lb.top;
    if (Math.abs(g1) < Math.abs(topGap)) { topGap = g1; topLabel = (r.innerText || '').trim().split('\n')[0]; }
    const g2 = r.getBoundingClientRect().bottom - bb;
    if (Math.abs(g2) < Math.abs(botGap)) { botGap = g2; botLabel = (r.innerText || '').trim().split('\n')[0]; }
  }
  const per = l.clientHeight / rowH;
  const off = (l.scrollTop - base) % rowH;
  return {
    pad: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
    rowH: +rowH.toFixed(3), viewH: l.clientHeight, per: +per.toFixed(4),
    perInt: Math.abs(per - Math.round(per)) < 0.02,
    snapOff: +Math.min(Math.abs(off), rowH - Math.abs(off)).toFixed(3),
    topGap: +topGap.toFixed(3), topLabel, botGap: +botGap.toFixed(3), botLabel,
  };
});
const chkAlign = (tag, a) => {
  ok(a && a.pad === 0, `${tag} · 列表无内边距 (${a ? a.pad : '?'}px)`);
  ok(a && a.perInt, `${tag} · 一屏正好整数行 (${a ? a.viewH + ' ÷ ' + a.rowH + ' = ' + a.per : '?'})`);
  ok(a && a.snapOff < 0.8, `${tag} · 滚动对齐到整行 (偏差 ${a ? a.snapOff : '?'}px)`);
  ok(a && Math.abs(a.topGap) < 1.2, `${tag} · 顶边无半行 (顶行「${a ? a.topLabel : '?'}」偏差 ${a ? a.topGap : '?'}px)`);
  ok(a && Math.abs(a.botGap) < 1.2, `${tag} · 底边无半行 (底行「${a ? a.botLabel : '?'}」偏差 ${a ? a.botGap : '?'}px)`);
};

await page.evaluate(() => window.__yspTV.togglePanel(true));
await page.evaluate(() => window.__yspTV.fitRows());
await page.evaluate(() => window.__yspTV.move(-99));   // 先回到第一行，三个采样点才有区别
await page.waitForTimeout(500);
chkAlign('顶部', await align());
await page.screenshot({ path: '/tmp/n6_align_top.png' });

for (let k = 0; k < 16; k++) { await page.evaluate(() => window.__yspTV.move(1)); await page.waitForTimeout(60); }
await page.waitForTimeout(500);
chkAlign('中段', await align());

for (let k = 0; k < 60; k++) { await page.evaluate(() => window.__yspTV.move(1)); await page.waitForTimeout(60); }
await page.waitForTimeout(500);
chkAlign('底部', await align());
await page.screenshot({ path: '/tmp/n7_align_bottom.png' });

if (errs.length) { console.log('\n页面错误:'); errs.slice(0,6).forEach(e=>console.log('  '+e)); }
await browser.close();
