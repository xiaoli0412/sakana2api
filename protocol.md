# chat.sakana.ai 逆向协议(基于真实浏览器 + JS bundle 分析)

> 逆向日期:2026-08-13。来源:真实 Chrome 会话抓包 + `_next/static/chunks/*.js` 反编译。
> 目标:把网页免费聊天封装成 OpenAI 兼容 API。

## 1. 整体架构

```
OpenAI Client (/v1/chat/completions)
        │  (本反代)
        ▼
Node server  ── HTTP cookie 会话 ──► chat.sakana.ai
        │                              CF SLB(5秒盾,需 cf_clearance)
        │                              Firebase Auth(session cookie,需登录账号)
        ▼
POST /api/conversation            (JSON 建会话 → {conversationId, systemMessageId})
POST /api/conversation/{id}       (FormData + NDJSON 流式生成)
GET  /api/conversation/{id}       (取会话详情)
POST /api/conversation/{id}/stop  (停止生成)
POST /api/conversation/{id}/compact (压缩)
POST /api/conversation/{id}/message/{mid}/feedback (反馈)
GET  /api/v2/conversations?p={p}  (会话列表)
PATCH/DELETE /api/v2/conversations/{id} (改名/删除)
```

## 2. 鉴权

- **CF 层**:`cf_clearance`(httpOnly,.sakana.ai)+ 完整浏览器指纹。纯 curl 直接 403。
- **业务层**:`credentials: "include"` 走 cookie。匿名 Firebase 用户 → 401 `AUTH-LOGIN-001`。
  **必须真实登录**(邮箱魔法链接 signInWithEmailLink 后服务端种会话 cookie)。
- 错误码:`AUTH-LOGIN-001` 需登录 / `AUTH-TOKEN-001` 缺 ID token /
  `AUTH-TOKEN-002` token 无效过期 / `AUTH-BOT-001` bot 验证失败(重载页) /
  `RATE-ANON-001` 匿名限额 / `RATE-MODEL-001/002` 模型日/周限额。

## 3. 建会话

```
POST /api/conversation
headers: { content-type: application/json }  (cookie 鉴权)
body:    { inputs?, enableThinking?, toneMode?, webSearchEnabled?, model? }
成功: 200 → { conversationId, systemMessageId }
```

## 4. 流式生成(核心)

```
POST /api/conversation/{conversationId}
headers: (fetch 不传 content-type,FormData 自动)   (cookie 鉴权)
body:  FormData
  data  = JSON string:
    { inputs: prompt?, id: messageId(uuid), is_retry: bool, is_continue: bool,
      enableThinking: bool, toneMode: character, webSearchEnabled: bool,
      userMessageId?, model? }
  files = 每个文件一个 part: new File([content], `${type};${name}`, { type: mime })
响应: text/event-stream 风格 NDJSON —— 逐行 JSON(每行一个对象),非 `data:` 前缀
```

### NDJSON 行(update)类型(translate 依据)

```ts
type Update =
  | { type: "stream", token: string }
  | { type: "finalAnswer", text: string, redactionReason?: string }
  | { type: "reasoning", token?: string, subtype?: string }
  | { type: "file", name: string, sha: string, mime: string }
  | { type: "toolTurnText", text: string, reasoning?: string }
  | { type: "toolCall",  toolCall:  { toolCallId, toolName, finalizing?, ... } }
  | { type: "toolResult", toolResult: { toolCallId, toolName, output, isError?, ... } }
  | { type: "status", status: "error" | ... }
```

### 消息对象(UI 层 toChatMessages 映射)

```ts
{ id, role: "user"|"assistant"|"tool", content, reasoning?,
  contentFormat?: "structured-v1", files?: [{name, sha, mime}],
  updates?: Update[], toneMode?, webSearchEnabled?, enableThinking?,
  interrupted?, ancestors?: string[], children?: string[] }
```

## 5. 工具系统(网页隐藏,协议层完整!)

`HIDDEN_TOOLS = new Set(["extract_file", "open"])` — 只有这俩 UI 隐藏。

已确认工具名(UI 标签即证据):
| toolName | UI 文案 | 说明 |
|----------|---------|------|
| `search` | Web検索 / ウェブサイトを確認しました | Web 搜索结果: `{query, formattedResults, sources:[{title,url,content}]}` |
| `open` | ページ確認中 / ページを確認しました | 打开 URL(HIDDEN) |
| `extract_file` | - | 解压文件(HIDDEN) |
| `finalizing` | 回答をまとめています | 收尾标志,之后是最终答案 |
| `skill` | スキルを読み込み中 | 加载技能 |
| `run_python` | Pythonコードを実行中 | **执行 Python** |
| `run_command` | コマンドを実行中 | **执行 shell 命令** |
| `read_file` | ファイルを確認中 | 读文件 |
| `upload_file` | ファイルを準備中 | 文件(在上传上下文) |

工具循环:`toolCall`(type=toolCall)→ `toolResult`(type=toolResult,含 output,isError)按 `toolCallId` 配对。
`finalizing` toolCall 表示工具阶段结束进入总结。**服务端自己执行工具**(一轮拉流内完成),无需客户端回传。

### WebSearch 结构
```ts
toolResult.output = { query, formattedResults, sources: [{ title, url, content? }] }
```
客户端把 sources 渲染为 `<source-chip title url>` 或作为搜索来源。

## 6. 思考/风格

- 思考:`reasoning` update 增量;内容含 `<thinking>...</thinking> <plan>...</plan> <answer>...</answer>` 标记。
- 风格 toneMode:默认 `default`;UI 有 `Standard 🐟 / Polite 🐠 / Osaka 🐙`。
- 模型:匿名仅 `sakana-namazu`;Fugu 需登录;另有 Marlin/Translate 子应用。
  - 内部 model 字符串:`sakana-namazu`(UI 名字 Namazu)。

## 7. 文件上传

- 请求:FormData `files` part,文件名格式 `${type};${name}`,mime 单独给。
- 输出:`file` update / files 字段 `{name, sha, mime}`;下载路由 `GET /api/conversation/{id}/output/{sha}`。
- UI 支持图片预览(预览 URL 为 `previewUrl` 或该下载路由)。

## 8. 其余端点

- `POST /api/conversation/{id}/stop` — 中止;UI 也通过中断自动触发。
- 会话数据 `ancestors/children` 构树,支持分支/重试(is_retry)/续写(is_continue)。