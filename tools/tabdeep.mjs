import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox','--disable-gpu'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, userAgent: UA })).newPage();
const logs=[], reqs=[];
page.on('pageerror', e=>logs.push('PAGEERR '+e.message));
page.on('console', m=>{ if(m.type()==='error') logs.push('CONSOLE '+m.text().slice(0,160)); });
page.on('request', r=>{ const u=r.url(); if(/api|list|channel|live|getTV|satellite|weishi/i.test(u)) reqs.push(r.method()+' '+u.slice(0,150)); });

await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-tab', { timeout:25000 });
await page.waitForTimeout(5000);

const vue = await page.evaluate(() => {
  const tab = document.querySelector('.tv-main-con-r-tab');
  const imgs = [...document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')];
  const pick = el => {
    const vm = el.__vue__ || el.__vueParentComponent || null;
    const out = { hasVue2: !!el.__vue__, hasVue3: !!el.__vueParentComponent };
    if (el.__vue__) { // vue2
      out.vue2_props = Object.keys(el.__vue__.$props||{}).slice(0,20);
      out.vue2_listeners = el.__vue__.$listeners ? Object.keys(el.__vue__.$listeners) : null;
      out.vue2_events = el.__vue__._events ? Object.keys(el.__vue__._events) : null;
      out.vue2_data = (()=>{ try{ const d=el.__vue__.$data||{}; return Object.keys(d).slice(0,30);}catch(e){return null;} })();
    }
    if (el.__vueParentComponent) {
      out.vue3_props = el.__vueParentComponent.props ? Object.keys(el.__vueParentComponent.props).slice(0,20) : null;
    }
    if (el.__vnode && el.__vnode.props) out.vnodeProps = Object.keys(el.__vnode.props);
    // 原生绑定的 onclick
    out.onclick = el.onclick ? 'native' : 'none';
    return out;
  };
  return { tab: pick(tab), t0: pick(imgs[0]), t1: pick(imgs[1]),
           parentChain: (()=>{ let e=imgs[1], out=[]; while(e && out.length<6){ out.push(e.tagName+'.'+(e.className||'')); e=e.parentElement;} return out; })() };
});
console.log('=== Vue 绑定 ==='); console.log(JSON.stringify(vue, null, 1));

// 尝试多种事件序列
const trySeq = async (name, fn) => {
  const before = await page.evaluate(()=>[...document.querySelectorAll('.tv-main-con-r-list-left > div')].slice(0,4).map(e=>e.innerText.trim().slice(0,14)));
  await fn();
  await page.waitForTimeout(4000);
  const after = await page.evaluate(()=>[...document.querySelectorAll('.tv-main-con-r-list-left > div')].slice(0,4).map(e=>e.innerText.trim().slice(0,14)));
  console.log(`\n[${name}] ${JSON.stringify(before)} -> ${JSON.stringify(after)}  ${JSON.stringify(before)===JSON.stringify(after)?'✗ 无变化':'✓ 变了'}`);
};

await trySeq('pointerdown/up/click 第二个tab-img', () => page.evaluate(()=>{
  const el = document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img')[1];
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(n=>{
    const E = n.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new E(n,{bubbles:true,cancelable:true,view:window,button:0,pointerType:'mouse',isPrimary:true}));
  });
}));

await trySeq('点击 tab 父容器本身', () => page.evaluate(()=>{
  const el = document.querySelector('.tv-main-con-r-tab');
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
}));

await trySeq('真实点击 父容器中心', async () => {
  const r = await page.evaluate(()=>{ const e=document.querySelector('.tv-main-con-r-tab'); const b=e.getBoundingClientRect();
    return {x:b.x+b.width*0.85, y:b.y+b.height/2}; });
  await page.mouse.click(r.x, r.y);
});

console.log('\n=== 页面错误(前8) ==='); logs.slice(0,8).forEach(l=>console.log(' '+l));
console.log('\n=== 相关请求(前15) ==='); reqs.slice(0,15).forEach(l=>console.log(' '+l));
await browser.close();
