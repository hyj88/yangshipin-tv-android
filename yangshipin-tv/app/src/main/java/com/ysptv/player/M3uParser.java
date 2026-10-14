package com.ysptv.player;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * m3u / m3u8 播放列表解析。
 *
 * 支持的写法（都是真实 IPTV 列表里见过的）：
 *
 *   ① 标准
 *      #EXTM3U
 *      #EXTINF:-1 tvg-name="CCTV1" group-title="央视",CCTV-1 综合
 *      http://a/b.m3u8
 *
 *   ② 分组用独立行
 *      #EXTGRP:卫视
 *
 *   ③ 请求头写在 URL 尾巴（Kodi/VLC 风格，& 或 %26 分隔）
 *      http://a/b.m3u8|User-Agent=Mozilla/5.0&Referer=http://h/
 *
 *   ④ 请求头写在 EXTVLCOPT 里
 *      #EXTVLCOPT:http-referrer=http://h/
 *      #EXTVLCOPT:http-user-agent=Mozilla/5.0
 *
 *   ⑤ 光秃秃的一行地址（没有 #EXTINF）—— 一样能收
 *      http://a/b.m3u8
 *
 * ⚠️ 本类【刻意】零 Android 依赖，可在宿主 JVM 上单测（见 tools/custom_source_test.mjs）。
 */
final class M3uParser {

    /** 认得的协议。别的（file:/content:/magnet: 之类）一律不当成源。 */
    private static final String[] SCHEMES = {
            "http://", "https://", "rtsp://", "rtmp://", "rtmps://", "udp://", "rtp://"
    };

    /** 解析出来的源默认归到哪个组 */
    static final String DEFAULT_GROUP = "自建";

    /** 单次导入的上限。防呆：有人会粘进来一两万条，SharedPreferences 会被撑爆 */
    static final int MAX_ITEMS = 2000;

    /** 不当作 HTTP 请求头的名字（它们是 m3u 的元数据，不是头） */
    private static final String[] NOT_HEADER = {
            "tvg-", "group", "logo", "name", "id", "duration", "extinf",
            "radio", "shift", "aspect-ratio", "catchup"
    };

    private M3uParser() {}

    // =====================================================================
    // 对外入口
    // =====================================================================

    /**
     * 「什么都收」的入口：给用户粘贴的一坨文本，自己判断是播放列表、一行地址，
     * 还是别的什么东西。
     *
     * @param text         用户粘贴的内容
     * @param fallbackName 单条地址时用的名字（用户在「名称」栏里填的）
     * @param defaultGroup 没有 group-title 时归到哪个组
     * @return 解析出的源；无法解析时返回空表（调用方见 {@link #LAST_IS_SINGLE_MANIFEST}）
     */
    static List<Source> parseFlexible(String text, String fallbackName, String defaultGroup) {
        LAST_IS_SINGLE_MANIFEST = false;
        List<Source> out = new ArrayList<>();
        if (text == null) return out;
        String t = text.trim();
        if (t.isEmpty()) return out;

        // ---- ① 一行、带协议、不含 # → 就是一条地址 ----
        if (t.indexOf('\n') < 0 && t.indexOf('\r') < 0 && t.charAt(0) != '#') {
            Map<String, String> h = new LinkedHashMap<>();
            String url = splitHeaders(t, h);
            if (isStreamUrl(url)) {
                Source s = new Source(fallbackName, url, groupOr(defaultGroup));
                s.headers.putAll(h);
                out.add(s);
            }
            return out;
        }

        String grp = groupOr(defaultGroup);

        // ---- ② 单个流自己的清单（分片列表 / 多码率 master）----
        // 这不是频道表：按频道解会得到几十条指向 .ts 分片、或同一路内容不同码率的
        // 假频道。宁可不收，让界面明确告诉用户「请直接填那个 .m3u8 地址」。
        if (isStreamManifest(t)) {
            LAST_IS_SINGLE_MANIFEST = true;
            return out;
        }

        // ---- ③ 正常播放列表 ----
        List<Source> parsed = parse(t, grp);
        if (parsed.size() > MAX_ITEMS) parsed = new ArrayList<>(parsed.subList(0, MAX_ITEMS));
        return parsed;
    }

    /**
     * 上一次 parseFlexible 是否识别出「这是单个流的清单，不是频道列表」。
     * 用一个静态标志而不是返回值：不想为了这一个布尔把签名搞复杂（调用都在主线程）。
     */
    static volatile boolean LAST_IS_SINGLE_MANIFEST = false;

    /**
     * 解析播放列表正文。
     *
     * @param defaultGroup 没有 group-title / #EXTGRP 时用的分组
     */
    static List<Source> parse(String text, String defaultGroup) {
        List<Source> out = new ArrayList<>();
        if (text == null || text.isEmpty()) return out;
        String grp0 = groupOr(defaultGroup);

        // ---- 逐条（#EXTINF 给）的信息 ----
        String pName = null;        // 标题
        String pGroupTitle = null;  // group-title
        String pTvgName = null;     // tvg-name（没有标题时用它）

        // ---- 粘性的文件级状态（#EXTGRP / #EXTVLCOPT 给）----
        // 为什么是「粘性」而不是「只作用于下一条」：
        //   真实 IPTV 列表绝大多数是「文件开头一段
        //     #EXTVLCOPT:http-user-agent=...
        //     #EXTGRP:央视
        //   之后所有台都吃这个设置」。若按配一条用一条清掉，
        //   只会在第一条生效 —— 那是错的。中途要改就再写一行，后面的自然覆盖。
        String stickyGroup = null;
        final Map<String, String> stickyHeaders = new LinkedHashMap<>();

        boolean mediaBlock = false; // 已进入分片清单区域（见 isSegmentLine 的用法）

        int from = 0;
        final int n = text.length();
        while (from <= n) {
            int nl = text.indexOf('\n', from);
            String line;
            if (nl < 0) { line = text.substring(from); from = n + 1; }
            else { line = text.substring(from, nl); from = nl + 1; }
            line = line.trim();
            if (line.endsWith("\r")) line = line.substring(0, line.length() - 1).trim();
            if (line.isEmpty()) continue;

            // ---------------- 指令行 ----------------
            if (line.charAt(0) == '#') {
                String up = line.toUpperCase(Locale.ROOT);

                if (up.startsWith("#EXTINF")) {
                    // 只清「逐条」那三样。粘性的分组/请求头【不能】在这里清
                    // —— #EXTGRP 和 #EXTVLCOPT 常常写在 #EXTINF 前面（甚至写在文件最前）。
                    pName = null; pGroupTitle = null; pTvgName = null;

                    int comma = lastIndexOfOutsideQuotes(line);
                    String attrs = (comma > 0) ? line.substring(0, comma) : line;
                    String title = (comma > 0) ? line.substring(comma + 1).trim() : "";

                    Map<String, String> a = parseAttrs(attrs);
                    pGroupTitle = a.get("group-title");
                    if (pGroupTitle == null) pGroupTitle = a.get("group");
                    pTvgName = a.get("tvg-name");
                    pName = title.isEmpty() ? null : title;

                } else if (up.startsWith("#EXTGRP:")) {
                    stickyGroup = line.substring(line.indexOf(':') + 1).trim();

                } else if (up.startsWith("#EXTVLCOPT:")) {
                    String kv = line.substring(line.indexOf(':') + 1).trim();
                    int eq = kv.indexOf('=');
                    if (eq > 0) {
                        String can = canonHeader(kv.substring(0, eq));
                        String v = kv.substring(eq + 1).trim();
                        if (can != null && !v.isEmpty()) stickyHeaders.put(can, v);
                    }

                } else if (up.startsWith("#EXT-X-TARGETDURATION")
                        || up.startsWith("#EXT-X-MEDIA-SEQUENCE")
                        || up.startsWith("#EXT-X-PLAYLIST-TYPE")
                        || up.startsWith("#EXT-X-ENDLIST")) {
                    mediaBlock = true;   // RFC 8216：媒体清单必备，据此判分片行

                } else if (up.startsWith("#EXT-X-STREAM-INF:")) {
                    // master 清单里的码率档位，顺手当名字用（RESOLUTION=1920x1080）
                    Map<String, String> a = parseAttrs(line);
                    String res = a.get("resolution");
                    if (res != null) {
                        int x = res.indexOf('x');
                        String h = (x > 0) ? res.substring(x + 1) : res;
                        if (!h.isEmpty()) pName = h + "P";
                    }
                }
                // #EXTM3U / #PLAYLIST / #EXT-X-VERSION 等一律忽略
                continue;
            }

            // ---------------- 地址行 ----------------
            // 分片行只在「确认是媒体清单」时才丢 —— 否则 http://x/ch1.ts 这种
            // 单文件源会被误杀
            if (mediaBlock && isSegmentLine(line)) continue;

            Map<String, String> h = new LinkedHashMap<>();
            String url = splitHeaders(line, h);
            if (!isStreamUrl(url)) continue;

            String g = grp0;
            if (pGroupTitle != null && !pGroupTitle.trim().isEmpty()) g = pGroupTitle.trim();
            else if (stickyGroup != null && !stickyGroup.isEmpty()) g = stickyGroup;

            String nm = pName;
            if (nm == null && pTvgName != null && !pTvgName.trim().isEmpty()) nm = pTvgName.trim();

            Source s = new Source(nm, url, g);
            s.headers.putAll(stickyHeaders);  // EXTVLCOPT 是底…
            s.headers.putAll(h);              // …URL 尾巴更具体，覆盖它
            out.add(s);

            // 这条已经吃完：#EXTINF 那三样作废；粘性的分组/请求头留着给下一条
            pName = null; pGroupTitle = null; pTvgName = null;
        }
        return out;
    }

    // =====================================================================
    // 片段工具（包级可见，好让单测直接打这些函数）
    // =====================================================================

    /** 是不是能交给播放器的地址 */
    static boolean isStreamUrl(String url) {
        if (url == null) return false;
        String u = url.trim().toLowerCase(Locale.ROOT);
        if (u.isEmpty()) return false;
        for (String sc : SCHEMES) if (u.startsWith(sc)) return true;
        return false;
    }

    /** 这是「单个流自己的清单」，不是频道列表 */
    static boolean isStreamManifest(String text) {
        if (text == null) return false;
        String up = text.toUpperCase(Locale.ROOT);
        if (up.indexOf("#EXT-X-STREAM-INF") >= 0) return true;
        if (up.indexOf("#EXT-X-TARGETDURATION") >= 0) return true;
        if (up.indexOf("#EXT-X-MEDIA-SEQUENCE") >= 0) return true;
        return false;
    }

    /**
     * 这份文本到底是不是「一份频道列表」。
     *
     * 专供「从网址导入」用：用户填的是一个 http(s) 地址，抓回来之后必须判断
     * 这坨东西是【频道清单】还是【单个流自己的清单】还是【别的什么网页】。
     * 判错的两种后果都不小：
     *   · 把单个流清单当频道表 → 导入几十条指向 .ts 分片的假频道；
     *   · 把频道表当单个流 → 用户以为导入成功了，其实只有 1 条。
     *
     * 判定（全部来自实测遇到的形态）：
     *   ① HTML（登录页、目录页、"源已失效"提示页）直接排除；
     *   ② 单个流自己的清单（#EXT-X-STREAM-INF / -TARGETDURATION / -MEDIA-SEQUENCE）排除；
     *   ③ 解析出 ≥2 条 → 是；
     *   ④ 只解析出 1 条，但正文里有 #EXTM3U → 也算（一条台的清单也是清单）。
     *
     * ⚠️ 这里和调用方会各解析一次（本函数只回答「是不是」）。清单有
     *    {@link #MAX_ITEMS} 封顶，两次解析的开销可以忽略，换来的是
     *    「判定规则只有一处」，比省那几毫秒值。
     */
    static boolean looksLikeChannelList(String text) {
        if (text == null) return false;
        String t = text.trim();
        if (t.isEmpty()) return false;
        if (isHtml(t)) return false;
        if (isStreamManifest(t)) return false;
        List<Source> p = parse(t, DEFAULT_GROUP);
        if (p.size() >= 2) return true;
        return p.size() == 1 && t.toLowerCase(Locale.ROOT).indexOf("#extm3u") >= 0;
    }

    /**
     * 这段文本是不是一张网页。
     * 抓远程清单时很常见：登录页、目录页、CDN 的「源已失效」提示页，都是 HTML。
     * 把它当频道表去解析，能从 <a href> 里捞出一堆莫名其妙的地址。
     */
    static boolean isHtml(String text) {
        if (text == null) return false;
        String low = text.trim().toLowerCase(Locale.ROOT);
        return low.startsWith("<!doctype") || low.indexOf("<html") >= 0 || low.indexOf("<head") >= 0;
    }

    private static boolean isSegmentLine(String line) {
        String l = line.toLowerCase(Locale.ROOT);
        int q = l.indexOf('?');
        if (q >= 0) l = l.substring(0, q);
        return l.endsWith(".ts") || l.endsWith(".m4s") || l.endsWith(".aac")
                || l.endsWith(".vtt") || l.endsWith(".key") || l.endsWith(".mp4");
    }

    /**
     * 找【引号外】的最后一个逗号 —— EXTINF 的标题在它后面。
     *
     * 为什么要有引号意识：属性值里可能有逗号，比如
     *     #EXTINF:-1 tvg-name="A, B",频道名
     * 傻取最后一个逗号会落到引号里，标题就变成了 ' B",频道名'。
     */
    static int lastIndexOfOutsideQuotes(String s) {
        int last = -1;
        boolean inq = false;
        char qc = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inq) {
                if (c == qc) inq = false;
            } else if (c == '"' || c == '\'') {
                inq = true; qc = c;
            } else if (c == ',') {
                last = i;
            }
        }
        return last;
    }

    /**
     * 把 "http://a/b.m3u8|User-Agent=X&Referer=Y" 拆成 url + headers。
     * headers 原地填进 out，返回纯 url。
     */
    static String splitHeaders(String raw, Map<String, String> out) {
        if (raw == null) return "";
        String s = raw.trim();

        // 有些列表把 | 写成了 %7C
        int bar = s.lastIndexOf('|');
        if (bar < 0) {
            int enc = s.toLowerCase(Locale.ROOT).lastIndexOf("%7c");
            if (enc > 0) { s = s.substring(0, enc) + "|" + s.substring(enc + 3); bar = enc; }
        }
        if (bar <= 0) return s;

        String url = s.substring(0, bar).trim();
        if (out == null) return url;

        StringBuilder cur = new StringBuilder();
        List<String> parts = new ArrayList<>();
        for (int i = bar + 1; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '&' || c == ';') { parts.add(cur.toString()); cur.setLength(0); }
            else cur.append(c);
        }
        parts.add(cur.toString());

        for (String p : parts) {
            p = p.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            String can = canonHeader(p.substring(0, eq));
            String v = p.substring(eq + 1).trim();
            if (can != null && !v.isEmpty()) out.put(can, v);
        }
        return url;
    }

    /**
     * 请求头名归一化。不认得的返回 null。
     *
     * 只对「明确是请求头的上下文」调用（| 尾巴、#EXTVLCOPT），所以放宽未知头，
     * 只挡住那一小撮确定是 m3u 元数据的名字。
     */
    static String canonHeader(String k) {
        if (k == null) return null;
        String s = k.trim();
        if (s.isEmpty()) return null;
        String low = s.toLowerCase(Locale.ROOT).replace("_", "-").replace("\"", "").replace("'", "").trim();
        if (low.startsWith("http-")) low = low.substring(5);   // http-user-agent → user-agent

        for (String bad : NOT_HEADER) if (low.startsWith(bad)) return null;

        if (low.equals("user-agent") || low.equals("useragent") || low.equals("ua")) return "User-Agent";
        if (low.equals("referer") || low.equals("referrer")) return "Referer";
        if (low.equals("cookie")) return "Cookie";
        if (low.equals("authorization") || low.equals("auth")) return "Authorization";
        if (low.equals("origin")) return "Origin";
        if (low.equals("accept")) return "Accept";

        // HTTP 头名只能是 token 字符；名字不合法就丢
        for (int i = 0; i < low.length(); i++) {
            char c = low.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
            if (!ok) return null;
        }
        // 原样返回（保留用户写的首字母大写习惯）
        return s;
    }

    /**
     * 从属性段里抠 key="value" / key='value' / key=value。
     */
    static Map<String, String> parseAttrs(String s) {
        Map<String, String> m = new LinkedHashMap<>();
        if (s == null) return m;
        int i = 0;
        final int n = s.length();
        while (i < n) {
            while (i < n && !isKeyChar(s.charAt(i))) i++;
            int ks = i;
            while (i < n && isKeyChar(s.charAt(i))) i++;
            if (ks == i) break;
            String key = s.substring(ks, i).toLowerCase(Locale.ROOT);
            while (i < n && (s.charAt(i) == ' ' || s.charAt(i) == '=')) i++;
            if (i >= n) { m.put(key, ""); break; }
            char q = s.charAt(i);
            String val;
            if (q == '"' || q == '\'') {
                i++;
                int e = s.indexOf(q, i);
                if (e < 0) e = n;
                val = s.substring(i, e);
                i = e + 1;
            } else {
                int e = i;
                while (e < n && s.charAt(e) != ' ') e++;
                val = s.substring(i, e);
                i = e;
            }
            m.put(key, val);
        }
        return m;
    }

    private static boolean isKeyChar(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '-' || c == '_';
    }

    private static String groupOr(String g) {
        return (g == null || g.trim().isEmpty()) ? DEFAULT_GROUP : g.trim();
    }
}
