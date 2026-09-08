# dsh-sub2api

[中文文档](./README.zh.md)

Connect your [sub2api](https://github.com/Wei-Shaw/sub2api) gateway to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) as model providers.

Sub2API is an AI API gateway that turns subscription quota into OpenAI-compatible endpoints. In its model, **each API key is bound to a group, and the group decides the platform** (OpenAI / Claude / Grok) and the models that key can serve. The three provider routes (`sub2api-openai`, `sub2api-claude`, `sub2api-grok`) are served by the harness's own pi-ai adapter (`dsh-llm-pi-ai`): this plugin translates its `llm-sub2api:` settings into `llm-pi-ai:` provider profiles (all sharing one **bare-host** base URL, no `/v1`), and protocol serialization, streaming, and usage accounting all live in pi-ai. The same gateway serves OpenAI, Claude, and Grok models side by side, and the harness routes each request to the key whose group owns the requested model.

## Features

- **Image generation**: select a generation model in settings. `generate_image` saves images to the workspace and returns an inline attachment. The separate image-analysis tool and its model selector have been removed.

- **One base URL, three provider routes**: `sub2api-openai`, `sub2api-claude`, `sub2api-grok` — each configured with its own key and at least one model, registered as a live LLM provider as soon as both are set.
- **Streaming chat (backed by pi-ai)**: SSE streaming, tool calls, reasoning deltas, and token usage are mapped to the harness protocol by `dsh-llm-pi-ai`, which natively handles wire-format details like top-level `function_call` items in the Responses API.
- **Model discovery**: one-click "fetch models" calls `GET {baseURL}/v1/models` with the key, so each route's catalog matches exactly what the sub2api group serves.
- **Reasoning effort (thinking mode)**: `reasoning_effort` is passed straight through to the gateway and adjustable right in the chat model selector; the settings page's per-model "reasoning strength" field fills each model's real levels from [models.dev](https://models.dev/) `reasoning_options` (e.g. `gpt-5.6-sol` → none/low/medium/high/xhigh/max, `deepseek-v4-flash` → low/high/max), editable in the settings page; `reasoningEfforts: []` opts a model out.
- **Usage lookup**: "view usage" calls `GET {baseURL}/v1/usage` and summarizes quota, balance, rate limits, and subscription windows.
- **Standards-based config**: base URL and model catalogs live in the `llm-sub2api:` settings section (`$DSH_HOME/settings.yaml`, written by the web Models page); keys go through the harness credential store.
- **Provider icons** from [lobehub/lobe-icons](https://lobehub.com/icons), embedded as SVG in the settings page.

## Install

Requires DeepSeek Harness **0.1.2-rc.1 or later**; typecheck, build, and compatibility tests also pass against **0.1.3-alpha.2**. This version uses the settings service’s `installSection` API and the `dsh-client-ui-renderer` browser service; `dsh-client-runtime` is no longer required.

```bash
dsh plugin --profile web add @godd6366/dsh-sub2api
```

or, from this repository:

```bash
dsh plugin --profile web add .
```

## Configure

Open **Settings → Sub2API 模型** (or edit `$DSH_HOME/settings.yaml` directly):

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
    generate:
      provider: openai
      model: gpt-image-1
```

Store each key through the credentials service (the web Models page writes it, or export `SUB2API_OPENAI_API_KEY=…` etc.). A route activates only when its platform has a key and at least one model; clear the key (or empty the model list) to drop the route again.

### Wire protocol (automatic per group)

The gateway serves each platform group upstream through its NATIVE protocol, and pi-ai picks the endpoint automatically from the key's group — no configuration needed. Configure the **bare host** (no `/v1`): OpenAI-style endpoints get `/v1` appended automatically, and the Anthropic SDK appends `/v1/messages` itself:

| Group | Protocol used | Endpoint |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

Speaking the native protocol means the gateway never has to convert chat/completions — that conversion is what drops/misaligns tool-call names and ids for parallel calls (`unknown tool ""`, `missing required property …`). To force a different endpoint for a group whose gateway does not serve it natively, declare `api` on the provider in `$DSH_HOME/settings.yaml` (advanced; no settings-page control):

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      api: openai-completions   # optional: openai-completions / openai-responses / anthropic-messages
      models:
        - id: gpt-5.6-sol
```

`api` accepts `openai-completions` (`/v1/chat/completions`), `openai-responses` (`/v1/responses`), or `anthropic-messages` (`/v1/messages`); omitted means the automatic group default above.

### Relationship to dsh-llm-pi-ai

This plugin no longer implements the LLM protocol layer itself: the three `sub2api-*` routes are served by `dsh-llm-pi-ai` (shipped dormant with dsh-base) through `llm-pi-ai:` settings profiles. On every `llm-sub2api:` change (and at boot) the plugin translates the bare-host base URL, per-group models, and key references into hand-declared profiles and writes them to `llm-pi-ai:`, so routes register/drop live. The settings page, model discovery (`GET /v1/models`), usage lookup (`GET /v1/usage`), the image-generation tool remain this plugin's own.

> **Dependency note (pi-ai multi-turn guard)**: pi-ai's `AssistantMessage.usage` is required in its types and its prefix-token estimation dereferences it. The harness path is already safe: `dsh-llm-pi-ai` attaches a zero `Usage` to every reconstructed assistant message. This plugin still applies a defensive guard at boot (`assistant.usage !== undefined` before counting prefix tokens) to `@earendil-works/pi-ai/dist/utils/estimate.js` inside the dsh install, protecting other callers that build pi-ai contexts without `usage`. The patch is idempotent and is re-applied automatically after a dsh upgrade; on a read-only install run `node scripts/patch-pi-ai.mjs` manually.
>

### Image input & reasoning effort

Attaching an image to the session model requires that model to declare the `image` input modality — otherwise the harness refuses before sending ("model does not support images"). **Both fields are editable in model details**: select image input and enter comma-separated reasoning levels, or disable reasoning. models.dev fills missing values without overriding manual choices:

- **Image input**: derived from models.dev `attachment` / `modalities.input` when present (e.g. gpt-5.6-luna → text+image, deepseek-v4-flash → text); otherwise guessed from the model id (`gpt-*`, `claude-*`, `gemini-*`, `grok-*`, `glm-*`, … default to text+image). Pin a model to text-only with `input: [text]` in `$DSH_HOME/settings.yaml`.
- **Reasoning effort**: derived from models.dev `reasoning_options` when present (e.g. deepseek-v4-flash → high/max); otherwise the default low/medium/high, and models with `reasoning: false` are marked unsupported.

When the model accepts images, the request carries the image in the group's native protocol: openai → Responses `input_image`, claude → Messages `image` (base64), grok → chat-completions `image_url`.


## Development

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## License

MIT
