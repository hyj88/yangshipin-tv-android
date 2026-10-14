import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
const reqs=[]; let mark=0;
page.on('request', r=>reqs.push(r.url()));
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(5000);

const probe = () => page.evaluate(() => {
  const l = document.querySelector('.tv-main-con-r-list-left');
  const txt = document.body.innerText || '';
  const imgs = [...document.querySelectorAll('.tv-main-con-r-tab img')].map(i=>i.getAttribute('src').split('/').pop());
  return { kids: l?l.children.length:-1,
           first3: l?[...l.children].slice(0,3).map(c=>c.innerText.trim().slice(0,12)):[],
           sat: /北京卫视|东方卫视|江苏卫视/.test(txt),
           tabImgs: imgs.join(' | ') };
});

const poll = async (label, secs) => {
  console.log(`\n### ${label}`);
  let last = '';
  for (let t = 0; t <= secs*2; t++) {
    const p = await probe();
    const s = JSON.stringify(p);
    if (s !== last) { console.log(`  +${(t*0.5).toFixed(1)}s ${s}`); last = s; }
    await new Promise(r=>setTimeout(r,500));
  }
};

await poll('点击前', 1);

mark = reqs.length;
// 真实可信点击
const c = await page.evaluate(()=>{ const e=document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
  const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; });
console.log('\n>>> 真实点击', JSON.stringify(c));
await page.mouse.click(c.x, c.y);
await poll('真实点击后', 15);
console.log('  新增请求:', reqs.slice(mark).map(u=>u.slice(0,110)));

mark = reqs.length;
console.log('\n>>> 合成事件点击（回到 CCTV 再切）');
await page.evaluate(()=>{ const e=document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[0];
  ['mousedown','mouseup','click'].forEach(n=>e.dispatchEvent(new MouseEvent(n,{bubbles:true,cancelable:true,view:window}))); });
await poll('点回 tab[0]', 8);
console.log('  新增请求:', reqs.slice(mark).map(u=>u.slice(0,110)));

await page.screenshot({ path:'/tmp/poll_end.png' });
await browser.close();
