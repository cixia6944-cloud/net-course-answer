# net-course-answer

网页学习平台的自动化桥接与调试工具。三部分组成：

| 部分 | 形态 | 职责 |
|---|---|---|
| `net-course-answer/` | 浏览器用户脚本（Tampermonkey / ScriptCat 加载） | 页面侧：探测平台 → 挂载浮动面板 → 解析题目/任务点 → 调本地桥取答案 → 填回页面 |
| `answer-bridge/` | 本地 Node 服务，`127.0.0.1:30142` | 把面板发来的 prompt 转给任意 OpenAI Chat Completions 兼容接口，按调用方口径裁出答案 |
| 面板（`src/ui/panel.js`） | 页面内浮动 UI | 每个标签页各自负责一类页面动作与状态展示 |

只在本机回环地址上通信，不经过任何第三方中转；桥不保存会话，页面凭据始终留在浏览器里。

## 架构与数据流

```
                     ┌──────────────────────── 浏览器 ────────────────────────┐
 页面 DOM ──读取──▶ │ 用户脚本 runtime.js                                    │
                     │   ├─ adapters/  平台路由（超星 / 智慧树 / 作业帧）      │
                     │   ├─ core/      解析·匹配·推理·填入·任务点播放          │
                     │   └─ ui/panel   浮动面板（答题/任务点/助教/讨论/陪练）   │
                     └───────────┬────────────────────────────────────────────┘
                                 │ POST /ask  /compose  /practice-answer
                                 │ GET  /health
                     ┌───────────▼──────────── 127.0.0.1:30142 ───────────────┐
                     │ answer-bridge/server.mjs                               │
                     │   server.mjs ─ 请求校验 → prompt 组装 → HTTP 调用       │
                     └───────────┬────────────────────────────────────────────┘
                                 │ OpenAI Chat Completions（HTTP）
                     ┌───────────▼────────────┐
                     │ 任意兼容网关 / 模型 API │
                     └────────────────────────┘
```

三条链路，各自独立：

1. **答题**：`runtime` 用 `adapters/` 选中当前页的适配器 → `core/runner` 解析题面（含字体验证码解密
   `core/font-decrypt`）→ `core/provider` POST 到桥 → 拿回答案 → `core/submit` 填回 DOM。
   面板按钮逐步推进，默认不点提交。
2. **任务点**：`core/course` + `core/player` 枚举章节内的任务点，按页面自身的心跳与播放进度推进，
   完成后回到目录取下一个（`adapters/cx-course`、`adapters/zhs-course` 各自实现平台侧状态机）。
3. **文本生成**：`/compose`（讨论区正文）、`/practice-answer`（练习页单题）走同一条桥，
   只是系统提示词与答案口径不同。

桥的每一次回答都是无状态的：没有会话、没有本地缓存、不落盘；`apiKey` 支持 `${VAR}` 从环境变量展开，
因此 key 不需要写进配置文件。

## 目录结构

```
net-course-answer/              用户脚本（ESM 源码 → 单文件 .user.js）
├── build.mjs                   零依赖构建器：静态解析 import、按依赖序拼成单个 IIFE
├── package.json                build / check / test 脚本
├── src/
│   ├── runtime.js              入口：平台探测 → 挂面板 → 按 URL 分流
│   ├── meta.js                 UserScript 头部（版本号单一来源见 src/version.js）
│   ├── adapters/               平台适配器：超星(作业/考试/章节课程)、智慧树(课程/练习)、内嵌作业帧
│   ├── contract/               页面 DOM 契约（选择器与结构假设集中在此）
│   ├── core/                   解析、匹配、推理、填入、任务点、讨论区、练习、字体验证码解密
│   ├── ui/                     panel.js（浮动面板）、harvest.js（课件/题目抓取条）
│   └── vendor/                 gm.js（GM_* 封装）、md5.js、typr.js（第三方，见下）
└── tools/                      单测、DOM fixture、CDP 侦察脚本、编译自测

answer-bridge/                  本地桥（无第三方依赖）
├── server.mjs                  HTTP 服务 + 上游调用 + 答案口径
├── README.md                   配置、接口、手动验证
└── bridge.config.example.json  配置样例（复制成 bridge.config.json 生效）

脚本/                            Windows 起停脚本（start/stop/status/selftest/开机自启）
启动答题桥.cmd                   双击起桥的入口
```

## 运行

**依赖**：Node 18+；浏览器装一个支持 `GM_*` 的脚本管理器；一个 OpenAI 兼容接口（本机网关、
中转、或官方 API 均可，只要支持 Chat Completions）。

1. 起桥（任选其一）：

   ```powershell
   node answer-bridge\server.mjs            # 前台，默认 30142
   .\启动答题桥.cmd                         # 后台，日志写 answer-bridge\bridge.*.log
   ```

   换后端：复制 `answer-bridge/bridge.config.example.json` 为 `bridge.config.json`，
   或直接给环境变量（优先）：

   ```powershell
   $env:ANSWER_BASE_URL="https://api.openai.com/v1"
   $env:ANSWER_MODEL="gpt-4o-mini"
   $env:ANSWER_API_KEY="sk-..."
   ```

2. 构建并安装用户脚本：

   ```bash
   cd net-course-answer
   npm run build            # → dist/net-course-answer.user.js
   ```

   把 `dist/net-course-answer.user.js` 拖进脚本管理器；更新版本时重新导入即可。
   脚本头部 `@connect 127.0.0.1` 已声明，桥地址变了要同步改 `@connect`。

3. 打开目标页面，右上角出现浮动面板即挂载成功。

## 调试

```bash
curl http://127.0.0.1:30142/health          # {"ok":true,"backend":"http",...}

curl -X POST http://127.0.0.1:30142/ask \
  -H "Content-Type: application/json" \
  -d '{"title":"下列关于……的说法正确的是()","type":"0","options":["A 项","B 项","C 项","D 项"]}'
```

- `/health` 的 `lastLlmUsage` 是最近一次上游用量。答案为空先看 `reasoningTokens`：
  推理吃满 `max_tokens` 时正文会是空串，把 `maxTokens` 调大即可。
- 桥的日志在 `answer-bridge/bridge.out.log` / `bridge.err.log`（已被 `.gitignore` 忽略）。
- 单测不碰网络、不碰浏览器：`cd net-course-answer && npm test`（DOM fixture + 假桥）。
- fixture 静态服务器：`npm run serve:fixture`（`127.0.0.1:30145`），配合 `tools/*.mjs` 里的
  端到端脚本做无浏览器回归。
- `tools/` 下的 `.sh` / `.js` 侦察脚本通过 CDP 端口（默认 `9222`）操作真实浏览器，
  参数一律走命令行，脚本里只留占位符（`<cpi>`、`<clazzId>`、`<courseId>` 等）。

## 开发约定

- **先只读侦察，再动手**：先用选择器把 DOM 结构读清楚，确认形态后才写点击逻辑；
  契约集中在 `src/contract/`，改版时只改这一处。
- **提交前测试必须通过**：`cd net-course-answer && npm test`（`pretest` 会先构建，产物缺失也能跑）；
  改动构建器或头部再补一次 `node tools/bundle-smoke.mjs`。测试里断言的是**产物行为**，不是源码文本。
- **一个标签页同一时间只有一个操作者**：面板的几条流水线互斥，同一页签并行两个自动化会互相踩
  （调试器只能挂一个）。串行跑，或换页签。
- **默认不提交**：填选与生成都是草稿，提交/交卷这类动作留给人工确认。
- **不伪造信号**：任务点推进依赖页面自身的播放与心跳，不人工造请求。

## 第三方代码

`net-course-answer/src/vendor/typr.js` 来自 [photopea/Typr.js](https://github.com/photopea/Typr.js)
（MIT），文件头保留了原始许可与来源注释，请勿移除。

## 许可

MIT。仅供学习与研究使用，使用前请自行确认所在平台的服务条款。
