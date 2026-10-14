# Licensing — AI Secretary

License data below was extracted from the installed packages' own `package.json` metadata
(`node_modules/**/package.json`) for the versions resolved in this build, not copied from memory.
The dependency manifest is inherited from the sandbox scaffold; packages not imported by
application code are marked *(scaffold)*. Removing unused scaffold dependencies is cleanup work,
not a licensing constraint.

## 1. Repository license

This repository does not yet ship its own `LICENSE` file. Until one is added, treat the source as
"all rights reserved by the operator" and do not redistribute. A permissive self-host-friendly
license decision is **Planned** (tracked in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)).

## 2. Core dependency licenses

| Dependency | Version (resolved) | License | Used in this build |
|---|---|---|---|
| next | 16.1.3 | MIT | Yes (App Router, API routes) |
| react / react-dom | 19.2.3 | MIT | Yes |
| prisma / @prisma/client | 6.19.2 | Apache-2.0 | Yes (DB layer) |
| nodemailer | 10.1.1 | **MIT-0** | Yes (SMTP connector: email test + send) |
| @types/nodemailer | 8.0.2 | MIT | Yes (dev types for nodemailer) |
| zod | 4.3.5 | MIT | Yes (validation) |
| tailwindcss | 4.1.18 | MIT | Yes |
| lucide-react | 0.525.0 | ISC | Yes (icons) |
| sonner | 2.0.7 | MIT | Yes (toasts) |
| date-fns | 4.1.0 | MIT | Yes (dates) |
| framer-motion | 12.26.2 | MIT | Yes (animations) |
| zustand | 5.0.10 | MIT | Yes (client state) |
| clsx / tailwind-merge | 2.1.1 / 3.4.0 | MIT | Yes (via shadcn `cn()`) |
| class-variance-authority | 0.7.1 | Apache-2.0 | Yes (via shadcn variants) |
| **z-ai-web-dev-sdk** | 0.0.18 | ISC label, **proprietary platform SDK** | Yes — **sandbox only** |

### z-ai-web-dev-sdk — important caveat

The `z-ai-web-dev-sdk` is a **proprietary SDK provided by the Z.ai sandbox platform** that ships
this development environment. Consequences:

- It is **sandbox-only**: applications must not depend on it outside this environment.
- It is licensed under platform terms, not the open licenses above; do not redistribute it.
- In production/self-hosted deployments it must be **replaced by BYOK adapters** — the Ollama and
  OpenAI-compatible adapters in `src/lib/ai` are the drop-in seams, selected via
  `ProviderConfig` without code changes.

## 3. UI component licenses

| Component set | License | Notes |
|---|---|---|
| shadcn/ui components (`src/components/ui/*`) | MIT | shadcn/ui is not a runtime dependency — components are **copied into this repo** under MIT and are part of this codebase |
| Radix UI primitives (`@radix-ui/react-*`) | MIT | Headless primitives under the shadcn components |
| embla-carousel-react 8.6.0 | MIT | (scaffold) |
| cmdk 1.1.1 | MIT | (scaffold) |
| vaul 1.1.2 | MIT | (scaffold) |
| react-resizable-panels 3.0.6 | MIT | (scaffold) |

## 4. Remaining scaffold dependencies

| Dependency | Version | License |
|---|---|---|
| @dnd-kit/core / sortable / utilities | 6.3.1 / 10.0.0 / 3.2.2 | MIT |
| @hookform/resolvers | 5.2.2 | MIT |
| @mdxeditor/editor | 3.52.3 | MIT |
| @reactuses/core | 6.1.9 | **Unlicense** (public domain) |
| @tanstack/react-query | 5.90.19 | MIT |
| @tanstack/react-table | 8.21.3 | MIT |
| input-otp | 1.4.2 | MIT |
| next-auth | 4.24.13 | **ISC** (present but unused by this build's auth) |
| next-intl | 4.7.0 | MIT |
| next-themes | 0.4.6 | MIT |
| react-day-picker | 9.13.0 | MIT |
| react-hook-form | 7.71.1 | MIT |
| react-markdown | 10.1.0 | MIT |
| react-syntax-highlighter | 15.6.6 | MIT |
| recharts | 2.15.4 | MIT |
| sharp | 0.34.5 | Apache-2.0 |
| tailwindcss-animate / tw-animate-css | 1.0.7 / 1.4.0 | MIT |
| uuid | 11.1.0 | MIT |
| bun-types, eslint, eslint-config-next, typescript | dev | MIT |

## 5. AI model licenses (operator responsibility)

This project **redistributes no model weights**. When an operator runs models locally (e.g. via
Ollama) or via a cloud provider, the model's own license applies. Common examples — verify before
production use:

| Model family | Typical license | Operator duty |
|---|---|---|
| Llama (Meta) | **Llama Community License** (use-based restrictions, attribution, naming requirements) | Read the license for your version; some commercial terms apply |
| Mistral | **Apache-2.0** (most releases; verify per model) | Standard Apache-2.0 compliance |
| Gemma (Google) | **Gemma Terms of Use** (prohibited-use policy) | Accept terms via download channel; follow use policy |
| Qwen, Phi, others | Varies per model card | Check the model card before use |

Cloud providers (OpenAI, Anthropic, etc.): the operator's API key = the operator's account and
terms. Usage, data-retention, and privacy commitments are between operator and provider. The
software sends prompts/FAQ context to whichever provider the operator configures — **BYOK means
BYO-terms**.

## 6. Compliance summary

- All bundled open-source dependencies are MIT / MIT-0 / ISC / Apache-2.0 / Unlicense — compatible with
  commercial self-hosting; no copyleft (GPL/AGPL) runtime dependencies are present.
- Retain upstream copyright notices (standard practice: keep `LICENSE` files reachable in
  distributed artifacts).
- No model weights, no proprietary SDK redistribution, no third-party analytics in the tree.
