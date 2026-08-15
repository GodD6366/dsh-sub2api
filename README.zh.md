# dsh-sub2api

[English](./README.md)

将你的 [sub2api](https://github.com/Wei-Shaw/sub2api) 网关接入 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)，作为模型供应商。

sub2api 是一个把订阅配额转成 OpenAI 兼容 API 的网关。它的模型是：**每个 API key 绑定一个分组，分组决定平台**（OpenAI / Claude / Grok / Gemini）与可用模型。四个供应商路由（`sub2api-openai`、`sub2api-claude`、`sub2api-grok`、`sub2api-gemini`）由 harness 自带的 pi-ai 适配器（`dsh-llm-pi-ai`）承载：本插件把 `llm-sub2api:` 配置翻译成 `llm-pi-ai:` provider profiles（共享同一个**裸主机** baseURL，不带 `/v1`），协议序列化、流式、用量统计全部由 pi-ai 完成。同一个网关同时提供 OpenAI、Claude、Grok、Gemini 模型，harness 按 key 所在分组自动路由请求。

## 功能

- **一个 baseURL，四个供应商路由**：`sub2api-openai`、`sub2api-claude`、`sub2api-grok`、`sub2api-gemini`——各自配置独立 key，填好 key 即注册为可用的 LLM 供应商。
- **流式对话（由 pi-ai 承载）**：SSE 流式、工具调用、reasoning 增量与 token 用量由 `dsh-llm-pi-ai` 映射到 harness 协议，天然正确处理 Responses API 的 `function_call` 顶层条目等 wire format 细节。
- **模型发现**：一键「获取模型」调用 `GET {baseURL}/models`（携带该 key），每个路由的模型目录与 sub2api 分组实际提供的完全一致。
- **正式模型参数**：设置页按模型 ID 从 [models.dev](https://models.dev/) 自动补全名称、Context Window 与最大输出长度；匹配不到的字段保持为空，可手动填写。
- **推理等级（思考模式）**：对话模型选择器可直接调整 `reasoning_effort`（透传网关）；设置页「思考强度」列按 [models.dev](https://models.dev/) 的 `reasoning_options` 逐模型填充真实档位（如 `gpt-5.6-sol` 为 none/low/medium/high/xhigh/max，`deepseek-v4-flash` 为 low/high/max），可手动增删档位或显式关闭。
- **用量查询**：「查看用量」调用 `GET {baseURL}/usage`，汇总配额、余额、限流窗口与订阅周期用量。
- **标准配置**：baseURL 与模型目录存于 `llm-sub2api:` 设置节（`$DSH_HOME/settings.yaml`，web 模型页可直接写入）；key 走 harness 凭据存储。
- **全局识图 / 生图工具**：即使当前会话模型不支持图片，也可以调用 `analyze_image` 和 `generate_image`。它们走设置页指定的识图 / 生图模型，返回文字描述或工作区文件路径，不会把图片块塞进纯文本会话。`generate_image` 生成后会把图片保存为附件，并在工具结果中返回 image 内容块，**聊天记录里直接内联渲染图片**（插件自带附件字节路由 + 工具卡片内嵌预览组件）；附件服务不可用时自动退回纯文本结果。
- **Auto Vision（自动识图）**：给纯文本模型图片能力。**不仅覆盖本插件自己的 `sub2api-*` 路由，还自动包装所有已注册的文本模型提供商**——deepseek 官方（`deepseek-official`）、`llm-pi-ai`、其他插件添加的路由都会生成同名镜像（如 `deepseek-official-vision`，模型选择器中显示为「DeepSeek + 自动识图」）。镜像路由声明图片输入，通过 harness 附件准入后，把图片块改写为视觉模型转述（走设置的识图模型，按附件缓存），再以纯文本回合委托给原模型——DeepSeek 始终只收文本，视觉模型只当眼睛。跟随 `llm/adapters-updated` 事件自动增删镜像，与其他插件的同名路由冲突时自动跳过。
- **供应商图标**来自 [lobehub/lobe-icons](https://lobehub.com/icons)，以 SVG 内嵌在设置页中。

## 安装

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
        - id: gpt-4o
          name: GPT-4o
          contextWindow: 128000
          maxTokens: 16384
    claude:
      apiKeyEnv: SUB2API_CLAUDE_API_KEY
    grok:
      apiKeyEnv: SUB2API_GROK_API_KEY
    gemini:
      apiKeyEnv: SUB2API_GEMINI_API_KEY
  tools:
    analyze:
      provider: openai
      model: gpt-4o
    generate:
      provider: openai
      model: gpt-image-1
```

通过凭据服务存储各 key（web 模型页可写入，或导出 `SUB2API_OPENAI_API_KEY=…` 等环境变量）。某平台填了 key 后对应路由才激活；清空 key 即可移除该路由。

### Auto Vision（自动识图）

默认开启。**不仅包装 `sub2api-*` 自己的路由，也自动包装所有已注册的文本模型提供商**（deepseek 官方 `deepseek-official`、`llm-pi-ai`、其他插件添加的路由），各自生成同名镜像（`<route>-vision`，如 `deepseek-official-vision`）。镜像里的模型 id 与显示名都带 **`-vision` 后缀**（如 `deepseek-v4-flash-vision`），一眼区分哪些模型支持识图；委托回原路由时后缀自动剥除，网关收到的仍是原模型 id。发图前在右下角模型选择器中选「+ 自动识图」分组（如 **DeepSeek + 自动识图** → `deepseek-v4-flash-vision`），然后正常粘贴/上传图片即可：

1. 镜像路由的模型条目声明 `inputModalities: ['text', 'image']`，通过 harness 的附件准入——纯文本模型不再报 `does not support image input`。
2. 回合中图片块被改写为视觉模型转述（走上面 `tools.analyze` 配置的识图模型），按附件 ID 缓存，后续回合直接复用，不重复调用。
3. 转述后的纯文本回合委托给原 DeepSeek/文本模型处理，会话日志保留原始图片块。

只在镜像路由上包装**纯文本模型**；原生多模态模型（如 `gpt-5.6-luna`）仍保留基础路由的原生图片输入。若想关闭镜像路由，在 `settings.yaml` 中设置：

> 镜像委托给基础路由（pi-ai）前会剥离 assistant 消息的 pi-ai 回放状态（`replayState`）：镜像路由名与回放状态戳里的基础路由 provider 不一致，不剥离会触发 pi-ai 的 `invalid pi-ai replay state: provider does not match assistant source`（`INVALID_REPLAY_STATE`）。镜像会话因此不享受 pi-ai 的原生回放优化，这是有意取舍。

```yaml
llm-sub2api:
  autoVision: false
```

> 注意：发图前必须选「+ 自动识图」分组。仍在原文本路由上发原生图片附件，harness 准入会在插件改写前直接拒绝。

### 网关协议（自动选择）

sub2api 网关的每个分组在上游走**原生协议**，pi-ai 按分组自动选择，无需配置。设置里填**裸主机**（不带 `/v1`）：OpenAI 风格端点会自动补 `/v1`，Anthropic SDK 会自动补 `/v1/messages`：

| 分组 | 自动选择 | 请求端点 |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok / gemini | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

这样网关不需要做 chat/completions ↔ 原生协议转换——并行工具调用正是在这种转换中丢失/错位工具名和 ID，导致 `unknown tool ""`、`missing required property` 报错。如某分组网关实际不走原生协议，可在 settings.yaml 中为该 provider 显式声明 `api`（仅 yaml 层支持，设置页不提供该选项）：

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      api: openai-completions   # 可选：openai-completions / openai-responses / anthropic-messages
      models:
        - id: gpt-4o
```

`api` 可选值：`openai-completions`（`/v1/chat/completions`）、`openai-responses`（`/v1/responses`）、`anthropic-messages`（`/v1/messages`）；省略 = 按上表自动。

### 与 dsh-llm-pi-ai 的关系

本插件不再自己实现 LLM 协议层：四个 `sub2api-*` 路由由 `dsh-llm-pi-ai`（dsh-base 内置、dormant 挂载）通过 `llm-pi-ai:` settings profiles 承载。插件在每次 `llm-sub2api:` 配置变化（及启动）时把裸主机 baseURL、各组模型与 key 引用翻译成 hand-declared profiles 写入 `llm-pi-ai:`，路由即时注册 / 撤销。设置页、模型发现（`GET /v1/models`）、用量查询（`GET /v1/usage`）、识图 / 生图工具与 Auto Vision 镜像仍由本插件提供。

> **依赖（pi-ai 多轮崩溃，归因：dsh-llm-pi-ai 违反 pi-ai 契约）**：pi-ai 的 `AssistantMessage.usage` 是必填字段，其前缀 token 估算会解引用它；而 dsh 自带的 `dsh-llm-pi-ai` 重建 harness 历史 assistant 消息时**不带 usage**（harness 的 `Message` 类型本来就没有 usage），导致多轮对话抛 `Cannot read properties of undefined (reading 'totalTokens')`。根修在 dsh-llm-pi-ai（挂零 usage）；**本插件启动时会给 dsh 安装目录的 `@earendil-works/pi-ai/dist/utils/estimate.js` 打防御性守卫**（`assistant.usage !== undefined` 才计入前缀 token），幂等、升级 dsh 后自动重打，全新安装开箱即用；只读安装失败时手动执行 `node scripts/patch-pi-ai.mjs`。

### 图片输入 / 思考强度（自动补全）

会话中直接给模型挂图，需要模型声明 `image` 输入模态（否则 harness 在发送前拒绝，提示"当前模型不支持图片"）。**这两个字段都从 models.dev 自动补全，无需手选**（模型展开详情里以只读形式显示推导结果）：

- **图片输入**：models.dev 的 `attachment` / `modalities.input` 有数据就自动定（如 gpt-5.6-luna → 文本+图片，deepseek-v4-flash → 仅文本）；没数据时按模型 ID 推断（`gpt-*` / `claude-*` / `gemini-*` / `grok-*` / `glm-*` 等默认支持图片），可手动在 settings.yaml 写 `input: [text]` 强制仅文本。
- **思考强度**：models.dev 的 `reasoning_options` 有数据就自动填真实档位（如 deepseek-v4-flash → high/max）；否则默认 low/medium/high，`reasoning: false` 的模型自动标为不支持。

挂图后请求按分组原生协议携带图片：openai → Responses `input_image`，claude → Messages `image`（base64），grok/gemini → chat/completions `image_url`。

在 **设置 → Sub2API 模型 → 全局图像工具** 指定识图 / 生图模型。这两个工具是全局的：纯文本会话模型也可以调用 `analyze_image`（本地文件或 URL）和 `generate_image`（写入当前工作区）。生图先走 `POST {baseURL}/images/generations`，网关没有该端点时再回退到 chat completions。

## 开发

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## 许可证

MIT
