# Secret Santa Games

Mobile-first PWA for Secret Santa events: organizer console, participant app, public display; realtime, privacy-by-projection. Spec: `doc/Secret_Santa_Games_Functional_Requirements.md`. Decisions: `doc/adr/`. Local setup: [`doc/local-development.md`](doc/local-development.md).

## Layout

| Path                 | Content                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `apps/web`           | React 19 + Vite PWA (`/o` `/e` `/d` `/j`), i18next EN/IT, Tailwind v4 |
| `apps/server`        | Fastify (+ Socket.IO later); REST, realtime, jobs                     |
| `packages/contracts` | zod DTOs and role output schemas                                      |
| `packages/domain`    | pure logic (phases, ranking, `canPublish()`)                          |
| `packages/db`        | Drizzle schema/migrations                                             |
| `e2e`                | Playwright                                                            |
| `infra`              | Bicep (later)                                                         |

## Commands (Node >= 24)

```
npm install
npm run dev         # server :3000 + web :5173 (proxied)
npm run typecheck
npm run lint
npm test            # builds TS refs, then Vitest
npm run build
npm run test:e2e    # first time: npx playwright install chromium
```
