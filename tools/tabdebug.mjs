import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-tab', { timeout:25000 });
await page.waitForTimeout(5000);

const tabInfo = await page.evaluate(() => {
  const tab = document.querySelector('.tv-main-con-r-tab');
  const kids = [...tab.children];
  return {
    tabHTML: tab.outerHTML.slice(0, 1400),
    tabCls: tab.className,
    tabRect: (r => [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)])(tab.getBoundingClientRect()),
    kids: kids.map(k => {
      const r = k.getBoundingClientRect();
      const img = k.querySelector('img');
      const ir = img ? img.getBoundingClientRect() : null;
      return { tag:k.tagName, cls:k.className,
        rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
        imgSrc: img ? img.getAttribute('src').split('/').pop() : null,
        imgRect: ir ? [Math.round(ir.x),Math.round(ir.y),Math.round(ir.width),Math.round(ir.height)] : null,
        pointer: getComputedStyle(k).pointerEvents, cursor: getComputedStyle(k).cursor };
    }),
  };
});
console.log(JSON.stringify(tabInfo, null, 1));

const list0 = await page.evaluate(() => [...document.querySelectorAll('.tv-main-con-r-list-left > div')].slice(0,8).map(e=>e.innerText.trim().slice(0,16)));
console.log('\n点击前列表:', JSON.stringify(list0));

// A) 真实鼠标点击 tab[2]（第二个 tab-img 的中心）
const rect = await page.evaluate(() => {
  const el = document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2 };
});
console.log('\n真实点击坐标:', JSON.stringify(rect));
await page.mouse.click(rect.x, rect.y);
await page.waitForTimeout(5000);
const list1 = await page.evaluate(() => [...document.querySelectorAll('.tv-main-con-r-list-left > div')].slice(0,8).map(e=>e.innerText.trim().slice(0,16)));
console.log('真实点击后列表:', JSON.stringify(list1));

// 若真实点击无效，尝试点 img 本身
if (JSON.stringify(list0) === JSON.stringify(list1)) {
  const rect2 = await page.evaluate(() => {
    const imgs = document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img img');
    const el = imgs[1]; const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, n: imgs.length };
  });
  console.log('\n改点 img, 共', rect2.n, '个 ->', JSON.stringify(rect2));
  await page.mouse.click(rect2.x, rect2.y);
  await page.waitForTimeout(5000);
  const list2 = await page.evaluate(() => [...document.querySelectorAll('.tv-main-con-r-list-left > div')].slice(0,8).map(e=>e.innerText.trim().slice(0,16)));
  console.log('点 img 后列表:', JSON.stringify(list2));
}
await page.screenshot({ path: '/tmp/tab_debug.png' });
await browser.close();
