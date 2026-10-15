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

