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
await page.goto('https://www.yangshipin.cn/tv/home', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForSelector('.tv-main-con-r-list-left', { timeout:25000 });
await page.waitForTimeout(4500);
await page.addStyleTag({ content: css });
await page.addScriptTag({ content: js });
await page.waitForTimeout(2500);

const toastState = () => page.evaluate(() => {
  const t = document.getElementById('ysp-toast');
  if (!t) return { exists: false };
  const cs = getComputedStyle(t);
  return { exists: true, text: t.textContent, show: t.classList.contains('show'), opacity: cs.opacity, bottom: cs.bottom, fs: cs.fontSize };
});

console.log('按键前:', JSON.stringify(await toastState()));

// 按下键，700ms 后立刻取气泡状态（气泡 1.6s 后淡出）
await page.evaluate(() => window.__yspTV.move(1));
await page.waitForTimeout(700);
console.log('按【下】+0.7s:', JSON.stringify(await toastState()));
await page.screenshot({ path: '/tmp/t_toast.png' });

await page.waitForTimeout(1400);
console.log('+2.1s（应已淡出）:', JSON.stringify(await toastState()));

// 面板展开时选中也该弹一次
await page.evaluate(() => window.__yspTV.activate());   // 弹出面板
await page.waitForTimeout(1500);
await page.evaluate(() => window.__yspTV.move(2));
await page.waitForTimeout(400);
await page.evaluate(() => window.__yspTV.activate());   // 选中并收起
await page.waitForTimeout(700);
console.log('面板内选中 +0.7s:', JSON.stringify(await toastState()));
await page.screenshot({ path: '/tmp/t_toast2.png' });

await browser.close();
