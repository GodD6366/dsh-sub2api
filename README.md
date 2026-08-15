# dsh-sub2api

Connect your [sub2api](https://github.com/Wei-Shaw/sub2api) gateway to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) as model providers.

Sub2API is an AI API gateway that turns subscription quota into OpenAI-compatible endpoints. In its model, **each API key is bound to a group, and the group decides the platform** (OpenAI / Claude / Grok / Gemini) and the models that key can serve. This plugin registers one provider route per configured key, all sharing a single base URL — so the same gateway serves OpenAI, Claude, Grok, and Gemini models side by side, and the harness routes each request to the key whose group owns the requested model.

## Features

- **One base URL, four provider routes**: `sub2api-openai`, `sub2api-claude`, `sub2api-grok`, `sub2api-gemini` — each configured with its own key, registered as a live LLM provider the moment the key is set.
- **Streaming chat**: full SSE streaming, tool calls (`tool_calls`), reasoning deltas, and token usage — all mapped to the harness `StreamChunk` protocol.
- **Model discovery**: one-click "fetch models" calls `GET {baseURL}/models` with the key, so each route's catalog matches exactly what the sub2api group serves.
- **Usage lookup**: "view usage" calls `GET {baseURL}/usage` and summarizes quota, balance, rate limits, and subscription windows.
- **Standards-based config**: base URL and model catalogs live in the `llm-sub2api:` settings section (`$DSH_HOME/settings.yaml`, written by the web Models page); keys go through the harness credential store.
- **Provider icons** from [lobehub/lobe-icons](https://lobehub.com/icons), embedded as SVG in the settings page.

## Install

```bash
dsh plugin --profile web add dsh-sub2api
```

or, from this repository:

```bash
dsh plugin --profile web add .
```

## Configure

Open **Settings → Sub2API 模型** (or edit `$DSH_HOME/settings.yaml` directly):

```yaml
llm-sub2api:
  baseURL: http://localhost:8080/v1
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      models:
        - id: gpt-4o
    claude:
      apiKeyEnv: SUB2API_CLAUDE_API_KEY
    grok:
      apiKeyEnv: SUB2API_GROK_API_KEY
    gemini:
      apiKeyEnv: SUB2API_GEMINI_API_KEY
```

Store each key through the credentials service (the web Models page writes it, or export `SUB2API_OPENAI_API_KEY=…` etc.). A route activates only when its platform has a key; clear the key to drop the route again.

## Development

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## License

MIT
