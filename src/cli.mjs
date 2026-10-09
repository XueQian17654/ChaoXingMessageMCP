#!/usr/bin/env node
/**
 * 命令行工具。
 *
 *   npm run set-user -- <手机号> <密码>   写入 config.json
 *   npm run cxm -- show                  看当前配置（密码打码）
 *   npm run cxm -- fetch                 强制去学习通拉一次，落进 messages/
 *   npm run cxm -- list                  看本地存了什么
 */
import { CONFIG_PATH, configExists, defaultConfig, loadConfig, saveConfig } from './config.mjs';
import { closeBrowser, installCleanup } from './browser.mjs';
import { localSummary } from './tools.mjs';
import { sync } from './sync.mjs';

const USAGE = `
用法：
  npm run set-user -- <手机号> <密码>   设置账号密码
  npm run cxm -- show                  查看配置（密码打码）
  npm run cxm -- fetch                 强制同步一次
  npm run cxm -- list                  查看本地已存的消息
  npm run cxm -- mcp                   启动 MCP 服务器（通常由客户端调）
`.trim();

function mask(value) {
  if (!value) return '(未设置)';
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(0, value.length - 3))}`;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
async function run(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'set-user': {
      const [phone, password] = rest;
      if (!phone || !password) {
        process.stderr.write('用法：npm run set-user -- <手机号> <密码>\n');
        return 1;
      }
      const config = configExists() ? loadConfig() : defaultConfig();
      config.user = { phone, password };
      saveConfig(config);
      process.stdout.write(`已写入 ${CONFIG_PATH}\n  账号 ${phone}\n  密码 ${mask(password)}\n`);
      return 0;
    }

    case 'show': {
      if (!configExists()) {
        process.stderr.write(`还没有 ${CONFIG_PATH}，先跑 npm install\n`);
        return 1;
      }
      const config = loadConfig();
      process.stdout.write(
        `${JSON.stringify({ ...config, user: { phone: config.user.phone, password: mask(config.user.password) } }, null, 2)}\n`,
      );
      return 0;
    }

    case 'fetch': {
      const result = await sync({ force: true, onProgress: (text) => process.stdout.write(`${text}\n`) });
      process.stdout.write(`\n同步完成，共 ${result.conversations.length} 个会话\n`);
      for (const conversation of result.conversations) {
        process.stdout.write(`  ${conversation.name}（${conversation.teacher || '未知老师'}）本地 ${conversation.messageCount} 条\n`);
      }
      return 0;
    }

    case 'list': {
      const summary = localSummary();
      process.stdout.write(`上次同步：${summary.lastSyncAt ? new Date(summary.lastSyncAt).toLocaleString() : '从未'}\n`);
      process.stdout.write(`会话 ${summary.conversationCount} 个，消息 ${summary.messageCount} 条\n\n`);
      for (const session of summary.sessions) {
        process.stdout.write(`  ${session.name}  ${session.messages} 条  (${session.sessionId})\n`);
      }
      return 0;
    }

    case 'mcp':
      process.stderr.write('MCP 服务器请直接跑 node ./src/mcp.mjs，或让客户端拉起\n');
      return 0;

    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return 0;

    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
      return 1;
  }
}

installCleanup();
run(process.argv.slice(2))
  .then(async (code) => {
    await closeBrowser();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(`出错了：${error.message}\n`);
    await closeBrowser();
    process.exit(1);
  });
