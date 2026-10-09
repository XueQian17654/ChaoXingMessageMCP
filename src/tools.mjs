/**
 * 三个工具的实现。MCP 服务器和命令行都调这里，避免两套逻辑。
 *
 * 设计约定（照抄 CipherTalk 的接口习惯）：
 *   - 结果里写死字段路径，方便模型直接取：conversations[].id / hits[].messageId
 *   - 时间参数秒、毫秒、ISO 字符串都收
 *   - 不给参数就是"最近的消息"，那是最常见的问法
 */
import { syncIfStale } from './sync.mjs';
import { readAllSessions, readIndex } from './store.mjs';

/**
 * 时间归一化成毫秒。接受秒、毫秒、ISO 字符串。
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
function toMillis(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 1. 枚举所有会话（不需要入参）。
 * @param {{force?: boolean}} [options]
 * @returns {Promise<object>}
 */
export async function listConversations(options = {}) {
  const result = await syncIfStale(options.force === true);
  return {
    lastSyncAt: result.lastSyncAt,
    count: result.conversations.length,
    conversations: result.conversations,
  };
}

/**
 * 2. 搜索消息。文本 / 时间段 / 会话 id 三个条件可任意组合，全不传就是"最近的消息"。
 * @param {{query?: string, startTime?: number|string, endTime?: number|string, sessionId?: string, limit?: number, force?: boolean}} [args]
 * @returns {Promise<object>}
 */
export async function searchMessages(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
  const from = toMillis(args.startTime);
  const to = toMillis(args.endTime);
  const keyword = (args.query || '').trim().toLowerCase();
  const wanted = args.sessionId ? String(args.sessionId) : null;

  await syncIfStale(args.force === true);

  const sessions = readAllSessions().filter((s) => !wanted || s.sessionId === wanted);
  const hits = [];

  for (const session of sessions) {
    for (const message of session.messages) {
      if (from !== null && message.ts < from) continue;
      if (to !== null && message.ts > to) continue;
      if (keyword) {
        const haystack = `${message.text} ${message.sender} ${session.name}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      hits.push({
        messageId: message.id,
        sessionId: session.sessionId,
        session: session.name,
        teacher: session.teacher,
        sender: message.sender,
        ts: message.ts,
        kind: message.kind,
        text: message.text,
      });
    }
  }

  hits.sort((a, b) => b.ts - a.ts);
  return {
    total: hits.length,
    returned: Math.min(hits.length, limit),
    hits: hits.slice(0, limit),
  };
}

/**
 * 3. 取一条消息的上下文。只需要 messageId——会话由服务端自己反查。
 * @param {{messageId: string, before?: number, after?: number, force?: boolean}} args
 * @returns {Promise<object>}
 */
export async function getContext(args = {}) {
  const messageId = args.messageId === undefined || args.messageId === null ? '' : String(args.messageId);
  if (!messageId) throw new Error('get_context 需要 messageId。先用 search_messages 拿到 hits[].messageId');

  const before = Math.min(Math.max(Number(args.before) || 10, 0), 200);
  const after = Math.min(Math.max(Number(args.after) || 10, 0), 200);

  await syncIfStale(args.force === true);

  let session = findSessionByMessage(messageId);
  if (!session) {
    // 本地没有：可能这条比上次同步更早，强制拉一次再找
    await syncIfStale(true);
    session = findSessionByMessage(messageId);
  }
  if (!session) throw new Error(`本地没有消息 ${messageId}。可能它不在这台机器同步过的范围内。`);

  const index = session.messages.findIndex((m) => m.id === messageId);
  const start = Math.max(0, index - before);
  const end = Math.min(session.messages.length, index + after + 1);

  return {
    sessionId: session.sessionId,
    session: session.name,
    teacher: session.teacher,
    anchorIndex: index,
    messages: session.messages.slice(start, end).map((message) => ({
      messageId: message.id,
      ts: message.ts,
      sender: message.sender,
      kind: message.kind,
      text: message.text,
      anchor: message.id === messageId,
    })),
  };
}

/**
 * @param {string} messageId
 * @returns {object|null} 含这条消息的会话文件
 */
function findSessionByMessage(messageId) {
  return readAllSessions().find((s) => s.messages.some((m) => m.id === messageId)) || null;
}

/** 本地库概况，CLI 用 */
export function localSummary() {
  const index = readIndex();
  const sessions = readAllSessions();
  return {
    lastSyncAt: index.lastSyncAt,
    conversationCount: sessions.length,
    messageCount: sessions.reduce((sum, s) => sum + s.messages.length, 0),
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, name: s.name, messages: s.messages.length })),
  };
}
