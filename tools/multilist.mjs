import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(5000);

const dump = async (tag) => {
  const d = await page.evaluate(() => {
    const lists = [...document.querySelectorAll('.tv-main-con-r-list-left')];
    const parents = [...document.querySelectorAll('.tv-main-con-r-list')];
    return {
      listCount: lists.length,
      parentCount: parents.length,
      parentChain: (()=>{ let e=lists[0], out=[]; while(e&&out.length<7){ out.push(e.tagName+'.'+(e.className||'').slice(0,55)); e=e.parentElement;} return out; })(),
      parentsHTML: parents.map(p=>p.outerHTML.slice(0,220)),
      lists: lists.map((l,i)=>{
        const r=l.getBoundingClientRect();
        const cs=getComputedStyle(l);
        return { i, kids:l.children.length,
          rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
          disp:cs.display, vis:cs.visibility, op:cs.opacity,
          first4:[...l.children].slice(0,4).map(c=>c.innerText.trim().slice(0,12)) };
      }),
      // 找所有含卫视文字的容器
      satelliteNodes: [...document.querySelectorAll('*')].filter(e=>/北京卫视|东方卫视/.test(e.textContent||'') && e.children.length===0).length,
    };
  });
  console.log(`\n===== ${tag} =====`);
  console.log(' .tv-main-con-r-list-left 数量 =', d.listCount, ' .tv-main-con-r-list 数量 =', d.parentCount);
  console.log(' 祖先链:', d.parentChain.join(' < '));
  d.lists.forEach(l => console.log(`  [${l.i}] kids=${l.kids} rect=${JSON.stringify(l.rect)} disp=${l.disp} vis=${l.vis} op=${l.op} first4=${JSON.stringify(l.first4)}`));
  console.log(' 叶子节点含卫视文字数 =', d.satelliteNodes);
  return d;
};

await dump('初始 (CCTV tab)');

// 用注入脚本的方式切 tab
await page.evaluate(() => {
  const tabs = document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img');
  tabs[1].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
});
await page.waitForTimeout(8000);
await dump('点击 tab[1] 后 8s');
await page.screenshot({ path: '/tmp/multi_list.png' });
await browser.close();
