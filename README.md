# 央视频 TV · Android TV 客户端

在电视上直接看央视频直播的 Android TV 应用，另带一个**自定义源播放器**（播自己的
m3u8 / mp4）。零第三方依赖 —— 整个 App 只用 Android Framework。

> **⚠️ 这不是央视频官方的 App。** 它把网页上的直播流抽出来在原生播放器里播，
> 站点改版时可能失效。播放地址来自站点自己的网络请求，没有绕过任何付费墙或
> 鉴权，只是把它已经下发给浏览器的地址交给 `MediaPlayer` 去播。

- 当前版本：**1.13**（versionCode 15）
- 最低系统：**Android 7.0**（API 24）
- 包名：`com.ysptv.player`
- 详细文档（含每个版本改了什么、踩了哪些坑）→ [`yangshipin-tv/README.md`](yangshipin-tv/README.md)

---

## 装

仓库里带了编译好的 release 包（约 112 KB）：

```bash
adb install dist/yangshipin-tv-1.12-release.apk
```

或自己构建（需要 JDK 11+ 与 Android SDK）：

```bash
cd yangshipin-tv && ./build.sh release     # 产物在 ../dist/
```

## 遥控器操作

| 按键 | 面板收起 | 面板展开 |
|---|---|---|
| 确认键 | 弹出选台面板 | 选中该台并收起 |
| 上 / 下 | 换上一台 / 下一台 | 移光标 |
| 左 / 右 | 切分组（全部 / 卫视） | 切分组 |
| 菜单键 | 展开面板 | 收起面板 |
| 菜单键**长按 0.7 秒** | 打开自定义源 | 同左 |
| 蓝色功能键 | 打开自定义源 | 同左 |
| 返回键 | 连按两次退出 | 先收起面板 |

**换台防抖**：连按上下键时只移动光标（气泡会跟着走），**停手 250ms 后才真正换台**。
原因是站点那个自研 WASM 播放器经不起反复 detach/mount —— 连按会把它敲到
永久死掉（`readyState 0`），只能 `location.reload()` 复活。防抖期间一次都不碰它。

1.13 又补了两件治「反应慢」的：**换台气泡守到真的出画才撤**（老逻辑 1.6s 就撤，
而站点要 1.3–1.6s 才出画，中间那段「提示没了、画面还是上一台」读起来就是卡住了），
以及**阀门提前解锁** —— 排队不再傻等满 1500ms，站点播放器一出画就发下一趟。

## 自定义源

除了央视频，还能播自己找的流地址（m3u8 / mp4，以及 rtsp / rtmp / udp 这类
系统播放器吃得下的地址）：

- **从网址导入** —— 给一份 m3u 清单的网址，电视自己去抓、解析、整份导入
- **从剪贴板导入** —— 手机上复制好的东西，电视这边按一下就进来了
- **局域网导入** —— 电视起一个临时 HTTP 服务，手机浏览器打开就能填
- **屏上输入** —— 遥控器打字，57 键

订阅的清单会**记住地址**，之后一键同步。同步是**按上游现状对齐**的
（上游下架或改名的台会一起删掉），也可以「退订这份清单」把整份清掉。
只影响这份清单带来的源 —— 你自己手加的、从别的清单加的一概不碰。

## 项目结构

```
yangshipin-tv/          Android App 本体
  app/src/main/
    java/com/ysptv/player/    Java 源码（12 个类，零第三方依赖）
    assets/                    注入脚本与页面（WebView 侧）
  build.sh                构建脚本
  README.md               详细文档：架构、每个版本的改动、踩过的坑
tools/                   开发与验证工具（不属于 APK）
  hosttest/              宿主 JVM 单测（不需要模拟器）
  *.mjs                  设备端测试套件
dist/                    产物（只保留最新一版 release APK）
```

## 验证

改动之后跑一遍（需要一台 TV 模拟器或真机）：

```bash
bash tools/tv-emu.sh debug              # 起模拟器 + 装包 + 开好调试通道

node tools/custom_source_test.mjs       # 自定义源全量（静态 + 单测 + 设备端）
node tools/device_test.mjs              # 主界面全量
node tools/switch_logic_test.mjs        # 换台状态机逻辑级（**不需要设备**）
node tools/switch_debounce_test.mjs     # 换台防抖
node tools/switch_throttle_test.mjs     # 换台节流（防死锁）
node tools/iptv_realworld_test.mjs      # 真实第三方清单
node tools/sync_unlist_test.mjs         # 订阅同步删除与退订
```

宿主 JVM 单测不需要设备：

```bash
node tools/custom_source_test.mjs static
```

## 几条实现上的注意点

- **零第三方依赖**，只用 Android Framework（minSdk 24 意味着可以直接用新 API）。
- **换台节流与防抖是两件事**：节流（1500ms）管「多久能发一趟」，防抖（250ms）管
  「按键停了才发」。前者防的是站点播放器被打死，后者防的是卡顿。
- **节流的 1500ms 不是死等**（1.13）：站点播放器一出画（`readyState>=3` 且在走、
  网络空闲）就提前发下一趟。两条保险：硬下限 60% 阀门（两次碰站点播放器至少隔
  这么久，复现死亡的连按间隔是 120ms），以及到点仍然照发 —— 判不出就绪时行为
  与老逻辑完全一致，不会变成死等。
- **换台气泡守到出画才撤**（1.13）：站点出画要 1.3–1.6s，比气泡原来的 1.6s 寿命
  还长，于是「提示没了、画面还是上一台」。现在守到出画再留 900ms；页面上没有
  `<video>` 时（inject.js 被自定义源页复用）按 1.6s 正常节奏撤，不白等。
- **清单导入会打「来源标记」**（JSON 里的 `"f"` 键）。这是「退订」和「同步删除」
  能实现的前提 —— 没有它就无法区分「这份清单带来的」和「我自己加的」。
- **局域网导入服务无鉴权**，只在浮层打开时监听，同一局域网内任何人都能读写你的源列表。
  它不能当通用代理用（只放行 http/https、正文有 2MB 上限、不回显抓取内容）。
- **判前台用 `dumpsys activity activities` 的 `topResumedActivity`**，不要用
  `dumpsys window` 的 `mCurrentFocus` —— 后者在模拟器上会返回 null 造成假失败。
