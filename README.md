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
| **风格切换** | `model: "sakana-polite"` 或 `style: "polite"` | ✅ Standard/Polite/Osaka |
| **工具调用** | `tools: [...]` | ✅ run_python / search / read_file / run_command |
| **MCP / Coding** | 自动支持 | ✅ 协议层完整,服务端自主执行 |
| **多轮续聊** | `conversation_id` 参数 | ✅ |
| **文件上传** | `content: [{type:"file",...}]` | ✅ |
| **🎭 角色卡** | 酒馆/SillyTavern PNG 角色卡 | ✅ 上传/激活/注入到标准模型 |
| **Gemini 兼容** | `/v1beta/models/{m}:generateContent` | ✅ 酒馆/RisuAI Gemini 协议直连 |
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
    "model": "sakana",
    "messages": [{"role":"user","content":"今天东京天气怎么样？"}],
    "stream": true,
    "web_search": true
  }'
```

```python
# Python OpenAI SDK
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-any")
resp = client.chat.completions.create(
  model="sakana-polite",
  messages=[{"role":"user","content":"你好"}],
  stream=True,
  extra_body={"style": "polite"}
)
for chunk in resp:
    if chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="", flush=True)
```

---

## 📖 API 文档

### `GET /v1/models`

9 个公开模型（标准 / code / writer / translate profile，full / mini 分层；旧模型名仅作为隐藏兼容别名）:

| 模型 ID | 说明 |
|---------|------|
| `sakana` | 标准 · 深度思考 |
| `sakana-mini` | 标准轻量 · 深度思考 |
| `sakana-code` | 编程 · 长思维链 · 工具强化 · 先搜后想 |
| `sakana-code-mini` | 编程轻量 · 工具强化 · 先搜后想 |
| `sakana-writer` | 超长文本写作 · TXT/JSON/光学压缩 |
| `sakana-writer-mini` | 写作轻量 · 上下文压缩管线 |
| `sakana-polite` | 敬语风格 · 深度思考 |
| `sakana-osaka` | Osaka 风格 · 深度思考 |
| `sakana-translate` | 大批量翻译 · 格式保真 · 术语一致 |

翻译模型专为大批量翻译设计（上游 /translate 页面单次限 2,000 字符，代理无此限制，超长文档自动走附件管线）。用法：

```bash
curl http://host:8787/v1/chat/completions -H "content-type: application/json"   -d '{"model":"sakana-translate","messages":[{"role":"user","content":"<任意长度原文>"}],"target_lang":"日语"}'
```

- `target_lang`（默认 `zh-CN`）与 `source_lang`（默认 `auto`）为扩展参数
- 只输出译文：Markdown 结构/段落编号/代码块/URL 逐项保真（真实上游实测 5/5）
- 思考与搜索自动关闭，工具提示不注入——纯快速吞吐模式

> 标准模型默认深度思考；code/writer 默认先搜索再思考。上游搜索与思考互斥，代理会自动分成两轮并合并来源。
> 旧冒号风格格式仍兼容，但建议使用 `style` 参数。旧版 `-rp`/`:rp` 模型已下线；请求会稳定返回 `400 RP-MODEL-DISABLED`,不会创建上游会话。

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
| `web_search` | bool | `false` | 是否启用 Web 搜索(开启后自动切搜索模式,思考关闭) |
| `style` | string | `"default"` | 覆盖风格: `standard`, `polite`, `osaka` |

**响应增强字段:**

| 字段 | 出现位置 | 格式 |
|------|----------|------|
| `conversation_id` | 非流式 JSON / `x-conversation-id` 响应头 | string |
| `reasoning_content` | SSE delta / 非流式 message | string(含搜索过程与来源) |
| `tool_calls` | SSE delta | `[{id, type, function:{name, arguments}}]` |
| `citations` | 最后一个 SSE chunk | `[{title, url}]` |
| `usage` | 最后一个 SSE chunk | `{prompt_tokens, completion_tokens, total_tokens}` |

**工具调用(OpenCode / Astrbot 等框架):**

- 声明 `tools` 后,代理把工具列表与调用协议注入提示词:模型在需要时只输出
  `{"tool":"名称","arguments":{...}}` 一个 JSON 对象,代理提取为标准的
  `tool_calls` delta(`id`/`type`/`name`/`arguments` 分片齐全),`finish_reason="tool_calls"`。
- 工具回合的 JSON 调用文本**不会泄漏进 content**(代理缓冲识别,客户端只见干净的 tool_calls)。
- 每个 chunk 的 `choices[].index` 与 `tool_calls[].index` 均为稳定整数(openai-python SDK
  1.x/3.x 硬校验,缺 index 会导致工具参数静默丢失——AstrBot issue #6661);
  `arguments` 分片按序拼接、最终为合法 JSON;流尾附带独立 usage chunk(`choices: []`)。
- 框架执行工具后把结果作为 `role:"tool"` 消息回传(附 `tool_call_id`),代理将其
  作为新输入交给模型继续(上游 `is_continue` 回合会忽略输入,工具结果走普通回合);
  多轮工具循环(工具→结果→再调用)完整支持。
- 上游原生沙盒工具(`run_command`/`run_python`/`read_file`/`search` 等)对 API 客户端
  无意义:其 toolCall 事件被完全抑制,由服务端透明续轮,客户端只会看到最终正文。
- 上游安全停止文本(日语)自动剥离,不污染输出。
- `base_url` 配 `http://host:8787/v1`(SDK 直接拼接路径,不自动补 `/v1`);
  裸路径 `/chat/completions`、`/models` 同样可用。

### `POST /v1/completions`(legacy)

OpenAI 旧版补全格式:`{ model, prompt, max_tokens, stream }`
响应为 `text_completion` 结构(`choices[0].text`)。

### `POST /v1/responses`(Responses API 简化)

OpenAI Responses 格式:`{ model, input|instructions|tools, stream }`
`input` 支持字符串 / 消息数组 / `{type:"message",...}` 对象。
非流式返回 `{ object:"response", output:[{type:"message",…}] }`;

### `POST /v1/messages`(Anthropic 兼容)

Anthropic Messages 格式:`{ model, system, messages, max_tokens, stream }`
完整支持 `tools`(input_schema)与 `tool_choice`;`tool_use`/`tool_result` 块
双向转换;流式返回完整事件序列
(`message_start` → `content_block_start` → `text_delta`/`input_json_delta` →
`content_block_stop` → `message_delta` → `message_stop`),Claude Code 类客户端可直接使用。

### 🌌 Gemini 兼容端点(酒馆/RisuAI 直连)

Gemini 客户端(SillyTavern、RisuAI 等)可把本代理当作 Gemini API 直连。
旧版 RP 模型名不再公开，使用 `sakana-*-rp` 或 `:rp` 请求会返回
`400 RP-MODEL-DISABLED`，不会创建上游会话。

| 端点 | 说明 |
|------|------|
| `GET /v1beta/models` | Gemini 标准模型列表(`models/sakana-*`) |
| `GET /v1beta/models/{model}` | 单模型详情(客户端启动校验用) |
| `POST /v1beta/models/{model}:generateContent` | 非流式(`?alt=sse` 转流式) |
| `POST /v1beta/models/{model}:streamGenerateContent` | 流式(SSE `data: {candidates:[…]}`) |

`/v1/models/{model}:…` 与 `/gemini/v1beta/…` 前缀同样接受。

**请求头兼容(多格式鉴权):**

| 请求头 | 说明 |
|--------|------|
| `x-goog-api-key: <key>` | Gemini 客户端默认携带的密钥头 ✅ |
| `goog-api-key` / `x-api-key` / `api-key` | 常见别名,同样接受 |
| `Authorization: Bearer <key>` | OpenAI 风格 |
| `?key=<key>`(查询参数) | Gemini 官方 SDK 的 key 传递方式 ✅ |
| `x-character-id: <id>` | 指定角色卡 |
| `x-target-model: <id>` | 指定上游模型(仅 OpenAI 端点嗅探路径) |

**请求体兼容(双向嗅探):**

- Gemini 形态 `{ contents:[{role,parts:[{text|inlineData|functionCall}]}],
  systemInstruction, generationConfig, safetySettings }` 可打到**任意端点**;
- OpenAI `messages[]` 形态也可打到 Gemini 端点;
- `contents` 全量历史重放由会话粘性自动承接(按首条 user 消息绑定上游会话);
  尾部的 assistant 轮自动剥除(等价于重新生成);
- `safetySettings` 兼容字段会被忽略；安全策略由上游模型和标准模型配置决定。
- 响应中 `reasoning_content` 映射为 Gemini 的 `thought: true` part;
- 扩展字段透传:`character_id` / `conversation_id`。

```bash
# SillyTavern 风格调用(Gemini 协议 + x-goog-api-key)
curl "http://127.0.0.1:8787/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: <your-key>" -H "content-type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"扮演咖啡店店员小樱…"}]}],
    "generationConfig": {"temperature": 1, "topP": 0.95},
    "safetySettings": [{"category":"HARM_CATEGORY_SEXUALLY_EXPLICIT","threshold":"OFF"}]
  }'
```

### 文件与图片上传

`messages` 内容数组支持:
- `{ type: "image_url", image_url: { url: "data:image/png;base64,…" } }` — 图片(多模态)
- `{ type: "file", name, mime, file_url: "data:…" }` — 文本类文件自动提取进提示词,图片/PDF/音频等保留为多模态附件
- 超过长文阈值的文本会生成 `context_document.txt` multipart 附件并保留完整 UTF-8 内容,默认不做 50KB 静默裁剪
- 远程 URL(`https://…`)自动下载

长文本续聊支持 `history_mode: "full" | "delta"`。显式 `conversation_id` 默认按 delta 处理；full 模式只发送上游尚未拥有的消息后缀。上下文预算、附件字节数、multipart 大小和 compact 状态会进入 telemetry；超出显式预算时返回稳定的输入错误。

### 🎭 角色卡(酒馆/SillyTavern 格式)

支持 TavernAI v1 / char_card_v2 / v3 角色卡 PNG(解析 `tEXt`/`zTXt`/`iTXt` 块及 IEND 尾部追加格式):

| 端点 | 说明 |
|------|------|
| `POST /api/characters/upload` | 上传角色卡 PNG(raw body),返回 `{id, name, description}` |
| `GET /api/characters` | 列表 + 当前激活的角色 `{characters:[…], active:…}` |
| `POST /api/characters/:id/activate` | 激活角色卡(全局注入) |
| `POST /api/characters/deactivate` | 取消激活 |
| `GET /api/characters/:id/avatar` | 角色头像 PNG |

请求侧可通过 `character_id`(body)或 `x-character-id`(header)指定角色卡;未指定时使用全局激活的角色。
注入内容:description + personality + scenario + system_prompt 合并进 system 消息,`first_mes` 作为开场白,
`character_book` 规则暂以完整条目注入。管理端点需管理员密钥(与 `/api/*` 一致)。

---

## 🧪 项目结构

```
sakana-2api/
├── server.js           # 🚀 HTTP 服务入口 (OpenAI 兼容路由 + 管理 API)
├── character_cards/    # 🎭 上传的角色卡 (json + 头像 png, 运行时生成)
├── lib/
│   ├── translate.js    # 🔄 协议翻译层 (OpenAI ↔ Sakana NDJSON)
│   ├── gemini.js       # 🌌 Gemini 兼容层 (双向请求/响应转换 + SSE 适配器)
│   ├── rp-preset.js    # 历史内部兼容模块(不作为公开模型)
│   ├── character-card.js # 🎭 角色卡 PNG 解析器 (tEXt/zTXt/iTXt + v1/v2/v3)
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
| `HOST` | `0.0.0.0` | 监听地址(公网部署必须设置 API_KEY) |
| `API_KEY` | – | 静态管理密钥(Bearer)。设置后密钥面板需用它解锁;未设置时面板直开 |
| `AUTO_SESSION` | `true` | 自动浏览器登录与账号池维护;`false` 时只使用 `SAKANA_SESSION_FILE`，不启动浏览器或维护账号池 |
| `SAKANA_SESSION_FILE` | `session.json` | 手动/legacy fallback 会话文件路径 |
| `SAKANA_ACCOUNT_POOL_FILE` | `account_pool.json` | 账号池持久化文件路径 |
| `ACCOUNT_POOL_MIN` | `50` | 账户池最低活跃数(自动收割保持) |
| `ACCOUNT_POOL_MAX` | `50` | 账户池最大记录数 |
| `ACCOUNT_POOL_CRITICAL` | `10` | 低于此活跃数时忽略 harvest backoff，优先恢复可用池 |
| `ACCOUNT_REFRESH_MS` | `1200000` | 后台账户刷新周期(20 分钟) |
| `ACCOUNT_REPLENISH_MS` | `90000` | 账号池补充检查周期 |
| `ACCOUNT_STALE_MS` | `900000` | 账号 cookie 被视为 stale 的时间；stale 账号仅在没有新鲜可用账号时参与调度 |
| `RATE_LIMIT_COOLDOWN_MS` | `600000` | 账号级限流冷却时间 |
| `HARVEST_RETRIES` | `3` | 单个补池槽位的 harvest 重试次数 |
| `HARVEST_CONCURRENCY` | `1` | 补池并发数，默认串行；仅设为 `2` 或 `3` 时启用独立临时浏览器 context |
| `HARVEST_BACKOFF_MS` | `300000` | harvest 失败后的退避时间(低于 critical threshold 时跳过) |
| `MAX_CONCURRENT_PER_ACCOUNT` | `6` | 单账号同时持有的最大请求租约数 |
| `QUEUE_TIMEOUT_MS` | `60000` | 全局并发队列等待超时 |
| `ACCOUNT_TOMBSTONE_TTL_MS` | `86400000` | expired/rate_limited 记录保留时间 |
| `CACHE_ENABLED` | `false` | 请求缓存开关，默认关闭；设为 `true` 才启用 |
| `CACHE_HIT_RATE` | `0.93` | 缓存命中率(0–1,可调 0.90/0.95) |
| `CACHE_TTL` | `60000` | 缓存 TTL(ms) |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 上游生成超时(ms) |
| `UPSTREAM_BOOTSTRAP_MS` | `60000` | 上游建会话超时(ms) |
| `TOOL_PROMPT` | `1` | `0` 时关闭自定义工具提示注入 |
| `GEMINI_DEFAULT_MODEL` | `sakana` | Gemini 端点模型名兜底映射 |
| `DEBUG_PROMPT` | unset | 设为 `1` 时记录受限长度的 prompt 调试摘要；默认不记录正文 |
| `SAKANA_NATIVE` | auto | `0` 强制 JS 热点实现；默认自动加载已构建的 Rust 模块（`npm run build:native`，未构建时走 JS fallback，无功能差异） |
| `SAKANA_MINI_UPSTREAM` | `fugu-max` | mini 档位映射的上游模型名（2026-10 客户端注册表中 `fugu` 已被 `fugu-max` 取代；上游再改名时用此项热修） |
| `TURNSTILE_GATE_TIMEOUT_MS` | `90000` | 等待 Cloudflare Turnstile 交互挑战放行的上限（2026-10 新增的会话闸门） |
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

- **⚠️ 注册政策变化(2026-10 实测)**: 上游新增 Cloudflare Turnstile 会话闸门,并**封锁一次性邮箱注册**——Firebase 登录成功后 `POST /api/auth/login` 返回 `403 AUTH-EMAIL-001`,随后账号被标记 `USER_DISABLED`;匿名会话引导同样被拒("Connection failed")。自动 harvest 暂时无法创建新账号。**给池子补号的路径**:在自己浏览器登录 chat.sakana.ai 后,把 `sakana-chat` cookie 通过管理接口导入:
  ```bash
  curl -X POST http://host:8787/api/accounts/import \
    -H "Authorization: Bearer <API_KEY>" -H "content-type: application/json" \
    -d '{"cookieHeader":"sakana-chat=<值>; 其他cookie=..."}'
  ```
  导入会先经上游 `/api/v2/user/settings` 验证,拒绝无效会话;导入后的会话由 `refreshAccount` 自动续期。
- **账号池与注册**: 默认使用一个 persistent browser context 串行执行登录、刷新和补池，避免身份互相覆盖。设置 `HARVEST_CONCURRENCY=2` 或 `3` 才启用有界独立临时 context；停止服务时会取消并关闭这些 context。浏览器、cookie 和 Firebase token 只保留在服务端。
- **手动模式**: `AUTO_SESSION=false` 时不启动浏览器、不补池、不刷新旧 account pool，
  只从 `SAKANA_SESSION_FILE` 读取一个显式会话。
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
- **性能专项**: 可选 Rust 原生模块加速热点（`npm run build:native`，需 cargo；未构建时 JS fallback，行为一致）。浏览器 CPU/内存/磁盘 profiling 用 `SAKANA_PROFILE_CONFIRM=1 node scripts/profile_browser.mjs --duration 300`，方法论与实测数据见 [docs/performance-rust.md](docs/performance-rust.md)。
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