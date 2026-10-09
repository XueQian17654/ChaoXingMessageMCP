/**
 * 同步：把服务端的消息拉下来，合并进本地消息库。
 *
 * 触发时机是「工具被调用时」。config 里的 syncTtlSeconds 之内不会重复拉，
 * 所以 agent 连着问三次不会打三次接口。
 */
import { loadConfig } from './config.mjs';
import { keepAlive } from './browser.mjs';
import { ensureEndpoints, ensureFrame, fetchRoaming, readConversations, resolveName } from './chaoxing.mjs';
import { attachmentTeacher, describeAttachment, messageKind } from './decode.mjs';
import { mergeMessages, readIndex, readSession, writeIndex, writeSession } from './store.mjs';

/**
 * 把一条解码后的消息变成存进本地库的记录。
 * @param {object} message
 * @param {string} sender
 * @returns {object}
 */
function toRecord(message, sender) {
  const text = message.attachments.length
    ? message.attachments.map(describeAttachment).join('；')
    : (message.text || '').trim();
  return {
    id: message.id,
    ts: message.timestamp,
    sender,
    kind: text ? messageKind(message) : '其它',
    // 图片、语音这类我们还没解析的消息也不能留空——宁可写清楚"看不到"，
    // 也不要让人以为这里本来就没东西。
    text: text || '（这条消息没有文本正文，可能是图片或语音，暂未解析）',
    attachments: message.attachments,
  };
}

/**
 * 纯文字会话没有 courseInfo.teacherfactor，用"发言最多的人"当老师。
 * @param {object[]} records
 * @returns {string}
 */
function mostFrequentSender(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record.sender) continue;
    counts.set(record.sender, (counts.get(record.sender) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 同步一次。
 * @param {{force?: boolean, onProgress?: (text: string) => void}} [options]
 * @returns {Promise<{skipped: boolean, lastSyncAt: number, conversations: object[]}>}
 */
export async function sync(options = {}) {
  const config = loadConfig();
  const index = readIndex();

  if (!options.force && index.lastSyncAt && Date.now() - index.lastSyncAt < config.syncTtlSeconds * 1000) {
    return { skipped: true, lastSyncAt: index.lastSyncAt, conversations: index.conversations };
  }

  const progress = options.onProgress || ((text) => process.stderr.write(`[chaoxing] ${text}\n`));

  const frame = await ensureFrame();
  let endpoints = await ensureEndpoints(frame);
  const conversations = await readConversations(frame);
  if (!conversations.length) throw new Error('会话列表是空的，消息面板可能还没加载完');

  const summary = [];

  for (const conversation of conversations) {
    let messages;
    try {
      messages = await fetchRoaming(frame, endpoints, conversation);
    } catch (error) {
      // token 过期：重取一次再试，其余错误直接上报
      if (!/401/.test(error.message)) throw error;
      endpoints = await ensureEndpoints(frame, true);
      messages = await fetchRoaming(frame, endpoints, conversation);
    }

    const previous = readSession(conversation.id);
    const records = [];
    let teacher = '';

    for (const message of messages) {
      const fromCard = message.attachments.map(attachmentTeacher).find(Boolean);
      const sender = fromCard || (await resolveName(frame, message.from));
      if (fromCard && !teacher) teacher = fromCard;
      records.push(toRecord(message, sender));
    }

    // 纯文字会话没有 teacherfactor，退而求其次：发言最多的那个（通常就是老师）。
    // 私聊不适用——那里发言最多的是你自己。
    if (!teacher && conversation.isGroup !== false) teacher = mostFrequentSender(records);

    const merged = mergeMessages(previous ? previous.messages : [], records);
    const session = {
      sessionId: conversation.id,
      name: conversation.name,
      isGroup: conversation.isGroup !== false,
      // 拉到消息却没推出老师，就是没有（别把上一轮的旧值继承下来，
      // 否则私聊里会一直显示成你自己）
      teacher: teacher || (records.length === 0 ? (previous && previous.teacher) || '' : ''),
      updatedAt: Date.now(),
      messages: merged,
    };
    writeSession(session);

    summary.push({
      id: conversation.id,
      name: conversation.name,
      teacher: session.teacher,
      unread: conversation.unread,
      lastMessageId: conversation.lastMessageId,
      lastMessageTimestamp: conversation.lastMessageTimestamp,
      messageCount: merged.length,
    });
    progress(`${conversation.name}：本地 ${merged.length} 条`);
  }

  const lastSyncAt = Date.now();
  writeIndex({ lastSyncAt, conversations: summary });
  keepAlive();
  return { skipped: false, lastSyncAt, conversations: summary };
}

/**
 * 只在需要时同步，返回本地索引。
 * @param {boolean} [force]
 */
export async function syncIfStale(force = false) {
  return sync({ force });
}
