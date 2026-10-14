package com.ysptv.player;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.zip.GZIPOutputStream;

/**
 * PlaylistFetcher 的宿主 JVM 单测（不需要 Android、不需要模拟器、不需要外网）。
 *
 * 做法：用 JDK 自带的 com.sun.net.httpserver 在 127.0.0.1 上起一个**桩服务**，
 * 把「远程清单」这个场景里所有会出问题的形态都摆出来 —— 重定向、GBK、BOM、
 * gzip、404/403、超大正文、读超时。全部离线可跑，结果确定。
 *
 * ⚠️ 为什么非要起桩服务：这些分支恰恰是「拿真网址测不到」的。
 *    真清单永远是 200 + UTF-8，GBK 和重定向的路径平时根本走不到，
 *    等真在电视上遇到就已经是用户报障了。
 *
 * 用法（由 tools/custom_source_test.mjs 调起，也可手工跑）：
 *   javac -d /tmp/yspfetchtest -encoding UTF-8 tools/hosttest/PlaylistFetcherTest.java \
 *         yangshipin-tv/app/src/main/java/com/hyj/ysptv/{Source,M3uParser,PlaylistFetcher}.java
 *   java -Dfile.encoding=UTF-8 -cp /tmp/yspfetchtest com.ysptv.player.PlaylistFetcherTest
 *
 * 退出码 0 = 全过；非 0 = 有失败（并打印详情）。
 */
public final class PlaylistFetcherTest {

    private static int pass = 0;
    private static int fail = 0;

    private static HttpServer server;
    private static java.util.concurrent.ExecutorService pool;
    private static String base = "";

    // 两份内容：一份 UTF-8，一份 GBK（同一份清单的两种编码，方便对照）
    private static final String LIST =
            "#EXTM3U\n"
            + "#EXTINF:-1 group-title=\"央视\",CCTV-1 综合\n"
            + "http://a.example/cctv1.m3u8\n"
            + "#EXTINF:-1 group-title=\"卫视\",湖南卫视\n"
            + "http://a.example/hunan.m3u8\n";

    /** 一路直播流自己的清单（不是频道表） */
    private static final String STREAM_MANIFEST =
            "#EXTM3U\n"
            + "#EXT-X-VERSION:3\n"
            + "#EXT-X-TARGETDURATION:6\n"
            + "#EXT-X-MEDIA-SEQUENCE:1523\n"
            + "#EXTINF:6.000,\n"
            + "seg-1523.ts\n"
            + "#EXTINF:6.000,\n"
            + "seg-1524.ts\n";

    private static final String HTML =
            "<!DOCTYPE html>\n<html><head><meta charset=utf-8><title>404</title></head>"
            + "<body><a href=\"http://a.example/x.m3u8\">x</a></body></html>\n";

    public static void main(String[] args) throws Exception {
        if (!Charset.isSupported("GBK")) {
            System.out.println("本 JVM 不支持 GBK，无法验证中文编码分支");
            System.exit(2);
        }
        startServer();
        try {
            t01_plainUtf8();
            t02_gbkWithCharset();
            t03_gbkSniffed();
            t04_utf8Bom();
            t05_relativeRedirect();
            t06_absoluteRedirect();
            t07_redirectLoop();
            t08_http404();
            t09_http403();
            t10_tooLarge();
            t11_gzip();
            t12_readTimeout();
            t13_emptyBody();
            t14_badSchemeAndHost();
            t15_streamManifestAndHtml();
            t16_contentTypeHeader();
            t17_decodeStatics();
        } finally {
            server.stop(0);
            // ⚠️ 线程池必须显式关掉。newFixedThreadPool 建的是**非守护**线程，
            //    server.stop() 不会碰它们 —— 不关的话 main 跑完、用例全过，
            //    JVM 却永远不退出（实测：挂在那儿直到被外部 SIGTERM，
            //    表现成「测试跑到一半无声无息被杀」，很容易被误当成用例卡死）。
            if (pool != null) pool.shutdownNow();
        }

        System.out.println();
        System.out.println("PlaylistFetcherTest: " + pass + " 过 / " + fail + " 失败");
        System.out.flush();
        // 一律显式退出：结果通过退出码表达，也免得还有别的非守护线程把进程吊住
        System.exit(fail > 0 ? 1 : 0);
    }

    // =====================================================================
    // 桩服务
    // =====================================================================

    private static void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        // 必须给线程池：/slow 会占住线程，串行执行会把别的用例一起卡住
        pool = Executors.newFixedThreadPool(4);
        server.setExecutor(pool);

        server.createContext("/ok.m3u", body(200, "text/plain; charset=utf-8",
                LIST.getBytes(StandardCharsets.UTF_8)));
        server.createContext("/gbk-charset.m3u", body(200, "text/plain; charset=GBK",
                LIST.getBytes(Charset.forName("GBK"))));
        // 故意不声明 charset —— 这才是有意思的那条路（只能靠嗅探）
        server.createContext("/gbk-nocs.m3u", body(200, "application/octet-stream",
                LIST.getBytes(Charset.forName("GBK"))));
        server.createContext("/utf8bom.m3u", body(200, "text/plain",
                prepend(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF},
                        LIST.getBytes(StandardCharsets.UTF_8))));

        // 相对 Location：验证 new URL(base, loc) 的拼接
        server.createContext("/redirect", ex -> {
            ex.getResponseHeaders().add("Location", "/ok.m3u");
            ex.sendResponseHeaders(302, -1);
            ex.close();
        });
        server.createContext("/redirect2", ex -> {
            ex.getResponseHeaders().add("Location", base + "/ok.m3u");
            ex.sendResponseHeaders(301, -1);
            ex.close();
        });
        server.createContext("/loop", ex -> {
            ex.getResponseHeaders().add("Location", "/loop");
            ex.sendResponseHeaders(302, -1);
            ex.close();
        });

        server.createContext("/404", body(404, "text/plain", "nope".getBytes(StandardCharsets.UTF_8)));
        server.createContext("/403", body(403, "text/plain", "denied".getBytes(StandardCharsets.UTF_8)));

        // 比 MAX_BYTES 大一点点
        byte[] big = new byte[PlaylistFetcher.MAX_BYTES + 4096];
        java.util.Arrays.fill(big, (byte) 'x');
        server.createContext("/big.txt", body(200, "text/plain", big));

        server.createContext("/gzip.m3u", ex -> {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            GZIPOutputStream gz = new GZIPOutputStream(bo);
            gz.write(LIST.getBytes(StandardCharsets.UTF_8));
            gz.close();
            ex.getResponseHeaders().add("Content-Encoding", "gzip");
            ex.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
            send(ex, 200, bo.toByteArray());
        });

        // 收下请求就装死：用来打读超时那条分支
        server.createContext("/slow.m3u", ex -> {
            try { Thread.sleep(2500); } catch (InterruptedException ignored) {}
            send(ex, 200, LIST.getBytes(StandardCharsets.UTF_8));
        });

        server.createContext("/empty.m3u", body(200, "text/plain", new byte[0]));
        server.createContext("/stream.m3u8", body(200, "application/vnd.apple.mpegurl",
                STREAM_MANIFEST.getBytes(StandardCharsets.UTF_8)));
        server.createContext("/page.html", body(200, "text/html; charset=utf-8",
                HTML.getBytes(StandardCharsets.UTF_8)));

        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** 固定响应体的 handler */
    private static HttpHandler body(int code, String type, byte[] data) {
        return ex -> {
            if (type != null) ex.getResponseHeaders().add("Content-Type", type);
            send(ex, code, data);
        };
    }

    private static void send(HttpExchange ex, int code, byte[] data) throws IOException {
        ex.sendResponseHeaders(code, data.length == 0 ? -1 : data.length);
        if (data.length > 0) {
            OutputStream os = ex.getResponseBody();
            os.write(data);
            os.close();
        }
        ex.close();
    }

    private static byte[] prepend(byte[] head, byte[] body) {
        byte[] out = new byte[head.length + body.length];
        System.arraycopy(head, 0, out, 0, head.length);
        System.arraycopy(body, 0, out, head.length, body.length);
        return out;
    }

    // =====================================================================
    // 断言小工具
    // =====================================================================

    private static void ok(boolean cond, String what) {
        if (cond) { pass++; return; }
        fail++;
        System.out.println("  ✗ " + what);
    }

    private static void eq(Object got, Object want, String what) {
        boolean same = (got == null) ? want == null : got.equals(want);
        if (same) { pass++; return; }
        fail++;
        System.out.println("  ✗ " + what + "  期望[" + want + "] 实际[" + got + "]");
    }

    private static void section(String s) { System.out.println("· " + s); }

    private static void contains(String hay, String needle, String what) {
        boolean c = hay != null && hay.contains(needle);
        if (c) { pass++; return; }
        fail++;
        System.out.println("  ✗ " + what + "（找不到「" + needle + "」）实际: " + hay);
    }

    // =====================================================================
    // 用例
    // =====================================================================

    private static void t01_plainUtf8() {
        section("01 普通 UTF-8 清单");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/ok.m3u");
        ok(r.ok, "抓取成功 " + r.err);
        eq(r.status, 200, "HTTP 200");
        eq(r.bytes, LIST.getBytes(StandardCharsets.UTF_8).length, "字节数与原文一致");
        contains(r.text, "CCTV-1 综合", "中文台名没被弄坏");
        ok(M3uParser.looksLikeChannelList(r.text), "被判定为频道列表");
        eq(M3uParser.parse(r.text, M3uParser.DEFAULT_GROUP).size(), 2, "解析出 2 条");
        ok(r.finalUrl.endsWith("/ok.m3u"), "finalUrl 指向真正取到内容的地址");
    }

    private static void t02_gbkWithCharset() {
        section("02 GBK + 声明了 charset");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/gbk-charset.m3u");
        ok(r.ok, "抓取成功 " + r.err);
        contains(r.text, "湖南卫视", "GBK 中文解对了");
        ok(!r.text.contains("\uFFFD"), "没有替换字符");
    }

    private static void t03_gbkSniffed() {
        section("03 GBK 但【没声明】charset（靠嗅探）");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/gbk-nocs.m3u");
        ok(r.ok, "抓取成功 " + r.err);
        // 这是本文件里最有价值的一条：服务器不声明编码时，按 UTF-8 硬解会得到乱码，
        // 而中文 IPTV 清单恰恰经常不声明。
        contains(r.text, "湖南卫视", "没声明 charset 也能嗅探出 GBK");
        ok(M3uParser.looksLikeChannelList(r.text), "嗅探对了才谈得上解析出东西");
    }

    private static void t04_utf8Bom() {
        section("04 UTF-8 BOM");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/utf8bom.m3u");
        ok(r.ok, "抓取成功 " + r.err);
        ok(r.text.startsWith("#EXTM3U"), "BOM 被剥掉了（否则首行不是 #EXTM3U）");
        contains(r.text, "CCTV-1 综合", "中文正常");
    }

    private static void t05_relativeRedirect() {
        section("05 302 + 相对 Location");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/redirect");
        ok(r.ok, "跟着跳转抓到了 " + r.err);
        contains(r.text, "CCTV-1 综合", "拿到的是目标内容");
        ok(r.finalUrl.endsWith("/ok.m3u"), "finalUrl 是跳转后的地址，实际是 " + r.finalUrl);
    }

    private static void t06_absoluteRedirect() {
        section("06 301 + 绝对 Location");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/redirect2");
        ok(r.ok, "跟着跳转抓到了 " + r.err);
        contains(r.text, "湖南卫视", "拿到的是目标内容");
    }

    private static void t07_redirectLoop() {
        section("07 跳转成环（跳数上限）");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/loop");
        ok(!r.ok, "没被死循环卡死");
        contains(r.err, "跳转", "给出的是「跳转太多」而不是别的错：" + r.err);
    }

    private static void t08_http404() {
        section("08 HTTP 404");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/404");
        ok(!r.ok, "判为失败");
        eq(r.status, 404, "状态码记下来了");
        contains(r.err, "404", "提示里有状态码：" + r.err);
    }

    private static void t09_http403() {
        section("09 HTTP 403");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/403");
        ok(!r.ok, "判为失败");
        contains(r.err, "403", "提示里有状态码：" + r.err);
    }

    private static void t10_tooLarge() {
        section("10 正文超过上限");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/big.txt");
        ok(!r.ok, "没把 " + (PlaylistFetcher.MAX_BYTES / 1024 / 1024) + "MB+ 一口气读进来");
        contains(r.err, "太大", "提示说清了是「太大」：" + r.err);
    }

    private static void t11_gzip() {
        section("11 gzip 正文（Content-Encoding: gzip）");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/gzip.m3u");
        ok(r.ok, "抓取成功 " + r.err);
        // 这条验证的是「魔数嗅探解压」：请求头里写的是 Accept-Encoding: identity，
        // 服务器还是发了 gzip；不嗅探的话这里拿到的会是一堆二进制。
        ok(r.text.startsWith("#EXTM3U"), "gzip 被解开了");
        contains(r.text, "CCTV-1 综合", "解压后中文正常");
    }

    private static void t12_readTimeout() {
        section("12 读超时");
        long t0 = System.currentTimeMillis();
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/slow.m3u", 1000, 700);
        long ms = System.currentTimeMillis() - t0;
        ok(!r.ok, "超时被当成失败");
        contains(r.err, "超时", "提示里说了超时：" + r.err);
        ok(ms < 2300, "确实按超时（" + ms + "ms）返回了，而不是等对方把 2.5s 睡完");
    }

    private static void t13_emptyBody() {
        section("13 空正文");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/empty.m3u");
        ok(!r.ok, "空正文判为失败（否则会被当成「导入 0 条」的假成功）");
        contains(r.err, "空", "提示：" + r.err);
    }

    private static void t14_badSchemeAndHost() {
        section("14 非法协议 / 不存在的域名");
        PlaylistFetcher.Result a = PlaylistFetcher.fetch("file:///etc/passwd");
        ok(!a.ok, "file:// 被挡住（局域网导入服务不能变成任意文件读取）");
        contains(a.err, "http", "提示：" + a.err);

        PlaylistFetcher.Result b = PlaylistFetcher.fetch("");
        ok(!b.ok, "空地址直接失败");

        PlaylistFetcher.Result c = PlaylistFetcher.fetch("http://no-such-host.invalid/x.m3u8", 1500, 1500);
        ok(!c.ok, "不存在的域名失败");
        ok(!c.err.isEmpty(), "有可读的原因：" + c.err);
    }

    private static void t15_streamManifestAndHtml() {
        section("15 直播流清单 / HTML 页（都不是频道列表）");
        PlaylistFetcher.Result s = PlaylistFetcher.fetch(base + "/stream.m3u8");
        ok(s.ok, "抓取成功");
        ok(M3uParser.isStreamManifest(s.text), "识别为「单个流自己的清单」");
        ok(!M3uParser.looksLikeChannelList(s.text), "不会被当成频道列表（否则会导入一堆 .ts 假频道）");

        PlaylistFetcher.Result h = PlaylistFetcher.fetch(base + "/page.html");
        ok(h.ok, "网页也能抓回来（HTTP 层面是成功的）");
        ok(M3uParser.isHtml(h.text), "识别为 HTML");
        ok(!M3uParser.looksLikeChannelList(h.text), "HTML 不会被当成频道列表");
    }

    private static void t16_contentTypeHeader() {
        section("16 服务器声明的 Content-Type 被记下来");
        PlaylistFetcher.Result r = PlaylistFetcher.fetch(base + "/ok.m3u");
        contains(r.contentType, "text/plain", "contentType=" + r.contentType);
    }

    private static void t17_decodeStatics() {
        section("17 decode / charsetOf 纯函数");
        eq(PlaylistFetcher.charsetOf("text/plain; charset=GBK"), "GBK", "带空格");
        eq(PlaylistFetcher.charsetOf("text/plain;charset=utf-8;x=1"), "utf-8", "后面还有别的参数");
        eq(PlaylistFetcher.charsetOf("text/plain; charset=\"UTF-8\""), "UTF-8", "带引号");
        eq(PlaylistFetcher.charsetOf("text/html"), null, "没写就是 null");

        // 纯 ASCII 不该被误判成 GBK（否则「湖南卫视」这种才该走 GBK，纯英文清单走 UTF-8）
        String ascii = "#EXTM3U\nhttp://a/b.m3u8\n";
        eq(PlaylistFetcher.decode(ascii.getBytes(StandardCharsets.US_ASCII), null), ascii, "纯 ASCII");

        // 明确声明 charset 时以声明为准
        String gbkText = "#EXTINF:-1,中文台\n";
        eq(PlaylistFetcher.decode(gbkText.getBytes(Charset.forName("GBK")),
                "text/plain; charset=GBK"), gbkText, "按声明的 GBK 解");
        eq(PlaylistFetcher.decode(gbkText.getBytes(Charset.forName("GBK")), null),
                gbkText, "没声明时靠嗅探解 GBK");

        // UTF-16 LE BOM
        byte[] u16 = prepend(new byte[] {(byte) 0xFF, (byte) 0xFE},
                gbkText.getBytes(StandardCharsets.UTF_16LE));
        eq(PlaylistFetcher.decode(u16, null), gbkText, "UTF-16LE BOM");

        eq(PlaylistFetcher.decode(new byte[0], null), "", "空字节 → 空串");
        eq(PlaylistFetcher.decode(null, null), "", "null → 空串（不能抛）");
    }
}
