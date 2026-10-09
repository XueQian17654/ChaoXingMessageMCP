/**
 * config.json 的读写。
 *
 * 仓库里提交的是一份**带占位符**的 config.json（不叫 example，用户开箱就有），
 * 账号密码由 `set-user` 覆盖写入。跑过 set-user 之后这份文件就带着真密码了，
 * 所以别在仓库目录里跑它——开发测试都在别处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（src/ 的上一级） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  user: { phone: '', password: '' },
  /** 留空则自动探测：Chrome → Edge */
  chromePath: '',
  /** 无头运行；排查登录问题时可以临时改成 false */
  headless: true,
  /** 浏览器空闲多少分钟后自动关掉（0 = 一直留着） */
  idleCloseMinutes: 10,
  /** 距上次同步不到这么多秒就直接读本地，不重新拉 */
  syncTtlSeconds: 60,
  /** 相对 ROOT 的路径 */
  messagesDir: 'messages',
  profileDir: 'user-profile',
};

/** 仓库里那份 config.json 预置的占位符，用来判断用户到底配过没有 */
const PLACEHOLDERS = new Set(['your password', 'password', 'your phone number', 'phone', '请输入']);

/**
 * 账号密码是否真的配过了。
 * 仓库里提交的 config.json 是占位符版本，没跑过 set-user 时就是这些值。
 * @param {object} config
 * @returns {boolean}
 */
export function userConfigured(config) {
  const phone = String(config?.user?.phone ?? '').trim();
  const password = String(config?.user?.password ?? '').trim().toLowerCase();
  // 学习通的账号是手机号或超星号，都是纯数字，这一条就能挡掉占位符和空值
  if (!/^\d{6,}$/.test(phone)) return false;
  return Boolean(password) && !PLACEHOLDERS.has(password);
}

/**
 * 没配账号时给调用方的提示（MCP 会原样转给 LLM，让它去提醒用户）。
 * @returns {string}
 */
export function userSetupHint() {
  return (
    '还没有配置学习通账号密码（config.json 里目前是占位符）。' +
    '请让用户先执行：npm run set-user -- <手机号> <密码>；' +
    `或直接编辑 ${CONFIG_PATH} 里的 user.phone 和 user.password。`
  );
}

/** @returns {object} 一份全新的默认配置 */
export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/** @returns {boolean} config.json 是否存在 */
export function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

/**
 * 读配置，缺失的键用默认值补齐。
 * @returns {object}
 * @throws config.json 不存在时
 */
export function loadConfig() {
  if (!configExists()) {
    throw new Error(`找不到 ${CONFIG_PATH}。先跑：npm install（会自动生成），或 npm run set-user -- <手机号> <密码>`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return { ...defaultConfig(), ...raw, user: { ...DEFAULTS.user, ...(raw.user || {}) } };
}

/**
 * 写配置。
 * @param {object} config
 */
export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * 把配置里的相对路径解析成绝对路径（相对仓库根目录）。
 * @param {string} value
 * @returns {string}
 */
export function resolveInRoot(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

/** @returns {string} messages 目录的绝对路径 */
export function messagesDir(config) {
  return resolveInRoot(config.messagesDir);
}

/** @returns {string} 浏览器 profile 目录的绝对路径 */
export function profileDir(config) {
  return resolveInRoot(config.profileDir);
}
