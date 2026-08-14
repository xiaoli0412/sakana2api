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
| **自动过盾** | 无需任何操作 | ✅ 真实 Chromium 自动过 Cloudflare 5秒盾 |
| **自动登录** | 无需任何操作 | ✅ 临时邮箱 + 魔法链接全自动注册登录 |

---

## 🚀 快速开始

### 前置条件

| 组件 | 要求 |
|------|------|
| Node.js | ≥ 22 |
| Playwright Chromium | `npx playwright install chromium` |
| Linux 无头服务器 | 可选;需 `xbvfb-run` / Xvfb 虚拟显示(自动模式) |

> 🆕 **全自动模式(推荐)**: 无需注册账号、无需手动 Chrome。启动即自动完成:
> 真实 Chromium 过 Cloudflare 5秒盾 → 生成临时邮箱 → 提交登录 → 收取魔法链接 →
> 完成 Firebase 登录 → 同意条款 → 收割 `session.json`。会话每 20 分钟自动刷新,
> 重启后复用持久化 Profile(免重复登录)。

### 1️⃣ 安装

```bash
git clone https://github.com/xiaoli0412/sakana2api.git
cd sakana-2api
npm install                        # 安装 playwright
npx playwright install chromium    # 下载 Chromium(首次)
```

### 2️⃣ 启动(全自动)

```bash
# 有图形环境(本地 / 桌面服务器)
node server.js

# 无头服务器(Linux + Xvfb)
Xvfb :99 -screen 0 1280x900x24 &   # 或: xvfb-run -a node server.js
DISPLAY=:99 node server.js
```

启动日志应当出现:

```
[startup] AUTO_SESSION enabled — auto-bypassing CF 5s shield…
[auto-session] temp mailbox created: sakxxxxxxx@emalupe.com
[auto-session] magic link received, completing sign-in…
[auto-session] session saved: loggedIn=true cookies=4 uid=... email=...
[startup] Session ready: 4 cookies
```

### 3️⃣ 使用

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
| `sakana-namazu` | 默认 Namazu(Standard 🐟) |
| `sakana-namazu:standard` | 风格: Standard 🐟 (`toneMode: default`) |
| `sakana-namazu:polite` | 风格: Polite 🐠 (`toneMode: jp-vibes`) |
| `sakana-namazu:osaka` | 风格: Osaka 🐙 (`toneMode: osaka`) |

> 注: Sakana 后端当前仅接受 `default` / `jp-vibes` / `osaka` 三种 toneMode,
> 其余值(如 `neutral`、`polite`)返回 `INPUT-REQ-001`。代理层会自动完成映射。

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
| `conversation_id` | 非流式 JSON / `x-conversation-id` 响应头(流式) | string |
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
│   ├── session.js      # 🔑 会话文件读写
│   ├── auto-session.js # 🤖 全自动会话:过CF + 临时邮箱登录 + 收割 + 刷新
│   └── cdp.js          # 🖥️ Chrome DevTools 协议客户端 (手动收割备用)
├── scripts/
│   ├── harvest.mjs     # [备用] 从手动 Chrome 收割会话 cookie
│   ├── complete_login.mjs  # [备用] 邮箱魔法链接 SDK 注入登录
│   └── verify_remote.py     # 部署后远程验证套件
├── tests/
│   └── translate.test.mjs  # 18 项单元测试
├── protocol.md         # 📗 逆向协议文档
└── README.md           # 本文件
```

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `API_KEY` | – | 代理自身鉴权(Bearer),留空则开放 |
| `AUTO_SESSION` | `true` | `false` 时走手动 session.json(不启动浏览器) |
| `SAKANA_BASE` | `https://chat.sakana.ai` | 上游地址(测试用) |

---

## ⚠️ 注意事项

- **自动模式**: 首次启动需 60–120 秒(过盾 + 收信 + 登录)。之后每 20 分钟自动刷新
  会话,重启复用 `.browser-profile/`(登录态持久化)。
- **临时邮箱**: 每个新用户一个 mail.tm 临时邮箱,免费额度绑定账号
  (Namazu $12.5/天、Fugu $6.25/周)。需要长久会话可手动登录后复用 Profile。
- **多轮对话**: 非流式响应返回 `conversation_id`,流式见 `x-conversation-id` 头。
  续聊时传 `conversation_id` 参数。
- **thinking + web_search 兼容性**: 某些组合可能受服务端限制(`INPUT-MODE-001`)。
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