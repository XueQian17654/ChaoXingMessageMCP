/**
 * 环信消息解码。
 *
 * messageroaming 返回的 `data.msgs[].msg` 是 base64 包着的 protobuf，字段是实测出来的，
 * 和网页端 Vue store 里的字段一一对应：
 *
 *   f1 = 消息 id（= store 的 lastMessageId）
 *   f2 = from JID，内层 f2 是用户号
 *   f3 = to   JID
 *   f4 = 时间戳毫秒（= store 的 lastMessageTimestamp）
 *   f6 = 正文容器：内层 f2=发送人、f4=文字体、f5=ext 键值对（attachment 就藏在这）
 *
 * 课程通知（签到 / 投票 / 选人 / 文件 / 话题讨论）的正文全在 f6 的 ext.attachment 里，
 * 网页端根本渲染不出来，所以这里绝不能靠 DOM。
 */

/**
 * 读一个 protobuf varint。
 * @param {Buffer} buf
 * @param {number} pos
 * @returns {[bigint, number]} 值与新的读取位置
 */
export function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, pos];
}

/**
 * 把一段 protobuf 拆成字段数组。只处理 varint(0) 和 length-delimited(2)，
 * 其余 wire type 跳过——环信的消息用不到。
 * @param {Buffer} buf
 * @returns {{field: number, wire: number, value?: bigint, bytes?: Buffer}[]}
 */
export function parseFields(buf) {
  const fields = [];
  let pos = 0;

  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      const bytes = buf.subarray(pos, pos + Number(length));
      pos += Number(length);
      fields.push({ field, wire, bytes });
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`不认识的 protobuf wire type ${wire}`);
    }
  }
  return fields;
}

const varintField = (fields, field) => fields.find((f) => f.field === field && f.wire === 0)?.value ?? null;
const bytesField = (fields, field) => fields.find((f) => f.field === field && f.wire === 2)?.bytes ?? null;
const textField = (fields, field) => bytesField(fields, field)?.toString('utf8') ?? null;

/**
 * 解开一条环信消息。
 * @param {string} base64
 * @returns {{id: string|null, timestamp: number|null, from: string|null, text: string|null, attachments: object[]}}
 */
export function decodeMessage(base64) {
  const buf = Buffer.from(base64, 'base64');
  const top = parseFields(buf);

  const id = varintField(top, 1);
  const timestamp = varintField(top, 4);

  let from = null;
  let text = null;
  const attachments = [];

  const body = bytesField(top, 6);
  if (body) {
    const fields = parseFields(body);

    const fromJid = bytesField(fields, 2);
    if (fromJid) from = textField(parseFields(fromJid), 2);

    const messageBody = bytesField(fields, 4);
    if (messageBody) {
      text = textField(parseFields(messageBody), 2);
      if (!text) {
        // 图片 / 语音 / 文件这类非文本消息没有文本字段，但正文里通常带着资源地址。
        // 捞出来总比留空强——至少知道这条消息是什么。
        const url = /https?:\/\/[\x21-\x7e]+/.exec(messageBody.toString('utf8'));
        if (url) text = `（非文本消息）${url[0].replace(/["'\\,}]+$/, '')}`;
      }
    }

    for (const entry of fields.filter((f) => f.field === 5 && f.wire === 2)) {
      const pair = parseFields(entry.bytes);
      if (textField(pair, 1) !== 'attachment') continue;
      const value = textField(pair, 6);
      if (!value) continue;
      try {
        attachments.push(JSON.parse(value));
      } catch {
        /* 值不是 JSON 就跳过 */
      }
    }
  }

  return {
    id: id === null ? null : id.toString(),
    timestamp: timestamp === null ? null : Number(timestamp),
    from,
    text: text || null,
    attachments,
  };
}

/**
 * 附件对象 → 一行中文描述。
 * @param {object} attachment
 * @returns {string}
 */
export function describeAttachment(attachment) {
  if (attachment.att_chat_course) {
    const card = attachment.att_chat_course;
    const title = card.title && card.title !== card.atypeName ? `：${card.title}` : '';
    return `【${card.atypeName || '课程活动'}】${title}`;
  }
  if (attachment.att_clouddisk) {
    const file = attachment.att_clouddisk;
    return `【文件】${file.name || ''}${file.fileSize ? `（${file.fileSize}）` : ''}`;
  }
  if (attachment.att_topic) return `【话题讨论】${attachment.att_topic.content || ''}`;
  const key = Object.keys(attachment).find((k) => k.startsWith('att_')) || '附件';
  return `【${key.replace(/^att_/, '')}】`;
}

/**
 * 消息类型标签，给 search_messages 的 kinds 过滤用。
 * @param {object} message 已解码的消息
 * @returns {string}
 */
export function messageKind(message) {
  const card = message.attachments.find((a) => a.att_chat_course)?.att_chat_course;
  if (card) {
    const name = card.atypeName || '';
    if (name.includes('签到')) return '签到';
    if (name.includes('投票')) return '投票';
    if (name.includes('选人') || name.includes('抢答')) return '选人';
    return '课程通知';
  }
  if (message.attachments.some((a) => a.att_clouddisk)) return '文件';
  if (message.attachments.some((a) => a.att_topic)) return '话题讨论';
  if (message.attachments.length) return '其它';
  return '文字';
}

/** 附件自带的 subTitle，卡片上显示的 `MM-DD HH:mm` */
export function attachmentTime(attachment) {
  return (
    (attachment.att_chat_course && attachment.att_chat_course.subTitle) ||
    (attachment.att_topic && attachment.att_topic.subTitle) ||
    ''
  );
}

/** 课程通知里带的老师名 */
export function attachmentTeacher(attachment) {
  const info = attachment.att_chat_course && attachment.att_chat_course.courseInfo;
  return (info && info.teacherfactor) || '';
}

/**
 * 把一条 messageroaming 响应解成消息数组（按时间升序）。
 * @param {string} responseText
 * @returns {object[]}
 */
export function decodeRoaming(responseText) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return [];
  }
  const messages = (payload && payload.data && payload.data.msgs) || [];
  return messages
    .map((entry) => decodeMessage(entry.msg || ''))
    .filter((message) => message.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
}
