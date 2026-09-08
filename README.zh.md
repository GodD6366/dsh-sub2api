# dsh-sub2api

[English](./README.md)

将你的 [sub2api](https://github.com/Wei-Shaw/sub2api) 网关接入 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)，作为模型供应商。

sub2api 是一个把订阅配额转成 OpenAI 兼容 API 的网关。它的模型是：**每个 API key 绑定一个分组，分组决定平台**（OpenAI / Claude / Grok）与可用模型。三个供应商路由（`sub2api-openai`、`sub2api-claude`、`sub2api-grok`）由 harness 自带的 pi-ai 适配器（`dsh-llm-pi-ai`）承载：本插件把 `llm-sub2api:` 配置翻译成 `llm-pi-ai:` provider profiles（共享同一个**裸主机** baseURL，不带 `/v1`），协议序列化、流式、用量统计全部由 pi-ai 完成。同一个网关同时提供 OpenAI、Claude、Grok 模型，harness 按 key 所在分组自动路由请求。

## 功能

- **一个 baseURL，三个供应商路由**：`sub2api-openai`、`sub2api-claude`、`sub2api-grok`——各自配置独立 key 与至少一个模型，两者就绪后即注册为可用的 LLM 供应商。
- **流式对话（由 pi-ai 承载）**：SSE 流式、工具调用、reasoning 增量与 token 用量由 `dsh-llm-pi-ai` 映射到 harness 协议，天然正确处理 Responses API 的 `function_call` 顶层条目等 wire format 细节。
- **模型发现**：一键「获取模型」调用 `GET {baseURL}/v1/models`（携带该 key），每个路由的模型目录与 sub2api 分组实际提供的完全一致。
- **正式模型参数**：设置页按模型 ID 从 [models.dev](https://models.dev/) 自动补全名称、Context Window 与最大输出长度；匹配不到的字段保持为空，可手动填写。
- **推理等级（思考模式）**：对话模型选择器可直接调整 `reasoning_effort`（透传网关）；设置页「思考强度」字段按 [models.dev](https://models.dev/) 的 `reasoning_options` 逐模型填充真实档位（如 `gpt-5.6-sol` 为 none/low/medium/high/xhigh/max，`deepseek-v4-flash` 为 low/high/max），设置页可编辑展示；可在 settings.yaml 中用 `reasoningEfforts: []` 显式关闭。
- **用量查询**：「查看用量」调用 `GET {baseURL}/v1/usage`，汇总配额、余额、限流窗口与订阅周期用量。
- **标准配置**：baseURL 与模型目录存于 `llm-sub2api:` 设置节（`$DSH_HOME/settings.yaml`，web 模型页可直接写入）；key 走 harness 凭据存储。
- **全局识图 / 生图工具**：即使当前会话模型不支持图片，也可以调用 `analyze_image` 和 `generate_image`。它们走设置页指定的识图 / 生图模型：`analyze_image` 返回文字描述；`generate_image` 写入当前工作区并返回文件路径，同时把生成图保存为附件、在工具结果中返回 image 内容块，**聊天记录里直接内联渲染图片**（插件自带附件字节路由 + 工具卡片内嵌预览组件）；附件服务不可用时自动退回纯文本结果。
- **供应商图标**来自 [lobehub/lobe-icons](https://lobehub.com/icons)，以 SVG 内嵌在设置页中。

## 安装

要求 DeepSeek Harness **0.1.2-rc.1 或更新版本**；已在 **0.1.3-alpha.2** 上通过类型检查、构建与兼容测试。本版本使用设置服务的 `installSection` API 与 `dsh-client-ui-renderer` 浏览器服务，不再依赖已停止发布的 `dsh-client-runtime`。

```bash
dsh plugin --profile web add @godd6366/dsh-sub2api
```

或直接在本仓库目录：

```bash
dsh plugin --profile web add .
```

## 配置

打开 **设置 → Sub2API 模型**（或直接编辑 `$DSH_HOME/settings.yaml`）：

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      models:
        - id: gpt-5.6-sol
    claude:
      apiKeyEnv: SUB2API_CLAUDE_API_KEY
    grok:
      apiKeyEnv: SUB2API_GROK_API_KEY
  tools:
    analyze:
      provider: openai
      model: gpt-5.6-luna
    generate:
      provider: openai
      model: gpt-image-1
```

通过凭据服务存储各 key（web 模型页可写入，或导出 `SUB2API_OPENAI_API_KEY=…` 等环境变量）。某平台填了 key 且至少有一个模型后对应路由才激活；清空 key（或清空模型列表）即可移除该路由。

### 网关协议（自动选择）

sub2api 网关的每个分组在上游走**原生协议**，pi-ai 按分组自动选择，无需配置。设置里填**裸主机**（不带 `/v1`）：OpenAI 风格端点会自动补 `/v1`，Anthropic SDK 会自动补 `/v1/messages`：

| 分组 | 自动选择 | 请求端点 |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

这样网关不需要做 chat/completions ↔ 原生协议转换——并行工具调用正是在这种转换中丢失/错位工具名和 ID，导致 `unknown tool ""`、`missing required property` 报错。如某分组网关实际不走原生协议，可在 settings.yaml 中为该 provider 显式声明 `api`（仅 yaml 层支持，设置页不提供该选项）：

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      api: openai-completions   # 可选：openai-completions / openai-responses / anthropic-messages
      models:
        - id: gpt-5.6-sol
```

`api` 可选值：`openai-completions`（`/v1/chat/completions`）、`openai-responses`（`/v1/responses`）、`anthropic-messages`（`/v1/messages`）；省略 = 按上表自动。

### 与 dsh-llm-pi-ai 的关系

本插件不再自己实现 LLM 协议层：三个 `sub2api-*` 路由由 `dsh-llm-pi-ai`（dsh-base 内置、dormant 挂载）通过 `llm-pi-ai:` settings profiles 承载。插件在每次 `llm-sub2api:` 配置变化（及启动）时把裸主机 baseURL、各组模型与 key 引用翻译成 hand-declared profiles 写入 `llm-pi-ai:`，路由即时注册 / 撤销。设置页、模型发现（`GET /v1/models`）、用量查询（`GET /v1/usage`）、识图 / 生图工具仍由本插件提供。

> **依赖说明（pi-ai 多轮守卫）**：pi-ai 的 `AssistantMessage.usage` 在类型上是必填字段，前缀 token 估算会解引用它。harness 路径本身已安全——dsh 自带的 `dsh-llm-pi-ai` 会给重建的 assistant 消息挂零 `Usage`。本插件启动时仍会给 dsh 安装目录的 `@earendil-works/pi-ai/dist/utils/estimate.js` 打防御性守卫（`assistant.usage !== undefined` 才计入前缀 token），保护其它不挂 `usage` 的调用方。补丁幂等，升级 dsh 后自动重打；只读安装失败时可手动执行 `node scripts/patch-pi-ai.mjs`。

### 图片输入 / 思考强度

在模型详情中选择「图片输入」，并选择自动、不支持或手动输入思考档位（逗号分隔，例如 `none, low, high, max`）。补全数据只填空白值，保留手动设置。自动识图镜像与 Gemini 供应商已移除；全局 `analyze_image` / `generate_image` 工具保留。

会话中直接给模型挂图，需要模型声明 `image` 输入模态（否则 harness 在发送前拒绝，提示"当前模型不支持图片"）。**这两个字段可以在模型详情里手动设置**；models.dev 仅用于补全未填写的值：

- **图片输入**：models.dev 的 `attachment` / `modalities.input` 有数据就自动定（如 gpt-5.6-luna → 文本+图片，deepseek-v4-flash → 仅文本）；没数据时按模型 ID 推断（`gpt-*` / `claude-*` / `gemini-*` / `grok-*` / `glm-*` 等默认支持图片），可手动在 settings.yaml 写 `input: [text]` 强制仅文本。
- **思考强度**：models.dev 的 `reasoning_options` 有数据就自动填真实档位（如 deepseek-v4-flash → high/max）；否则默认 low/medium/high，`reasoning: false` 的模型自动标为不支持。

挂图后请求按分组原生协议携带图片：openai → Responses `input_image`，claude → Messages `image`（base64），grok → chat/completions `image_url`。

在 **设置 → Sub2API 模型 → 全局图像工具** 指定识图 / 生图模型。这两个工具是全局的：纯文本会话模型也可以调用 `analyze_image`（本地文件或 URL）和 `generate_image`（写入当前工作区）。生图先走 `POST {baseURL}/v1/images/generations`，网关没有该端点时再回退到 chat completions。

## 开发

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## 许可证

MIT
