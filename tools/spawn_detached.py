#!/usr/bin/env python3
"""把一个命令以真正的守护进程方式拉起（双 fork + setsid），使其脱离调用者的进程组。

为什么需要它：
  用 `nohup cmd &` 或平台的后台任务机制起的模拟器，会随调用方会话/任务结束被一起回收
  （实测两次：一次 nohup 被 SIGTERM，一次 run_in_background 在回合结束时终止）。
  只有 setsid 新建会话才能真正脱离进程组，而 macOS 默认没有 setsid 命令，
  所以用 Python 的双 fork 实现。

用法: spawn_detached.py <logfile> <cmd> [args...]
"""
import os
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    logfile, argv = sys.argv[1], sys.argv[2:]

    pid = os.fork()
    if pid > 0:
        os._exit(0)                     # 第一父进程立刻退出

    os.setsid()                          # 新会话 → 脱离原进程组与控制终端
    os.chdir('/')

    pid = os.fork()
    if pid > 0:
        os._exit(0)                     # 第二父进程退出，只剩孤儿进程被 init 收养

    devnull = os.open('/dev/null', os.O_RDONLY)
    os.dup2(devnull, 0)
    log = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(log, 1)
    os.dup2(log, 2)

    os.execv(argv[0], argv)


if __name__ == '__main__':
    main()
