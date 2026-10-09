/**
 * 浏览器生命周期：找一个能用的 Chromium 内核浏览器，按需启动，空闲自动关。
 *
 * 依赖只有 playwright-core（12MB，不下载浏览器），所以必须用系统已有的浏览器。
 * 回退链：config 指定的路径 → Chrome → Edge。Windows 10/11 出厂带 Edge，
 * 所以"用户没有 Chromium 浏览器"这种情况基本不存在。
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { loadConfig, profileDir } from './config.mjs';

/** 各平台的常见安装位置，按优先级 */
const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

/**
 * 定位浏览器可执行文件。
 * @param {string} [explicit] config 里指定的路径
 * @returns {string}
 */
export function findBrowser(explicit) {
  const list = explicit ? [explicit, ...(CANDIDATES[process.platform] || [])] : CANDIDATES[process.platform] || [];
  for (const candidate of list) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `没找到 Chrome 或 Edge。请装一个 Chromium 内核的浏览器，` +
      `或在 config.json 的 chromePath 里写明路径（当前平台 ${process.platform}）`,
  );
}

/** 当前会话：{ context, page, timer } */
let session = null;

/** 每次工具调用都要调一次，重置空闲计时器 */
export function keepAlive() {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  const minutes = loadConfig().idleCloseMinutes;
  if (!minutes || minutes <= 0) return;
  session.timer = setTimeout(() => {
    void closeBrowser('空闲超时');
  }, minutes * 60_000);
  session.timer.unref?.();
}

/**
 * 拿到一个已登录（或可登录）的页面。第一次调用才真正启动浏览器。
 * @returns {Promise<import('playwright-core').Page>}
 */
export async function getPage() {
  if (session && session.page && !session.page.isClosed()) {
    keepAlive();
    return session.page;
  }

  const config = loadConfig();
  const executablePath = findBrowser(config.chromePath);
  const userDataDir = profileDir(config);
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: config.headless !== false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1400, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(45_000);
  session = { context, page, timer: null };
  await applyRealUserAgent(page);
  keepAlive();
  process.stderr.write(`[chaoxing] 浏览器已启动：${executablePath}\n`);
  return page;
}

/**
 * 把无头模式的 UA 里的 "Headless" 去掉。
 * 学习通有风控，`HeadlessChrome/154` 这种 UA 太显眼了。
 * @param {import('playwright-core').Page} page
 */
async function applyRealUserAgent(page) {
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  if (!userAgent.includes('Headless')) return;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
    await client.detach();
  } catch {
    /* 改不了就算了，不阻断主流程 */
  }
}

/**
 * 关掉浏览器。
 * @param {string} [reason]
 */
export async function closeBrowser(reason) {
  if (!session) return;
  const current = session;
  session = null;
  if (current.timer) clearTimeout(current.timer);
  try {
    await current.context.close();
    process.stderr.write(`[chaoxing] 浏览器已关闭${reason ? `（${reason}）` : ''}\n`);
  } catch {
    /* 已经关了 */
  }
}

/**
 * 注册进程退出时的清理。stdio MCP 的客户端断开时会关掉我们的 stdin，
 * 那就是"agent 关了"的信号。
 */
export function installCleanup() {
  const bye = () => {
    void closeBrowser('进程退出');
  };
  process.on('SIGINT', () => void closeBrowser('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => void closeBrowser('SIGTERM').then(() => process.exit(0)));
  process.on('exit', bye);
  process.stdin.on('end', () => {
    void closeBrowser('stdin 关闭').then(() => process.exit(0));
  });
  process.stdin.on('close', () => {
    void closeBrowser('stdin 关闭').then(() => process.exit(0));
  });
}
