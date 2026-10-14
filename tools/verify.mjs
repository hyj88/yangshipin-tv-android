// 央视频 TV 页 —— 注入效果验证工具
// 用法: node verify.mjs [css文件] [输出png]
// 复用系统 Chrome，无需下载 chromium
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'https://www.yangshipin.cn/tv/home';
// 必须伪装桌面 UA：页面有 isMobile() 检查，Android UA 会被重定向到移动站
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cssFile = process.argv[2] || null;
const outPng = process.argv[3] || '/tmp/inject_out.png';
const W = 1920, H = 1080;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', `--window-size=${W},${H}`, '--hide-scrollbars',
         '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  userAgent: UA,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForSelector('.tv-main-con-l', { timeout: 25000 });
  await page.waitForSelector('.tv-main-con-r', { timeout: 25000 });
} catch (e) { console.log('!! 等待核心容器超时'); }
await page.waitForTimeout(4000);

// ---- 测量原始布局 ----
const geom = await page.evaluate(() => {
  const out = { html: document.documentElement && getComputedStyle(document.documentElement).fontSize, items: [] };
  const sels = ['.header', '.tv-home', '.tv-home-list', '.tv', '.tv-main', '.tv-main-con',
                '.tv-main-con-l', '.tv-main-con-l-vid', '.tv-main-con-r',
                '.tv-main-con-r-tab', '.tv-main-con-r-list', '.tv-zhan', '.footer',
                'video', '#app'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) { out.items.push({ sel: s, missing: true }); continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.items.push({ sel: s, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                     pos: cs.position, display: cs.display, vis: cs.visibility });
  }
  // 选台项数量
  out.chanItems = document.querySelectorAll('.tv-main-con-r-list-left > div').length;
  out.tabs = document.querySelectorAll('.tv-main-con-r-tab > *').length;
  return out;
});

console.log('=== html font-size ===', geom.html);
console.log('=== 原始几何 ===');
for (const it of geom.items) {
  if (it.missing) { console.log(`  ${it.sel.padEnd(24)} <缺失>`); continue; }
  console.log(`  ${it.sel.padEnd(24)} x=${String(it.x).padStart(5)} y=${String(it.y).padStart(5)} w=${String(it.w).padStart(5)} h=${String(it.h).padStart(5)}  pos=${it.pos} disp=${it.display} vis=${it.vis}`);
}
console.log('=== 选台项数 ===', geom.chanItems, '  tab数 ===', geom.tabs);

// ---- 注入 CSS ----
if (cssFile && fs.existsSync(cssFile)) {
  const css = fs.readFileSync(cssFile, 'utf8');
  await page.addStyleTag({ content: css });
  await page.waitForTimeout(2500);
  console.log('\n=== 已注入:', cssFile, `(${css.length} 字符) ===`);
  const after = await page.evaluate(() => {
    const out = [];
    for (const s of ['.header', '.tv-main-con-l', '.tv-main-con-r', '.tv-zhan', 'video', '.tv-main-con-r-list']) {
      const el = document.querySelector(s);
      if (!el) { out.push({ sel: s, missing: true }); continue; }
      const r = el.getBoundingClientRect();
      out.push({ sel: s, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  });
  console.log('=== 注入后几何 ===');
  for (const it of after) {
    if (it.missing) { console.log(`  ${it.sel.padEnd(24)} <缺失>`); continue; }
    console.log(`  ${it.sel.padEnd(24)} x=${String(it.x).padStart(5)} y=${String(it.y).padStart(5)} w=${String(it.w).padStart(5)} h=${String(it.h).padStart(5)}`);
  }
}

await page.screenshot({ path: outPng });
console.log('\n截图 ->', outPng);
if (errs.length) { console.log('\n=== 页面错误(前10条) ==='); errs.slice(0, 10).forEach(e => console.log('  ' + e)); }
await browser.close();
