#!/bin/bash
# ============================================================
#  启动 Android TV 模拟器（1080p 真电视环境）
#
#  环境：Google 官方 SDK 模拟器 + android-34 android-tv arm64-v8a 系统镜像
#  特性：1920x1080 @320dpi / dpr 2.0（WebView 视口 960x540）
#        android.software.leanback + android.hardware.type.television
#
#  用法：
#    bash tv-emu.sh              启动 TV 模拟器
#    bash tv-emu.sh install      启动 + 装最新 debug APK
#    bash tv-emu.sh install-r    启动 + 装最新 release APK
#    bash tv-emu.sh debug        启动 + 装 debug APK + 建 WebView 调试通道(9222)
#    bash tv-emu.sh shot         截一张图到 dist/screenshots_tv/
# ============================================================
set -e

AVD_NAME="AndroidTV_1080p"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

EMU="$ANDROID_HOME/emulator/emulator"
SERIAL="${ANDROID_SERIAL:-emulator-5554}"

# 用双 fork + setsid 守护化启动。
# ⚠️ 别改成 `nohup ... &` 或平台的后台任务机制：那两种方式起的模拟器
#    会随调用方会话/回合结束被一起回收（实测两次都被回收过）。
#    macOS 默认没有 setsid 命令，所以借 Python 的 os.setsid() 实现。
# 优先用 $PY；否则 PATH 里的 python3。⚠️ 别写死某台机器的绝对路径。
PY="${PY:-$(command -v python3)}"
SPAWN="$ROOT/tools/spawn_detached.py"

boot_if_needed() {
  if adb devices | grep -q "$SERIAL[[:space:]]*device"; then
    echo "TV 模拟器已在运行: $SERIAL"
  else
    echo "启动 $AVD_NAME (守护化)..."
    "$PY" "$SPAWN" /tmp/tv-emu.log "$EMU" -avd "$AVD_NAME" -gpu host -no-boot-anim
    echo "  日志：/tmp/tv-emu.log"
  fi
  echo -n "等待系统就绪"
  for _ in $(seq 1 60); do
    if [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      echo " —— 完成"
      return 0
    fi
    echo -n "."
    sleep 3
  done
  echo " —— 超时，请查看 /tmp/tv-emu.log"
  exit 1
}

apk_path() {  # $1 = debug|release
  local p="$ROOT/yangshipin-tv/app/build/outputs/apk/$1/app-$1.apk"
  if [ -f "$p" ]; then echo "$p"; return 0; fi
  # ⚠️ 这里原来写死回退到 `dist/yangshipin-tv-1.1-$1.apk`。
  #    那是个陷阱：app/build 被 clean 掉时，它会**一声不吭地装一个 1.1 的老包**，
  #    然后整轮设备测试跑在一个几版之前的二进制上 ——「跑绿了」这件事本身不成立。
  #    改成从 dist 里挑**版本号最大**的那一个（版本号按数字段比，不是字典序：
  #    字典序会让 1.10 排在 1.9 前面）。找不到就报错，绝不静默降级。
  local newest
  newest="$(ls -1 "$ROOT"/dist/yangshipin-tv-*-"$1".apk 2>/dev/null \
            | sed -E 's#.*/yangshipin-tv-([0-9]+(\.[0-9]+)*)-'"$1"'\.apk#\1 &#' \
            | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
            | tail -1 | cut -d' ' -f2-)"
  if [ -z "$newest" ]; then
    echo "错误：既没有 $p，dist/ 里也没有 yangshipin-tv-*-$1.apk" >&2
    echo "      请先构建：bash yangshipin-tv/build.sh${1/release/ release}" >&2
    return 1
  fi
  echo "$newest"
}

install_apk() {
  local kind="$1" apk
  apk="$(apk_path "$kind")"
  echo "安装 $apk"
  adb -s "$SERIAL" install -r "$apk" | tail -1
}

case "${1:-boot}" in
  boot)      boot_if_needed ;;
  install)   boot_if_needed; install_apk debug;   adb -s "$SERIAL" shell am start -n com.ysptv.player/.MainActivity >/dev/null ;;
  install-r) boot_if_needed; install_apk release; adb -s "$SERIAL" shell am start -n com.ysptv.player/.MainActivity >/dev/null ;;
  debug)
    boot_if_needed
    install_apk debug
    adb -s "$SERIAL" shell am force-stop com.ysptv.player
    adb -s "$SERIAL" shell am start -n com.ysptv.player/.MainActivity >/dev/null
    echo -n "等待 WebView 起来"
    for _ in $(seq 1 20); do
      PID=$(adb -s "$SERIAL" shell cat /proc/net/unix 2>/dev/null | grep -o "webview_devtools_remote_[0-9]*" | head -1 | tr -d '\r')
      [ -n "$PID" ] && break
      echo -n "."; sleep 2
    done
    [ -z "$PID" ] && { echo " 未拿到 WebView 调试点"; exit 1; }
    adb -s "$SERIAL" forward --remove-all >/dev/null 2>&1 || true
    adb -s "$SERIAL" forward tcp:9222 localabstract:"$PID"
    echo " 调试通道就绪 → http://127.0.0.1:9222/json  ($PID)"
    echo " 设备端验证：node tools/device_test.mjs"
    ;;
  shot)
    mkdir -p "$ROOT/dist/screenshots_tv"
    OUT="$ROOT/dist/screenshots_tv/shot_$(date +%H%M%S).png"
    adb -s "$SERIAL" exec-out screencap -p > "$OUT"
    echo "$OUT" ;;
  *)
    echo "未知参数：$1"; sed -n '2,16p' "$0"; exit 1 ;;
esac
