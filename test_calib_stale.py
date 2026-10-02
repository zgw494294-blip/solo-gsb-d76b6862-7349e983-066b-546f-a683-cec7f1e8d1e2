"""标定页“迟到响应”回归的 python3 入口：转调 Node 运行 test_calib_stale.js。

与仓库其他测试保持一致（可直接 python3 运行）。回归本身用 Node 的 vm +
可控延迟 fetch 驱动真实的 static/app.js（前端竞态无法在 Python 内复现）；
本机没有 node 时打印提示并跳过（视为通过），有 node 时以其退出码为准。
"""

import shutil
import subprocess
import sys
from pathlib import Path

JS = Path(__file__).with_name("test_calib_stale.js")


def main() -> int:
    node = shutil.which("node")
    if node is None:
        print("未找到 node，跳过 test_calib_stale.js（标定页迟到响应回归）")
        return 0
    return subprocess.call([node, str(JS)])


if __name__ == "__main__":
    sys.exit(main())
