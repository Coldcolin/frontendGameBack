# DiffArena — backend

API, realtime and grader for DiffArena, a 1v1 frontend duel. Two contenders rebuild the same 600 × 400 target in HTML with Tailwind or plain CSS (a `<style>` block), and a pixel diff scores every render.

Node + Express + Socket.IO + MongoDB (Mongoose), with headless Chromium (Playwright) for grading. The frontend lives in its own repo and deploys to Vercel.

## Run it

```bash
npm install
npx playwright install chromium   # used by the grader
cp .env.example .env
npm run dev                       # http://localhost:4000
```

MongoDB: set `MONGODB_URI` in `.env` (local `mongod` or Atlas). If it's not set, the backend starts a throwaway in-memory MongoDB, so data resets on restart.

## How a match works

1. The host signs in with `ADMIN_PASSWORD` (a 12-hour session; changing the password signs everyone out), then picks two contenders, a target and a length, then launches the match. Until the start, only the admin link can see which target was picked. They get a private link for each player, a spectator link and an admin link.
2. The host starts the match. Both players see the target at the same moment, and the clock is server-authoritative.
3. Each player's code renders in a sandboxed iframe (opaque origin, CSP, scripts stripped). The browser diffs every render against the target, so the player sees their own score instantly. Rendered snapshots go to the server, which scores each image itself. That way the **live** score everyone else sees always matches the canvas spectators watch, and browsers never report their own number. Opponents and spectators get scores and snapshots, never source code.
4. **Submit diff check** (⌘/Ctrl + Enter) sends the code to the backend. The backend re-renders it in headless Chromium with the same reset and Tailwind runtime (plain CSS in `<style>` blocks works the same way), then scores it in two parts:
   - **Pixel score** (pixelmatch), measured from a blank canvas: `pixel = (1 − diffPixels / blankDiffPixels) × 100`, clamped to 0–100.
   - **Layout score**: is there content where the target has content (within 10 px), in roughly the right colour? It's recall × precision² against the target's ink, with 0 set at the best a flat fill can do, so painting the canvas one colour earns nothing. Without it, a close attempt with slightly misplaced text scores worse than blank and gets clamped to 0, the same as doing nothing.

   `score = 0.75 × pixel + 0.25 × layout`. A pixel-perfect render scores 100 and a blank canvas 0.
5. At time-up, the server grades each player's latest code, and the higher official score wins.

## Deploy (Render)

The backend runs on **Render** as a Docker service, since the grader needs Chromium.

**1. MongoDB Atlas.** Create a cluster and a database user. Under Network Access, allow `0.0.0.0/0`, because Render has no static outbound IPs on the free plan. Copy the connection string.

**2. Render.** Go to New → Blueprint, pick this repo, and Render reads [`render.yaml`](render.yaml) and builds the [`Dockerfile`](Dockerfile). Set:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Atlas connection string |
| `ADMIN_PASSWORD` | Password the host signs in with to set up matches (pick your own) |
| `WEB_ORIGIN` | Your Vercel URL, e.g. `https://diffarena.vercel.app` (comma-separate several) |
| `WEB_ORIGIN_PATTERN` | Optional regex for preview deploys |

Render sets `PORT`. The health check is `/api/health`. Keep the Playwright image tag in the Dockerfile in sync with the `playwright` version in `package.json`.

**3.** If the Vercel URL changes later, update `WEB_ORIGIN` on Render.

### Caveats on Render's free plan

- **Files are ephemeral.** `storage/` (uploaded targets, avatars, diff and render PNGs) is wiped on every restart and redeploy. Built-in targets re-render at boot, but uploads and results images from earlier matches break.
- **Idle instances sleep** after about 15 minutes, and the first request then takes about a minute.
- **Restarts during a match are handled.** Live matches re-arm their timer at boot, and players' browsers re-send their latest code when the socket reconnects.
- **Rate limits** are per IP, in memory, over 15 minutes: 30 match creations, 30 uploads, 10 sign-in attempts and 1500 API calls, plus 20 concurrent sockets. Tune them with the `RATE_LIMIT_*` env vars. `TRUST_PROXY=1` (set in `render.yaml`) makes the limits use the real client IP.
- **Run one instance only.** Live match state (typed code, live scores, presence) is in memory.

## Tests

```bash
npm test    # diff scoring, sanitizer, API + real Playwright grading
```
