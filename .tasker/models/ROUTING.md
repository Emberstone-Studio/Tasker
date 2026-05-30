# Tasker Model Routing Guide

Fast delegation decisions for Claude Code acting as Tasker's orchestrator. Read the
full dossier only when a routing decision is non-obvious; this guide covers the common
cases. Covers 17 models across Anthropic, OpenAI, Google, xAI, Meta, Mistral, and DeepSeek.

> Unverified at creation (2026-05-30): `gpt-5-4`, `gpt-5-3-codex`, `gemini-3-1-pro`,
> `gemini-3-flash`. Confirm the model string resolves before routing real traffic; fall
> back to the verified sibling (`gpt-5`, `gemini-2.5-pro`) if it does not.
>
> Host-dependent config: `llama-3-3` has `null` endpoint/auth — it depends on the host
> (Ollama, Groq, Together, vLLM) and must be configured per deployment.

## 1. Model by task category

| Task category | First choice | Cheaper fallback |
| --- | --- | --- |
| Architecture, ambiguous judgment, final review | **Claude Opus 4.6** | Claude Sonnet 4.6 |
| Everyday coding / implementation | **Claude Sonnet 4.6** | gpt-5-mini / Mistral Large |
| Pure code gen / bug fix / tests | **gpt-5-3-codex** | Codestral / gpt-5-mini |
| Inline code completion (FIM, IDE-style) | **Codestral** | — |
| General reasoning + math | **GPT-5** | DeepSeek R1 (cheap) / Grok 3 |
| Deep reasoning / logic at low cost | **DeepSeek R1** | grok-3-mini |
| Current-events-flavored reasoning | **Grok 3** | grok-3-mini |
| Long-context / large-document synthesis | **Gemini 3.1 Pro** / Gemini 2.5 Pro | Gemini 3 Flash |
| Multimodal (image/video/audio) | **Gemini 3.1 Pro** | Gemini 3 Flash / Grok 3 |
| Classification / extraction / routing | **Claude Haiku 4.5** | Gemini 3 Flash / gpt-5-mini |
| High-volume summarization over big inputs | **Gemini 3 Flash** | Claude Haiku 4.5 |
| Private / self-hosted / data-residency work | **Llama 3.3** (local) | Mistral Large (EU-hosted) |
| Multilingual (European languages) | **Mistral Large** | Llama 3.3 |

## 2. Models that work well in sequence

- **Gemini drafts → Opus edits.** Gemini Pro/Flash generate first drafts over large or
  multimodal inputs cheaply; Opus tightens verbosity, fixes format, and fact-checks.
  The highest-leverage pairing.
- **DeepSeek R1 reasons → Opus/Sonnet packages.** R1 produces cheap deep reasoning;
  strip its trace and have a Claude model turn the answer into clean, formatted output.
- **Codestral/Codex generates → Opus reviews.** Fast code generation, then Opus as the
  final correctness and edge-case reviewer.
- **Haiku/Flash fan-out → Sonnet/Opus reduce.** Cheap models extract or classify in
  parallel; a stronger model synthesizes the aggregate.
- **Opus plans → Sonnet/Llama/Mistral executes.** Opus decomposes ambiguous work into
  concrete subtasks; a cheaper model runs each.

## 3. Pairings to avoid

- **DeepSeek R1 in any tool-use / function-calling chain** — it has weak-to-no tool use.
  Route agentic legs to GPT-5, Claude, Mistral, or Grok instead.
- **Few-shot prompting into DeepSeek R1** — examples and "think step by step" *degrade*
  its reasoning. Any upstream step that injects exemplars must be stripped before R1.
- **Two looser-format models chained (e.g. Gemini → Llama, or Grok → Codestral)** with no
  Claude/GPT pass between them — format drift compounds. Insert a strict-format reviewer.
- **Merging GPT, Grok, and Claude prose without a normalizing pass** — three distinct
  house styles read as inconsistent. One model should own the final voice.
- **Codestral or Codex for prose / product judgment** — wrong specialization.
- **Any fast tier (Haiku, Flash, gpt-5-mini, grok-3-mini) for a multi-step reasoning leg.**
  Keep fast-tier calls atomic.

## 4. Cost-conscious routing

Handle these on fast/cheap tiers (Haiku 4.5, Gemini 3 Flash, gpt-5-mini, grok-3-mini,
Llama 3.3, Codestral) with no meaningful quality loss, provided each call is atomic and the
output format is explicit with an example:

- classification, labeling, routing decisions
- field extraction and format conversion
- short summaries of single documents
- mechanical refactors and inline code completion (Codestral)
- first drafts that a stronger model will edit anyway

For **cheap deep reasoning**, DeepSeek R1 is the standout: near-frontier logic/math at low
cost — accept the latency and strip its reasoning trace. For **private/local** work, Llama
3.3 keeps data on your own host.

Escalate to **Sonnet 4.6** when a task needs reasoning but not deep judgment, and reserve
**Opus 4.6** for genuine ambiguity, architecture, and the final correctness review where a
mistake is expensive. Default rule: start at the cheapest tier that can plausibly succeed,
and escalate only the legs that fail review.
