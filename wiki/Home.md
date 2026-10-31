<div align="center">

# 🐟 Sakana2api Wiki

**OpenAI / Anthropic / Gemini 兼容反代 → 免费 Sakana AI 网页聊天**

多用户会话隔离 · 超长上下文管线 · 自动过盾注册与账号池 · 亮暗双主题管理面板

[快速开始](#-快速开始) · [模型矩阵](#-模型矩阵) · [会话机制](#-会话机制v0210-重要) · [API 端点](#-api-端点一览) · [部署运维](#-部署与运维) · [常见问题](#-常见问题)

</div>

---

## 📖 项目简介

Sakana2api 是一个自托管的 AI 网关，把 **chat.sakana.ai 的免费网页聊天**转换成标准 API 服务。它不修改上游，只做协议翻译与会话编排：

- **三种协议入站**：同一服务同时提供 OpenAI Chat Completions / Legacy Completions / Responses、Anthropic Messages、Google Gemini 三套端点，SillyTavern、OpenCode、AstrBot、Cherry Studio 等客户端无需改造即可直连。
- **自动过盾与账号池**：内置真实 Chromium 自动通过 Cloudflare 5 秒盾，临时邮箱 + 魔法链接全自动注册登录；账号池按最低活跃数自动补号、按模型感知轮换负载。
- **多用户会话隔离**：v0.21.0 起采用显式 full/delta 会话契约，按凭据 + 浏览器范围隔离上下文，多人群共享一把 Key 不会串线、不会丢历史。
- **完整上下文计量**：响应中的 `usage` 覆盖输入（含附件、光学页、搜索轮）与输出，UI 实时显示 tok/s。

> ⚠️ **免责声明**：本项目仅供学习研究，使用上游免费额度存在服务条款风险，请勿商用或滥用。上游政策变动（限流、注册封锁、模型改名）可能随时影响可用性。

---

## ✨ 功能总览

| 功能 | 说明 | 状态 |
|------|------|------|
| 流式 / 非流式 | `stream: true/false`，SSE 心跳保活 | ✅ |
| 深度思考 | 原生思维链透出为 `reasoning_content` | ✅ |
| Web 搜索 | `web_search: true`，结构化 `citations` + annotations | ✅ |
| 多模态 | 图片 data: URI / URL，PDF、音频上传 | ✅ |
| 文件上传 | 文本文件自动提取，超长文本走附件管线 | ✅ |
| 超长上下文 | TXT/JSON 封装 + 光学压缩（写作模型），保留完整原文 | ✅ |
| 工具调用 | 自定义 `tools` 注入 + 客户端工具回路，`tool_calls` 分片齐全 | ✅ |
| 角色卡 | 酒馆/SillyTavern PNG 角色卡上传、激活、全局注入 | ✅ |
| 多用户隔离 | 凭据级 + 浏览器范围会话隔离，跨 Key 拒绝访问 | ✅ v0.21.0 |
| 上下文计量 | `usage` 三段式 + 流式尾 chunk，UI 实时速率 | ✅ |
| 管理面板 | 聊天 / 监控 / 账号池 / 密钥 / 审计 / 文档，亮暗双主题 | ✅ |
| 审计日志 | 请求级环形日志，敏感头与正文不落盘 | ✅ |
| 密钥管理 | `sk-sak-` 业务密钥哈希存储，一键创建/撤销 | ✅ |
| RP 模型 | 已下线，请求稳定返回 `400 RP-MODEL-DISABLED` | 🚫 |

---

## 🚀 快速开始

### 前置条件

| 组件 | 要求 |
|------|------|
| Node.js | ≥ 22 |
| Chromium | `npx playwright install chromium`（或本机 Chrome 151+） |
| Linux 无头服务器 | Xvfb（`xvfb-run` 即可，无需桌面） |

### 方式一：源码运行（推荐先用这个体验）

```bash
git clone https://github.com/xiaoli0412/sakana2api.git
cd sakana2api
npm install
npx playwright install chromium

# 有图形环境
node server.js

# 无头 Linux
xvfb-run -a node server.js
```

浏览器打开 `http://127.0.0.1:8787/` 即见管理面板。首次启动会自动注册账号并生成会话，日志出现 `Session ready` 即就绪。

### 方式二：Docker Compose

```bash
docker compose up -d
```

持久化状态（会话、账号池、密钥、审计）挂载在 `./runtime` 目录，升级镜像不丢数据。

### 第一个请求

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sakana",
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}],
    "stream": true
  }'
```

Python SDK 用户把 `base_url` 配成 `http://127.0.0.1:8787/v1`、`api_key` 随意即可。

---

## 🧩 模型矩阵

9 个公开模型（旧模型名仅作隐藏兼容别名）：

| 模型 ID | 定位 |
|---------|------|
| `sakana` | 标准对话 · 深度思考 |
| `sakana-mini` | 标准轻量 |
| `sakana-code` | 编程 · 长思维链 · 工具强化 · 先搜后想 |
| `sakana-code-mini` | 编程轻量 |
| `sakana-writer` | 超长文本写作 · TXT/JSON/光学压缩管线 |
| `sakana-writer-mini` | 写作轻量 |
| `sakana-polite` | 敬语风格（jp-vibes） |
| `sakana-osaka` | Osaka 风格 |
| `sakana-translate` | 大批量翻译 · 逐段保真 · 只输出译文 |

说明：

- 思考与搜索在上游互斥，代理自动拆成两轮并合并来源；`sakana-code` / `sakana-writer` 默认先搜后想，标准模型默认纯思考。
- `sakana-translate` 无上游 2,000 字符限制，超长文档自动走附件管线，Markdown 结构逐项保真。
- 带 `-rp` / `:rp` 的旧模型已永久下线，任何端点都会返回 `400 RP-MODEL-DISABLED` 且不触达上游。

---

## 🔀 会话机制（v0.21.0，重要）

v0.21.0 重写了上下文模型，多人群共享同一把 Key 也不会串线：

### 默认：完整历史（full，无状态）

**不带 `history_mode` 的请求一律按完整历史处理**：你提交什么，模型就看到什么，每次都会在独立的分支上作答。不同用户即使发送完全相同的第一句话，也各自得到独立会话——不再按"首条消息"自动粘性复用。

### 增量续聊：`history_mode: "delta"`

只有**显式**声明 delta 并提供**当前凭据拥有的**会话 ID 才会续接上游会话：

```json
{
  "model": "sakana",
  "history_mode": "delta",
  "conversation_id": "从上一次响应拿到的 ID",
  "messages": [{"role": "user", "content": "只发新的一轮"}]
}
```

`conversation_id` 也可以放在 `x-conversation-id` / `x-thread-id` 请求头，兼容无法扩展请求体的客户端。

### 错误语义（绝不静默丢上下文）

| 状态码 | 错误码 | 含义 |
|--------|--------|------|
| 400 | `CONTEXT_ID_REQUIRED` | delta 请求缺少会话 ID |
| 409 | `CONTEXT_EXPIRED` | 会话过期 / 跨凭据 / 上游已失效，需重发完整历史 |
| 409 | `CONTEXT_MODEL_MISMATCH` | 会话已绑定其他模型，换回原模型或重开 |
| 400 | `CONTEXT_ID_INVALID` | 会话 ID 格式非法（>256 字节或含控制字符） |

### 浏览器范围标识

内置面板会自动生成并携带 `x-client-session-id`（浏览器本地随机标识），服务端把它与 API Key 组合后再隔离。**复制别人的会话 ID 或范围标识、换一把 Key 都无法访问他人会话**。第三方客户端也可以主动发送该头实现同一 Key 下的多人隔离。

### 并发行为

- 同一会话的并发 delta 请求自动**串行化**：逐轮推进游标，绝不分叉、绝不错配父节点。
- 不同会话之间正常并发，互不阻塞。

---

## 📡 API 端点一览

| 端点 | 协议 | 说明 |
|------|------|------|
| `POST /v1/chat/completions` | OpenAI | 主力端点，兼容 Gemini 请求体直打 |
| `POST /v1/completions` | OpenAI legacy | `text_completion` 格式 |
| `POST /v1/responses` | OpenAI Responses | 简化版 Responses API |
| `POST /v1/messages` | Anthropic | Messages API，含 tool_use 块转换 |
| `POST /v1beta/models/{model}:generateContent` | Gemini | SillyTavern / RisuAI 直连 |
| `POST /v1beta/models/{model}:streamGenerateContent` | Gemini | SSE 流式 |
| `GET /v1/models` | OpenAI | 模型列表 |
| `GET /v1/conversations` | - | 当前凭据登记的会话列表（管理员可查上游全量） |
| `GET /v1/conversations/:id/messages` | - | 读取自己的会话消息 |
| `POST /v1/conversations/:id/stop` | - | 停止自己的生成 |
| `GET /health` | - | 健康检查，含版本号（公开） |

### 常用扩展参数

| 参数 | 位置 | 说明 |
|------|------|------|
| `web_search` | body | 开启搜索（自动切换搜索模式） |
| `style` | body | `polite` / `osaka` 风格覆盖 |
| `target_lang` / `source_lang` | body | 翻译模型专用 |
| `history_mode` | body | `full`（默认）/ `delta` |
| `context_format` | body 或 `x-context-format` 头 | `txt`（默认）/ `json` |
| `conversation_id` | body 或 `x-conversation-id` 头 | 续聊会话 |
| `x-client-session-id` | 头 | 多人隔离范围标识（面板自动发送） |
| `character_id` | body 或 `x-character-id` 头 | 指定角色卡 |
| `tools` | body | 自定义工具声明 |

### 响应增强字段

| 字段 | 位置 | 说明 |
|------|------|------|
| `conversation_id` | 非流式 JSON / `x-conversation-id` 响应头 | 上游会话 ID，delta 续聊时回传 |
| `reasoning_content` | SSE delta / message | 思维链（含搜索过程） |
| `tool_calls` | SSE delta | 标准 OpenAI 分片，含稳定 `index` |
| `citations` / `annotations` | 尾部 chunk | 搜索来源 |
| `usage` | 尾部 chunk | `{prompt_tokens, completion_tokens, total_tokens}`（启发式估算，附 `x-usage-estimated` 头） |

---

## 🖥️ Web 管理面板

浏览器打开服务根路径即可使用，无需任何前端依赖：

| 页签 | 功能 |
|------|------|
| 仪表盘 | 请求数 / Token / 成本估算 / 模型排行 / 24h 与 30d 趋势 |
| Sakana Chat | 内置对话：模型切换、思考链、搜索、图片上传、多轮会话管理 |
| 账号池 | 账号状态、手动导入 cookie、刷新与限流监控 |
| 密钥管理 | 业务密钥创建/撤销（一次性显示） |
| 模型矩阵 | 9 模型能力速查 |
| 请求审计 | 逐请求状态、错误码、耗时、上下文元数据 |
| API 文档 | 内置端点速查 |
| 系统设置 | 邮箱供应商配置等 |

支持亮/暗双主题（顶栏、侧栏、聊天抽屉三处均可切换）、移动端抽屉式导航、键盘无障碍操作，主题选择跨标签同步并本地持久化。

---

## 🛠️ 部署与运维

### 关键环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `API_KEY` | – | 静态管理员密钥（公网部署必须配置它或持久化 admin key） |
| `ADMIN_API_KEY` | – | 管理密钥覆盖项；未设置时从 `runtime/admin_key` 读取 |
| `AUTO_SESSION` | `true` | 自动过盾注册与账号池维护；`false` 时只用显式会话文件 |
| `ACCOUNT_POOL_MIN` / `MAX` | `50` / `50` | 账号池目标规模 |
| `MAX_CONCURRENT_PER_ACCOUNT` | `6` | 单账号最大并发租约 |
| `QUEUE_TIMEOUT_MS` | `60000` | 全局排队超时 |
| `CACHE_ENABLED` | `false` | 响应缓存开关 |
| `SAKANA_BASE` | 上游官方地址 | 仅测试时修改 |

完整变量清单见 [README](https://github.com/xiaoli0412/sakana2api#readme)。

### 鉴权模式（三态）

| 状态 | 触发条件 | 行为 |
|------|----------|------|
| 开放模式 | 无任何静态/持久化/业务密钥 | 全部接口免鉴权（仅建议本机使用） |
| Key 模式 | 存在业务 Key 或管理员密钥 | 业务端点需有效密钥 |
| 管理锁 | 配置了管理员密钥 | 管理/密钥端点仅管理员密钥可操作 |

> 业务密钥以 sha256 哈希存于 `keys.json`；撤销全部业务 Key **不会**在管理员密钥仍存在时把服务退回开放模式。

### 状态持久化

所有运行时状态（`session.json`、`account_pool.json`、`keys.json`、审计日志、邮箱配置）都写入 `runtime/` 目录并符号链接进程序目录，升级/重启不丢失。部署脚本对持久化数据做**失败即停止**的迁移预检，冲突时保留双方数据等待人工处理。

### 升级到 v0.21.0 的注意点

- **行为变更**：旧版"显式 `conversation_id` 默认按 delta 续聊"已改为**默认 full**。依赖旧语义自动续聊的客户端需要显式加 `history_mode: "delta"`。
- 旧版按首条用户消息自动绑定上游会话的逻辑已移除。
- 其余 API 形状（工具、usage、citations、三协议端点）保持兼容。

---

## ❓ 常见问题

**Q：给群友共享同一把 Key，上下文会串吗？**
不会。v0.21.0 起完整历史请求一律独立建会话；delta 续聊只认"凭据 + 拥有的会话 ID"，跨 Key 或复制的范围标识一律 409 拒绝。多人共用建议各自发完整历史，或在客户端加 `x-client-session-id` 头。

**Q：返回 409 CONTEXT_EXPIRED 怎么办？**
会话已过期或上游已失效（状态有 24h TTL）。把完整历史（含原始附件）重新发送即可，服务不会用"只补最后一轮"的方式假装恢复。

**Q：为什么请求返回 400 RP-MODEL-DISABLED？**
RP 模型已全线下线且不可恢复，这是预期行为，请求不会触达上游。请改用标准模型。

**Q：usage 里的 token 数是精确的吗？**
是启发式估算（CJK ≈ 1 token/字、拉丁 ≈ 4 字符/token、图片按像素面积），上游不返回权威计数。响应带 `x-usage-estimated: true` 头标识。

**Q：账号池补不了号？**
上游 2026-10 起启用 Turnstile 会话闸门并封锁一次性邮箱注册。请在自己浏览器登录 chat.sakana.ai 后，把 `sakana-chat` cookie 通过 `POST /api/accounts/import` 导入，导入会先经上游验证。

**Q：怎么彻底停掉自动注册？**
设 `AUTO_SESSION=false`，服务只使用 `SAKANA_SESSION_FILE` 指定的显式会话，不启动浏览器。

---

## 🧭 文档导航

- [README](https://github.com/xiaoli0412/sakana2api#readme) — 功能总览与完整环境变量
- [Releases](https://github.com/xiaoli0412/sakana2api/releases) — 版本发布与变更
- [v0.21.0 更新日志](https://github.com/xiaoli0412/sakana2api/blob/main/CHANGELOG.md) — 会话隔离与安全加固明细
- [protocol.md](https://github.com/xiaoli0412/sakana2api/blob/main/protocol.md) — 上游协议逆向文档

后续可在本 Wiki 扩展：[[部署指南]]、[[API 参考]]、[[会话与隔离详解]]、[[常见问题]]、[[更新日志]]。

---

<div align="center">

**GitHub**：[xiaoli0412/sakana2api](https://github.com/xiaoli0412/sakana2api) · **问题反馈**：[Issues](https://github.com/xiaoli0412/sakana2api/issues)

MIT © 2026 xiaoli0412

</div>
