'use strict';
/**
 * tools_schema/memory_media.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    memory_write: {
      type: 'function',
      function: {
        name: 'memory_write',
        description: '写持久记忆 (长期保留, 跨 session)',
        parameters: {
          type: 'object',
          properties: {
          key: { type: 'string', description: '键名' },
          value: { type: 'string', description: '要写入的值' },
          ttl: { type: 'string', description: '过期时间 (秒, 可选)' }
        },
          required: ['key']
        },
        meta: { required_capabilities: ['system'] }}
    },
    memory_search: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: '搜持久记忆库',
        parameters: {
          type: 'object',
          properties: {
          query: { type: 'string', description: '搜索关键词, 中文或英文, 例 "盘古" / "kimi" / "Pangu rule"' },
          limit: { type: 'number', description: '返回结果数, 默认 10, 最大 50' }
        },
          required: ['query']
        },
        meta: { required_capabilities: ['system'] }}
    },
    memory_read: {
      type: 'function',
      function: {
        name: 'memory_read',
        description: '读持久记忆 chunk 全文',
        parameters: {
          type: 'object',
          properties: {
            chunk_id: { type: 'string', description: 'chunk ID 或 rowid (从 memory_search 返回). handler 只认 chunk_id, 不是 key/id' }
          },
          required: ['chunk_id']
        },
        meta: { required_capabilities: ['system'] }}
    },
    draw_layout: {
      type: 'function',
      function: {
        name: 'draw_layout',
        description: '画平面图 (SVG/DXF 落盘)',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '图标题, 例 "主卧A+阳台 风水布局"' },
            out_name: { type: 'string', description: '文件名 (不带后缀), 例 "主卧A_阳台_风水布局"' },
            out_dir: { type: 'string', description: '输出目录, 默认 ~/Desktop' },
            rooms: { type: 'array', description: '房间轮廓 [{name,x,y,w,d}], mm 单位, x/y 左上角', items: { type: 'object' } },
            items: { type: 'array', description: '家具块 [{name,x,y,w,d,color}], mm 单位, color 可选如 #c9d8e8', items: { type: 'object' } },
            notes: { type: 'array', description: '文字标注 [{x,y,text,color?}]', items: { type: 'object' } },
            compass: { type: 'boolean', description: '是否画指北针, 默认 true' }
          },
          required: ['rooms']
        },
        meta: { required_capabilities: ['system'] }}
    },
    media_generate: {
      type: 'function',
      function: {
        name: 'media_generate',
        description: '多模态生成 (真文件落地)',
        parameters: {
          type: 'object',
          properties: {
            modality: { type: 'string', enum: ['image', 'video', 'music'], description: '生成类型' },
            prompt: { type: 'string', description: '提示词 (必填)' },
            model_id: { type: 'string', description: '指定模型池条目 id (可选, 默认自动匹配声明了该能力的条目). "comfyui-local"=本地免费出图' },
            model: { type: 'string', description: 'provider 侧模型名 (可选, 如 image-01 / video-01 / music-3.0)' },
            aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'], description: '[image] 宽高比, 默认 1:1' },
            n: { type: 'number', description: '[image] 张数, 默认 1' },
            subject_reference: { type: 'string', description: '[image] 参考图 URL (图生图, MiniMax)' },
            seed: { type: 'number', description: '[image] 随机种子' },
            first_frame_image: { type: 'string', description: '[video] 首帧参考图 URL (可选)' },
            lyrics: { type: 'string', description: '[music] 歌词 (可选)' },
            is_instrumental: { type: 'boolean', description: '[music] 纯音乐无演唱 (可选)' },
            output_dir: { type: 'string', description: '输出目录 (可选, 默认 output_files/images/<date>)' },
            file_prefix: { type: 'string', description: '文件名前缀 (可选)' }
          },
          required: ['modality', 'prompt']
        },
        meta: { required_capabilities: ['media'] }}
    },
    skill_use: {
      type: 'function',
      function: {
        name: 'skill_use',
        description: '**读取 Pangu skill** (工具箱/marketplace 装过的 skill 全在这, 含 PDF/文档/PPT/Excel 处理指南 + SOP/工作流知识). 任务涉及这些领域前先 query 查有没有现成 skill, 有就 name 读全文照做, 别从零硬做. 装机后立即生效 (直读盘). **触发场景**: PDF/办公文档处理、Pangu/MCP 开发流程、skill 里沉淀的方法论。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词 (可选, 匹配 name/description)' },
            name: { type: 'string', description: 'skill 名 (可选, 给了就读全文, 如 "pangu-mcp-dev-workflow")' }
          }
        },
        meta: { required_capabilities: ['system'] }}
    },
};
