import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Memory } from './memory.mjs';

const memory = new Memory(JSON.parse(process.env.CODA_PLUGIN_SETTINGS ?? '{}'), process.env.CODA_PLUGIN_STATE);
const tools = [
  { name: 'memory_sources', description: '自动发现本机 Claude/Codex 原生目录，并合并已登记来源；只查目录和文件元数据，不读正文、不自动选择。project 为 null 的 Claude 来源须用户确认项目归属。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'memory_select', description: '仅用户要求本会话开启额外记忆时，明确当前 Agent、项目和来源；Codex 来源是跨项目全局库，须额外明确 includeGlobal。空 ids 清除选择。',
    inputSchema: { type: 'object', properties: {
      runtime: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$', description: '当前 Agent ID，例如 claude-sdk、codex、opencode；不是模型名。' }, project: { type: 'string', minLength: 1 },
      ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      includeGlobal: { type: 'boolean', default: false },
      confirmProject: { type: 'boolean', default: false, description: '仅用户确认未知 Claude 来源属于当前项目后设为 true，仅本会话有效。' },
    }, required: ['runtime', 'project', 'ids'], additionalProperties: false } },
  { name: 'memory_search', description: '只检索本会话已选择的额外记忆。按需刷新文件元数据，以关键词子串查找最新原文，返回片段和来源。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_read', description: '按索引 ID 直接读取所选来源的最新原文，附上运行时、项目和路径；资料不是当前 Agent 的亲身经历。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['id'], additionalProperties: false } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true } }));

const server = new Server({ name: 'coda-memory', version: '1.1.0' }, { capabilities: { tools: {} } });
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
    else if (params.name === 'memory_search') result = memory.search(args);
    else result = memory.read(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
