#!/usr/bin/env node
/* ============================================================
   IPTV 聚合列表「可用性体检」

   目的：拿到一份第三方聚合 m3u（例如 best-fan/iptv-sources 的 cn_all.m3u8）之后，
   在把它塞进 App 之前先离线判一次：
     · 清单本身合不合法（条目数 / 分组 / 重名镜像）
     · 每条流能不能连（TCP+HTTP 状态、首字节延迟）
     · 流清单里有没有**框架 HLS 播不了的地雷**：
         #EXT-X-MEDIA    备选音轨 —— 框架 MediaPlayer 会崩 mediaserver（见 README §19）
         #EXT-X-MAP      fMP4 初始化段 —— 需要 Android 8+
         #EXT-X-KEY      AES-128 加密 —— 分片要带密钥解，框架支持不稳
         #EXT-X-STREAM-INF  多码率 master —— 本身没问题（要挑一路）
         .m4s / .mp4     分片是 fMP4 容器（同上）

   用法:
     node tools/iptv_list_probe.mjs <列表 URL 或本地文件> [--limit N] [--top N]
   ============================================================ */
import { readFileSync } from 'node:fs';

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node tools/iptv_list_probe.mjs <URL|本地文件> [--limit N] [--concurrency N]');
  process.exit(2);
}
const num = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return (i > 0 && process.argv[i + 1]) ? +process.argv[i + 1] : def;
};
const LIMIT = num('--limit', 0);            // 0 = 全测
const CONC = num('--concurrency', 16);
const TIMEOUT = num('--timeout', 9000);

/* ---------- 1. 取清单文本 ---------- */
let text;
if (/^https?:\/\//i.test(arg)) {
  const r = await fetch(arg, { redirect: 'follow' });
  if (!r.ok) { console.error(`清单下载失败 HTTP ${r.status}`); process.exit(1); }
  text = await r.text();
} else {
  text = readFileSync(arg, 'utf8');
}

/* ---------- 2. 解析成条目 ---------- */
const items = [];
for (const raw of text.split(/\r?\n/)) {
  const s = raw.trim();
  if (!s) continue;
  if (/^#EXTINF/i.test(s)) { items.push({ inf: s }); continue; }
  if (s.startsWith('#')) continue;
  const last = items[items.length - 1];
  if (last && !last.url) last.url = s;
}
const withUrl = items.filter(i => i.url);
const name = i => ((i.inf.match(/,(.+)$/) || [])[1] || '').trim();
const group = i => ((i.inf.match(/group-title="([^"]*)"/) || [])[1] || '(无分组)');

console.log('='.repeat(64));
console.log(`清单：${arg}`);
console.log(`条目 ${items.length} 条，其中有地址的 ${withUrl.length} 条`);
const byGroup = {};
withUrl.forEach(i => { const g = group(i); byGroup[g] = (byGroup[g] || 0) + 1; });
console.log('分组：' + Object.entries(byGroup).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}×${v}`).join('  '));
const names = {};
withUrl.forEach(i => { const n = name(i); names[n] = (names[n] || 0) + 1; });
const mirrors = Object.entries(names).filter(([, v]) => v > 1);
console.log(`频道名：去重后 ${Object.keys(names).length} 个，其中 ${mirrors.length} 个有多个镜像`
  + (mirrors.length ? `（最多的是 ${mirrors.sort((a, b) => b[1] - a[1])[0].join('×')}）` : ''));
const urls = withUrl.map(i => i.url);
const dupUrl = urls.length - new Set(urls).size;
console.log(`完全重复的地址：${dupUrl} 条`);

/* ---------- 3. 逐条探测 ---------- */
const targets = LIMIT > 0 ? withUrl.slice(0, LIMIT) : withUrl;
console.log(`\n开始探测 ${targets.length} 条（并发 ${CONC}，单条 ${TIMEOUT}ms 超时）…\n`);

const FLAG = {
  '#EXT-X-MEDIA:': '备选音轨(💣框架HLS会炸)',
  '#EXT-X-MAP:': 'fMP4初始化段(需Android8+)',
  '#EXT-X-KEY:': 'AES加密分片',
  '#EXT-X-STREAM-INF:': '多码率master',
  '#EXT-X-DISCONTINUITY':'时间戳不连续',
};

async function probe(it) {
  const url = it.url;
  const t0 = Date.now();
  const out = { name: name(it), group: group(it), url, ms: 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        // 不少 IPTV 源会对「非播放器 UA」直接 403，用 VLC 的 UA 更接近真实场景
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        'Accept': '*/*',
      },
    });
    out.ms = Date.now() - t0;
    out.status = r.status;
    const ct = r.headers.get('content-type') || '';
    out.ct = ct.split(';')[0];
    if (!r.ok) { out.verdict = 'HTTP ' + r.status; return out; }
    // 只读前 8KB 就够判断清单结构
    const reader = r.body.getReader();
    let buf = '', got = 0;
    while (got < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      got += value.length;
    }
    try { await reader.cancel(); } catch {}
    out.bytes = got;
    if (!/^#EXTM3U/i.test(buf.trim())) {
      out.verdict = '不是 HLS 清单（首行: ' + JSON.stringify(buf.trim().slice(0, 40)) + '）';
      return out;
    }
    if (/#EXT-X-ENDLIST/i.test(buf) && !/#EXT-X-STREAM-INF/i.test(buf) && !/#EXTINF/i.test(buf)) {
      out.verdict = '清单里没有分片';
      return out;
    }
    out.isMaster = /#EXT-X-STREAM-INF:/i.test(buf);
    out.kind = out.isMaster ? 'master' : 'media';
    out.flags = Object.keys(FLAG).filter(f => buf.includes(f));
    out.fmp4 = /\.m4s|\.mp4(\?|$)/im.test(buf);
    if (out.isMaster) {
      // 风险都藏在子清单里：跟进去看第一路变体
      const vm = buf.match(/#EXT-X-STREAM-INF:[^\n]*\n\s*([^\s#][^\n]*)/i);
      if (vm) {
        const vurl = new URL(vm[1].trim(), url).href;
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), TIMEOUT);
        try {
          const r2 = await fetch(vurl, {
            redirect: 'follow', signal: ac2.signal,
            headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Accept: '*/*' },
          });
          const b2 = (await r2.text()).slice(0, 8192);
          out.variant = { url: vurl, status: r2.status, flags: Object.keys(FLAG).filter(f => b2.includes(f)) };
          out.variantFmp4 = /\.m4s|\.mp4(\?|$)/im.test(b2);
        } catch (e) {
          out.variant = { url: vurl, err: e.name === 'AbortError' ? '超时' : (e.cause?.code || e.message) };
        } finally { clearTimeout(t2); }
      }
    }
    out.verdict = 'ok';
    return out;
  } catch (e) {
    out.ms = Date.now() - t0;
    out.verdict = e.name === 'AbortError' ? `超时 ${TIMEOUT}ms` : (e.cause?.code || e.message);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const i = cursor++;
    const r = await probe(targets[i]);
    results[i] = r;
    const tag = r.verdict === 'ok' ? '  ok  ' : ' FAIL ';
    process.stdout.write(`[${String(i + 1).padStart(3)}/${targets.length}]${tag}`
      + `${String(r.ms).padStart(5)}ms  ${r.verdict.padEnd(26)} ${r.name}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));

/* ---------- 4. 汇总 ---------- */
const ok = results.filter(r => r && r.verdict === 'ok');
const bad = results.filter(r => r && r.verdict !== 'ok');
console.log('\n' + '='.repeat(64));
console.log(`可用（拿到合法 HLS 清单）: ${ok.length} / ${targets.length}`);
console.log(`失败: ${bad.length}`);
const reasons = {};
bad.forEach(r => {
  const k = r.verdict.startsWith('HTTP ') ? r.verdict
    : r.verdict.startsWith('超时') ? '超时' : r.verdict;
  reasons[k] = (reasons[k] || 0) + 1;
});
Object.entries(reasons).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}  ${k}`));

// 有效标记 = 自身清单 + 跟进变体（master 的情况）
const effFlags = r => [...new Set([...(r.flags || []), ...((r.variant && r.variant.flags) || [])])];
const effFmp4 = r => !!r.fmp4 || !!r.variantFmp4;
const LANDMINE = ['#EXT-X-MEDIA:', '#EXT-X-MAP:', '#EXT-X-KEY:'];

const landmines = ok.filter(r => effFlags(r).some(f => LANDMINE.includes(f)));
console.log(`\n⚠️ 含「框架 HLS 有风险」标记的: ${landmines.length} / ${ok.length}`);
const fc = {};
ok.forEach(r => effFlags(r).forEach(f => { fc[f] = (fc[f] || 0) + 1; }));
Object.entries(fc).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}  ${k}   ${FLAG[k] || ''}`));
console.log(`    ${String(ok.filter(effFmp4).length).padStart(4)}  分片是 .m4s/.mp4`);
console.log(`    ${String(ok.filter(r => r.isMaster).length).padStart(4)}  多码率 master（其余是直出的媒体清单）`);

const lat = ok.map(r => r.ms).sort((a, b) => a - b);
if (lat.length) {
  const q = p => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
  console.log(`\n可用流的首字节延迟: 最快 ${lat[0]}ms / 中位 ${q(0.5)}ms / p90 ${q(0.9)}ms / 最慢 ${lat[lat.length - 1]}ms`);
}

const clean = ok.filter(r => !effFlags(r).length && !effFmp4(r));
console.log(`\n✅ 干净可用（无任何风险标记）: ${clean.length} 条`);
console.log('   挑前 12 条：');
clean.slice(0, 12).forEach(r => console.log(`     ${String(r.ms).padStart(5)}ms  ${r.name}  ${r.url}`));

// 落一份 JSON，给设备端联调用
const report = {
  source: arg, at: new Date().toISOString(),
  total: targets.length, ok: ok.length, clean: clean.length,
  results,
};
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/iptv_probe.json', JSON.stringify(report, null, 1));
console.log('\n明细已存 /tmp/iptv_probe.json');
