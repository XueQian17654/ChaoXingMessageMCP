#!/usr/bin/env node
/**
 * MCP 服务器（stdio）。
 *
 * 为什么手搓而不用官方 SDK：SDK 1.x 为了 HTTP/SSE 传输拖着 17 个直接依赖
 * （express、hono、jose、ajv、cors…），而 MCP 的 stdio 传输就是
 * 「一行一个 JSON-RPC 对象」——这点东西自己写比拉 40MB 依赖划算。
 * 如果以后要换官方 SDK，只有这个文件要改。
 *
 * ⚠️ stdout 是协议通道，除了 JSON-RPC 什么都不许往里写。日志一律走 stderr。
 */
import { createInterface } from 'node:readline';
import { closeBrowser, installCleanup } from './browser.mjs';
import { getContext, listConversations, searchMessages } from './tools.mjs';

const SERVER_NAME = 'chaoxing-message-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

/**
 * 工具清单。description 是写给模型看的，要说清"什么时候用"和"字段在哪"。
 */
const TOOLS = [
  {
    name: 'list_conversations',
    description:
      '枚举学习通里的全部会话（课程群聊），不需要参数。返回 conversations[]，每项含 id（会话 id，' +
      '其它工具要的 sessionId 就是它）、name（课程/群名）、teacher、unread（未读数）、' +
      'lastMessageTimestamp、messageCount（本地已存条数），以及 lastSyncAt（上次同步时间，毫秒）。' +
      '需要看某条消息内容或搜索时，先用这个拿 sessionId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_messages',
    description:
      '搜索消息。query（文本子串，会匹配正文/发送人/课程名）、startTime、endTime、sessionId 三个条件' +
      '可以任意组合；全部不传就返回最近的消息。startTime/endTime 接受秒、毫秒或 ISO 时间字符串。' +
      '返回 total 和 hits[]，每项含 messageId、sessionId、session、sender、ts（毫秒）、kind' +
      '（文字/签到/投票/选人/文件/话题讨论）、text。拿到 messageId 后可用 get_context 看上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '文本子串，大小写不敏感。省略则不按文本过滤。' },
        startTime: {
          type: ['number', 'string'],
          description: '起始时间，秒 / 毫秒 / ISO 字符串都行。省略则不设下界。',
        },
        endTime: {
          type: ['number', 'string'],
          description: '结束时间，秒 / 毫秒 / ISO 字符串都行。省略则不设上界。',
        },
        sessionId: { type: 'string', description: '限定某一个会话，取自 list_conversations 的 conversations[].id。' },
        limit: { type: 'number', description: '最多返回多少条，默认 50，上限 500。' },
        force: { type: 'boolean', description: 'true 则忽略同步缓存，强制重新去学习通拉一次。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_context',
    description:
      '取某条消息的上下文。只需要 messageId（来自 search_messages 的 hits[].messageId），' +
      '会话由服务端自己反查。before/after 是前后各取多少条，默认各 10。' +
      '返回 messages[]，按时间升序，目标那条带 anchor: true。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '目标消息 id，取自 search_messages 的 hits[].messageId。' },
        before: { type: 'number', description: '往前取多少条，默认 10。' },
        after: { type: 'number', description: '往后取多少条，默认 10。' },
        force: { type: 'boolean', description: 'true 则忽略同步缓存，强制重新拉一次。' },
      },
      required: ['messageId'],
      additionalProperties: false,
    },
  },
];

const IMPLEMENTATIONS = {
  list_conversations: (args) => listConversations(args),
  search_messages: (args) => searchMessages(args),
  get_context: (args) => getContext(args),
};

/** 往 stdout 写一条 JSON-RPC 消息（协议通道，必须是单行 JSON） */
function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** JSON-RPC 错误对象 */
function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 分发一个请求。
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>}
 */
async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(params.name, params.arguments || {});
    // 没有声明这两个能力，但客户端偶尔会探一下；回空列表比报错友好
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

/**
 * 执行一个工具。
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>}
 */
async function callTool(name, args) {
  const implementation = IMPLEMENTATIONS[name];
  if (!implementation) {
    return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  }
  try {
    const result = await implementation(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `出错了：${error.message}` }], isError: true };
  }
}

/** 处理一行输入 */
async function handleLine(line) {
  const text = line.trim();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // 通知（没有 id）不需要回包
  if (message.id === undefined || message.id === null) return;

  try {
    const result = await dispatch(message.method, message.params || {});
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: error.code || -32603, message: String(error.message || error) },
    });
  }
}

function main() {
  installCleanup();

  // 串行处理：工具调用会开浏览器、发网络请求，并发跑只会互相打架
  let queue = Promise.resolve();
  const reader = createInterface({ input: process.stdin });

  reader.on('line', (line) => {
    queue = queue.then(() => handleLine(line)).catch((error) => {
      process.stderr.write(`[chaoxing] 处理消息出错：${error.stack || error}\n`);
    });
  });

  reader.on('close', () => {
    void closeBrowser('stdin 关闭').then(() => process.exit(0));
  });

  process.stderr.write(`[chaoxing] ${SERVER_NAME} v${SERVER_VERSION} 已就绪（等待 MCP 客户端）\n`);
}

main();
