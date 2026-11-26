// lore.mjs —— 盘古话术层
//
// 从原版 `apps/desktop/src/lib/lore.js` (git 110661d^) 原样搬过来。
// 这一份是**设置页子导航**的唯一真源 —— 子导航项 / 顺序 / 名称 / 说明都从这儿取。

export const PAN_LORE = {
  brand: '盘古',
  subtitle: '64 卦 · 384 爻 · 易学推演',
  motto: '开天辟地，万物皆可为用',

  rooms: {
    chat: { name: '圭室', desc: '主对话 · 起卦问事', icon: '☰', shortcut: '⌘1' },
  },

  settings: [
    // 第 143 批: 说明原来是**开发者黑话** —— 「Provider / 路由 / 用神」
    //   「Agent / 兜底链 / 推演强度」「总表 / 按角色 · 开关 · 试跑」……
    //   每一个词都要先懂盘古的内部结构才看得懂。改成"这一页能干什么"。
    { id: 'connect', name: '连接', desc: '服务地址与连接状态', icon: 'server' },
    { id: 'model', name: '模型', desc: '模型来源与选择', icon: 'gauge' },
    { id: 'agent', name: '将灵', desc: '八位角色与推演深度', icon: 'bot' },
    { id: 'tools', name: '内部工具', desc: '工具清单与授权', icon: 'sliders' },
    { id: 'mcp', name: 'MCP', desc: '外部工具服务', icon: 'plug' },
    { id: 'permission', name: '权限', desc: '谁能动哪些工具', icon: 'shield' },
    { id: 'ui', name: '界面', desc: '主题与字号', icon: 'wand' },
    { id: 'storage', name: '存储', desc: '数据位置与清理', icon: 'database' },
    { id: 'credentials', name: '凭证', desc: '账号与密钥', icon: 'key' },
    { id: 'selfrepair', name: '自愈', desc: '故障与自愈记录', icon: 'sparkles' },
    // 第 172 批: 盘古自己接微信 (直连 iLink, 不经过老 openclaw 桌面端)。
    //   放在「凭证」后面 —— 它跟账号绑定有关, 但要看的是"通没通", 不是密钥本身。
    { id: 'weixin', name: '微信', desc: '微信通道与收发状态', icon: 'message' },
    { id: 'voice', name: '语音', desc: '语音输入与朗读', icon: 'mic' },
    { id: 'update', name: '更新', desc: '版本与更新', icon: 'refresh' },
  ],

  onboarding: {
    steps: [
      { id: 'zhuren', name: '认主', desc: '我是谁', hint: '识别使用者 · 标记用神' },
      { id: 'qigua', name: '起卦', desc: '以何为卦', hint: '推理引擎选型' },
      { id: 'lianduan', name: '连端', desc: '接哪方端', hint: '本地 / 云端 Provider' },
    ],
  },

  team: {
    steps: [
      { id: 'qiliuyao', name: '起六爻', desc: '把任务分成 6 步', hint: '任务分解为 6 步序列' },
      { id: 'piguo', name: '批果', desc: '逐爻推演', hint: '顺序执行 · 1 Agent 跑 6 步' },
      { id: 'fupan', name: '复盘', desc: '结果回写 · 卦象归藏', hint: '归档 · 复盘' },
    ],
  },

  status: {
    ready: '静候',
    thinking: '推演中…',
    streaming: '将灵干活中',
    error: '卦变',
    idle: '静候',
  },
};

export default PAN_LORE;

