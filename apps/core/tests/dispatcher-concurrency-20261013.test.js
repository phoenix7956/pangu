#!/usr/bin/env node
// 红测试: 子 agent 并发闸门 — 存在并发门控, 且额度按**端点**取而不是人拨的全局旋钮。
//
// 2026-10-17: 并发闸门连同整个派发引擎搬进 modules/subagent_runner.js —— 因为主
// agent (乾) 现在也调它, 两边各留一份 = 迟早只改其中一份。闸门本身一字未改,
// 这里只把源码路径跟着搬。
//
// 2026-10-18 (老板原话: «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»):
// 原来只有一句 `parseInt(process.env.PANGU_MAX_CONCURRENT_SUBAGENTS || '3')` ——
// 一个不分端点、不看实际跑在谁上面的全局标量。于是本地单卡也放 3 路,
// 实机 session 80004976 两刀撞 ZERO_CONTENT_TIMEOUT_300s (633.2s / 300.0s)。
// 下面加的是"额度必须跟着这一刀的真实端点走"这条约束。
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const srcPath = path.join(__dirname, '..', 'modules', 'subagent_runner.js');
const src = fs.readFileSync(srcPath, 'utf8');
assert.ok(
  src.includes('PANGU_MAX_CONCURRENT_SUBAGENTS'),
  'dispatcher 源码应包含 PANGU_MAX_CONCURRENT_SUBAGENTS 环境变量'
);
assert.ok(
  src.includes('_acquireSlot') && src.includes('_releaseSlot'),
  'dispatcher 源码应包含并发闸门 (_acquireSlot/_releaseSlot)'
);
assert.ok(
  src.includes('_runOneSubTaskInner'),
  '原始 _runOneSubTask 应重命名为 _runOneSubTaskInner, 外层包并发闸门'
);

// 2026-10-18: 额度不许再是一个跟端点无关的全局标量。
assert.ok(
  !/const _MAX_CONCURRENT\s*=\s*Math\.max\(1, parseInt/.test(src),
  '不许再有"一个数套所有端点"的全局闸门 —— 本地单卡和云端能吃的并发不是一个量级'
);
assert.ok(
  src.includes('_MAX_CONCURRENT_LOCAL') && src.includes('_MAX_CONCURRENT_CLOUD'),
  '并发额度必须分本地/云端两档 (本地 = 单卡串行解码, 云端 = 可并发)'
);
assert.ok(
  /isLocalModel\(/.test(src),
  '本地判定必须走 model_cost.isLocalModel 单一真源, 不许在派发机制里另写一份 provider 名单'
);
// 额度按端点分组计数, 而不是整个 runner 一把锁。
assert.ok(
  src.includes('_gateActive') && /new Map\(\)/.test(src),
  '闸门必须按端点分组计数 (Map), 不许用单一全局 _activeCount'
);
// 闸门在**模型解析之后**才定 —— 原来它是先进闸门、后解析模型。
assert.ok(
  /_gateFor\s*\(subTask\)[\s\S]{0,240}_acquireSlot/.test(src),
  '必须先 _gateFor(subTask) 解析出这一刀的端点, 再 _acquireSlot —— '
  + '顺序反了就是"闸门在它该依赖的信息出来之前就定好了"'
);
// 排队要让主人看见, 否则"跟死了一样"。
assert.ok(
  src.includes('sub_agent_queue'),
  '排队必须发 sub_agent_queue 事件 —— 没抢到槽位的刀要能被主人看见, 否则整轮看着像死了'
);
console.log('PASS: dispatcher 并发闸门源码验证');
