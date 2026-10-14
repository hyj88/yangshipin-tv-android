package com.ysptv.player;

import android.content.Context;
import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * 局域网导入服务 —— 电视上敲字太痛苦，把导入这件事挪到手机/电脑上做。
 *
 * 纯 {@link ServerSocket} 手写的极简 HTTP/1.1，不引任何第三方库（整个工程零依赖）。
 * 只在「源管理」浮层打开时监听，关掉浮层立刻停 —— 不常驻端口。
 *
 * 路由：
 *   GET  /               表单页（assets/lan_import.html）
 *   GET  /api/list       现有源（JSON）+ 记住的远程清单地址
 *   POST /api/add        导入正文，自动判断是 m3u 播放列表还是一行地址
 *   POST /api/addurl     给一个**网址**，由 App 自己去抓（频道清单→整份导入；直播流→收下这条）
 *   POST /api/refresh    重新抓一次记住的清单地址
 *   POST /api/clear      清空全部
 *   GET  /favicon.ico    204
 *
 * ⚠️ /api/addurl 与 /api/refresh 会联网（走 {@link SourceImport}）。这两条在本类的
 *    服务线程上跑，不占主线程 —— 但单线程串行处理意味着「一次慢抓取会把整页的其他
 *    请求排队」。这里只有一台手机开着表单，权衡下来不值得为它上线程池。
 *
 * 安全取舍：局域网内无鉴权。它只能往本 App 自己的配置里写几条播放地址，
 * 不涉及任何账号/文件访问；而且【只在浮层打开的那几分钟】监听。
 * 另外它**不能**被当成通用代理用：抓取地址必须过 {@link M3uParser#isStreamUrl}
 * （只放 http/https），返回内容也不会回显给请求方 —— 只能变成源列表里的条目。
 * 这点风险换「不用在电视上打字」，值。
 */
final class LanImportServer {

    private static final String TAG = "YSPTV";
    private static final int MAX_BODY = 4 * 1024 * 1024;   // 4MB，够放几万条 m3u
    private static final int MAX_HEADER = 16 * 1024;
    private static final int SOCKET_TIMEOUT_MS = 20000;

    interface Listener {
        /** 源列表被改动了（导入/清空都算），让界面刷新 */
        void onSourcesChanged();
    }

    private final Context app;
    private final Listener listener;

    private ServerSocket server;
    private Thread thread;
    private volatile boolean running = false;
    private int port = 0;
    private String addresses = "";

    LanImportServer(Context ctx, Listener listener) {
        this.app = ctx.getApplicationContext();
        this.listener = listener;
    }

    boolean isRunning() { return running; }

    /** 供界面显示的地址（可能有多块网卡 → 多个地址） */
    synchronized String addressText() { return addresses; }

    synchronized int port() { return port; }

    // =====================================================================
    // 开 / 关
    // =====================================================================

    /**
     * 启动（幂等：已经在跑就直接把现有地址再报一遍）。
     *
     * @return 出错原因；成功返回 null
     */
    synchronized String start() {
        if (running) return null;
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress("0.0.0.0", 0));   // 端口交给系统挑
            port = server.getLocalPort();
            running = true;
        } catch (Throwable t) {
            Log.w(TAG, "局域网导入服务启动失败", t);
            closeQuietly();
            return "端口无法监听（" + t.getClass().getSimpleName() + "）";
        }

        addresses = buildAddressText(port);
        if (addresses.isEmpty()) {
            stop();
            return "没有找到可用的局域网 IP（是不是没连 Wi-Fi/网线？）";
        }

        thread = new Thread(new Runnable() {
            @Override public void run() { loop(); }
        }, "ysp-lan-import");
        thread.setDaemon(true);
        thread.start();
        Log.i(TAG, "局域网导入服务已启动 " + addresses);
        return null;
    }

    synchronized void stop() {
        running = false;
        closeQuietly();
        Thread t = thread;
        thread = null;
        if (t != null) t.interrupt();
        port = 0;
        addresses = "";
    }

    private void closeQuietly() {
        try { if (server != null) server.close(); } catch (Throwable ignored) {}
        server = null;
    }

    // =====================================================================
    // 地址枚举
    // =====================================================================

    private static String buildAddressText(int port) {
        List<String> ips = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis != null) {
                for (NetworkInterface ni : Collections.list(nis)) {
                    try {
                        if (!ni.isUp() || ni.isLoopback()) continue;
                        for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                            if (a.isLoopbackAddress() || !(a instanceof Inet4Address)) continue;
                            String ip = a.getHostAddress();
                            if (ip == null || ip.isEmpty() || ips.contains(ip)) continue;
                            ips.add(ip);
                        }
                    } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "枚举网卡失败", t);
        }

        // 常见的家用/办公网段排前面，用户一眼就能认出该用哪个
        Collections.sort(ips, new java.util.Comparator<String>() {
            @Override public int compare(String a, String b) {
                return rank(a) - rank(b);
            }
            private int rank(String ip) {
                if (ip.startsWith("192.168.")) return 0;
                if (ip.startsWith("10.")) return 1;
                if (ip.startsWith("172.")) return 2;
                return 3;
            }
        });

        StringBuilder sb = new StringBuilder();
        for (String ip : ips) {
            if (sb.length() > 0) sb.append("    ");
            sb.append("http://").append(ip).append(':').append(port).append('/');
        }
        return sb.toString();
    }

    // =====================================================================
    // 服务循环
    //
    // 单线程串行处理，且处理完一条再 accept 下一条。
    // 这里不会有并发压力（就一台手机开个表单），省掉线程池 + 并发写配置的麻烦。
    // =====================================================================

    private void loop() {
        while (running) {
            Socket s = null;
            try {
                ServerSocket ss = server;
                if (ss == null) break;
                s = ss.accept();
                s.setSoTimeout(SOCKET_TIMEOUT_MS);
                handle(s);
            } catch (Throwable t) {
                if (running) Log.w(TAG, "处理请求出错: " + t);
            } finally {
                try { if (s != null) s.close(); } catch (Throwable ignored) {}
            }
        }
    }

    private void handle(Socket s) throws IOException {
        InputStream in = s.getInputStream();

        // ---- 请求行 + 头（按字节读，别用 readLine 把 body 吃掉）----
        String head = readHead(in);
        if (head == null) return;
        String[] lines = head.split("\r\n");
        if (lines.length == 0) return;

        String[] req = lines[0].split(" ");
        if (req.length < 2) return;
        String method = req[0];
        String path = req[1];
        int q = path.indexOf('?');
        String query = (q >= 0) ? path.substring(q + 1) : "";
        if (q >= 0) path = path.substring(0, q);

        int contentLength = 0;
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            String k = lines[i].substring(0, c).trim();
            if (!"content-length".equalsIgnoreCase(k)) continue;
            try { contentLength = Integer.parseInt(lines[i].substring(c + 1).trim()); }
            catch (NumberFormatException ignored) {}
        }
        if (contentLength > MAX_BODY) { sendText(s, 413, "text/plain; charset=utf-8", "too large"); return; }

        byte[] body = readBody(in, contentLength);

        // ---- 路由 ----
        if ("/favicon.ico".equals(path)) { sendText(s, 204, "text/plain", ""); return; }

        if ("/api/list".equals(path)) { sendJson(s, listJson()); return; }

        if ("/api/clear".equals(path)) {
            if (!"POST".equals(method)) { sendText(s, 405, "text/plain; charset=utf-8", "POST only"); return; }
            SourceStore.clear(app);
            notifyChanged();
            // 清单地址是故意留着的（见 SourceStore.clear 的说明），提示里说一句，
            // 免得用户以为「清空」把订阅也弄丢了
            String rem = SourceStore.loadRemoteUrl(app);
            String msg = rem.isEmpty()
                    ? "已清空"
                    : "已清空。记住的清单地址还留着，点「重新导入上次的」就能拉回来";
            sendJson(s, "{\"ok\":true,\"total\":0,\"msg\":" + quote(msg) + "}");
            return;
        }

        if ("/api/add".equals(path)) {
            if (!"POST".equals(method)) { sendText(s, 405, "text/plain; charset=utf-8", "POST only"); return; }
            String text = new String(body, StandardCharsets.UTF_8);
            // 表单提交时是 urlencoded 的
            if (text.startsWith("text=") || text.indexOf("&text=") >= 0) {
                String decoded = formGet(text, "text");
                if (decoded != null) text = decoded;
            }
            String name = formGet(text, "name");   // 极少用得上，有就顺手支持
            handleAdd(s, text, name);
            return;
        }

        if ("/api/addurl".equals(path)) {
            if (!"POST".equals(method)) { sendText(s, 405, "text/plain; charset=utf-8", "POST only"); return; }
            String raw = new String(body, StandardCharsets.UTF_8);
            String url = formGet(raw, "url");
            if (url == null) url = raw.trim();            // 也允许直接 POST 一整个网址
            handleAddUrl(s, url, formGet(raw, "name"));
            return;
        }

        if ("/api/refresh".equals(path)) {
            if (!"POST".equals(method)) { sendText(s, 405, "text/plain; charset=utf-8", "POST only"); return; }
            handleRefresh(s);
            return;
        }

        if ("/".equals(path) || "/index.html".equals(path)) {
            sendText(s, 200, "text/html; charset=utf-8", page());
            return;
        }

        // 其余路径也回表单页：用户少敲一个字符也能到
        sendText(s, 200, "text/html; charset=utf-8", page());
    }

    private void handleAdd(Socket s, String text, String fallbackName) throws IOException {
        if (text == null || text.trim().isEmpty()) {
            sendJson(s, "{\"ok\":false,\"msg\":\"内容是空的\"}");
            return;
        }
        SourceImport.Result r = new SourceImport(app).importText(text, fallbackName);
        if (r.added > 0) notifyChanged();
        sendJson(s, resultJson(r));
    }

    /** 用户给的是一个**网址**：由 App 自己去抓，抓到频道清单就整份导入 */
    private void handleAddUrl(Socket s, String url, String name) throws IOException {
        if (url == null || url.trim().isEmpty()) {
            sendJson(s, "{\"ok\":false,\"msg\":\"网址是空的\"}");
            return;
        }
        SourceImport.Result r = new SourceImport(app).importUrl(url, name);
        if (r.added > 0) notifyChanged();
        sendJson(s, resultJson(r));
    }

    /** 用记住的清单地址再抓一次 */
    private void handleRefresh(Socket s) throws IOException {
        SourceImport.Result r = new SourceImport(app).refreshRemote();
        if (r.added > 0) notifyChanged();
        sendJson(s, resultJson(r));
    }

    /**
     * 统一的返回体。字段和 /api/add 的老响应保持兼容（ok/added/parsed/total/msg 都在），
     * 再加几个「这次到底干了什么」的字段，页面好据此说话。
     */
    private static String resultJson(SourceImport.Result r) {
        return "{\"ok\":" + r.ok
                + ",\"isList\":" + r.isList
                + ",\"fetched\":" + r.fetched
                + ",\"parsed\":" + r.parsed
                + ",\"added\":" + r.added
                + ",\"total\":" + r.total
                + ",\"fetchErr\":" + quote(r.fetchErr)
                + ",\"listUrl\":" + quote(r.listUrl)
                + ",\"msg\":" + quote(r.msg) + "}";
    }

    private String listJson() {
        List<Source> l = SourceStore.load(app);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"total\":").append(l.size())
          .append(",\"max\":").append(M3uParser.MAX_ITEMS)
          .append(",\"remote\":").append(quote(SourceStore.loadRemoteUrl(app)))
          .append(",\"items\":[");
        int n = 0;
        for (Source s : l) {
            if (n >= 400) break;                 // 页面只展示前 400 条，别撑爆浏览器
            if (n > 0) sb.append(',');
            sb.append("{\"name\":").append(quote(s.display()))
              .append(",\"group\":").append(quote(s.groupOr("")))
              .append(",\"url\":").append(quote(s.url)).append('}');
            n++;
        }
        sb.append("]}");
        return sb.toString();
    }

    private void notifyChanged() {
        if (listener != null) {
            try { listener.onSourcesChanged(); } catch (Throwable ignored) {}
        }
    }

    private String page() {
        try {
            return readAsset("lan_import.html");
        } catch (Throwable t) {
            Log.w(TAG, "读 lan_import.html 失败", t);
            return "<!DOCTYPE html><meta charset=utf-8><h1>页面资源缺失</h1>";
        }
    }

    private String readAsset(String name) throws IOException {
        InputStream is = app.getAssets().open(name);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    // =====================================================================
    // HTTP 细节
    // =====================================================================

    /** 读到空行为止。返回整段头（不含结尾的空行）。 */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int state = 0;   // 累计匹配到的 \r\n\r\n
        while (bo.size() < MAX_HEADER) {
            int c = in.read();
            if (c < 0) return bo.size() == 0 ? null : new String(bo.toByteArray(), StandardCharsets.ISO_8859_1);
            bo.write(c);
            if ((state == 0 || state == 2) && c == '\r') state++;
            else if ((state == 1 || state == 3) && c == '\n') state++;
            else state = 0;
            if (state == 4) break;
        }
        String s = new String(bo.toByteArray(), StandardCharsets.ISO_8859_1);
        int end = s.indexOf("\r\n\r\n");
        if (end >= 0) s = s.substring(0, end);
        return s;
    }

    private static byte[] readBody(InputStream in, int len) throws IOException {
        if (len <= 0) return new byte[0];
        byte[] b = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(b, off, len - off);
            if (n < 0) break;
            off += n;
        }
        if (off == len) return b;
        byte[] out = new byte[off];
        System.arraycopy(b, 0, out, 0, off);
        return out;
    }

    private static void sendText(Socket s, int code, String type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        OutputStream os = new BufferedOutputStream(s.getOutputStream());
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n\r\n");
        os.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        os.write(b);
        os.flush();
    }

    private static void sendJson(Socket s, String json) throws IOException {
        sendText(s, 200, "application/json; charset=utf-8", json);
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 405: return "Method Not Allowed";
            case 413: return "Payload Too Large";
            default:  return "OK";
        }
    }

    /** JSON 字符串字面量。手写而不是引 org.json，省得为一行转义拉个依赖。 */
    private static String quote(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /** 从 urlencoded 里取一个字段（自己解，不引 URLEncoder/URLDecoder 的异常噪音） */
    static String formGet(String qs, String key) {
        if (qs == null || key == null) return null;
        String[] parts = qs.split("&");
        for (String p : parts) {
            int eq = p.indexOf('=');
            if (eq <= 0) continue;
            String k = p.substring(0, eq);
            if (!k.equals(key)) continue;
            try {
                return URLDecoder.decode(p.substring(eq + 1), "UTF-8");
            } catch (UnsupportedEncodingException e) {
                return p.substring(eq + 1);
            } catch (IllegalArgumentException e) {
                return p.substring(eq + 1);
            }
        }
        return null;
    }
}
