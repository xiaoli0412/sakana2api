# 性能专项：浏览器治理 + Rust 热点（v0.15 阶段 9）

本文记录性能专项的方法论、已实测数据和后续路线。核心原则：**先 profile，再重写**——所有重写决定必须由实测数据支撑。

## 1. 浏览器资源 profiling（真实抓取）

工具：`scripts/profile_browser.mjs`（fail-closed，需 `SAKANA_PROFILE_CONFIRM=1`）。

采样维度（每 2s，默认 5 分钟）：
- Node 进程：RSS（OS 层面）、heapUsed/heapTotal（V8 层面）
- Chromium 子进程：进程数、合计 WorkingSet、CPU 时间
- persistent profile 磁盘占用（`.browser-profile` 字节 + 文件数）
- 派生指标：nodeRSS/chromeWS 每小时增长速率（回归检测）

输出只含汇总统计（min/avg/p95/max + 增长率），不含任何请求、prompt、cookie、token。

建议基线场景（在部署主机上依次运行并对比）：
1. 空闲 30 分钟（无流量）→ 基线泄漏检测
2. 100 次短请求 → 单请求边际成本
3. 10 次超长上下文请求（writer, 240K）→ 附件管线峰值
4. crash/restart 恢复 → 恢复后基线是否复位

判定阈值（经验起点，用数据修正）：
- 空闲 30 分钟 RSS 增长 > 30MB → 存在泄漏，需排查
- 每请求 chrome WS 边际 > 15MB → context/page 残留
- `.browser-profile` 每日增长 > 100MB → 渲染缓存治理

## 2. Rust 热点实测数据（2026-10，本机 win32-x64，cargo 1.96.0）

已落地 `native/`（napi-rs v2，`npm run build:native` 构建，`lib/native.js` 加载 + JS fallback）。
8MB 负载实测：

| 操作 | JS | Rust (napi) | 加速比 | 结论 |
|---|---|---|---|---|
| sha256Hex（附件摘要） | 4.17ms | 3.99ms | **1.05x** | 已接入 request-normalizer（无损，可选） |
| utf8ClampBytes（字节裁剪） | 16.95ms | 24.87ms | **0.68x（更慢）** | **保持 JS**，不接入热点 |

关键教训：
- Node 的 `crypto.createHash` 底层就是 OpenSSL 原生实现，napi 包装无收益。
- napi 边界跨界成本（String/Buffer 复制）会吞掉小操作的收益；utf8 clamp 的 JS Buffer 路径已高度优化。
- **已原生化的 Node 操作不要用 Rust 重写**。Rust 只应接手 JS 真正慢的工作：

### Rust 候选清单（按预期收益排序，全部需实测验证）
1. **多缓冲单遍 multipart 组装器**：输入 N 个 Buffer，单遍产出 multipart body + SHA-256 + 字节预算判断，消除 JS 侧多轮 `Buffer.concat` 的 MB 级复制（长上下文/多附件路径的真正拷贝热点）。预期收益：减少大请求的内存峰值 + 峰值延迟。
2. **光学上下文 PNG 预处理**（若实测渲染成为瓶颈）：分栏 HTML 文本测量、密度分块计算。
3. **SSE NDJSON 增量解析**（若 CPU profile 显示 translator 占比高）：流式字节级扫描。

接入规范：`lib/native.js` 统一加载，`SAKANA_NATIVE=0` 强制 JS；每个函数必须先过 native/JS 双路径字节一致性测试（`tests/native.test.mjs` 模式）再接入热点。

## 3. 浏览器 CPU/内存治理（已落地项）

- persistent context 单飞 + 生命周期监听（close/disconnect 清缓存）
- `Target crashed` 有界重试 + `withBrowserRecovery`
- harvest/refresh 独立临时 BrowserContext（与 persistent profile 的 IndexedDB 隔离），全部 bounded close
- 停机绝对 deadline：queue drain、persistent close、isolated close 共享一个 `STOP_DRAIN_MS` 预算
- 隔离 launch 与 stop 竞态收口：launch 挂起期间 stop 也能接管，晚到的浏览器强制关闭
- 注册流程固定 sleep 全部替换为事件驱动等待

## 4. 后续路线

1. 部署主机跑 §1 四场景，写入 `docs/profiles/`（汇总 JSON）。
2. 数据若证实 multipart 组装为峰值热点 → 实现 §2 候选 1（Rust 单遍组装器）。
3. Chrome 子进程 CPU 数据若显示渲染进程异常 → 调整 `browserLaunchOptions`（--js-flags、后台节流）与 density 分档。
4. profile dir 增长超阈值 → 引入渲染缓存 TTL 清理任务。
