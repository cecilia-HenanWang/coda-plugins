import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Memory } from './memory.mjs';

const memory = new Memory(JSON.parse(process.env.CODA_PLUGIN_SETTINGS ?? '{}'), process.env.CODA_PLUGIN_STATE);
const tools = [
  { name: 'memory_sources', description: '自动发现本机 Claude/Codex 记忆目录，并合并已登记来源；只查元数据，不读正文、不自动选择。项目标注仅表示来源，不限制跨项目加载。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'memory_select', description: '按用户明确选择加载任意项目、任意运行时的来源；传 ids 选择部分，用户明确要求全部时传 all: true（二选一）。空 ids 关闭。返回短索引而非全部正文；完整正文通过 files/read 分页读取。',
    inputSchema: { type: 'object', properties: {
      runtime: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$', description: '当前 Agent ID，用于重复加载提示，不限制来源。' }, project: { type: 'string', minLength: 1, description: '当前会话目录，不会覆盖记忆原本的项目归属。' },
      ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      all: { type: 'boolean', description: '仅用户明确选择全部来源时设 true，包括其他项目、Codex 全局库与当前运行时来源；不自动选择以后新出现的目录。' },
      includeGlobal: { type: 'boolean', description: '兼容旧调用，已不限制全局来源，无需填写。' },
      confirmProject: { type: 'boolean', description: '兼容旧调用，已不要求来源属于当前项目，无需填写。' },
    }, required: ['runtime', 'project'], oneOf: [{ required: ['ids'] }, { required: ['all'] }], additionalProperties: false } },
  { name: 'memory_files', description: '分页列出本会话已选来源的全部文件 ID 与来源，不读正文。用户要求全部正文时逐页列出，再用 memory_read 逐文件读取，不把短预览当作已全部加载。',
    inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: 'memory_search', description: '只检索本会话已选择的额外记忆。按需刷新文件元数据，以关键词子串查找最新原文，返回片段和来源。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_read', description: '按索引 ID 直接读取所选来源的最新原文，附上运行时、项目和路径；资料不是当前 Agent 的亲身经历。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['id'], additionalProperties: false } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true } }));

const server = new Server({ name: 'coda-memory', version: '1.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const tool = tools.find(item => item.name === params.name);
    if (!tool) throw new Error('未知记忆工具');
    const args = params.arguments ?? {};
    if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error('包含不支持的参数');
    let result;
    if (params.name === 'memory_sources') result = memory.list();
    else if (params.name === 'memory_select') result = memory.select(args);
    else if (params.name === 'memory_files') result = memory.files(args);
    else if (params.name === 'memory_search') result = memory.search(args);
    else result = memory.read(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
