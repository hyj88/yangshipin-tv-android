import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(5000);

const measure = (tag) => page.evaluate((tag) => {
  const box = document.querySelector('.tv-main-con-r-list-left');
  const cs = getComputedStyle(box);
  const rows = [...box.children];
  const stat = (cls) => {
    const sel = rows.filter(r => r.className.includes(cls));
    const vis = sel.filter(r => { const b=r.getBoundingClientRect(); return b.height>0 && b.width>0; });
    const s0 = sel[0] ? getComputedStyle(sel[0]) : null;
    return { total: sel.length, visible: vis.length,
             sample: s0 ? { display:s0.display, vis:s0.visibility, h:Math.round(sel[0].getBoundingClientRect().height), pos:s0.position } : null,
             firstVisible: vis[0] ? vis[0].innerText.trim().slice(0,12) : null };
  };
  // 每个孩子的 y 位置
  const ys = rows.map(r => Math.round(r.getBoundingClientRect().y));
  const cls = rows.map(r => r.className.includes('imgb') ? 'B' : r.className.includes('imga') ? 'A' : '?').join('');
  return { tag,
    box: { h: Math.round(box.getBoundingClientRect().height), scrollH: box.scrollHeight, clientH: box.clientHeight,
           overflow: cs.overflow, overflowY: cs.overflowY, display: cs.display },
    A: stat('imga'), B: stat('imgb'),
    seq: cls, yMin: Math.min(...ys), yMax: Math.max(...ys) };
}, tag);

console.log(JSON.stringify(await measure('CCTV tab 激活'), null, 1));
await page.screenshot({ path:'/tmp/m_cctv.png' });

// 真实点击 卫视
const c = await page.evaluate(()=>{ const e=document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
  const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; });
await page.mouse.click(c.x, c.y);
await page.waitForTimeout(7000);
console.log('\n' + JSON.stringify(await measure('卫视 tab 激活'), null, 1));
await page.screenshot({ path:'/tmp/m_sat.png' });
await browser.close();
