# dsh-sub2api

[中文文档](./README.zh.md)

Connect your [sub2api](https://github.com/Wei-Shaw/sub2api) gateway to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) as model providers.

Sub2API is an AI API gateway that turns subscription quota into OpenAI-compatible endpoints. In its model, **each API key is bound to a group, and the group decides the platform** (OpenAI / Claude / Grok / Gemini) and the models that key can serve. The four provider routes (`sub2api-openai`, `sub2api-claude`, `sub2api-grok`, `sub2api-gemini`) are served by the harness's own pi-ai adapter (`dsh-llm-pi-ai`): this plugin translates its `llm-sub2api:` settings into `llm-pi-ai:` provider profiles (all sharing one **bare-host** base URL, no `/v1`), and protocol serialization, streaming, and usage accounting all live in pi-ai. The same gateway serves OpenAI, Claude, Grok, and Gemini models side by side, and the harness routes each request to the key whose group owns the requested model.

## Features

- **One base URL, four provider routes**: `sub2api-openai`, `sub2api-claude`, `sub2api-grok`, `sub2api-gemini` — each configured with its own key, registered as a live LLM provider the moment the key is set.
- **Streaming chat (backed by pi-ai)**: SSE streaming, tool calls, reasoning deltas, and token usage are mapped to the harness protocol by `dsh-llm-pi-ai`, which natively handles wire-format details like top-level `function_call` items in the Responses API.
- **Model discovery**: one-click "fetch models" calls `GET {baseURL}/models` with the key, so each route's catalog matches exactly what the sub2api group serves.
- **Reasoning effort (thinking mode)**: `reasoning_effort` is passed straight through to the gateway and adjustable right in the chat model selector; the settings page's per-model "reasoning strength" column fills each model's real levels from [models.dev](https://models.dev/) `reasoning_options` (e.g. `gpt-5.6-sol` → none/low/medium/high/xhigh/max, `deepseek-v4-flash` → low/high/max), with editable levels and an explicit opt-out.
- **Usage lookup**: "view usage" calls `GET {baseURL}/usage` and summarizes quota, balance, rate limits, and subscription windows.
- **Standards-based config**: base URL and model catalogs live in the `llm-sub2api:` settings section (`$DSH_HOME/settings.yaml`, written by the web Models page); keys go through the harness credential store.
- **Global vision / image tools**: `analyze_image` and `generate_image` stay available even when the current chat model cannot see or create images. They call a dedicated vision or image model configured on the settings page, and return a description or a workspace file path rather than injecting image blocks into a text-only session.
- **Auto Vision wrapper**: image capability for text-only models. Every registered text-only provider route gets a same-name twin (`<route>-vision`, shown as "… + 自动识图") — our own `sub2api-*` routes **and external providers** (official `deepseek-official`, `llm-pi-ai`, routes added by other plugins). Twin models carry a **`-vision` id/name suffix** (e.g. `deepseek-v4-flash-vision`) so the picker shows at a glance which models accept images; the suffix is stripped again when the call is delegated back to the base route. The twin's catalog declares `inputModalities: ['text', 'image']` so the harness attachment admission passes, and the twin's stream rewrites image blocks into vision-model transcriptions (via the configured `tools.analyze` model, cached per attachment) before delegating the text-only turn to the original route's adapter. DeepSeek stays the brain; the vision model is only the eyes. Twins follow `llm/adapters-updated` and skip names already taken by other plugins. Disable with `autoVision: false`.
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
  baseURL: http://localhost:8080
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
  tools:
    analyze:
      provider: openai
      model: gpt-4o
    generate:
      provider: openai
      model: gpt-image-1
```

Store each key through the credentials service (the web Models page writes it, or export `SUB2API_OPENAI_API_KEY=…` etc.). A route activates only when its platform has a key; clear the key to drop the route again.

### Wire protocol (automatic per group)

The gateway serves each platform group upstream through its NATIVE protocol, and pi-ai picks the endpoint automatically from the key's group — no configuration needed. Configure the **bare host** (no `/v1`): OpenAI-style endpoints get `/v1` appended automatically, and the Anthropic SDK appends `/v1/messages` itself:

| Group | Protocol used | Endpoint |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok / gemini | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

Speaking the native protocol means the gateway never has to convert chat/completions — that conversion is what drops/misaligns tool-call names and ids for parallel calls (`unknown tool ""`, `missing required property …`). To force a different endpoint for a group whose gateway does not serve it natively, declare `api` on the provider in `$DSH_HOME/settings.yaml` (advanced; no settings-page control):

```yaml
llm-sub2api:
  baseURL: http://localhost:8080
  providers:
    openai:
      apiKeyEnv: SUB2API_OPENAI_API_KEY
      api: openai-completions   # optional: openai-completions / openai-responses / anthropic-messages
      models:
        - id: gpt-4o
```

`api` accepts `openai-completions` (`/v1/chat/completions`), `openai-responses` (`/v1/responses`), or `anthropic-messages` (`/v1/messages`); omitted means the automatic group default above.

### Relationship to dsh-llm-pi-ai

This plugin no longer implements the LLM protocol layer itself: the four `sub2api-*` routes are served by `dsh-llm-pi-ai` (shipped dormant with dsh-base) through `llm-pi-ai:` settings profiles. On every `llm-sub2api:` change (and at boot) the plugin translates the bare-host base URL, per-group models, and key references into hand-declared profiles and writes them to `llm-pi-ai:`, so routes register/drop live. The settings page, model discovery (`GET /v1/models`), usage lookup (`GET /v1/usage`), the vision/image tools, and the Auto Vision twins remain this plugin's own.

> **Dependency**: the bundled `@earendil-works/pi-ai` (0.82.x) unconditionally reads `assistant.usage.totalTokens` when history contains an assistant message, but harness-reconstructed history carries no usage field, so multi-turn conversations throw `Cannot read properties of undefined (reading 'totalTokens')`. A minimal guard patch (`assistant.usage !== undefined` before counting prefix tokens) has been applied to `node_modules/@earendil-works/pi-ai/dist/utils/estimate.js` in the dsh install; re-apply it after a dsh upgrade overwrites it.

### Image input & reasoning effort (auto-filled)

Attaching an image to the session model requires that model to declare the `image` input modality — otherwise the harness refuses before sending ("model does not support images"). **Both fields are auto-filled from models.dev — no manual selection** (the model details panel shows the derived values read-only):

- **Image input**: derived from models.dev `attachment` / `modalities.input` when present (e.g. gpt-5.6-luna → text+image, deepseek-v4-flash → text); otherwise guessed from the model id (`gpt-*`, `claude-*`, `gemini-*`, `grok-*`, `glm-*`, … default to text+image). Pin a model to text-only with `input: [text]` in `$DSH_HOME/settings.yaml`.
- **Reasoning effort**: derived from models.dev `reasoning_options` when present (e.g. deepseek-v4-flash → high/max); otherwise the default low/medium/high, and models with `reasoning: false` are marked unsupported.

When the model accepts images, the request carries the image in the group's native protocol: openai → Responses `input_image`, claude → Messages `image` (base64), grok/gemini → chat-completions `image_url`.

Pick the dedicated vision / image models under **Settings → Sub2API 模型 → 全局图像工具**. Those two tools stay global: a text-only chat model can still call `analyze_image` (local file or URL) and `generate_image` (writes into the session workspace). Generation first tries `POST {baseURL}/images/generations`, then falls back to chat completions when the gateway has no images endpoint.

## Development

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## License

MIT
