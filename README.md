# ChaoXingMessageMCP

ChaoXingMessageMCP是一个用于超星学习通消息的 MCP 服务器。
它给 AI agent 提供三个只读工具：

| 工具 | 入参 | 用途 |
|---|---|---|
| `list_conversations` | 无 | 枚举所有会话（课程群聊） |
| `search_messages` | 文本 / 时间段 / 会话 id，任选 | 搜索消息 |
| `get_context` | 消息 id + 上下文条数 | 看某条消息的前后文 |

可以获取的消息包括但不限于签到、投票、选人、文件、话题讨论

## 安装（从源码安装）
安装 Node.js 20+，以及一个 Chromium 内核的浏览器（Chrome 或 Edge），然后运行
如需从仓库源码安装：
```bash
git clone https://github.com/XueQian17654/ChaoXingMessageMCP
cd ChaoXingMessageMCP
npm install
```

## 配置

### 必须项
```bash
npm run set-user -- 手机号 密码
```

### 可选项 位于config.json

| 配置项 | 说明 | 默认值 |
| ---- | ---- | ---- |
| user | 账号信息，包含 phone（手机号）、password（密码） | `{"phone":"...","password":"..."}` |
| chromePath | 浏览器路径，留空自动探测 | `""` |
| headless | 是否无头模式 | `true` |
| idleCloseMinutes | 浏览器空闲自动关闭时间（分钟），0 = 一直保持打开 | `10` |
| syncTtlSeconds | 缓存有效期，距上次同步不足该秒数则直接读取本地数据 | `60` |
| messagesDir | 消息存储目录名 | `"messages"` |
| profileDir | 浏览器用户配置目录名 | `"user-profile"` |

## 使用

### DeepSeek Harness
```yaml
- insert:
    - id: mcp-chaoxing
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chaoxing
        transport: stdio
        command: '~\nodejs\node.exe'
        args: [ '~\ChaoXingMessageMCP\src\mcp.mjs' ]
```

### Claude Code
```josn
{
  "mcpServers": {
    "chaoxing": {
      "type": "stdio",
      "command": "~\\nodejs\\node.exe",
      "args": [
        "~\\ChaoXingMessageMCP\\src\\mcp.mjs"
      ]
    }
  }
}
```

### OpenAI Codex
```toml
[mcp_servers.chaoxing]
command = "~\\nodejs\\node.exe"
args = ["~\\ChaoXingMessageMCP\\src\\mcp.mjs"]
enabled = true
```


## 数据存在哪

```
config.messagesDir/_index.json        索引文件，会话索引以及上次同步时间
config.messagesDir/<会话id>.json      会话文件，里面是这个会话的全部消息
config.profileDir/            浏览器登录态
```

同步是**按需的**：工具被调用时才去拉，`syncTtlSeconds` 之内不重复拉。
想看最新的可以直接 `npm run cxm -- fetch` 强制同步。

## 命令行

```bash
npm run cxm -- show      # 看当前配置
npm run cxm -- fetch     # 强制同步一次
npm run cxm -- list      # 看本地存了什么
```

## 它是怎么做到的

- 用 `playwright-core` 连**系统已装的** Chrome/Edge（回退链：配置 → Chrome → Edge），
  所以不下载浏览器，依赖只有 12 MB。
- 判断登录态不看 URL——passport2 的登录页在已登录时不会自动跳走——而是用带 cookie 的
  轻量接口探一下。
- 消息面板在 `fe.chaoxing.com` 的跨域 iframe 里，父页面脚本够不到，所以要拿到 frame 句柄。
- **不点会话**：点会话会把这门课的未读标记清掉。会话列表直接从页面里的 Vue store 读。
- 正文从 `messageroaming` 的 protobuf 里解，不依赖 DOM 渲染，所以空气泡也不会漏。
- 所有跨域请求必须带 `Accept: application/json, text/plain, */*`——超星服务端拿它决定响应
  编码，少了这个头中文会变成写进响应体的真问号。
