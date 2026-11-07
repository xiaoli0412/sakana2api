# API 参考

> 三协议兼容端点的请求、响应与错误语义。所有推理端点共用同一套会话管线。

## 1. 鉴权

```
Authorization: Bearer <API_KEY 或 sk-sak- 业务密钥>
```

同时兼容 `x-goog-api-key` / `goog-api-key` / `x-api-key` / `api-key` 头，以及 Gemini 的 `?key=` 查询参数。开放模式下可省略。

管理端点（`/api/*`）只接受 `ADMIN_API_KEY`；业务密钥不能读取账号池、审计或密钥列表。

## 2. 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models`、`/models` | OpenAI 模型列表（9 个公开模型） |
| POST | `/v1/chat/completions`、`/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/completions`、`/completions` | Legacy completions |
| POST | `/v1/responses`、`/responses` | Responses 风格（简化） |
| POST | `/v1/messages`、`/messages` | Anthropic Messages |
| GET | `/v1beta/models`、`/gemini/v1beta/models` | Gemini 模型列表 |
| GET | `/v1beta/models/{model}` | Gemini 单模型详情 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini 非流式 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini 流式（`?alt=sse` 亦可） |
| GET | `/v1/conversations` | 当前凭据可见的会话（管理员可拉上游列表） |
| GET | `/v1/conversations/{id}/messages` | 读取会话消息 |
| POST | `/v1/conversations/{id}/stop` | 停止该会话正在生成的请求 |
| GET | `/health` | 存活、版本、运行时长、内存 |
| GET | `/` | 管理面板 |

管理端点（需管理员密钥）：`/api/stats`、`/api/keys`（创建/撤销/删除）、`/api/audit` 与 `/api/export-audit.csv`、`/api/accounts`（列表/refresh/import）、`/api/cache/clear`、`/api/mail-config`（+`/test`）、`/api/characters`（上传/激活/停用）。

## 3. Chat Completions 请求

标准字段：`model`、`messages`、`stream`、`temperature`、`max_tokens`、`tools`、`tool_choice`。

代理扩展字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `history_mode` | `"full"` / `"delta"` | 默认 full；delta 需同时给 `conversation_id` |
| `conversation_id` | string | delta 续聊的上游会话 ID；full 时忽略 |
| `x-client-session-id` 头 | string | 浏览器范围标识，用于隔离同 Key 多用户 |
| `web_search` | bool | 联网检索；与思考在上游互斥，代理自动拆两轮并合并 citations |
| `style` / `tone_mode` | `default` / `polite` / `osaka` | 覆盖模型默认语气 |
| `character_id` | string | 服务端已上传的角色卡 ID |
| `context_format` | `"txt"` / `"json"` | 超长上下文的封装格式 |
| `search_chain` | bool | 显式启用"先搜后想"两轮链 |
| `message_id` | string | 高级用法：指定上游消息 ID |

RP 模型已下线：任何带 `rp` / `roleplay` 的模型名返回 `400 RP-MODEL-DISABLED`，不触达上游。

## 4. 响应

- 流式：`text/event-stream`，带 `: ping` 心跳；增量在 `choices[0].delta`；末 chunk 带完整 `usage` 且 `choices` 为空数组；以 `data: [DONE]` 收尾。
- 非流式：常规 OpenAI JSON。
- 响应头 `x-conversation-id` 返回本次上游会话 ID；`x-usage-estimated: true` 表示 token 为启发式估算（CJK ≈ 1 token/字、拉丁 ≈ 4 字符/token、图片按像素折算）。
- `usage` 含输入（系统注入 + 附件文本 + 光学页 + 搜索轮）与输出；流式在尾 chunk 汇总。
- `citations` / annotations 在搜索轮出现；`reasoning_content` 透出思维链。

## 5. 错误语义

| HTTP | code | 含义 |
|------|------|------|
| 400 | `INVALID_JSON` / `invalid_request_error` | 请求体不合法 |
| 400 | `RP-MODEL-DISABLED` | RP 模型已下线 |
| 400 | `CONTEXT_ID_INVALID` | `conversation_id` 格式非法 |
| 400 | `CONTEXT_ID_REQUIRED` | delta 未给 `conversation_id` |
| 401 | `authentication_error` | 缺失或错误 Key |
| 403 | `forbidden` | 管理端点缺管理员密钥 |
| 400 | `INVALID-SESSION` | 导入的 cookie 格式/内容无效 |
| 400 | `SESSION-REJECTED` | 上游拒绝该会话（`reason` 细分过盾/失效） |
| 409 | `CONTEXT_EXPIRED` | 会话过期或上游失效，重发完整历史 |
| 409 | `CONTEXT_MODEL_MISMATCH` | 会话与当前模型不匹配，新建会话 |
| 409 | `CONTEXT-AFFINITY-MISSING` | 会话所属账号不可用 |
| 409 | `DUPLICATE-SESSION` | 导入的会话已在池中或已隔离 |
| 413 | `MULTIPART_BUDGET_EXCEEDED` | 输入超过上游 multipart 预算 |
| 429 | `PROBE-BACKOFF` | 连续探测失败后的短暂退避，按 `retryAfterMs` 重试 |
| 502 | `EMPTY-RESPONSE` / `UPSTREAM-NETWORK` | 上游空响应或网络失败 |
| 503 | `SERVER-SHUTDOWN` | 服务正在优雅退出 |

错误体统一为 `{ "error": { "message", "type", "code" } }`；导入相关错误额外带 `reason`、`upstreamStatus`、`retryAfterMs`。

## 6. 会话端点

```bash
curl http://127.0.0.1:8787/v1/conversations \
  -H "Authorization: Bearer $API_KEY"
```

- 普通凭据只看到自己拥有的会话；管理员请求会向该账号的上游拉取分页列表。
- 读取消息与停止生成会按会话所属账号路由；账号不可用返回 404/409，不会静默换账号。
- 详细契约见[会话与隔离详解](会话与隔离详解)。