import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(5000);

// 真实点击 卫视
const c = await page.evaluate(()=>{ const e=document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
  const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; });
await page.mouse.click(c.x, c.y);
await page.waitForTimeout(7000);

const res = await page.evaluate(() => {
  const out = {};
  // 1) 找出所有「叶子节点」含 北京卫视 的元素的祖先链
  const all = [...document.querySelectorAll('*')];
  const leaf = all.filter(e => e.children.length <= 1 && /北京卫视|东方卫视|江苏卫视/.test(e.textContent||''));
  out.leafCount = leaf.length;
  out.chains = leaf.slice(0,4).map(e => {
    let cur = e, chain = [];
    while (cur && chain.length < 9) { chain.push(cur.tagName + '.' + (cur.className||'').toString().slice(0,58)); cur = cur.parentElement; }
    return { text:(e.textContent||'').trim().slice(0,14), chain: chain.join('  <  ') };
  });
  // 2) tv-main-con-r-list 的完整子结构（只要结构 + 类名）
  const pr = document.querySelector('.tv-main-con-r');
  const walk = (el, d, acc) => {
    if (d > 5) return;
    [...el.children].forEach(ch => {
      acc.push('  '.repeat(d) + ch.tagName + '.' + (ch.className||'').toString().slice(0,60) + ` [${(ch.innerText||'').trim().slice(0,10)}]`);
      if (acc.length < 60) walk(ch, d+1, acc);
    });
  };
  const acc = []; walk(pr, 0, acc);
  out.panelTree = acc.slice(0, 45);
  // 3) 所有 .tv-main-con-r-list-left 的兄弟
  const l = document.querySelector('.tv-main-con-r-list-left');
  out.listSiblings = [...(l.parentElement?.children||[])].map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,60)+`kids=${e.children.length} txt=${(e.innerText||'').trim().slice(0,16)}`);
  // 4) 可见元素计数
  out.visibleLists = [...document.querySelectorAll('[class*=tv-main-con-r-list]')].map(e=>{
    const r = e.getBoundingClientRect(); const cs=getComputedStyle(e);
    return { cls:(e.className||'').toString().slice(0,60), kids:e.children.length, disp:cs.display,
             rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
             txt:(e.innerText||'').trim().slice(0,18) };
  });
  return out;
});
console.log(JSON.stringify(res, null, 1));
await page.screenshot({ path:'/tmp/satellite_active.png' });
await browser.close();
