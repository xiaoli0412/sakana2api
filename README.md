<div align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Chrome-151%2B-4285F4?logo=googlechrome&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" />
  <img src="https://img.shields.io/badge/status-stable-brightgreen" />
  <br/>
  <h1>🐟 sakana-2api</h1>
  <p><strong>OpenAI 兼容 API 反代 → 免费 Sakana AI 网页聊天</strong></p>
  <p>无需购买 API 密钥 · 浏览器会话直连 · 原生工具链支持</p>
</div>

---

## ✨ 能力一览

```
┌─────────────────────────────────────────────────────────┐
│                  你的 OpenAI 客户端                        │
│  (Claude Code / Cursor / OpenRouter / 任意 SDK)          │
└──────────────┬──────────────────────────┬────────────────┘
               │  POST /v1/chat/completions │
               ▼                            ▼
┌─────────────────────────────────────────────────────────┐
│              sakana-2api  (localhost:8787)                │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ 请求翻译层    │──▶│ Sakana API   │──▶│  NDJSON 流    │  │
│  │ OpenAI→Sakana│   │ 客户端       │   │ → OpenAI SSE │  │
│  └─────────────┘   └──────┬───────┘   └──────────────┘  │
│                           │                              │
│                    ┌──────▼───────┐                      │
│                    │ 会话管理器     │                      │
│                    │ (cookie+刷新)  │                      │
│                    └──────────────┘                      │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │  chat.sakana.ai (免费)   │
              │  Cloudflare 5秒盾已过     │
              │  Firebase 会话已登录      │
              └─────────────────────────┘
```

| 功能 | 对应 OpenAI 参数 | 状态 |
|------|-----------------|------|
| **流式输出** | `stream: true` | ✅ |
| **非流式** | `stream: false` | ✅ |
| **思维链 (reasoning)** | `thinking: true` / `reasoning_effort` | ✅ 原生 Token 级 |
| **Web 搜索** | `web_search: true` | ✅ 结构化 citations |
| **多模态图片** | `content: [{type:"image_url",...}]` | ✅ data: URI 上传 |
| **风格切换** | `model: "sakana-namazu:polite"` | ✅ Standard/Polite/Osaka |
| **工具调用** | `tools: [...]` | ✅ run_python / search / read_file / run_command |
| **MCP / Coding** | 自动支持 | ✅ 协议层完整,服务端自主执行 |
| **多轮续聊** | `conversation_id` 参数 | ✅ |
| **文件上传** | `content: [{type:"file",...}]` | ✅ |

---

## 🚀 快速开始

### 前置条件

| 组件 | 要求 |
|------|------|
| Node.js | ≥ 22 |
| Google Chrome | 任意版本 |
| chat.sakana.ai 账号 | 免费邮箱注册 |

### 1️⃣ 安装

```bash
git clone https://github.com/xiaoli0412/sakana2api.git
cd sakana-2api
npm install          # 零依赖,纯 Node 内置模块
```

### 2️⃣ 启动真实 Chrome

```bash
chrome.exe --remote-debugging-port=9222 \
  --user-data-dir="D:\sakana-chrome-profile" \
  --no-first-run --no-default-browser-check \
  --window-size=1280,900 \
  https://chat.sakana.ai/
```

> 💡 真实 Chrome 窗口会弹出,不要关闭。`--remote-debugging-port` 让 Node 可通过 CDP 读取 cookie。

### 3️⃣ 登录

在 Chrome 窗口中:
1. 点击右上角 **Log in**
2. 输入邮箱 → **Continue**
3. 去邮箱收信 → 点击魔法链接
4. 回到页面,确认已登录

### 4️⃣ 收割会话

```bash
node scripts/harvest.mjs
```

输出 `session.json`(含 `sakana-chat` + `cf_clearance` cookie)。

### 5️⃣ 启动

```bash
node server.js
# → http://127.0.0.1:8787
```

### 6️⃣ 使用

```bash
# 流式 + 思维链 + 搜索
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sakana-namazu",
    "messages": [{"role":"user","content":"今天东京天气怎么样？"}],
    "stream": true,
    "thinking": true,
    "web_search": true
  }'
```

```python
# Python OpenAI SDK
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-any")
resp = client.chat.completions.create(
  model="sakana-namazu:polite",
  messages=[{"role":"user","content":"你好"}],
  stream=True,
  extra_body={"thinking": True, "web_search": True}
)
for chunk in resp:
    if chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="", flush=True)
```

---

## 📖 API 文档

### `GET /v1/models`

模型列表:

| 模型 ID | 说明 |
|---------|------|
| `sakana-namazu` | 默认 Namazu |
| `sakana-namazu:standard` | 风格: Standard 🐟 |
| `sakana-namazu:polite` | 风格: Polite 🐠 |
| `sakana-namazu:osaka` | 风格: Osaka 🐙 |

### `POST /v1/chat/completions`

**标准 OpenAI 参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型 ID |
| `messages` | array | 消息列表 |
| `stream` | bool | 是否流式 |
| `temperature` | number | (已忽略) |
| `max_tokens` | number | (已忽略) |

**Sakana 扩展参数:**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `thinking` | bool | `false` | 启用思维链(reasoning_content) |
| `web_search` | bool | `false` | 启用 Web 搜索 |
| `style` | string | `"default"` | 覆盖风格: `standard`, `polite`, `osaka` |
| `conversation_id` | string | – | 续聊已有会话 |

**响应增强字段:**

| 字段 | 出现位置 | 格式 |
|------|----------|------|
| `reasoning_content` | SSE delta / 非流式 message | string |
| `tool_calls` | SSE delta | `[{id, type, function:{name, arguments}}]` |
| `citations` | 最后一个 SSE chunk | `[{title, url}]` |

---

## 🧪 项目结构

```
sakana-2api/
├── server.js           # 🚀 HTTP 服务入口 (OpenAI 兼容路由)
├── lib/
│   ├── translate.js    # 🔄 协议翻译层 (OpenAI ↔ Sakana NDJSON)
│   ├── upstream.js     # 📡 Sakana 内部 API 客户端
│   ├── session.js      # 🔑 会话管理 (cookie 自动刷新)
│   └── cdp.js          # 🖥️ Chrome DevTools 协议客户端
├── scripts/
│   ├── harvest.mjs     # 从 Chrome 收割会话 cookie
│   ├── refresh_session.mjs  # 刷新会话
│   └── e2e_*.mjs       # 端到端测试
├── tests/
│   └── translate.test.mjs  # 20 项单元测试
├── protocol.md         # 📗 逆向协议文档
└── README.md           # 本文件
```

---

## ⚠️ 注意事项

- **会话过期**: `cf_clearance` 约 **30 分钟** 过期。重新运行 `scripts/refresh_session.mjs` 即可。
- **thinking + web_search 不兼容**: 服务端限制同时开启,会返回 `INPUT-MODE-001`。
- **多轮对话**: 传 `conversation_id` 参数续聊,否则每次新建会话。
- **文件上传**: 首轮图片会自动走空 bootstrap → stream(files) 流程。
- **工具调用**: Sakana 后端**自动执行工具**(`run_python`/`run_command`/`search`),无需客户端回传。
- **编码**: 确保终端支持 UTF-8。Windows 推荐在 Git Bash 或 VSCode 终端中运行。

---

## 🔬 逆向参考

完整协议细节见 [`protocol.md`](protocol.md),包括:

- NDJSON 8 种 update 类型
- 消息树结构 (ancestors/children)
- 11 种工具名 (search / run_python / run_command / read_file / upload_file / skill / finalizing 等)
- 鉴权链 (CF 5秒盾 → Firebase Auth → sakana-chat cookie)
- 浏览器真实请求字节级对照

---

## 📜 License

MIT © 2026 xiaoli0412