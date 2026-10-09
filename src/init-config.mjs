/**
 * postinstall 钩子：`npm install` 之后跑一次。
 *
 * 只在 config.json 不存在时生成一份默认的——这就是为什么仓库里
 * 不需要 config.example.json：用户装完依赖就"开箱有 config"。
 * 已经存在的配置绝不覆盖（用户的账号密码在里面）。
 */
import { CONFIG_PATH, configExists, defaultConfig } from './config.mjs';
import fs from 'node:fs';

const NAME = '[chaoxing-message-mcp]';

if (configExists()) {
  console.log(`${NAME} config.json 已存在，保留不动`);
} else {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  console.log(`${NAME} 已生成 config.json`);
  console.log(`${NAME} 下一步：npm run set-user -- <手机号> <密码>`);
}
