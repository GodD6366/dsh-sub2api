# dsh-sub2api

将你的 [sub2api](https://github.com/Wei-Shaw/sub2api) 网关接入 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)，作为模型供应商。

sub2api 是一个把订阅配额转成 OpenAI 兼容 API 的网关。它的模型是：**每个 API key 绑定一个分组，分组决定平台**（OpenAI / Claude / Grok / Gemini）与可用模型。本插件为每个已配置的 key 注册一个供应商路由，全部共享同一个 baseURL——同一个网关同时提供 OpenAI、Claude、Grok、Gemini 模型，harness 按 key 所在分组自动路由请求。

## 功能

- **一个 baseURL，四个供应商路由**：`sub2api-openai`、`sub2api-claude`、`sub2api-grok`、`sub2api-gemini`——各自配置独立 key，填好 key 即注册为可用的 LLM 供应商。
- **流式对话**：完整支持 SSE 流式、工具调用（tool_calls）、reasoning 增量与 token 用量，全部映射到 harness 的 `StreamChunk` 协议。
- **模型发现**：一键「获取模型」调用 `GET {baseURL}/models`（携带该 key），每个路由的模型目录与 sub2api 分组实际提供的完全一致。
- **正式模型参数**：设置页按模型 ID 从 [models.dev](https://models.dev/) 自动补全名称、Context Window 与最大输出长度；匹配不到的字段保持为空，可手动填写。
- **推理等级（思考模式）**：对话模型选择器可直接调整 `reasoning_effort`（透传网关）；设置页「思考强度」列按 [models.dev](https://models.dev/) 的 `reasoning_options` 逐模型填充真实档位（如 `gpt-5.6-sol` 为 none/low/medium/high/xhigh/max，`deepseek-v4-flash` 为 low/high/max），可手动增删档位或显式关闭。
- **用量查询**：「查看用量」调用 `GET {baseURL}/usage`，汇总配额、余额、限流窗口与订阅周期用量。
- **标准配置**：baseURL 与模型目录存于 `llm-sub2api:` 设置节（`$DSH_HOME/settings.yaml`，web 模型页可直接写入）；key 走 harness 凭据存储。
- **供应商图标**来自 [lobehub/lobe-icons](https://lobehub.com/icons)，以 SVG 内嵌在设置页中。

## 安装

```bash
dsh plugin --profile web add dsh-sub2api
```

或直接在本仓库目录：

```bash
dsh plugin --profile web add .
```

## 配置

打开 **设置 → Sub2API 模型**（或直接编辑 `$DSH_HOME/settings.yaml`）：

```yaml
llm-sub2api:
  baseURL: http://localhost:8080/v1
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
```

通过凭据服务存储各 key（web 模型页可写入，或导出 `SUB2API_OPENAI_API_KEY=…` 等环境变量）。某平台填了 key 后对应路由才激活；清空 key 即可移除该路由。

## 开发

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## 许可证

MIT
