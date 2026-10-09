/**
 * 学习通侧的操作：登录、进消息面板、读会话列表、拉消息漫游、解姓名。
 *
 * 所有跨域请求都在**页面里**用 fetch 发，不在 Node 里发。原因：
 *   1. 跨域 CORS 由页面自己处理；
 *   2. cookie 自动带上，不用去解 Chrome 加密后的 cookie 库；
 *   3. IM token 直接从 chaoxing 自己的接口现取，永远新鲜。
 *
 * ⚠️ 所有跨域接口都必须带 `Accept: application/json, text/plain, *​/*`。
 * 超星服务端拿它决定响应编码，只发 `*​/*` 时中文会退化成写进响应体里的真问号。
 * 这几个函数要被序列化进页面执行，拿不到外层常量，所以字面量只能重复写。
 */
import fs from 'node:fs';
import { loadConfig, profileDir, userConfigured, userSetupHint } from './config.mjs';
import { getPage, keepAlive } from './browser.mjs';
import { decodeRoaming } from './decode.mjs';

const LOGIN_URL = 'https://passport2.chaoxing.com/login';
const BASE_URL = 'https://i.chaoxing.com/base';
const NOTICE_URL = 'https://i.chaoxing.com/base/getNoticeCount';
const WEBIM_HOST = 'fe.chaoxing.com/front/webim';

/** 当前会话：{ frame, prefix, easemobUser, roamingUrl, token, names } */
let live = null;

/** addInitScript 只需要往每个 context 挂一次 */
let hookedContext = null;

/**
 * 保证有一个可用的 webim frame。第二次调用会复用，不重新导航。
 *
 * 注意顺序：钩子必须在**导航之前**挂上。SDK 的启动请求（user_channels/list、
 * messageroaming）在页面一加载就发了，晚一步就什么都抓不到。
 * @returns {Promise<import('playwright-core').Frame>}
 */
export async function ensureFrame() {
  // 全新环境（还没有浏览器 profile）里连登录态都没有，先确认账号配过，
  // 免得白启动一次浏览器再报错——桌面还会闪一下。
  const config = loadConfig();
  if (!userConfigured(config) && !fs.existsSync(profileDir(config))) {
    throw new Error(userSetupHint());
  }

  const page = await getPage();
  if (hookedContext !== page.context()) {
    await page.context().addInitScript(HOOK_URLS);
    hookedContext = page.context();
  }

  await ensureLoggedIn(page);

  let frame = webimFrame(page);
  if (!frame) frame = await openMessages(page);
  keepAlive();
  return frame;
}

/**
 * 拿齐拉消息需要的三样东西：漫游地址、环信用户号、IM token。
 * token 会过期，所以允许强制重取。
 * @param {import('playwright-core').Frame} frame
 * @param {boolean} [refresh]
 * @returns {Promise<{roamingUrl: string, easemobUser: string, token: string}>}
 */
export async function ensureEndpoints(frame, refresh = false) {
  if (live && live.frame === frame && !refresh) return live;

  const urls = await frame.evaluate(() => window.__cxUrls || []);
  const found = parseEasemobUrls(urls);
  if (!found) throw new Error('没能从页面请求里认出环信地址，消息面板可能还没加载完');

  const token = await frame.evaluate(GET_TOKEN);
  if (!token) throw new Error('getUserImToken 没有返回 hxToken，登录态可能失效了');

  live = { frame, ...found, token, names: (live && live.names) || new Map() };
  return live;
}

/** 丢弃缓存的 token，下次重取 */
export function forgetToken() {
  if (live) live.token = null;
}

/** 找已经存在的 webim iframe */
function webimFrame(page) {
  return page.frames().find((f) => f.url().includes(WEBIM_HOST));
}

/**
 * 确认登录态。passport2 的登录页在已登录时**不会**自动跳走，
 * 所以不能看 URL 判断，要用带 cookie 的轻量接口探。
 * @param {import('playwright-core').Page} page
 */
async function ensureLoggedIn(page) {
  const config = loadConfig();

  const probe = await page
    .context()
    .request.get(NOTICE_URL, { timeout: 15_000 })
    .catch(() => null);
  if (probe && probe.ok()) {
    const body = (await probe.text()).trim();
    if (body.startsWith('{') || body.startsWith('[')) return;
  }

  // 没配账号（还是占位符或空值）就直接把说明抛出去，MCP 会原样转给 LLM，
  // 让它去提醒用户设置密码——不要拿 "Your Phone Number" 去登录然后报个看不懂的错。
  if (!userConfigured(config)) throw new Error(userSetupHint());

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(2000);

  const password = page.locator('input[type="password"]').first();
  if (!(await password.count())) return; // 已经是登录态，页面直接把表单换掉了

  await page
    .locator('#phone, input[placeholder*="手机号"], input[name="uname"], input[type="text"]')
    .first()
    .fill(config.user.phone);
  await password.fill(config.user.password);
  await page.locator('#loginBtn, button:has-text("登录"), a:has-text("登录")').first().click();
  await page.waitForTimeout(3500);

  if (/passport2\.chaoxing\.com\/login/.test(page.url())) {
    const hint = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`登录没成功，还停在登录页（可能要验证码）。把 config.json 里的 headless 改成 false 可以看现场。页面内容：${hint}`);
  }
  process.stderr.write('[chaoxing] 登录成功\n');
}

/**
 * 进个人空间 → 点「消息」→ 返回 webim 的 frame。
 * @param {import('playwright-core').Page} page
 */
async function openMessages(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(2000);

  if (/passport|login/i.test(page.url())) throw new Error(`被弹回登录页：${page.url()}`);

  const selectors = ['[role="menuitem"]:has-text("消息")', '[role="menubar"] >> text=消息', 'text=消息'];
  let clicked = false;
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    try {
      await target.waitFor({ state: 'visible', timeout: 4000 });
      await target.click();
      clicked = true;
      break;
    } catch {
      /* 换下一个选择器 */
    }
  }
  if (!clicked) throw new Error('页面上没找到「消息」菜单项');

  for (let i = 0; i < 60; i++) {
    const frame = webimFrame(page);
    if (frame) {
      await frame.waitForSelector('.message-list', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return frame;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('webim iframe 一直没出现');
}

/**
 * 读会话列表。数据来自页面里的 Vue/pinia store——
 * **不点会话**，因为点会话会把这人的未读标记清掉。
 * @param {import('playwright-core').Frame} frame
 * @returns {Promise<object[]>}
 */
export async function readConversations(frame) {
  return frame.evaluate(() => {
    const root = document.querySelector('#app') || document.querySelector('[data-v-app]');
    const app = root && root.__vue_app__;
    const pinia = app && app.config.globalProperties && app.config.globalProperties.$pinia;
    const state = pinia && pinia.state && pinia.state.value;
    const list = (state && state.conversation && state.conversation.conversations) || [];
    return list.map((item) => ({
      id: String(item.id),
      name: item.name || '',
      isGroup: item.isGroup !== false,
      lastMessageId: item.lastMessageId ? String(item.lastMessageId) : null,
      lastMessageTimestamp: Number(item.lastMessageTimestamp) || 0,
      unread: Number(item.unread) || 0,
    }));
  });
}

/** 记下每个会话哪种 queue 写法能拿到消息，避免每次都试三种 */
const queueFormat = new Map();

/**
 * 拉一个会话的历史消息。
 *
 * queue 的写法群聊和私聊不一样，网页端自己也是在两种格式之间切。与其去逆向，
 * 不如按可能性依次试，哪个能拿到消息就用哪个，并把结果记下来。
 * @param {import('playwright-core').Frame} frame
 * @param {{roamingUrl: string, token: string}} endpoints
 * @param {{id: string, isGroup?: boolean}} conversation
 * @param {number} [count]
 * @returns {Promise<object[]>} 已解码的消息，按时间升序
 */
export async function fetchRoaming(frame, endpoints, conversation, count = 50) {
  const id = conversation.id;
  const candidates = conversation.isGroup === false
    ? [id, `${id}@easemob.com`, `${id}@conference.easemob.com`]
    : [`${id}@conference.easemob.com`, id];

  const known = queueFormat.get(id);
  const ordered = known ? [known, ...candidates.filter((q) => q !== known)] : candidates;

  let last = [];
  for (const queue of ordered) {
    const messages = await postRoaming(frame, endpoints, queue, count);
    if (messages.length) {
      queueFormat.set(id, queue);
      return messages;
    }
    last = messages;
  }
  return last;
}

/**
 * 发一次 messageroaming 请求并解码。
 * @returns {Promise<object[]>}
 */
async function postRoaming(frame, endpoints, queue, count) {
  const result = await frame.evaluate(
    async ({ url, token, queue: q, count: n }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          queue: q,
          start: -1,
          pull_number: n,
          is_positive: false,
          msgType: '',
          end: -1,
          startTime: null,
          endTime: null,
          userId: null,
        }),
      });
      return { status: res.status, text: await res.text() };
    },
    { url: endpoints.roamingUrl, token: endpoints.token, queue, count },
  );

  if (result.status === 401) {
    forgetToken();
    throw new Error('messageroaming 401，IM token 过期，下次会自动重取');
  }
  if (result.status !== 200) throw new Error(`messageroaming 返回 HTTP ${result.status}`);

  return decodeRoaming(result.text);
}

/**
 * 环信用户号 → 姓名，带缓存。
 * @param {import('playwright-core').Frame} frame
 * @param {string|null} uid
 * @returns {Promise<string>}
 */
export async function resolveName(frame, uid) {
  if (!uid) return '';
  if (live && live.names.has(uid)) return live.names.get(uid);

  const name = await frame
    .evaluate(async (tuid) => {
      const res = await fetch(
        `https://im.chaoxing.com/webim/user/getUserInfoByTuid?crossOrigin=true&tuid=${encodeURIComponent(tuid)}`,
        { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } },
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json && json.name ? json.name : null;
    }, uid)
    .catch(() => null);

  const value = name || '';
  if (live) live.names.set(uid, value);
  return value;
}

/**
 * 从页面发过的请求里认出环信地址。
 * 优先用真正发过 messageroaming 的那条——环信按服务分域名（a1 登录、a3 消息），
 * 猜错域名会直接 404。
 * @param {string[]} urls
 * @returns {{prefix: string, easemobUser: string, roamingUrl: string}|null}
 */
function parseEasemobUrls(urls) {
  const ordered = [...urls].sort((a, b) => Number(/messageroaming/.test(b)) - Number(/messageroaming/.test(a)));
  for (const url of ordered) {
    const match = /^(https:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(?:.*?\/)?(?:users|user)\/(\d{6,})(?:\/|$)/.exec(url);
    if (!match) continue;
    return {
      prefix: `${match[1]}/${match[2]}/${match[3]}`,
      easemobUser: match[4],
      roamingUrl: /messageroaming/.test(url) ? url : `${match[1]}/${match[2]}/${match[3]}/users/${match[4]}/messageroaming`,
    };
  }
  return null;
}

/**
 * 注入脚本：记录页面向环信发过的请求 URL。
 * 必须用 context.addInitScript 在页面脚本之前注入，否则启动请求就漏掉了。
 */
export const HOOK_URLS = () => {
  window.__cxUrls = window.__cxUrls || [];
  if (window.__cxHooked) return;
  window.__cxHooked = true;

  const remember = (url) => {
    const target = String(url || '');
    if (!/easemob\.com/.test(target)) return;
    if (!window.__cxUrls.includes(target)) window.__cxUrls.push(target);
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    remember(url);
    return open.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input) {
    remember(typeof input === 'string' ? input : input && input.url);
    return originalFetch.apply(this, arguments);
  };
};

/** 页面内取一次 IM token（hxToken 就是 Bearer） */
const GET_TOKEN = async () => {
  const res = await fetch('https://learn.chaoxing.com/apis/user/getUserImToken?crossOrigin=true', {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  const json = await res.json();
  return (json && json.msg && json.msg.hxToken) || null;
};
