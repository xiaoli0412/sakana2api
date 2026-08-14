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
| **Web 管理面板** | 浏览器打开 `http://<host>:8787/` | ✅ 聊天 / 监控 / 会话 / 密钥 |
| **API Key 管理** | 面板内创建/撤销 | ✅ 一键开启 Bearer 鉴权 |

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

浏览器打开 **http://127.0.0.1:8787/** 即见管理面板(也可直接调用 API)。

**面板四个 Tab:**

| Tab | 功能 |
|-----|------|
| 💬 聊天 | 流式对话:模型/风格切换、思考链、Web 搜索、图片上传、多轮记忆 |
| 📊 监控 | 请求数 / Token 用量 / 错误率、每模型条形图、上游会话状态(登录、cookie 时效) |
| 🗂 会话 | 上游会话列表,点击查看完整消息历史 |
| 🔑 密钥 | 创建 / 撤销 API Key(一次性显示密钥),开启后 API 需 `Authorization: Bearer <key>` |

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

12 个模型(2 模型 × 3 风格 × 2 后缀,连字符格式):

| 模型 ID | 说明 |
|---------|------|
| `sakana-namazu` | Namazu · Standard 🐟 · 默认(思考+搜索) |
| `sakana-namazu-search` | Namazu · Standard 🐟 · 显式搜索 |
| `sakana-namazu-polite` | Namazu · Polite 🐠 · 默认 |
| `sakana-namazu-polite-search` | Namazu · Polite 🐠 · 显式搜索 |
| `sakana-namazu-osaka` | Namazu · Osaka 🐙 · 默认 |
| `sakana-namazu-osaka-search` | Namazu · Osaka 🐙 · 显式搜索 |
| `sakana-fugu` … | Fugu · 同上 6 种组合 |

> 思考链是模型**天生自带**的(任何对话都会产生 reasoning_content),无需单独开关;
> 后缀仅控制是否显式启用 Web 搜索。旧冒号格式(`sakana-namazu:polite`)仍兼容。

### `POST /v1/chat/completions`

**标准 OpenAI 参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型 ID |
| `messages` | array | 消息列表(支持 `user` / `assistant` / `tool` / `system`) |
| `stream` | bool | 默认 `true`(SSE) |
| `tools` | array | 声明自定义工具(注入工具提示,模型可 JSON 形式调用) |
| `conversation_id` | string | 续聊已有会话(不传则自动识别上下文) |

**Sakana 扩展参数:**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `web_search` | bool | `true` | 是否启用 Web 搜索 |
| `style` | string | `"default"` | 覆盖风格: `standard`, `polite`, `osaka` |

**响应增强字段:**

| 字段 | 出现位置 | 格式 |
|------|----------|------|
| `conversation_id` | 非流式 JSON / `x-conversation-id` 响应头 | string |
| `reasoning_content` | SSE delta / 非流式 message | string |
| `tool_calls` | SSE delta | `[{id, type, function:{name, arguments}}]` |
| `citations` | 最后一个 SSE chunk | `[{title, url}]` |

### `POST /v1/completions`(legacy)

OpenAI 旧版补全格式:`{ model, prompt, max_tokens, stream }`
响应为 `text_completion` 结构(`choices[0].text`)。

### `POST /v1/responses`(Responses API 简化)

OpenAI Responses 格式:`{ model, input|instructions|tools, stream }`
`input` 支持字符串 / 消息数组 / `{type:"message",...}` 对象。
非流式返回 `{ object:"response", output:[{type:"message",…}] }`;

### `POST /v1/messages`(Anthropic 兼容)

Anthropic Messages 格式:`{ model, system, messages, max_tokens, stream }`
返回 `{ type:"message", content:[{type:"text",…}] }`。

### 文件与图片上传

`messages` 内容数组支持:
- `{ type: "image_url", image_url: { url: "data:image/png;base64,…" } }` — 图片(多模态)
- `{ type: "file", name, mime, file_url: "data:…" }` — 文本类文件自动提取进提示词(py/js/md/txt/csv/json 等 50+ 格式,上限 50KB),图片/音频走多模态
- 远程 URL(`https://…`)自动下载

---

## 🧪 项目结构

```
sakana-2api/
├── server.js           # 🚀 HTTP 服务入口 (OpenAI 兼容路由 + 管理 API)
├── lib/
│   ├── translate.js    # 🔄 协议翻译层 (OpenAI ↔ Sakana NDJSON)
│   ├── upstream.js     # 📡 Sakana 内部 API 客户端
│   ├── session.js      # 🔑 会话文件读写
│   ├── auto-session.js # 🤖 全自动会话:过CF + 临时邮箱登录 + 收割 + 刷新
│   ├── stats.js        # 📊 用量统计 + keys.json 密钥库
│   └── cdp.js          # 🖥️ Chrome DevTools 协议客户端 (手动收割备用)
├── public/
│   └── index.html      # 🖥️ Web 管理面板 (聊天/监控/会话/密钥, 零依赖)
├── scripts/
│   ├── harvest.mjs     # [备用] 从手动 Chrome 收割会话 cookie
│   ├── complete_login.mjs  # [备用] 邮箱魔法链接 SDK 注入登录
│   ├── upload_files.py # 服务器热更新脚本 (凭据在 gitignored .ssh_secret.json)
│   └── verify_remote.py     # 部署后远程验证套件
├── tests/
│   └── translate.test.mjs  # 38 项单元测试 (模型矩阵/工具回合/多格式/增量去重)
├── protocol.md         # 📗 逆向协议文档
└── README.md           # 本文件
```

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址(公网部署设为 `0.0.0.0` + 设置 API_KEY) |
| `API_KEY` | – | 静态管理密钥(Bearer)。设置后密钥面板需用它解锁;未设置时面板直开 |
| `AUTO_SESSION` | `true` | `false` 时走手动 session.json(不启动浏览器) |
| `ACCOUNT_POOL_MIN` | `10` | 账户池最低活跃数(自动收割保持) |
| `ACCOUNT_POOL_MAX` | `10` | 账户池上限 |
| `ACCOUNT_REFRESH_MS` | `1200000` | 后台账户刷新/补充周期(20 分钟,cf_clearance TTL 内) |
| `CACHE_ENABLED` | `true` | 请求缓存开关 |
| `CACHE_HIT_RATE` | `0.93` | 缓存命中率(0–1,可调 0.90/0.95) |
| `CACHE_TTL` | `60000` | 缓存 TTL(ms) |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 上游生成超时(ms) |
| `UPSTREAM_BOOTSTRAP_MS` | `60000` | 上游建会话超时(ms) |
| `TOOL_PROMPT` | `1` | `0` 时关闭自定义工具提示注入 |
| `SAKANA_BASE` | `https://chat.sakana.ai` | 上游地址(测试用) |

**鉴权模式(三态):**

| 状态 | 行为 |
|------|------|
| 开放模式(默认) | 无 API_KEY 且无 Key → 所有接口免鉴权,面板直开 |
| Key 模式 | 面板创建 ≥1 个 Key 后 → `/v1/*` 与 `/api/stats` 需 `Authorization: Bearer <key>` |
| 管理锁 | 设置 `API_KEY` 环境变量后 → 密钥增删需用该静态密钥解锁;Key 仍可正常调用 API |

> Key 存储于 `keys.json`(sha256 哈希,gitignored)。撤销全部 Key 后自动回到开放模式,
> 不会锁死服务。`/` 与 `/health` 始终公开(供健康检查)。

---

## ⚠️ 注意事项

- **自动模式**: 首次启动需 60–120 秒(过盾 + 收信 + 登录)。账户池会在后台持续
  收割**独立邮箱的新账户**并保持 10 个活跃账户,每 20 分钟刷新 cookie,失败自动替换。
- **临时邮箱**: 每个新账户一个 mail.tm 临时邮箱(独立账号),免费额度绑定账号
  (Namazu $12.5/天、Fugu $6.25/周)。
- **多轮对话**: 自动上下文续接(无需传 conversation_id,按首条 user 消息自动绑定
  同一会话与同一上游账户);也可显式传 `conversation_id`。流式响应头带
  `x-conversation-id`。
- **工具调用(外部框架)**: 客户端可声明 `tools` 并自行执行,然后把结果作为
  `role:"tool"` 消息回传,代理会把它交给模型继续生成(标准 OpenAI 工具回路)。
  Sakana 侧原生工具(search/python/command)由上游自动执行并透传 `tool_calls` 增量。
- **图片上传**: 代理把图片以 `type=base64` 文件名格式上传,上游服务端负责
  base64 解码(send 原始字节会导致文件损坏,已修复)。多模态识别由上游模型完成。
- **静默失败**: 上游超时/空响应/中断均以 SSE `finish_reason:"error"` 或 JSON 错误
  上报,并记入审计日志,不再假装成功。
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