# Browser smoke check

A Playwright suite that drives a running local Docmost in a real browser. Run it before and after a change to show the change broke nothing.

## Run

```sh
pnpm install
pnpm exec playwright install chromium   # once
pnpm dev                                # or any running client + server
SMOKE_ADMIN_EMAIL=<admin email> SMOKE_ADMIN_PASSWORD=<admin password> pnpm smoke
```

Run one check: `pnpm smoke --grep "upload an image"`. Every test creates its own data and can run alone. The HTML report is in `e2e/smoke/playwright-report/`.

## Environment

| Variable | Default | Use |
|----------|---------|-----|
| `SMOKE_BASE_URL` | `http://localhost:5173` | The client address. |
| `SMOKE_ADMIN_EMAIL` | required | Admin to sign in as. Also the admin created when the instance has no workspace. |
| `SMOKE_ADMIN_PASSWORD` | required | Password for that admin. |
| `SMOKE_CHROME_PATH` | unset | Path to a Chrome binary, if Playwright's own browser cannot be downloaded. |

On an empty database the first test creates the workspace (it is skipped when one exists). The admin needs a space with the slug `general`. Email delivery is not needed: invite links are read through the API.

## What it covers

Workspace setup, page create and formatting, live editing from two browsers, image, table, reload, comment, publish to web, signed-out reading, search, Markdown export, page history, Excalidraw, trash and restore, invite and accept, space reader limits, signed-out access to a private page.

## Lessons

- Click the title before typing. After a page is created, focus lands on a menu button.
- The body editor is the second `.ProseMirror`. A third, hidden one exists.
- Type at about 25 ms per key and pause after `/`, or the slash menu and markdown shortcuts race.
- Scroll an image block into view before waiting for its `img`.
- The first page load after the client starts can take tens of seconds while the editor compiles.
