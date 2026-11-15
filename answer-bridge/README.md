# answer-bridge —— 答题桥

把油猴面板的答题请求转给一个 **OpenAI Chat Completions 兼容接口**。只监听本机 `127.0.0.1:30142`。

```
浏览器面板 ──POST──▶ 127.0.0.1:30142 ──HTTP──▶ 网关 / 模型 API ──▶ 答案文本
```

> 这条链路里**没有任何 agent 框架**：它只做一件事 —— 把 prompt POST 给一个 OpenAI 兼容接口，
> 读回正文，按调用方的口径裁成答案。早期版本还带过一条本地 agent RPC 通道，已整体移除，
> 现在的 `backend` 恒为 `http`。

## 配置：本机零配置

默认值写死在代码里，但**默认指向一个占位后端**，实际用起来必须指定自己的兼容接口：

| 项 | 默认 |
|---|---|
| base URL | `https://api.openai.com/v1` |
| model | `gpt-4o-mini` |
| apiKey | 空（从 `ANSWER_API_KEY` 或配置文件的 `${VAR}` 展开） |
| maxTokens | `1024` |

要换后端，两种办法，**环境变量优先**：

```powershell
# 1) 同目录放 bridge.config.json（可从 bridge.config.example.json 复制）
{ "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "${ANSWER_API_KEY}" }

# 2) 或者直接给环境变量
$env:ANSWER_BASE_URL="https://api.openai.com/v1"; $env:ANSWER_MODEL="gpt-4o-mini"; $env:ANSWER_API_KEY="sk-..."
```

`apiKey` 支持写成 `${VAR}` 从环境变量展开，key 不落盘。

## maxTokens 别调小

这台网关上的模型默认开推理：一句「正确」实测烧 **304 个 reasoning token**。
`max_tokens: 64` 时正文直接是空字符串、`finish_reason: length`。
而且 `reasoning.effort` / `reasoning_effort` / `reasoning: false` 三种关推理的写法**都被忽略**，只能给预算。
答案为空先看 `/health` 里的 `lastLlmUsage.reasoningTokens`。

## 起停

```powershell
node server.mjs                 # 默认 30142
node server.mjs --port 30142    # 或指定端口（需与脚本 @connect 一致）
```

`脚本\start.ps1` 后台拉起并写 `bridge.out.log` / `bridge.err.log`；`脚本\stop.ps1` 停。
端口也可用 `BRIDGE_PORT` 指定。

## 接口

| 方法 | 路径 | 用途 | 请求体 | 返回 |
|---|---|---|---|---|
| POST | `/ask` | 作业/测验答题 | `{title, type, options?: string[]}` | `{ok, answer: string[]}` |
| POST | `/practice-answer` | AI 陪练单题 | `{stem, type, options?: [{key,text}]}` | `{ok, answer: "A"}` |
| POST | `/compose` | 讨论区回帖正文 | `{topicTitle, topicBody?, existingReplies?}` | `{ok, text}` |
| GET | `/health` | 探活 | — | `{ok, service, port, backend, llm, lastLlmUsage}` |

`type`：`0` 单选 / `1` 多选 / `2` 填空 / `3` 判断 / `4` 简答 / `999` 未知。
`/ask` 的答案口径与页面一致（单选给选项全文、判断给「正确/错误」、多选每行一条）；
`/practice-answer` 是陪练口径（单选给字母、多选连写、判断给「对/错」、填空用 `|` 分隔）。

## 手动验证

```powershell
curl http://127.0.0.1:30142/health

curl -X POST http://127.0.0.1:30142/ask -H "Content-Type: application/json" `
  -d '{"title":"党的根本工作路线是()。","type":"0","options":["解放思想,实事求是","与时俱进","一切为了群众,一切依靠群众,从群众中来,到群众中去","一切从实际出发"]}'
# → {"ok":true,"answer":["一切为了群众,一切依靠群众,从群众中来,到群众中去"]}
```

实测（`2026-11-13`）：三个入口全通，单题 2–5s，讨论区 4–18s。
