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

# --- JDK ---
# 找 JDK：优先 JAVA_HOME，其次系统 java_home，最后 PATH 里的 javac。
# ⚠️ 别写死某个开发机的绝对路径 —— 那样别人克隆下来就没法构建。
if [ -z "$JAVA_HOME" ]; then
  for cand in \
      "$(/usr/libexec/java_home 2>/dev/null)" \
      "$HOME/.workbuddy/binaries/jdk/Contents/Home" \
      "/Library/Java/JavaVirtualMachines"/*/Contents/Home \
      "/usr/lib/jvm"/*; do
    if [ -x "$cand/bin/javac" ]; then export JAVA_HOME="$cand"; break; fi
  done
fi
echo "JAVA_HOME=$JAVA_HOME"

# --- Android SDK ---
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"

# --- Gradle：优先用本地缓存发行版，其次 PATH ---
GRADLE="$(ls -d "$HOME"/.gradle/wrapper/dists/gradle-8.7-bin/*/gradle-8.7/bin/gradle 2>/dev/null | head -1)"
if [ -z "$GRADLE" ]; then GRADLE="$(command -v gradle || true)"; fi
if [ -z "$GRADLE" ]; then echo "找不到 Gradle，请先安装 Gradle 8.7+"; exit 1; fi
echo "GRADLE=$GRADLE"

# --- 先 clean ---
# ⚠️ 必须 clean，别指望增量。踩过一次，代价是一整轮回归跑在旧包上：
#   改完 assets/custom.js（18:22）后连着 build debug + release，
#   release 是新的、debug 却是旧的（`mergeDebugAssets` 认了缓存），
#   而设备端套件用的是 debug 包 —— 于是「跑绿了」这件事本身不成立。
#   这个工程总共几十个源文件，clean 之后也就几秒，不值得为省这点时间冒这个险。
"$GRADLE" --no-daemon --console=plain clean

"$GRADLE" --no-daemon --console=plain :app:assembleDebug

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
  "$GRADLE" --no-daemon --console=plain :app:assembleRelease
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
