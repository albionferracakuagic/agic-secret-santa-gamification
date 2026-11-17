# Local development

## Prerequisites
- Node >= 24, npm, git. No database or mail server needed (PGlite + console email).

## Setup
```
npm ci
cp .env.example .env      # Windows: copy .env.example .env
npm run dev               # server :3000, web (Vite) :5173
```
The server loads the repo-root `.env` outside production; real environment variables win over file values, and empty values (`KEY=`) count as unset. Open <http://localhost:5173>.

`BETTER_AUTH_URL` must equal the URL in the browser's address bar (default `http://localhost:5173`). Other modes: single-port (`http://localhost:3000` + `WEB_DIST=apps/web/dist` after a build), or phones on LAN (`http://<LAN-IP>:5173`, run vite with `--host`).

## Signing in (magic link)
With `EMAIL_TRANSPORT=console` nothing is sent; the link is printed in the **server console**:

```
Sign in: http://localhost:5173/api/auth/magic-link/verify?token=...
```
Open it in the browser. Links are single-use, expire after 10 minutes, and requests are limited to 5 per minute. Production uses Azure Communication Services Email via managed identity (`EMAIL_TRANSPORT=acs`, verified sender domain).

## Data
- Seed demo data: `npm run seed -w @santa/db`
- Reset: stop the server and delete `apps/server/.data`

## Troubleshooting
- `403 INVALID_ORIGIN`: `BETTER_AUTH_URL` differs from the browser URL (host and port); fix `.env` and restart the server.
- Port in use: stop the other process on 3000/5173 or change `PORT`.
- First start can take ~30 s (PGlite init and migrations).
