/**
 * 本地消息库。
 *
 *   messages/_index.json          会话索引 + 上次同步时间
 *   messages/<会话id>.json        一个会话一个文件，里面是这个会话的全部消息
 *
 * 不按天分文件——按会话分，查的时候直接读那一个文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, messagesDir } from './config.mjs';

const INDEX_FILE = '_index.json';

/** 确保 messages 目录存在 */
function ensureDir() {
  const dir = messagesDir(loadConfig());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 读会话索引。
 * @returns {{lastSyncAt: number|null, conversations: object[]}}
 */
export function readIndex() {
  const file = path.join(ensureDir(), INDEX_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastSyncAt: raw.lastSyncAt ?? null, conversations: raw.conversations || [] };
  } catch {
    return { lastSyncAt: null, conversations: [] };
  }
}

/**
 * 写会话索引。先写临时文件再改名，避免断电留下半个 JSON。
 * @param {{lastSyncAt: number|null, conversations: object[]}} index
 */
export function writeIndex(index) {
  const file = path.join(ensureDir(), INDEX_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** @returns {string} 某个会话的文件路径 */
export function sessionFile(sessionId) {
  // 会话 id 是纯数字，但仍做一次清洗，避免路径穿越
  const safe = String(sessionId).replace(/[^0-9A-Za-z_-]/g, '');
  return path.join(ensureDir(), `${safe}.json`);
}

/**
 * 读一个会话的消息文件。
 * @param {string} sessionId
 * @returns {{sessionId: string, name: string, teacher: string, updatedAt: number|null, messages: object[]}|null}
 */
export function readSession(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 写一个会话的消息文件。
 * @param {object} session
 */
export function writeSession(session) {
  const file = sessionFile(session.sessionId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 列出本地所有会话文件。
 * @returns {object[]} 每个文件的解析结果，坏文件跳过
 */
export function readAllSessions() {
  const dir = ensureDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name === INDEX_FILE) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

/**
 * 合并消息：按 id 去重，按时间升序。
 * 老消息不会被覆盖掉——漫游接口每次只给最近 N 条，本地要能累积。
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {object[]}
 */
export function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}
