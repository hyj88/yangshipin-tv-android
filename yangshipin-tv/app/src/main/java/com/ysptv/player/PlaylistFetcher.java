package com.ysptv.player;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

import javax.net.ssl.SSLException;

/**
 * 抓一份「远程播放列表」。
 *
 * ==========================================================================
 * 为什么要放在 App 里抓，而不是让用户把内容粘进来
 * ==========================================================================
 * 聚合清单（best-fan/iptv-sources、各种「直播源每日更新」仓库）的用法本来就是
 * 「记住一个网址，隔几天重新拉一次」。让用户每次去浏览器打开、复制全文、再粘贴，
 * 等于把这件事做废了。Android 侧自己抓还有两个附带好处：
 *   · 不受网页的同源 / CORS 限制（局域网导入页是电视自己吐出来的页面，
 *     它去 fetch 第三方域名会被浏览器拦掉）；
 *   · 抓完能把「清单地址」记下来，以后一键刷新。
 *
 * ⚠️ 本类【刻意】零 Android 依赖（连 Log 都不用）—— 这样它能像 M3uParser 一样
 *    在宿主 JVM 上直接 javac + 单测，不必开模拟器
 *    （见 tools/hosttest/PlaylistFetcherTest.java，本地起 HTTP 桩服务打全套边界）。
 */
final class PlaylistFetcher {

    /** 抓取用的 UA。很多直播源站点会对 UA 挑食，桌面 Chrome 是最不容易被拦的一个。 */
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /** 正文上限。2000 条源 ≈ 500KB，2MB 足够宽裕，又不至于让有人贴个视频地址进来就把内存吃光。 */
    static final int MAX_BYTES = 2 * 1024 * 1024;

    /** 正文超限。单独一个类型，好跟「读失败」区分开给用户看 */
    static final class TooLarge extends IOException {
        TooLarge() { super("body too large"); }
    }

    /** 最多跟几次重定向 */
    static final int MAX_HOPS = 5;

    static final int DEFAULT_CONNECT_MS = 8000;
    static final int DEFAULT_READ_MS = 15000;

    /** 抓取结果。成功时 text 是**已经解好字符集**的正文。 */
    static final class Result {
        boolean ok;
        String text = "";
        String err = "";
        /** 跟完重定向之后真正取到的地址（空的表示请求根本没发出去） */
        String finalUrl = "";
        /** 正文原始字节数 */
        int bytes = 0;
        int status = 0;
        /** 服务器声明的 Content-Type（只用于排障显示） */
        String contentType = "";

        /** 请求还没发出去就失败了（协议不对、地址为空）—— 建一个干净的结果 */
        static Result fail(String why) {
            return new Result().err(why);
        }

        /**
         * 就地记下失败原因，**保留**已经填好的 status / finalUrl / contentType。
         *
         * ⚠️ 这个「就地」很关键，是被单测逮出来的：早先每处失败都 `return Result.fail(...)`
         *    新造一个对象，于是 404 那一路返回的 Result 里 status 是 0 ——
         *    「服务器返回 HTTP 404」这句话是拼出来了，可状态码字段是空的。
         *    调用方（局域网页面/日志）想知道到底回了几，就永远拿不到。
         */
        Result err(String why) {
            this.ok = false;
            this.err = (why == null || why.isEmpty()) ? "抓取失败" : why;
            return this;
        }
    }

    private PlaylistFetcher() {}

    // =====================================================================
    // 抓取
    // =====================================================================

    static Result fetch(String url) {
        return fetch(url, DEFAULT_CONNECT_MS, DEFAULT_READ_MS);
    }

    /**
     * @param connectMs 连接超时；读超时单独给，灌测试和小超时用
     */
    static Result fetch(String url, int connectMs, int readMs) {
        Result r = new Result();
        if (url == null || url.trim().isEmpty()) return Result.fail("地址是空的");
        String cur = url.trim();
        if (!M3uParser.isStreamUrl(cur)) {
            return Result.fail("只支持 http:// 或 https:// 开头的地址");
        }

        for (int hop = 0; hop <= MAX_HOPS; hop++) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(cur);
                c = (HttpURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(false);   // 自己跟：默认实现不跟 http→https，而且拿不到跳转链
                c.setConnectTimeout(connectMs);
                c.setReadTimeout(readMs);
                c.setUseCaches(false);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept", "*/*");
                // ⚠️ 明确要 identity。不写这一行的话，Android 的 HttpURLConnection 会
                //    自己加 Accept-Encoding: gzip 并透明解压 —— 那是能用的，但
                //    「解压发生在哪一层」就变成了实现细节：万一遇到不透明解压的实现
                //    （或服务器无视 identity 硬发 gzip），下面读到的就是一串二进制。
                //    索性自己声明 identity，再对正文做 gzip 魔数嗅探兜底（见 readAll）。
                c.setRequestProperty("Accept-Encoding", "identity");

                r.status = c.getResponseCode();
                r.contentType = c.getContentType() == null ? "" : c.getContentType();
                r.finalUrl = c.getURL() == null ? cur : c.getURL().toString();

                // ---- 重定向 ----
                if (isRedirect(r.status)) {
                    String loc = c.getHeaderField("Location");
                    try { c.disconnect(); } catch (Throwable ignored) {}
                    if (loc == null || loc.trim().isEmpty()) return r.err("服务器让跳转但没给地址");
                    if (hop == MAX_HOPS) return r.err("跳转次数太多（超过 " + MAX_HOPS + " 次），放弃");
                    // Location 可能是相对路径
                    cur = new URL(new URL(r.finalUrl), loc.trim()).toString();
                    continue;
                }

                if (r.status != 200) {
                    return r.err(describeStatus(r.status));
                }

                byte[] body = readAll(c.getInputStream());
                if (body == null) return r.err("读取正文失败");
                r.bytes = body.length;
                if (body.length == 0) return r.err("抓回来的内容是空的");
                r.text = decode(body, r.contentType);
                r.ok = true;
                return r;

            } catch (TooLarge e) {
                return r.err("内容太大（超过 " + (MAX_BYTES / 1024 / 1024)
                        + "MB），这不像是一份频道清单");
            } catch (UnknownHostException e) {
                return r.err("域名解析不了（" + hostOf(cur) + "）—— 电视没联网，或者这个地址写错了");
            } catch (SocketTimeoutException e) {
                // 连接超时和读超时抛的是同一个异常类型，这里不硬猜是哪种，
                // 给一句对两种情况都成立的话（硬猜反而会误导方向）
                return r.err("超时：对方没能及时回应（网络慢、地址不通，或被网络挡了）");
            } catch (ConnectException e) {
                return r.err("连不上（对方拒绝连接或被网络挡了）");
            } catch (SSLException e) {
                return r.err("HTTPS 握手/证书出错");
            } catch (MalformedURLException e) {
                return r.err("地址格式不对");
            } catch (IOException e) {
                return r.err("网络错误：" + e.getClass().getSimpleName()
                        + (e.getMessage() == null ? "" : " " + e.getMessage()));
            } catch (Throwable t) {
                return r.err("抓取出错：" + t.getClass().getSimpleName());
            } finally {
                if (c != null) { try { c.disconnect(); } catch (Throwable ignored) {} }
            }
        }
        return r.err("跳转次数太多");
    }

    private static boolean isRedirect(int code) {
        return code == 301 || code == 302 || code == 303 || code == 307 || code == 308;
    }

    private static String describeStatus(int code) {
        switch (code) {
            case 403: return "服务器拒绝访问（HTTP 403）—— 这个源可能要特定的请求头";
            case 404: return "地址不存在（HTTP 404）—— 清单可能改名或删掉了";
            case 429: return "请求太频繁（HTTP 429），等一会儿再试";
            case 500: case 502: case 503: case 504: return "服务器出错（HTTP " + code + "）";
            default:  return "服务器返回 HTTP " + code;
        }
    }

    private static String hostOf(String url) {
        try { String h = new URL(url).getHost(); return h == null ? url : h; }
        catch (Throwable t) { return url; }
    }

    /** 读到 EOF，但有上限。超限抛 {@link TooLarge}。 */
    private static byte[] readAll(InputStream rawIn) throws IOException {
        if (rawIn == null) return null;
        InputStream in = rawIn;

        // gzip 魔数嗅探：比信任 Content-Encoding 更可靠 ——
        // 已经透明解压过的实现不会留下这个魔数，所以不会重复解压。
        java.io.PushbackInputStream pb = new java.io.PushbackInputStream(rawIn, 2);
        byte[] magic = new byte[2];
        int got = pb.read(magic);
        if (got > 0) pb.unread(magic, 0, got);
        if (got == 2 && (magic[0] & 0xff) == 0x1f && (magic[1] & 0xff) == 0x8b) {
            in = new GZIPInputStream(pb);
        } else {
            in = pb;
        }

        ByteArrayOutputStream bo = new ByteArrayOutputStream(64 * 1024);
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + n > MAX_BYTES) { in.close(); throw new TooLarge(); }
            bo.write(buf, 0, n);
        }
        in.close();
        return bo.toByteArray();
    }

    // =====================================================================
    // 字符集
    // =====================================================================

    /**
     * 字节 → 字符串。
     *
     * 中文 IPTV 清单有相当一部分是 GBK/GB18030 编码，而服务器**不一定**在
     * Content-Type 里声明 charset。直接按 UTF-8 解会得到一堆 U+FFFD，
     * 台名全变乱码 —— 这种错误看起来像「App 坏了」，其实是编码没猜对。
     *
     * 判定顺序：
     *   ① BOM（UTF-8 / UTF-16 LE / BE）
     *   ② Content-Type 里的 charset=
     *   ③ 严格试解 UTF-8：能解通就是 UTF-8（纯 ASCII 清单也走这条）
     *   ④ 解不通 → GBK（Android 与 JDK 都带）；再不行 GB18030 → 最后 UTF-8 容错兜底
     */
    static String decode(byte[] b, String contentType) {
        if (b == null || b.length == 0) return "";

        // ① BOM
        if (b.length >= 3 && (b[0] & 0xff) == 0xEF && (b[1] & 0xff) == 0xBB && (b[2] & 0xff) == 0xBF) {
            return new String(b, 3, b.length - 3, StandardCharsets.UTF_8);
        }
        if (b.length >= 2 && (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xFE) {
            return new String(b, 2, b.length - 2, StandardCharsets.UTF_16LE);
        }
        if (b.length >= 2 && (b[0] & 0xff) == 0xFE && (b[1] & 0xff) == 0xFF) {
            return new String(b, 2, b.length - 2, StandardCharsets.UTF_16BE);
        }

        // ② 声明过的 charset
        String cs = charsetOf(contentType);
        if (cs != null) {
            Charset c = charsetOrNull(cs);
            if (c != null) return new String(b, c);
        }

        // ③ 严格 UTF-8 试解
        String utf8 = strictDecode(b, StandardCharsets.UTF_8);
        if (utf8 != null) return utf8;

        // ④ 中文老编码
        for (String name : new String[] {"GBK", "GB18030", "GB2312"}) {
            Charset c = charsetOrNull(name);
            if (c == null) continue;
            String s = strictDecode(b, c);
            if (s != null) return s;
        }
        return new String(b, StandardCharsets.UTF_8);   // 兜底：带替换字符也好过抛异常
    }

    /** 从 Content-Type 里取 charset=xxx；没有返回 null */
    static String charsetOf(String contentType) {
        if (contentType == null) return null;
        int i = contentType.toLowerCase(Locale.ROOT).indexOf("charset=");
        if (i < 0) return null;
        String s = contentType.substring(i + 8);

        // ⚠️ 先跳过前导的空白与引号。RFC 2616 允许 charset 参数带引号
        //    （charset="utf-8"），实测也确实有服务器这么发。
        //    不跳的话，下面按第一个字符就把值截成空串 → 白白丢掉一个已经明说的编码。
        //    （这条是单测 t17 逮出来的。）
        int from = 0;
        while (from < s.length()) {
            char c = s.charAt(from);
            if (c == ' ' || c == '\t' || c == '"' || c == '\'') from++;
            else break;
        }
        int end = s.length();
        for (int k = from; k < s.length(); k++) {
            char c = s.charAt(k);
            if (c == ';' || c == ' ' || c == '\t' || c == '"' || c == '\'') { end = k; break; }
        }
        if (end <= from) return null;
        return s.substring(from, end);
    }

    private static Charset charsetOrNull(String name) {
        try { return Charset.forName(name); } catch (Throwable t) { return null; }
    }

    /** 严格解码：遇到非法字节返回 null，而不是静默塞 U+FFFD */
    private static String strictDecode(byte[] b, Charset cs) {
        try {
            CharsetDecoder d = cs.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            CharBuffer cb = d.decode(ByteBuffer.wrap(b));
            return cb.toString();
        } catch (CharacterCodingException e) {
            return null;
        } catch (Throwable t) {
            return null;
        }
    }
}
