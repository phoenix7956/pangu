#!/usr/bin/env swift
// Pangu CGEvent Helper - macOS Quartz 操控, 不依赖 osascript / 辅助功能
// 用法: pangu-cg <action> [args...]
//   click <x> <y> [--button=left|right|middle] [--double]
//   type <text>
//   key <keycode>
//   drag <x1> <y1> <x2> <y2>
//   screenshot <output_path>
//   test (返回 "OK" 表示能用)
//
// 编译: swiftc -O pangu_cg.swift -o ~/.pangu/runtime/bin/pangu-cg
// 框架: CoreGraphics (Quartz), AppKit, Foundation

import Foundation
import CoreGraphics
import AppKit

func printUsage() {
    let usage = """
    Pangu CGEvent Helper v1.0
    用法: pangu-cg <action> [args...]

    Actions:
      click <x> <y> [--button=left|right|middle] [--double]
      type <text>
      key <keycode>
      drag <x1> <y1> <x2> <y2>
      screenshot <output_path>
      test
    """
    print(usage)
    exit(0)
}

func log(_ msg: String) {
    FileHandle.standardError.write("[\(Date())] \(msg)\n".data(using: .utf8)!)
}

func postMouse(_ event: CGEvent, at point: CGPoint) {
    event.post(tap: .cghidEventTap)
}

func cmdTest() -> Int32 {
    // 测一下能不能 get mouse position (基本不需要权限)
    let event = CGEvent(source: nil)
    if event == nil {
        log("CGEvent.source 返 nil, Quartz 不能用")
        return 1
    }
    let mousePos = CGEvent(source: nil)?.location ?? .zero
    let screenSize = NSScreen.main?.frame.size ?? CGSize(width: 0, height: 0)
    print("OK mouse=\(mousePos) screen=\(screenSize)")
    return 0
}

func cmdClick(args: [String]) -> Int32 {
    guard args.count >= 2,
          let x = Double(args[0]),
          let y = Double(args[1]) else {
        print("ERROR: click 需要 x y"); return 1
    }
    var button: CGMouseButton = .left
    var double = false
    var i = 2
    while i < args.count {
        if args[i] == "--button", i + 1 < args.count {
            let raw = UInt32(args[i+1]) ?? 0
            switch args[i+1] {
            case "right": button = .right
            case "middle": button = .center
            default: button = .left
            }
            i += 2
        } else if args[i] == "--double" {
            double = true
            i += 1
        } else {
            i += 1
        }
    }
    let point = CGPoint(x: x, y: y)
    let downType: CGEventType = button == .left ? .leftMouseDown : (button == .right ? .rightMouseDown : .otherMouseDown)
    let upType: CGEventType = button == .left ? .leftMouseUp : (button == .right ? .rightMouseUp : .otherMouseUp)
    let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
    let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
    guard let d = down, let u = up else {
        print("ERROR: CGEvent 创建失败"); return 1
    }
    d.post(tap: .cghidEventTap)
    if double {
        let d2 = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
        let u2 = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
        d2?.post(tap: .cghidEventTap)
        u2?.post(tap: .cghidEventTap)
    }
    usleep(50_000)
    u.post(tap: .cghidEventTap)
    print("OK clicked (\(Int(x)),\(Int(y))) button=\(button == .left ? "left" : button == .right ? "right" : "middle")\(double ? " double" : "")")
    return 0
}

func cmdType(args: [String]) -> Int32 {
    guard !args.isEmpty else { print("ERROR: type 需要 text"); return 1 }
    let text = args.joined(separator: " ")
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0x31, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0x31, keyDown: false) else {
        print("ERROR: CGEvent 键盘事件创建失败"); return 1
    }
    down.keyboardSetUnicodeString(stringLength: text.count, unicodeString: Array(text.utf16))
    up.keyboardSetUnicodeString(stringLength: text.count, unicodeString: Array(text.utf16))
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    print("OK typed \(text.count) chars")
    return 0
}

func cmdKey(args: [String]) -> Int32 {
    guard args.count >= 1, let raw = UInt16(args[0]) else {
        print("ERROR: key 需要 keycode"); return 1
    }
    let keycode = CGKeyCode(raw)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keycode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keycode, keyDown: false) else {
        print("ERROR: CGEvent 创建失败"); return 1
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    print("OK pressed key \(keycode)")
    return 0
}

func cmdDrag(args: [String]) -> Int32 {
    guard args.count >= 4,
          let x1 = Double(args[0]), let y1 = Double(args[1]),
          let x2 = Double(args[2]), let y2 = Double(args[3]) else {
        print("ERROR: drag 需要 x1 y1 x2 y2"); return 1
    }
    let p1 = CGPoint(x: x1, y: y1)
    let p2 = CGPoint(x: x2, y: y2)
    let moveTo = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p1, mouseButton: .left)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p1, mouseButton: .left)
    let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p2, mouseButton: .left)
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p2, mouseButton: .left)
    moveTo?.post(tap: .cghidEventTap)
    down?.post(tap: .cghidEventTap)
    for i in 1...10 {
        let t = CGFloat(i) / 10.0
        let p = CGPoint(x: x1 + (x2-x1)*t, y: y1 + (y2-y1)*t)
        let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
        e?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
    up?.post(tap: .cghidEventTap)
    print("OK dragged (\(Int(x1)),\(Int(y1))) -> (\(Int(x2)),\(Int(y2)))")
    return 0
}

func cmdScreenshot(args: [String]) -> Int32 {
    let outputPath = args.first ?? "/tmp/pangu_cg_screenshot.png"
    // macOS 15+ 弃用了 CGDisplayCreateImage, 改用系统 screencapture 命令
    let process = Process()
    process.launchPath = "/usr/sbin/screencapture"
    process.arguments = ["-x", outputPath]
    do {
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus == 0 {
            let size = (try? FileManager.default.attributesOfItem(atPath: outputPath)[.size] as? Int) ?? 0
            print("OK saved \(outputPath) \(size) bytes")
            return 0
        } else {
            print("ERROR: screencapture exit \(process.terminationStatus)")
            return 1
        }
    } catch {
        print("ERROR: \(error)")
        return 1
    }
}

// ============ Main ============

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    printUsage()
    exit(1)
}
let action = argv[1]
let args = Array(argv[2...])

switch action {
case "test":
    exit(cmdTest())
case "click":
    exit(cmdClick(args: args))
case "type":
    exit(cmdType(args: args))
case "key":
    exit(cmdKey(args: args))
case "drag":
    exit(cmdDrag(args: args))
case "screenshot":
    exit(cmdScreenshot(args: args))
case "help", "-h", "--help":
    printUsage()
default:
    print("ERROR: 未知 action: \(action)")
    printUsage()
    exit(1)
}