# src/ — application code

See /AGENTS.md at repo root for conventions, hard rules, and the module map. Key dirs: app/api (route handlers per docs/API.md), lib/business (deterministic core), lib/ai (BYOK providers + receptionist tool loop), lib/client (typed API client + zustand store), components/sections (SPA sections). Money = integer cents. Org-scope every query. Never fake success.
