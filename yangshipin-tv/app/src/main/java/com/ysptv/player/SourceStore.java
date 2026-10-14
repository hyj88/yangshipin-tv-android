package com.ysptv.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 自定义源的持久化。
 *
 * 存哪儿：SharedPreferences 里一个 JSON 字符串。
 * 为什么不落文件：源列表是「用户手工维护的几十上百条」，不是日志。
 * 用 prefs 的好处是原子写入 + 系统自动备份，坏处是别塞太大 —— 所以
 * {@link M3uParser#MAX_ITEMS} 加了上限。
 *
 * JSON 形态（键名刻意用单字母压体积）：
 *   [{"n":"CCTV-1 综合","u":"http://a/b.m3u8","g":"央视",
 *     "f":"http://清单地址/cn_all.m3u8",
 *     "h":{"User-Agent":"Mozilla/5.0"}}]
 *
 * ⚠️ "f"（from）是 v1.11 加的：记录这条来自哪份清单，是「退订」和
 *    「刷新时同步删除」的地基。1.10 及以前存的条目没有这个字段，
 *    读出来是 null → 当作「自己手加的」，同步删除时一概不碰（保守，见 syncFrom）。
 */
final class SourceStore {

    private static final String TAG = "YSPTV";

    private static final String PREF = "ysp_custom";
    private static final String K_LIST = "sources";
    private static final String K_CUR = "cur_url";
    /**
     * 上次成功导入的**远程清单地址**（best-fan/iptv-sources 那种聚合清单）。
     * 记住它是为了让「刷新远程清单」变成一次按键的事 —— 这类清单的用法本来就是
     * 「记住一个网址、隔几天重新拉一次」。
     */
    private static final String K_REMOTE = "remote_list_url";

    private SourceStore() {}

    // =====================================================================
    // 读写
    // =====================================================================

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /** 读全部源。解析失败一律当空表，绝不让脏数据把界面搞挂。 */
    static List<Source> load(Context c) {
        List<Source> out = new ArrayList<>();
        String raw;
        try {
            raw = prefs(c).getString(K_LIST, "");
        } catch (Throwable t) {
            Log.w(TAG, "读自定义源失败", t);
            return out;
        }
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Source s = new Source(o.optString("n", null), o.optString("u", null),
                        o.optString("g", null), o.optString("f", null));
                if (s.url == null || s.url.isEmpty()) continue;
                JSONObject h = o.optJSONObject("h");
                if (h != null) {
                    for (java.util.Iterator<String> it = h.keys(); it.hasNext(); ) {
                        String k = it.next();
                        String v = h.optString(k, "");
                        if (!v.isEmpty()) s.headers.put(k, v);
                    }
                }
                out.add(s);
            }
        } catch (Throwable t) {
            Log.w(TAG, "解析自定义源 JSON 失败，按空表处理: " + t);
            return new ArrayList<>();
        }
        return out;
    }

    static void save(Context c, List<Source> list) {
        try {
            JSONArray arr = new JSONArray();
            if (list != null) {
                for (Source s : list) {
                    if (s == null || s.url == null || s.url.isEmpty()) continue;
                    JSONObject o = new JSONObject();
                    o.put("n", s.name == null ? "" : s.name);
                    o.put("u", s.url);
                    o.put("g", s.group == null ? "" : s.group);
                    // "f" 只在有值时写：手加的条目不写这个键，JSON 体积小一点
                    if (s.from != null && !s.from.isEmpty()) o.put("f", s.from);
                    if (!s.headers.isEmpty()) {
                        JSONObject h = new JSONObject();
                        for (Map.Entry<String, String> e : s.headers.entrySet()) {
                            h.put(e.getKey(), e.getValue());
                        }
                        o.put("h", h);
                    }
                    arr.put(o);
                }
            }
            prefs(c).edit().putString(K_LIST, arr.toString()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "保存自定义源失败", t);
        }
    }

    /**
     * 合并导入：按 URL 去重，返回**新增**的条数。
     *
     * 去重只认 URL —— 同一个地址被别人起了不同名字、或分到别的组，那是重复，不是新台。
     * 但如果是「同一个 URL 换了名字」的重复项，保留旧的（用户可能已经改过名）。
     */
    static int merge(Context c, List<Source> add) {
        if (add == null || add.isEmpty()) return 0;
        List<Source> cur = load(c);
        Set<String> seen = new HashSet<>();
        for (Source s : cur) seen.add(s.url);

        int added = 0;
        for (Source s : add) {
            if (s == null || s.url == null || s.url.isEmpty()) continue;
            if (!seen.add(s.url)) continue;
            if (cur.size() >= M3uParser.MAX_ITEMS) break;
            cur.add(s);
            added++;
        }
        if (added > 0) save(c, cur);
        return added;
    }

    /**
     * 一次「同步式刷新」的结果。
     * 用一个类而不是两个 int，是因为调用方要能分别说清「加了几条」「删了几条」——
     * 用户看到「清单已更新：新增 3 条、删除 27 条」远比「已刷新」有信息量。
     */
    static final class SyncResult {
        /** 本次清单里有、之前没有的 → 新增 */
        int added;
        /** 之前属于这份清单、这次清单里没有的 → 删除（= 上游下架/改名） */
        int removed;
        /** 上游条目数 */
        int parsed;
        /** 刷新后列表总数 */
        int total;
        /** 删掉之前正在播的那条吗（true = 播放被中断，得让调用方重新起播） */
        boolean playingRemoved;
        /** 同步之后应有的完整列表（由 {@link #planSync} 填好，调用方直接 save） */
        List<Source> kept = new ArrayList<>();
    }

    /**
     * 同步的**纯计算**部分：给定「当前列表」「这次拉到的清单」「清单地址」，
     * 算出「应该变成什么样」。
     *
     * ⚠️ 刻意做成不碰 Context / SharedPreferences 的纯函数：
     *    边界规则（哪些能删、哪些绝不能碰）是这个功能最容易写错的地方，
     *    做成纯函数才能在宿主 JVM 上单测（tools/hosttest/SourceSyncTest.java）。
     *    真跑一次设备才知道代价：「删多了」比「删少了」严重得多
     *    —— 一次误删可能把用户辛苦攒的 172 条真台清掉。
     */
    static SyncResult planSync(List<Source> cur, List<Source> parsed,
                               String listUrl, String curPlaying) {
        SyncResult r = new SyncResult();
        // ⚠️ 没有清单地址（退订之后、或从没导入过）→ **原样返回 cur，一个都不动**。
        //    这里以前写成「kept 留空然后 return」：单测立刻抓到了它 ——
        //    返回的 kept 和实际存储不一致（syncFrom 靠 `!kept.isEmpty()` 侥幸
        //    没触发 save，才没出事）。这种「靠下游兜底才不出错」的写法早晚会出事，
        //    而且一次误判就是清空用户列表 —— 属于绝对不能有的隐患。
        if (listUrl == null || listUrl.isEmpty()) {
            if (cur != null) r.kept.addAll(cur);
            r.total = r.kept.size();
            return r;
        }
        List<Source> kept = new ArrayList<>();

        Set<String> inList = new HashSet<>();
        if (parsed != null) {
            for (Source s : parsed) {
                if (s == null || s.url == null || s.url.isEmpty()) continue;
                inList.add(s.url);
            }
        }
        r.parsed = inList.size();

        // ---- ① 先删：属于这份清单、但这次清单里没有的 ----
        if (cur != null) {
            for (Source s : cur) {
                if (s == null || s.url == null || s.url.isEmpty()) continue;
                if (s.fromList(listUrl) && !inList.contains(s.url)) {
                    r.removed++;
                    if (s.sameAsUrl(curPlaying)) r.playingRemoved = true;
                    continue;                     // 删掉
                }
                kept.add(s);
            }
        }

        // ---- ② 再增：清单里有、列表里没有的 ----
        Set<String> seen = new HashSet<>();
        for (Source s : kept) seen.add(s.url);
        if (parsed != null) {
            for (Source s : parsed) {
                if (s == null || s.url == null || s.url.isEmpty()) continue;
                if (!seen.add(s.url)) {
                    // 已在列表里：把「已存在的那条」也标上来源，
                    // 这样下一次同步才能正确判断它该不该活 ——
                    // 老条目（1.10 及以前导入的，from 为 null）靠这一步补上 from。
                    markFrom(kept, s.url, listUrl);
                    continue;
                }
                if (kept.size() >= M3uParser.MAX_ITEMS) break;
                Source copy = new Source(s.name, s.url, s.group, listUrl);
                copy.headers.putAll(s.headers);
                kept.add(copy);
                r.added++;
            }
        }

        r.kept = kept;
        r.total = kept.size();
        return r;
    }

    /**
     * 同步式刷新：把 {@code parsed} 当作 {@code listUrl} 这份清单的**完整现状**。
     *
     * 与 {@link #merge} 的区别就在这一句：merge 只增不减（老条目永远留着），
     * syncFrom 会把「属于这份清单、但这次清单里已经没有」的条目**删掉**。
     * 用户抱怨的正是这个：清单上游下架/改名了一堆台，App 里还留着失效的条目，
     * 而删除模式要一条一条划，172 条根本划不完。
     *
     * ⚠️ **只删「from == listUrl」的条目**，两种一律不碰：
     *    ① 自己手加的（from 为 null）；
     *    ② 来自**别的**清单的。
     *    这条边界很重要 —— 否则「退订 A 清单」会顺手删掉用户从 B 清单加的台。
     *
     * ⚠️ 1.10 及以前导入的条目没有 from 字段（null），所以**第一次同步刷新不会删任何东西**
     *    （它们看起来像手加的）。这是有意的保守选择：宁可第一次不删，
     *    也不能把用户 172 条真台当垃圾清掉。删完这次之后，from 就齐全了。
     */
    static SyncResult syncFrom(Context c, List<Source> parsed, String listUrl) {
        SyncResult r = planSync(load(c), parsed, listUrl, loadCurrentUrl(c));
        if (r.added > 0 || r.removed > 0 || !r.kept.isEmpty()) {
            save(c, r.kept);
            if (r.playingRemoved) prefs(c).edit().remove(K_CUR).apply();
        }
        return r;
    }

    /** 给「已存在于列表里」的那一条补上来源标记（就地改，不触发保存，由调用方统一 save） */
    private static void markFrom(List<Source> list, String url, String listUrl) {
        for (Source s : list) {
            if (s.sameAsUrl(url) && s.from == null) { s.from = listUrl; return; }
        }
    }

    /**
     * 退订：删掉所有「来自这份清单」的条目。
     *
     * 顺带把 {@link #K_CUR} 里可能指向这些条目的「正在播」清掉 —— 不然
     * 退订之后播放器还抱着一条已经不存在的源，下一次重载会莫名其妙地失败。
     *
     * @return 被删掉的条数
     */
    static int unlist(Context c, String listUrl) {
        if (listUrl == null || listUrl.isEmpty()) return 0;
        List<Source> cur = load(c);
        String curPlaying = loadCurrentUrl(c);
        List<Source> kept = new ArrayList<>();
        int removed = 0;
        boolean playingGone = false;
        for (Source s : cur) {
            if (s.fromList(listUrl)) {
                removed++;
                if (s.sameAsUrl(curPlaying)) playingGone = true;
                continue;
            }
            kept.add(s);
        }
        if (removed > 0) {
            save(c, kept);
            if (playingGone) prefs(c).edit().remove(K_CUR).apply();
        }
        return removed;
    }

    /** 有多少条是来自这份清单的（菜单上提示用） */
    static int countFrom(Context c, String listUrl) {
        if (listUrl == null || listUrl.isEmpty()) return 0;
        int n = 0;
        for (Source s : load(c)) if (s.fromList(listUrl)) n++;
        return n;
    }

    /**
     * 清空全部源。
     *
     * ⚠️ 故意**不删** {@link #K_REMOTE}：清单地址不是「源」，而是「怎么把源弄回来」。
     *    用户清空之后最常见的下一步就是「重新导入一遍」，把地址留着，
     *    「刷新远程清单」一按就回来了。要是连它一起清掉，用户就得重新对着电视打一遍
     *    那一长串网址 —— 这正是加网址导入要避免的事。
     *    （要连地址一起清，用「退订」—— 那是另一件事，见 {@link #unlist}。）
     */
    static void clear(Context c) {
        try {
            prefs(c).edit().remove(K_LIST).remove(K_CUR).apply();
        } catch (Throwable t) {
            Log.w(TAG, "清空自定义源失败", t);
        }
    }

    // =====================================================================
    // 远程清单地址
    // =====================================================================

    static void saveRemoteUrl(Context c, String url) {
        try {
            prefs(c).edit().putString(K_REMOTE, url == null ? "" : url).apply();
        } catch (Throwable t) {
            Log.w(TAG, "记住清单地址失败", t);
        }
    }

    /** 没记住过返回 ""（不返回 null，调用方少判一次） */
    static String loadRemoteUrl(Context c) {
        try {
            String s = prefs(c).getString(K_REMOTE, "");
            return s == null ? "" : s;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 忘掉清单地址（v1.11：退订用）。
     *
     * ⚠️ 和 {@link #clear} 刻意相反：清空全部源要**留着**地址（方便一键拉回来），
     *    退订则必须**清掉** —— 留着就还能一键拉回来，那不叫退订。
     */
    static void clearRemoteUrl(Context c) {
        try {
            prefs(c).edit().remove(K_REMOTE).apply();
        } catch (Throwable t) {
            Log.w(TAG, "清除清单地址失败", t);
        }
    }

    // =====================================================================
    // 上次播放的是哪一条
    // =====================================================================

    /** 记住「上次播的那条」的 URL，下次进来自动接着播 */
    static void saveCurrentUrl(Context c, String url) {
        try {
            prefs(c).edit().putString(K_CUR, url == null ? "" : url).apply();
        } catch (Throwable t) {
            Log.w(TAG, "记住当前源失败", t);
        }
    }

    static String loadCurrentUrl(Context c) {
        try {
            return prefs(c).getString(K_CUR, "");
        } catch (Throwable t) {
            return "";
        }
    }

    // =====================================================================
    // 分组
    // =====================================================================

    /**
     * 按分组切成有序的 map，并且**把「全部」放在第一组**。
     *
     * 用 LinkedHashMap 而不是 HashMap：面板上的 tab 顺序必须稳定，
     * 否则每次进来自定义源，tab 都可能换位置。
     */
    static Map<String, List<Source>> group(List<Source> list) {
        Map<String, List<Source>> m = new LinkedHashMap<>();
        List<Source> all = new ArrayList<>();
        if (list != null) {
            for (Source s : list) {
                if (s == null) continue;
                all.add(s);
                String g = s.groupOr(M3uParser.DEFAULT_GROUP);
                List<Source> bucket = m.get(g);
                if (bucket == null) { bucket = new ArrayList<>(); m.put(g, bucket); }
                bucket.add(s);
            }
        }
        Map<String, List<Source>> out = new LinkedHashMap<>();
        out.put(ALL_GROUP, all);
        out.putAll(m);
        return out;
    }

    /** 「全部」这个虚拟分组名 */
    static final String ALL_GROUP = "全部";
}
