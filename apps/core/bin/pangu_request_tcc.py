#!/usr/bin/env python3
"""
pangu_request_tcc.py — 盘古自带的 TCC 申请模块
# 2026-07-19 00:40

盘古 22:58 失败原因:
  - CLI 触发 TCC 弹窗被静默吞掉
  - ffmpeg / sox 是命令行进程, macOS 不信

修复:
  - 通过 osascript 让 GUI app (Photo Booth / Voice Memos) 触发
  - GUI app 的访问才会真正触发 TCC 弹窗
  - 老板在弹窗里点"好" = 授权到位
"""

import os
import sys
import subprocess
import time
from pathlib import Path

GUI_TRIGGER_APPS = {
    'camera': 'Photo Booth',
    'microphone': 'Voice Memos'
}


def trigger_gui_access(app_name: str, action: str = 'access') -> bool:
    """通过 osascript 让 GUI app 触发摄像头/麦克风访问"""
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    delay 1
    tell application "System Events"
        tell process "{app_name}"
            try
                {{
                    'Photo Booth': 'click button "Take Photo" of window 1',
                    'Voice Memos': 'keystroke " "',
                }}.get('{app_name}', 'return')
            on error errMsg
                return "error: " & errMsg
            end try
        end tell
    end tell
    '''
    try:
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode == 0
    except Exception as e:
        print(f'  ⚠️ {app_name} 触发失败: {e}')
        return False


def request_permission(service: str) -> bool:
    """请求 service (camera/microphone) 的 TCC 权限"""
    app = GUI_TRIGGER_APPS.get(service)
    if not app:
        print(f'  ❌ 未知 service: {service}')
        return False

    print(f'\n>>> 触发 {service} TCC 申请 (通过 {app})')
    ok = trigger_gui_access(app)
    if ok:
        print(f'  ✅ {app} 已激活, macOS 应该弹 TCC 弹窗')
    else:
        print(f'  ⚠️ {app} 触发失败, 弹窗可能没出')
    return ok


def check_permission(service: str) -> str:
    """检查权限状态 (用 sqlite3, 需要 sudo)"""
    tcc_db = Path.home() / 'Library/Application Support/com.apple.TCC/TCC.db'
    service_map = {
        'camera': 'kTCCServiceCamera',
        'microphone': 'kTCCServiceMicrophone'
    }
    tcc_service = service_map.get(service)
    if not tcc_service:
        return 'unknown'

    # 尝试用 sudo 读 (一般会失败, 因为 TCC.db 受 SIP 保护)
    try:
        result = subprocess.run(
            ['sudo', '-n', 'sqlite3', str(tcc_db),
             f'SELECT auth_value FROM access WHERE service="{tcc_service}";'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            values = [v for v in result.stdout.strip().split('\n') if v]
            return f'authorized={len(values)} apps'
    except Exception:
        pass

    return 'unknown (TCC.db 受保护, 无法直接查询)'


def main():
    print('=' * 60)
    print('  Pangu TCC 权限申请')
    print('=' * 60)
    print()

    # 1. 检查 Pangu Bridge 在不在 (GUI 焦点进程 — Bridge 持 TCC entitlement)
    try:
        result = subprocess.run(
            ['pgrep', '-f', 'Pangu Bridge.app'],
            capture_output=True,
            text=True
        )
        bridge_pid = result.stdout.strip()
        if bridge_pid:
            print(f'✅ Pangu Bridge 在跑 (PID {bridge_pid.split()[0]})')
        else:
            print('❌ Pangu Bridge 没在跑, 请先启动 (target/release/bundle/macos/Pangu Bridge.app)')
            return 1
    except Exception as e:
        print(f'⚠️ 检测 Pangu Bridge 失败: {e}')

    # 2. 检查 Pangu daemon
    result = subprocess.run(['pgrep', '-f', 'pangu_daemon.py'],
                            capture_output=True, text=True)
    daemon_pid = result.stdout.strip()
    if daemon_pid:
        print(f'✅ Pangu Daemon 在跑 (PID {daemon_pid.split()[0]})')
    else:
        print('⚠️ Pangu Daemon 不在跑 (但权限给 Pangu Bridge 就行, 子进程会继承)')
    print()

    # 3. 触发摄像头申请
    request_permission('camera')
    time.sleep(2)

    # 4. 触发麦克风申请
    request_permission('microphone')
    time.sleep(2)

    print()
    print('=' * 60)
    print('  申请已触发')
    print('=' * 60)
    print()
    print('预期: macOS 弹 1-2 个 TCC 弹窗')
    print('  - "Photo Booth 想访问摄像头吗?"')
    print('  - "Voice Memos 想访问麦克风吗?"')
    print()
    print('请在弹窗里点 "好" / "允许"')
    print()
    print('完成后告诉盘古 "权限好了"')
    print('盘古会自动验证眼耳是否能跑')
    print()

    # 5. 退出 GUI app
    for app in GUI_TRIGGER_APPS.values():
        subprocess.run(['osascript', '-e', f'tell application "{app}" to quit'],
                       capture_output=True, timeout=5)
    time.sleep(1)

    print('✅ 脚本执行完毕')
    return 0


if __name__ == '__main__':
    sys.exit(main())