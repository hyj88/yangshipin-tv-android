#!/bin/bash
# 央视频TV —— 一键构建 debug APK
# 依赖：本机已装 JDK17、Android SDK(platform 34 + build-tools 36)、Gradle 8.7 缓存
set -e

cd "$(dirname "$0")"

# --- 同步注入脚本 ---
# ⚠️ 必须做：APK 里的 assets/inject.{css,js} 是 tools/ 下那份的副本。
# 忘了同步 = 改了源码但 APK 里还是旧样式（这个坑踩过一次）。
SRC="../tools"
for f in inject.css inject.js; do
  if [ -f "$SRC/$f" ]; then
    if ! cmp -s "$SRC/$f" "app/src/main/assets/$f"; then
      cp "$SRC/$f" "app/src/main/assets/$f"
      echo "synced  assets/$f  ←  tools/$f"
    else
      echo "ok      assets/$f  (已是最新)"
    fi
  else
    echo "警告：找不到 $SRC/$f"; exit 1
  fi
done

# --- 校验「自定义源」那几张资源 ---
# 这几个没有 tools/ 副本（assets 下就是正本），但缺一个 App 就会白屏 / 导入页 404，
# 而且都是在运行时才炸，所以构建时先拦一道。
for f in custom.html custom.css custom.js inject.css inject.js lan_import.html; do
  if [ ! -s "app/src/main/assets/$f" ]; then
    echo "错误：assets/$f 缺失或为空"; exit 1
  fi
done
echo "ok      assets/custom.{html,css,js} + lan_import.html"

# --- JDK：必须有 JDK 17+，并且用当前仓库的 Wrapper 统一 Gradle 版本 ---
# 这里不再依赖机器里是否装过某个版本的 Gradle；wrapper 自己下载对应分发包，
# 这样新环境 / CI / 其它开发机都能复现同一套构建工具链。
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  if [ -z "$JAVA_HOME" ]; then
    JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || true)"
  fi
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "找不到 JDK 17+。请先安装 JDK 17，或执行：export JAVA_HOME=..." >&2
  exit 1
fi
export JAVA_HOME
echo "JAVA_HOME=$JAVA_HOME"

# --- Android SDK：优先使用环境变量；否则按常见目录兜底 ---
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [ ! -d "$ANDROID_HOME" ] || [ ! -d "$ANDROID_HOME/platforms" ] || [ ! -d "$ANDROID_HOME/build-tools" ]; then
  echo "Android SDK 未就绪：$ANDROID_HOME" >&2
  echo "请先安装 platform 34 与 build-tools 36.0.0，或设置 ANDROID_HOME / ANDROID_SDK_ROOT。" >&2
  exit 1
fi
echo "ANDROID_HOME=$ANDROID_HOME"

# --- Gradle：仓库内 wrapper 统一版本，不再依赖本机全局 Gradle ---
if [ ! -x "$PWD/gradlew" ]; then
  echo "找不到 ./gradlew；先在项目根目录生成 wrapper（gradle wrapper --gradle-version 8.7）。" >&2
  exit 1
fi
echo "GRADLE_WRAPPER=./gradlew"

# --- 先 clean ---
# ⚠️ 必须 clean，别指望增量。踩过一次，代价是一整轮回归跑在旧包上：
#   改完 assets/custom.js（18:22）后连着 build debug + release，
#   release 是新的、debug 却是旧的（`mergeDebugAssets` 认了缓存），
#   而设备端套件用的是 debug 包 —— 于是「跑绿了」这件事本身不成立。
#   这个工程总共几十个源文件，clean 之后也就几秒，不值得为省这点时间冒这个险。
./gradlew --no-daemon --console=plain clean

./gradlew --no-daemon --console=plain :app:assembleDebug

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  # debug 包也进 dist（成套件用，也免得再出现「dist 里那个 debug 是旧的」）
  VER_D="$(grep -m1 'versionName' app/build.gradle | sed -E 's/.*"([^"]+)".*/\1/')"
  mkdir -p ../dist
  cp "$APK" "../dist/yangshipin-tv-${VER_D}-debug.apk"
  echo ""
  echo "==================================================="
  echo " 构建成功"
  echo " APK: $(pwd)/$APK"
  echo " 体积: $(du -h "$APK" | cut -f1)"
  echo " 已同步到: ../dist/yangshipin-tv-${VER_D}-debug.apk"
  echo "==================================================="
else
  echo "构建结束但未找到 APK"; exit 1
fi

# --- release 打包：bash build.sh release ---
# 产物直投 ../dist/，文件名规范为 yangshipin-tv-<ver>-release.apk
# 版本号从 build.gradle 里读，别在两处各写一遍（写重了迟早对不上）
if [ "${1:-}" = "release" ]; then
  VER="$(grep -m1 'versionName' app/build.gradle | sed -E 's/.*"([^"]+)".*/\1/')"
  [ -z "$VER" ] && { echo "读不到 versionName"; exit 1; }
  ./gradlew --no-daemon --console=plain :app:assembleRelease
  REL="app/build/outputs/apk/release/app-release.apk"
  if [ -f "$REL" ]; then
    OUT="../dist/yangshipin-tv-${VER}-release.apk"
    mkdir -p ../dist
    cp "$REL" "$OUT"
    echo ""
    echo "==================================================="
    echo " release APK: $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
    echo " 版本: ${VER}"
    echo " 体积: $(du -h "$OUT" | cut -f1)"
    echo " md5: $(md5 -q "$OUT")"
    echo "==================================================="
  else
    echo "未找到 release APK"; exit 1
  fi
fi
