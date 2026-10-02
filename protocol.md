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

## 3. 模型与路由

公开模型固定为 8 个：`sakana`、`sakana-mini`、`sakana-code`、`sakana-code-mini`、
`sakana-writer`、`sakana-writer-mini`、`sakana-translate`、`sakana-polite`、`sakana-osaka`。旧的 Namazu/Fugu
模型名只作为隐藏兼容别名，不会出现在模型列表；任何包含 `rp`、`roleplay` 或
`role-play` 的名称都会在映射前返回 `RP-MODEL-DISABLED`。

标准模型默认深度思考；code/writer profile 默认执行“先搜索、后思考”的两轮链，
因为上游 `webSearchEnabled` 与 `enableThinking` 互斥。显式 `web_search`、工具回合或
`SAKANA_SEARCH_CHAIN=off` 会回退到单轮互斥模式。搜索来源会合并到最终 citations。


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
响应: text/event-stream 风格 NDJSON ——逐行 JSON(每行一个对象),非 `data:` 前缀
```

## 5. 超长上下文附件

长文本会以 `context_document.txt` 或 `context_document.json` 作为 synthetic multipart
附件发送，避免只在代理内存中拼接后被截断。JSON 文档使用 `sakana-context/1` schema，
保留 system 与 turns 边界；请求体可用 `context_format`，也可用 `x-context-format`
请求头选择格式。writer profile 超过 `OPTICAL_CONTEXT_THRESHOLD` 后，旧历史可被渲染
为带页标的 PNG，近期尾部仍保留 TXT；渲染失败自动回退完整文本。光学压缩不等于突破
上游上下文硬限制，真实准确率必须通过授权基准测量。



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
- 风格 toneMode:默认 `default`;公开风格模型为 `sakana`、`sakana-polite`、`sakana-osaka`，也可通过 `style` 参数覆盖。
- 公开模型固定为 8 个 profile：`sakana`、`sakana-mini`、`sakana-code`、`sakana-code-mini`、
  `sakana-writer`、`sakana-writer-mini`、`sakana-translate`、`sakana-polite`、`sakana-osaka`。
- translate 档:思考与搜索强制关闭(纯快速模式),`target_lang`/`source_lang` 扩展参数注入翻译协议,
  不注入工具提示;上游 2026-10 新增 `/translate` 页面(单次 2,000 字符限制,`/translate/api/*` 需登录)。
  full 档映射上游 `sakana-namazu`，mini 档映射上游 `fugu-max`（2026-10 客户端注册表实证，`fugu` 单名已从 bundle 消失；可用 `SAKANA_MINI_UPSTREAM` 热修）；旧 Namazu/Fugu 名称仅作兼容别名。

## 6b. 2026-10 上游变化（实测）

- **Cloudflare Turnstile 会话闸门**: 新 UI 在 session bootstrap 时插入 Turnstile 挑战(sitekey `0x4AAAAAAD7JJzk0xcJKoYwj`),自适应模式下会出现交互式复选框遮罩(`.fixed.inset-0.bg-black/60`);闸门未放行时 SPA 无法完成 `POST /api/auth/login`,cookie 不会种下。auto-session 已内置 `passTurnstileGate()`(等待+点击)。
- **登录流**: magic link → Firebase `signInWithEmailLink`(成功,返回 idToken) → 回跳 `/login?apiKey=…` → 客户端 `POST /api/auth/login`(FormData: `idToken` + `turnstileToken`)。**上游封锁一次性邮箱**: 该调用对 mail.tm 域名返回 `403 AUTH-EMAIL-001`,随后账号 `USER_DISABLED`。cookie 仅在登录成功后由服务端种植;`sakana-chat` cookie 单独存在不代表会话有效——有效性以 `/api/v2/user/settings`(200)为准。
- **每模型配额端点**: `GET /api/rate-limit/status`(需登录),返回 `{models:[{id,exceeded}]}`;未登录 401 `AUTH-LOGIN-001`。
- **模型注册表**(bundle 实证): 匿名态 `availableModels` = `sakana-namazu`(multimodal image/*, thinking:false, anonymousAccess:true) + `fugu-max`("Orchestrates diverse models", thinking:false, 匿名不可用);代码另有 `fugu-ultra` 特判分支(登录档位,待实测确认)。文件类型白名单: image/*、application/pdf、text/plain、text/markdown、application/json、docx、csv、xlsx、html、pptx。
- **账号补充路径**: 自动注册被封锁期间,用管理接口 `POST /api/accounts/import`(body `{cookieHeader}`)导入人工登录获得的会话;导入前先经 `/api/v2/user/settings` 验证。

## 7. 文件上传

- 请求:FormData `files` part,文件名格式 `${type};${name}`,mime 单独给。
- 输出:`file` update / files 字段 `{name, sha, mime}`;下载路由 `GET /api/conversation/{id}/output/{sha}`。
- UI 支持图片预览(预览 URL 为 `previewUrl` 或该下载路由)。

## 8. 其余端点

- `POST /api/conversation/{id}/stop` — 中止;UI 也通过中断自动触发。
- 会话数据 `ancestors/children` 构树,支持分支/重试(is_retry)/续写(is_continue)。