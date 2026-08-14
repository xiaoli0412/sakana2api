# sakana-2api

OpenAI 兼容 API 反代 → **chat.sakana.ai 免费网页版聊天**

> 无需购买 Sakana AI 付费 API,通过真实浏览器会话调用网页版后端,获得与付费 API 几乎一致的能力:流式/思维链/Web 搜索/多模态/工具调用。

## 原理

1. 在你的 Windows 机器上启动**真实 Chrome**(带 user-data-dir),用你的账号登录 `chat.sakana.ai`(邮箱魔法链接),收割会话 cookie(`sakana-chat` + `cf_clearance`)。
2. Node.js 服务端使用这些 cookie 直接调用 `chat.sakana.ai` 的内部 API(`/api/conversation`),同时把网页版协议**翻译成 OpenAI 兼容格式**。
3. **刷新**:Firebase refreshToken 自动续期 idToken;cf_clearance 过期时触发浏览器重新收割。

## 能力清单

| 功能 | 对应 OpenAI API 参数 | 状态 |
|------|---------------------|------|
| **流式输出** | `stream: true` | ✅ |
| **非流式输出** | `stream: false` | ✅ |
| **思维链(原生 reasoning)** | `thinking: true` / `reasoning_effort` | ✅ |
| **Web 搜索** | `web_search: true` / `web_search_options` | ✅ 返回结构化 citations |
| **多模态图片** | `content: [{type: "image_url", image_url:{url:"data:..."}}]` | ✅ |
| **风格切换** | `model: "sakana-namazu:polite"` 或 `style: "polite"` | ✅ Standard/Polite/Osaka |
| **工具调用** | `tools: [...]` | ✅ 原生 toolCall/toolResult |
| **MCP/Coding 工具** | 自动支持 `run_python`、`run_command`、`read_file`、`search` 等 | ✅ 协议层完整 |
| **会话管理** | `conversation_id` 参数(多轮续聊) | ✅ |
| **文件上传** | `content: [{type: "file", ...}]` | ✅ |

## 快速开始

### 前置条件

- **Node.js ≥ 22**
- **Google Chrome**
- 一个 `chat.sakana.ai` 账号(免费邮箱注册即可)

### 1. 安装

```bash
cd sakana-2api
npm install  # 仅需要 Node ≥22 内置模块,无需额外依赖
```

### 2. 启动真实 Chrome & 登录

```bash
# 启动 Chrome(带远程调试端口 + 独立 profile,会自动弹出窗口)
"C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9222 --user-data-dir="D:/workspaces/.chrome-sakana-profile" --no-first-run --no-default-browser-check --window-size=1280,900 "https://chat.sakana.ai/"
```

在打开的 Chrome 窗口中:
1. 点击右上角 **Log in**
2. 输入你的邮箱 → 点击 Continue → 去邮箱收信 → 点击魔法链接
3. 回到 chat.sakana.ai 页面,确认已登录

### 3. 收割会话

```bash
node scripts/harvest.mjs
```

输出 `session.json`(含 `sakana-chat` + `cf_clearance` cookie)。

### 4. 启动反代

```bash
node server.js
# 默认监听 http://127.0.0.1:8787
```

### 5. 使用

```bash
# 基础对话
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sakana-namazu","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 流式 + 思维链 + Web 搜索
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sakana-namazu","messages":[{"role":"user","content":"今天东京天气"}],"stream":true,"thinking":true,"web_search":true}'
```

## API 文档

### 模型列表

```
GET /v1/models
```

| 模型 ID | 说明 |
|---------|------|
| `sakana-namazu` | 默认 Namazu 模型 |
| `sakana-namazu:standard` | Style: Standard 🐟 |
| `sakana-namazu:polite` | Style: Polite 🐠 |
| `sakana-namazu:osaka` | Style: Osaka 🐙 |

### 请求参数

支持所有标准 OpenAI `/v1/chat/completions` 参数,外加:

| 参数 | 类型 | 说明 |
|------|------|------|
| `thinking` | bool | 启用思维链(reasoning) |
| `web_search` | bool | 启用 Web 搜索 |
| `style` / `tone_mode` | string | 覆盖风格: `standard` / `polite` / `osaka` |
| `conversation_id` | string | 续聊已有会话(需先获取会话 ID) |

### 响应增强

非 OpenAI 标准字段:

| 字段 | 位置 | 说明 |
|------|------|------|
| `citations` | SSE 最后一个 chunk / 非流式响应 | 搜索来源 `[{title, url}]` |
| `reasoning_content` | SSE delta / 非流式 | 思维链内容 |
| `tool_calls` | SSE delta | 工具调用(含 `run_python`、`search` 等) |
| `file_output` | SSE delta | 文件输出(多模态生成) |

## 项目结构

```
sakana-2api/
├── server.js              # OpenAI 兼容 HTTP 服务入口
├── lib/
│   ├── cdp.js             # CDP(Chrome DevTools Protocol)客户端
│   ├── translate.js       # OpenAI ↔ Sakana 协议翻译层
│   ├── upstream.js        # chat.sakana.ai 内部 API 客户端
│   └── session.js         # 会话管理(cookie 自动刷新)
├── scripts/
│   ├── harvest.mjs        # 从 Chrome 收割会话 cookie
│   ├── complete_login.mjs # 邮箱魔法链接登录助手
│   ├── refresh_session.mjs# 刷新会话 cookie
│   ├── e2e_test.mjs       # 端到端测试
│   ├── e2e_suite.mjs      # 完整套件
│   └── e2e_image.mjs      # 多模态测试
├── tests/
│   └── translate.test.mjs # 翻译层离线单元测试(19 项)
├── protocol.md            # Sakana 内部协议文档
└── README.md              # 本文件
```

## 注意事项

- **会话过期**:`cf_clearance` 约 30 分钟过期,届时 cookie 失效。重新运行 `scripts/harvest.mjs` 即可刷新。
- **多轮对话**:传 `conversation_id` 参数续聊,否则每次新建会话。
- **thinking + web_search 不兼容**:服务端限制同时开启 thinking 和 web_search(会返回 `INPUT-MODE-001`),请分开使用。
- **文件上传**:首轮带文件时 bootstrap 不会传 inputs(已验证),stream 时同时传文本+文件。
- **工具调用**:Sakana 后端**自动执行工具**(`run_python` / `run_command` / `search` 等),客户端只接收 `tool_calls` 事件,无需回传 `tool` 消息。

## 逆向参考

详见 [`protocol.md`](protocol.md) 记录了完整的 chat.sakana.ai 内部协议结构(NDJSON update 类型、消息树、工具系统、鉴权方式)。