# cloudflare-slider-captcha

A self-hosted **slider (jigsaw-gap) CAPTCHA** for **Cloudflare Pages + D1**. Drop it into a Pages
project, create one D1 table, and you have human verification running on your own domain — no
Third-party service, no API key, no monthly fee, no user data leaving your infrastructure.

> 自托管拼图（缺口滑块）人机验证，直接部署在 **Cloudflare Pages + D1** 上。无需第三方服务、无需
> API Key、无需付费，用户数据不出你的基础设施。中文文档见 [下文](#中文文档)。

---

## Table of contents

- [English](#english)
  - [Why](#why)
  - [Features](#features)
  - [How it works](#how-it-works)
  - [Project structure](#project-structure)
  - [Requirements](#requirements)
  - [Quick start](#quick-start)
  - [Frontend usage](#frontend-usage)
  - [Backend usage](#backend-usage)
  - [HTTP API](#http-api)
  - [Configuration](#configuration)
  - [Security notes](#security-notes)
  - [License](#license)
- [中文文档](#中文文档)

---

## English

### Why

Most CAPTCHAs on GitHub either call a third party (hCaptcha / reCAPTCHA / Turnstile) or need a
server that Cloudflare can't host directly. This one is designed for Cloudflare from the start:

- **Fully self-hosted** — challenge generation, verification and ticket issuing all run inside
  Cloudflare Pages Functions.
- **No dependency** — the widget is a single vanilla-JS file; the backend only needs D1.
- **Green by default** — the background is generated on the fly as an SVG, so there is no image
  library, no asset upload and near-zero storage cost.

### Features

- 1 draggable puzzle piece + 2–3 differently sized gaps; only the size-matching gap accepts the piece.
- Server-side generated SVG background (procedural shapes + gradient), no image assets.
- Answer coordinates are split into a random "decoy base point + inner offset" so the answer is never
  shipped to the client in plain form.
- Drag-track analysis: duration, monotonic movement, no teleport, speed ceiling, jitter variance and
  reversal ratio — tuned to still be comfortable on touch screens.
- One-time ticket: consumed exactly once, bound to the client IP, invalid right after use.
- Per-challenge retry limit, per-IP issue quota (in D1, cross-isolate) and a generic rate limiter.
- Keyboard accessible (arrow keys + Enter) and responsive.
- Zero build step.

### How it works

```
Browser (captcha.js)                       Cloudflare Pages Functions      D1
────────────────────                       ──────────────────────────      ──
GET  /api/captcha/new        ───────────▶  issueChallenge()  ───────────▶  INSERT challenge
  ◀─── { id, bg, pieces, ttl }               (answer stays server-side)
  user drags the piece
POST /api/captcha/verify     ───────────▶  verifyChallenge()  ──────────▶  read challenge
  { id, placements:[{x,track}] }             · position within ±tolerance
  ◀─── { ticket }                            · track looks human
                                             · wall-clock ≥ minMsPerPiece
                                             └▶  UPDATE solved, ticket
POST /api/your-endpoint      ───────────▶  consumeTicket(token)  ───────▶  ticket_used = 1
  { captchaToken }                           (one-time, IP-bound)
```

### Project structure

```
cloudflare-slider-captcha/
├── public/
│   ├── captcha.js               # front-end widget (vanilla JS, self-contained)
│   └── index.html               # live demo / playground
├── src/
│   ├── captcha.js               # server core: issue / verify / consume + SVG generation
│   └── config.js                # all tunable parameters (single source of truth)
├── functions/api/
│   ├── captcha/new.js           # GET  /api/captcha/new
│   ├── captcha/verify.js        # POST /api/captcha/verify
│   └── demo/submit.js           # POST /api/demo/submit   (example business endpoint)
├── schema.sql                   # D1 table + indexes
├── wrangler.toml                # Pages configuration + D1 binding
└── package.json
```

### Requirements

- Node.js 18+
- A Cloudflare account (Pages + D1 are available on the free plan)
- `wrangler` (installed automatically by `npm install`)

### Quick start

```bash
# 1. install tooling
npm install

# 2. create the D1 database and copy the returned `database_id`
npx wrangler d1 create captcha-db

# 3. put that id into wrangler.toml
#    [[d1_databases]] → database_id = "..."

# 4. create the table (remote = production, local = dev)
npm run db:init:remote
npm run db:init:local

# 5. run locally
npm run dev            # http://localhost:8788

# 6. deploy
npx wrangler pages project create cloudflare-slider-captcha
npm run deploy
```

Then open the deployed URL — `public/index.html` is a working demo of the whole flow.

### Frontend usage

Load the widget and give it a container:

```html
<div class="forest-captcha" data-forest-captcha data-action="login"></div>
<script src="/captcha.js?v=1.9.3"></script>
<script>
  const captcha = window.ForestCaptcha.get(document.querySelector('[data-forest-captcha]'));
  // captcha.ticket() returns '' until the user passes; the value is a one-time token
</script>
```

Mount it dynamically (e.g. inside a dialog that is opened later):

```js
const instance = window.ForestCaptcha.mount(containerEl, { action: 'feedback' });
```

API:

| Method | Description |
| --- | --- |
| `ForestCaptcha.mount(el, options?)` | Create an instance on `el`. `options.action` is a free-form label sent with the challenge. |
| `ForestCaptcha.get(el)` | Return the instance bound to `el` (mounts it on demand). |
| `ForestCaptcha.ticket(el)` | Convenience shortcut for `instance.ticket()`. |
| `instance.ticket()` | One-time token, or `''` if not solved yet. |
| `instance.reset()` | Discard the current challenge and load a new one. |
| `ForestCaptcha.resetAll(root?)` | Reset every widget under `root` (defaults to `document`). |

The container also emits a bubbling `forest-captcha-solved` event with `detail.ticket`.

**Lazy loading:** if the container is hidden (zero width) when created, the widget waits and only
requests a challenge once it becomes visible — handy for popups.

### Backend usage

Send the ticket as `captchaToken` in your form body, and consume it on the server **after** your own
validation (wrong password, duplicate username, …):

```js
import { consumeTicket } from '../src/captcha.js';

export async function onRequestPost({ request, env }) {
  const data = await request.json();

  // ... validate username / password first ...

  if (!(await consumeTicket(data?.captchaToken, request, env))) {
    return new Response(JSON.stringify({ error: 'Please complete the CAPTCHA first' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  // proceed
}
```

`consumeTicket` returns `true` only when the ticket was solved, not used yet, not expired and comes
from the same IP; it marks it as used immediately, so replaying the same token fails.

### HTTP API

| Endpoint | Method | Body / Query | Success response |
| --- | --- | --- | --- |
| `/api/captcha/new` | `GET` | — | `{ id, w, h, ttl, attempts, bg, pieces:[{index,y,w,h,image}] }` |
| `/api/captcha/verify` | `POST` | `{ id, placements:[{ x, track:[{x,t}] }] }` | `{ success:true, ticket, expiresIn }` |
| `/api/demo/submit` | `POST` | `{ captchaToken }` | `{ success:true, message }` (demo only) |

Error responses use `{ "error": "…" }` with a `4xx` status; a failed `verify` may additionally
include `{ remaining, expired }` so the client can decide whether to keep or refresh the challenge.

### Configuration

Everything tunable lives in [`src/config.js`](src/config.js):

| Key | Default | Meaning |
| --- | --- | --- |
| `ttlSeconds` | `300` | Challenge lifetime. |
| `maxAttempts` | `3` | Wrong answers allowed per challenge. |
| `tolerance` | `4` | Accepted drop offset (± px). |
| `stageWidth` / `stageHeight` | `320` / `180` | Background size in SVG units. |
| `pieceSize` | `50` | Puzzle piece base size (width is `size × 1.18`). |
| `minGaps` / `maxGaps` | `2` / `3` | Number of differently sized gaps drawn. |
| `issueLimitPerMinute` | `12` | Challenges issued per IP per minute (D1, global). |
| `minMsPerPiece` | `520` | Minimum wall-clock time a human solve can take. |
| `requestLimitPerMinute` | `60` | Generic per-IP request limiter. |
| `enforceSameOrigin` | `true` | Reject cross-site POSTs. |

**Widget text** is Chinese by default. UI strings live in `public/captcha.js` (the `CSS`/`build`
block and the `updateStatus`/`setMessage` calls); server-side error messages live in
`src/captcha.js`. Search for the Chinese literals and replace them to localize.

### Security notes

- The correct answer never leaves the server: the client only receives an SVG whose gaps are drawn
  with a random decoy offset.
- Tickets are 24 random bytes (48 hex chars), single-use and IP-bound.
- The track heuristic blocks naive bots but is intentionally not a hard gate — a determined attacker
  with a real browser can still pass. Treat it as a lightweight first line of defence, not an
  airtight wall.
- The in-memory rate limiter is per-isolate; the per-IP issue quota in D1 is the global guard.
- No third-party scripts, cookies for tracking, or external requests are made by the widget.

### License

[MIT](LICENSE).

---

## 中文文档

一个可直接部署在 **Cloudflare Pages + D1** 上的**自托管拼图（缺口滑块）验证码**。放进 Pages
项目、建一张 D1 表就能用，全程跑在自己的域名下：**不依赖第三方服务、不需要 API Key、不额外
付费，用户数据不出你的基础设施**。

### 为什么做它

GitHub 上现成的验证码，要么得调第三方（hCaptcha / reCAPTCHA / Turnstile），要么需要一个
Cloudflare 托管不了的后端。这一份从一开始就是为 Cloudflare 写的：

- **完全自托管**：出题、校验、签发票据都在 Pages Functions 内完成。
- **零依赖**：前端就是一个原生 JS 文件，后端只要一个 D1。
- **默认省资源**：背景图由服务端实时生成 SVG，不需要图片库、不需要上传素材、几乎不占存储。

### 特性

- 一道题只拖 **1 块拼图**，背景上画 **2~3 个大小不同的缺口**，只有尺寸匹配的那个能放下。
- 服务端按种子生成 SVG 背景（随机图形 + 渐变），没有任何图片资源。
- 答案坐标拆成「随机干扰基点 + 内层偏移」，答案不会以明文形式下发到前端。
- 拖动轨迹分析：时长、单调性、禁止瞬移、瞬时速度上限、抖动方差、回摆比例；对触摸屏做了放宽。
- 一次性 ticket：只能用一次、绑定客户端 IP、用完立即失效。
- 单题重试上限、单 IP 出题配额（写在 D1，跨 isolate 全局生效）、通用限流兜底。
- 支持键盘操作（方向键 + 回车），自适应宽度。
- 无需构建步骤。

### 工作原理

```
浏览器 (captcha.js)                        Cloudflare Pages Functions      D1
──────────────────                        ──────────────────────────      ──
GET  /api/captcha/new        ───────────▶ issueChallenge()  ───────────▶  INSERT 题目
  ◀─── { id, bg, pieces, ttl }             （答案只存服务端）
  用户拖动拼图
POST /api/captcha/verify     ───────────▶ verifyChallenge()  ──────────▶  读取题目
  { id, placements:[{x,track}] }           · 落点在 ±容差内
  ◀─── { ticket }                          · 轨迹像真人
                                           · 墙钟 ≥ 单块最少耗时
                                           └▶  UPDATE solved, ticket
POST /api/你的业务接口        ───────────▶ consumeTicket(token)  ───────▶  ticket_used = 1
  { captchaToken }                         （一次性、绑定 IP）
```

### 目录结构

```
cloudflare-slider-captcha/
├── public/
│   ├── captcha.js               # 前端组件（原生 JS，自包含）
│   └── index.html               # 在线演示 / 调试页
├── src/
│   ├── captcha.js               # 服务端核心：出题 / 校验 / 消费 + SVG 生成
│   └── config.js                # 全部可调参数（唯一参数来源）
├── functions/api/
│   ├── captcha/new.js           # GET  /api/captcha/new
│   ├── captcha/verify.js        # POST /api/captcha/verify
│   └── demo/submit.js           # POST /api/demo/submit（业务接口示例）
├── schema.sql                   # D1 建表 + 索引
├── wrangler.toml                # Pages 配置 + D1 绑定
└── package.json
```

### 环境要求

- Node.js 18+
- 一个 Cloudflare 账号（Pages 和 D1 均在免费额度内可用）
- `wrangler`（`npm install` 会自动装上）

### 快速开始

```bash
# 1. 安装工具
npm install

# 2. 创建 D1 数据库，记下返回的 database_id
npx wrangler d1 create captcha-db

# 3. 把 id 填进 wrangler.toml
#    [[d1_databases]] → database_id = "..."

# 4. 建表（remote = 线上，local = 本地开发）
npm run db:init:remote
npm run db:init:local

# 5. 本地运行
npm run dev            # http://localhost:8788

# 6. 部署
npx wrangler pages project create cloudflare-slider-captcha
npm run deploy
```

部署后打开首页，`public/index.html` 就是完整流程的可运行演示。

### 前端用法

引入组件并给它一个容器：

```html
<div class="forest-captcha" data-forest-captcha data-action="login"></div>
<script src="/captcha.js?v=1.9.3"></script>
<script>
  const captcha = window.ForestCaptcha.get(document.querySelector('[data-forest-captcha]'));
  // 未通过时 captcha.ticket() 返回空字符串；通过后返回一次性 token
</script>
```

动态挂载（例如稍后才弹出的对话框里）：

```js
const instance = window.ForestCaptcha.mount(containerEl, { action: 'feedback' });
```

接口：

| 方法 | 说明 |
| --- | --- |
| `ForestCaptcha.mount(el, options?)` | 在 `el` 上创建实例。`options.action` 是随题上报的自由标签。 |
| `ForestCaptcha.get(el)` | 取回绑定在 `el` 上的实例（需要时会自动挂载）。 |
| `ForestCaptcha.ticket(el)` | `instance.ticket()` 的快捷写法。 |
| `instance.ticket()` | 一次性 token；未通过时为空字符串。 |
| `instance.reset()` | 作废当前题并重新出题。 |
| `ForestCaptcha.resetAll(root?)` | 重置 `root`（默认 `document`）下所有组件。 |

容器还会冒泡派发 `forest-captcha-solved` 事件，`detail.ticket` 即所得 token。

**懒加载**：若创建时容器不可见（宽度为 0，例如藏在未打开的弹窗里），组件会等待，等可见后再
请求题目。

### 后端用法

把 token 作为 `captchaToken` 随表单提交，并在**你自己校验之后**、在服务端消费它（比如密码
错误、用户名重复这类前置错误不该白白作废一次验证）：

```js
import { consumeTicket } from '../src/captcha.js';

export async function onRequestPost({ request, env }) {
  const data = await request.json();

  // ... 先做你自己的校验 ...

  if (!(await consumeTicket(data?.captchaToken, request, env))) {
    return new Response(JSON.stringify({ error: '请先完成人机验证' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  // 继续业务逻辑
}
```

`consumeTicket` 只在「已解出、未被使用、未过期、同 IP」时返回 `true`，并立即置为已用，
所以同一个 token 重放一定失败。

### HTTP 接口

| 接口 | 方法 | 请求体 / 参数 | 成功响应 |
| --- | --- | --- | --- |
| `/api/captcha/new` | `GET` | — | `{ id, w, h, ttl, attempts, bg, pieces:[{index,y,w,h,image}] }` |
| `/api/captcha/verify` | `POST` | `{ id, placements:[{ x, track:[{x,t}] }] }` | `{ success:true, ticket, expiresIn }` |
| `/api/demo/submit` | `POST` | `{ captchaToken }` | `{ success:true, message }`（仅演示） |

错误响应统一为 `{ "error": "…" }` 搭配 `4xx` 状态码；`verify` 失败时还可能附带
`{ remaining, expired }`，供前端决定是继续重试还是换题。

### 配置

所有可调参数都在 [`src/config.js`](src/config.js)：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `ttlSeconds` | `300` | 单题存活时间（秒）。 |
| `maxAttempts` | `3` | 单题允许答错次数。 |
| `tolerance` | `4` | 落点允许误差（± px）。 |
| `stageWidth` / `stageHeight` | `320` / `180` | 背景尺寸（SVG 逻辑单位）。 |
| `pieceSize` | `50` | 拼图块基准尺寸（宽度 = `size × 1.18`）。 |
| `minGaps` / `maxGaps` | `2` / `3` | 绘制的大小不一的缺口数量。 |
| `issueLimitPerMinute` | `12` | 单 IP 每分钟出题上限（写 D1，全局生效）。 |
| `minMsPerPiece` | `520` | 单块拼图的最少耗时（毫秒）。 |
| `requestLimitPerMinute` | `60` | 通用单 IP 每分钟请求上限。 |
| `enforceSameOrigin` | `true` | 拒绝跨站 POST。 |

**界面文案默认是中文**。前端文案在 `public/captcha.js`（`CSS` / `build` 区块，以及
`updateStatus`、`setMessage` 的调用处），服务端错误文案在 `src/captcha.js`。搜索中文串替换
即可本地化。

### 安全说明

- 正确答案不下发：前端拿到的只是一张把缺口用随机干扰基偏移画出来的 SVG。
- ticket 为 24 字节随机数（48 位十六进制），一次性且绑定 IP。
- 轨迹启发式能挡住朴素脚本，但它**不是**硬门槛——有真实浏览器的攻击者仍可能通过。把它当作
  轻量第一道防线，而不是密不透风的墙。
- 进程内限流是 per-isolate 的；单 IP 出题配额写在 D1，才是全局兜底。
- 组件不加载任何第三方脚本、不写跟踪 Cookie、不发外部请求。

### 许可证

[MIT](LICENSE)。