import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const out = {};
  const list = document.querySelector('.tv-main-con-r-list-left');
  out.listOuter = list.outerHTML.slice(0, 1200);
  // tab
  const tab = document.querySelector('.tv-main-con-r-tab');
  out.tabOuter = tab ? tab.outerHTML.slice(0, 1500) : null;
  // 前3行 计算样式
  out.rows = [];
  [...list.children].slice(0,3).forEach((el, i) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.rows.push({
      i, cls: el.className, tag: el.tagName,
      html: el.innerHTML.slice(0, 300),
      rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
      color: cs.color, bg: cs.backgroundColor, bgImg: cs.backgroundImage.slice(0,80),
      fontSize: cs.fontSize, padding: cs.padding, display: cs.display, alignItems: cs.alignItems,
    });
    // 子元素
    out.rows[i].kids = [...el.querySelectorAll('*')].slice(0,5).map(k => {
      const kcs = getComputedStyle(k);
      const kr = k.getBoundingClientRect();
      return { tag:k.tagName, cls:k.className, text:(k.textContent||'').trim().slice(0,20),
               color:kcs.color, bg:kcs.backgroundColor, bgImg:kcs.backgroundImage.slice(0,80),
               rect:[Math.round(kr.x),Math.round(kr.y),Math.round(kr.width),Math.round(kr.height)], fs:kcs.fontSize, pos:kcs.position };
    });
  });
  // 列表与右侧panel
  const lr = list.getBoundingClientRect();
  out.listRect = [Math.round(lr.x),Math.round(lr.y),Math.round(lr.width),Math.round(lr.height)];
  out.listCS = { overflow: getComputedStyle(list).overflow, display: getComputedStyle(list).display, pad: getComputedStyle(list).padding };
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
