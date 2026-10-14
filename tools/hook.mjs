import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const ctx = await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA });

// 在页面脚本执行前挂钩 addEventListener
await ctx.addInitScript(() => {
  window.__L = [];
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      let tag = '', cls = '';
      if (this === document) { tag = 'DOCUMENT'; }
      else if (this === window) { tag = 'WINDOW'; }
      else if (this === document.body) { tag = 'BODY'; }
      else if (this && this.tagName) { tag = this.tagName; cls = (this.className || '').toString().slice(0, 70); }
      else { tag = String(this).slice(0, 30); }
      window.__L.push({ tag, cls, type, src: String(fn).replace(/\s+/g, ' ').slice(0, 150) });
    } catch (e) {}
    return orig.call(this, type, fn, opts);
  };
});

const page = await ctx.newPage();
const allReqs = [];
page.on('request', r => allReqs.push(r.url()));
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-tab', { timeout:25000 });
await page.waitForTimeout(5000);

const rel = await page.evaluate(() => {
  const L = window.__L || [];
  const hit = L.filter(x => /tab/i.test(x.cls) || /tab/i.test(x.src) || x.tag === 'DOCUMENT' || x.tag === 'BODY' || x.tag === 'WINDOW' || x.tag === 'DIV' && /tv-main-con/i.test(x.cls));
  return { total: L.length, hit: hit.slice(-80) };
});
console.log('总监听器数:', rel.total);
console.log('=== 与 tab / 全局委托 相关的监听器 ===');
rel.hit.forEach(h => console.log(` [${h.tag}.${h.cls}] ${h.type}  ::  ${h.src}`));

// 点击前后对比网络
const n0 = allReqs.length;
await (async () => {
  const r = await page.evaluate(()=>{ const e=document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
    const b=e.getBoundingClientRect(); return {x:b.x+b.width/2, y:b.y+b.height/2}; });
  await page.mouse.click(r.x, r.y);
})();
await page.waitForTimeout(6000);
console.log('\n=== 点击后新增请求 ===');
allReqs.slice(n0).forEach(u => console.log('  ' + u.slice(0, 160)));
await browser.close();
