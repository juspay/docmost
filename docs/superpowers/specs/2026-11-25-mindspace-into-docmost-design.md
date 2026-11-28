# Mindspace into Docmost: design

Date: 2026-11-25
Status: draft, not yet approved. On 2026-11-25 Sachin asked for the implementation plan to be written from it.
Plan: `docs/superpowers/plans/2026-11-25-mindspace-into-docmost-plan.html`

The plan was reviewed adversarially after this document was written. Where the plan's
"Deviations from the spec" table differs from this document, the plan is right. The main
differences: no copy marker is stored on a block; spreadsheet rows and columns have
stable ids; part 7 also depends on part 6; the migration writes through repositories;
public links get an expiry (part 8 of the plan) instead of being dropped at cut-over.
Source app: https://github.com/sinha-sahil/mindspace (read at commit `149db12`)
Target: this repository (`juspay/docmost`, a fork of `docmost/docmost`, at `c956adaa`)

## 1. Intent

Mindspace is retired. Docmost becomes the one tool. People who use mindspace today
must be able to do the same work in docmost, and their existing content moves over.

Docmost keeps its own documents, comments, sharing, workspaces and search. Only what
docmost lacks is built.

## 2. Goals

1. A **whiteboard block** with live multi-user drawing, live cursors and presence.
2. A **to-do board block**: cards on a pan/zoom canvas, nested items, effort / time /
   priority ratings, sort and hide-done views.
3. A **spreadsheet block**: tabs, formulas, formatting, merge, freeze, fill handle,
   paste from Google Sheets or Excel.
4. **Split view**: two pages side by side.
5. **Passkey login** as an option, alongside the existing password login. Passwords
   stay and nobody is required to use a passkey.
6. **Personal access tokens** and a **hosted MCP endpoint**, written in the
   open-source part of the codebase.
7. A **migration tool** that moves mindspace data into docmost, and a cut-over.
8. **Public links that can expire** (added 2026-11-25, see Q6): an expired link stops
   working for anonymous visitors only and can be renewed.

## 3. Non-goals

- Mindspace's markdown editor, its Mono look, accent colour, what's-new popup, admin
  allowlist page, magic-link login and PostHog wiring. Docmost's equivalents stay.
- Version history for the contents of the three new blocks (first release).
- Searching inside the three new blocks (first release). Mindspace has neither.
- General REST API access with tokens. Tokens open the MCP endpoint only.
- The local stdio MCP binary in `mindspace/mcp`. Hosted HTTP only.
- Converting existing docmost Excalidraw diagrams to live whiteboards.
- Contributing any of this to upstream docmost.

## 4. Anti-goals

These make the work a failure even if it runs.

- **Deriving from Enterprise code.** Nothing may be copied or adapted from
  `apps/client/src/ee`, `apps/server/src/ee`, `packages/ee` or `packages/base-formula`.
  Builders do not open those folders.
- **Losing edits** when two people work in the same block at once.
- **Widening access** during migration. Nobody may see more than they could in mindspace.
- **Large edits to upstream files.** Each one becomes a conflict on every upstream merge.

## 5. Constraints (verified in the code)

| Fact | Where | Consequence |
|---|---|---|
| Stack: React 19 + Mantine 9, NestJS 11 on Fastify, Kysely migrations, Hocuspocus 4.9 + Yjs, pnpm + nx. Server tests are jest `*.spec.ts`, client tests are vitest. | `package.json`, `apps/*/package.json` | Mindspace's Svelte UI is rewritten in React. Use what docmost uses. |
| The fork has no commits of its own yet. Upstream is very active. | `git rev-list --count upstream/main..HEAD` = 0 | New code goes in new files. Upstream files are touched only at the registration points listed in section 10. |
| Duplicating a page and restoring history both rebuild the page from its stored JSON. | `apps/server/src/core/page/services/page.service.ts:968`, `apps/server/src/collaboration/collaboration.handler.ts:114` | Any block data kept outside that JSON needs its own copy step. |
| The sync server maps a document name to a page id by splitting on `.`. Its auth and persistence code assume every document is a page. | `apps/server/src/collaboration/collaboration.util.ts:219`, `extensions/authentication.extension.ts`, `extensions/persistence.extension.ts` | Block documents need a guarded branch in those two files. |
| Without the Enterprise module every licensed feature reports "off". | `apps/server/src/integrations/environment/license-check.service.ts:29-50` | New features must not go through that gate. |
| Every `api_key` JWT is routed to the Enterprise service, which is absent. | `apps/server/src/core/auth/strategies/jwt.strategy.ts:100-123` | Our tokens are a separate kind, not `api_key` JWTs. |
| The path `/mcp` is reserved for the Enterprise MCP route. | `apps/server/src/main.ts:57` | Our endpoint uses a different path. |
| A new login method gets a normal session by calling `SessionService.createSessionAndToken(user)` and setting the `authToken` cookie. | `apps/server/src/core/session/session.service.ts:41-58`, `apps/server/src/core/auth/auth.controller.ts:222-230` | Passkey login reuses this. |
| The page editor uses app-wide state, and many feature files read the page from the URL. | `pageEditorAtom` in 8 files; 39 feature files call `useParams` | Two full editors in one React tree would need wide changes to upstream files. |
| The server allows same-origin framing. | `apps/server/src/common/helpers/security-headers.ts:8` | A second pane can be an iframe. |
| Mindspace's to-do and spreadsheet logic is plain TypeScript with no Svelte, DOM or Supabase imports, and has tests. | `board.ts`, `sheets/model.ts`, `ops.ts`, `engine.ts`, `style.ts` and their `*.test.ts` | That logic can be reused as is, subject to the licence point below. |
| Page-level restrictions are enforced in open-source code, but nothing in open-source code creates one from scratch; only copying on duplicate exists. Managing them is an Enterprise feature. | `apps/server/src/database/repos/page/page-permission.repo.ts` (`canUserEditPage`, `copyRestrictions`), `page.service.ts:992` | Block access must go through the same check as page access. Migration cannot rely on a supported way to grant one person one page. See Q4. |
| The sync token is issued per user, not per document. The sync server looks up the page and checks access itself. | `apps/server/src/core/auth/services/token.service.ts:45`, `authentication.extension.ts:75-110` | The existing token works for block documents once the server resolves the block to its page. |
| The server already edits page content through the sync server. | `apps/server/src/collaboration/collaboration.handler.ts:92` (`updatePageContent`) | MCP and migration writes use this path, and block documents get an equivalent. |
| **The mindspace repository has no licence file.** | `gh repo view`: `licenseInfo: null` | Reusing its code needs the author's permission. Sachin confirmed on 2026-11-25 that permission exists (Q1). |

## 6. Approaches

Three ways to place whiteboards, to-do boards and spreadsheets were considered.

- **A. New kinds of page** in the space tree, next to documents. Inherits permissions,
  sharing and trash. Touches core page code. *Recommended by Claude.*
- **B. Blocks inside documents**, like today's Excalidraw block. Least change to core
  code. No page of its own for a whiteboard; large sheets must not bloat the document.
- **C. A separate projects area** with its own tables, sidebar and sharing. Closest to
  mindspace, but duplicates what docmost has.

**Decision (Sachin): B, blocks inside documents.**

The rest of this document designs B so that its two known weaknesses are handled: a
block can open to the full window, and block data is stored outside the document so
large boards and sheets do not slow down typing.

## 7. Decisions made by Sachin

- The goal is to retire mindspace and migrate its data.
- Tokens and MCP are built independently in the open-source part, not licensed.
- The three new things are blocks inside documents.

Everything in sections 8 and 9 is Claude's call unless it says otherwise.

## 8. Design

### 8.1 Live blocks: the shared foundation

A **live block** is a block in a document whose content is kept in its own small
synced document instead of inside the page.

- The block node in the page holds only: `blockId`, `kind` (`whiteboard`, `todo`,
  `sheet`), a title, a display height, and for whiteboards a preview image.
- A new table `live_blocks` holds: `id`, `workspace_id`, `page_id`, `kind`, `ydoc`
  (binary), `snapshot` (plain JSON, written each time the block is stored),
  timestamps, `deleted_at`.
- The block syncs through the existing Hocuspocus server under the document name
  `block.<blockId>`. Live cursors and presence use Hocuspocus awareness.
- **Access to a block is access to its page.** The server resolves a block to the
  page in its `page_id` and runs the same access check the sync server runs for
  pages, page restrictions included. Read-only page access gives a read-only block.
  When page access is revoked, open block connections are dropped, the same as page
  connections are today. The existing per-user sync token is used; no new token.
- **A block belongs to one page for its whole life.** `page_id` never changes.
  Moving the page to another space keeps the page id, so nothing changes. Cut and
  paste inside the same page keeps the `blockId`. Pasting into a different page
  makes a clone that belongs to the new page, and needs read access to the source page.
- **Public and read-only reads are checked against the page content.** The snapshot
  call returns a block only if its `blockId` is in the current content of a page the
  caller may read (for a share link: a page that share covers). A block id alone
  never grants a read.
- Each block renders inline at a set height and has an **Open** control that fills
  the window. A link with `?block=<blockId>` opens the page with that block already
  full-window. This is what gives migrated mindspace projects their canvas-first feel.

Why not keep the data inside the page:

- Inside the page's node tree: every drag of a shape or edit of a cell becomes a
  document change. A sheet with thousands of cells would make the page slow.
- As extra data in the page's own sync document: lost on duplicate and history
  restore, because those rebuild from JSON.

What storing data outside the page obliges us to build:

| Situation | Behaviour |
|---|---|
| Page is duplicated or copied to another space | Each live block is cloned to a new `blockId`, in the same step that copies attachments today. |
| A block is copied and pasted | The pasted block gets a new `blockId` and a cloned copy. Two blocks never share one document. |
| A block is deleted from the page | Its row is kept, so undo works. No clean-up job in the first release. |
| Page is trashed or deleted | Blocks follow the page. |
| Page history is restored | The block keeps its current content. Block content is not versioned. |
| Read-only viewer or public share link | No live connection. The block renders from `snapshot`, fetched by a REST call that checks the page or the share. |
| Export to Markdown, HTML or PDF | Whiteboard as its preview image, to-do board as a checklist, sheet as a table of displayed values. Rendered on the server from `snapshot`. |
| Block inside a synced block (transclusion) | Not allowed in the first release. |

New code lives in a new shared package, `packages/live-blocks` (board logic, sheet
engine, Yjs mappings, snapshot builders), used by client and server. The three node
definitions go in a new folder in `packages/editor-ext`, following the existing
pattern where the package defines the node and the client supplies the view.

### 8.2 Whiteboard block

- A **new block**, `whiteboard`. The existing Excalidraw block is left untouched and
  keeps working for old diagrams. Its slash-menu entry is replaced by "Whiteboard" so
  new inserts are live.
- Uses the Excalidraw version docmost already pins.
- Elements are stored one entry per element. On a conflict the element with the
  higher `version` wins, with `versionNonce` as the tie-break. This is mindspace's
  rule (`collab.svelte.ts:336-372`).
- Images are stored as docmost attachments, not inline in the scene.
- Presence: an avatar stack of who is in the board, live pointers with name and colour.
- Inline, the block shows a static preview image. The live session runs only while
  the board is open. A page with many boards therefore opens no extra connections
  until one is opened.
- The preview image is saved by an editor's browser when the board goes idle or is
  closed. A board that has no preview yet (made by MCP or by migration) is drawn in
  the viewer's browser from `snapshot`; if that viewer can edit, their browser saves
  the preview. The server cannot draw a whiteboard, so an export of a board with no
  preview shows its title and a link instead of an image.

### 8.3 To-do board block

- Reuses mindspace's `board.ts` data model and rules (subject to Q1): cards with a
  position and width; items that are tasks or section headings, nested to any depth;
  effort, time and priority ratings 0 to 3 on items and on cards; ticking a parent
  ticks its children; sort by manual / effort / time / priority; hide done.
- Keyboard: Enter adds a sibling, Tab and Shift+Tab nest and un-nest, Cmd/Ctrl+Enter
  ticks.
- Card positions, sort and hide-done are shared. Pan and zoom are per person, and a
  board opens fitted to its content.
- Two people editing different items or cards at once both keep their edits. Two
  people editing the text of the same item: the last one wins.
- Unlike mindspace, the board is live for several editors.

### 8.4 Spreadsheet block

- Reuses mindspace's `model.ts`, `ops.ts`, `engine.ts` and `style.ts` (subject to
  Q1): tabs; cells that store only raw input; 86 formula functions; A1, `$A$1`, range
  and cross-sheet references; cycle detection; number formats; merges; frozen rows
  and columns; up to 5,000 rows by 702 columns.
- Computed values are never stored. Each client computes them. The server computes
  them for `snapshot`, export and MCP, using the same engine.
- The grid UI (3,584 lines of Svelte in mindspace) is rewritten in React. This is the
  largest single piece of the whole project.
- Two people editing different cells both keep their edits. Same cell: last one wins.
  Inserting or deleting rows and columns is applied as one whole-sheet change.
- This is separate from docmost's Enterprise "bases" and its formula package. It does
  not import from them.

### 8.5 Split view

- "Open in split view" on a page's tree menu and in the page header.
- The right pane is an **iframe** of the same docmost page with `?pane=1`, which
  hides the sidebar and top bar. Both panes are fully editable and live.
- The divider is draggable and the ratio is remembered per browser. The address bar
  carries the second page, so a split survives reload and can be shared.
- Hidden on narrow screens.
- Why an iframe: section 5 shows two editors in one tree would need wide changes to
  upstream files. Cost: the second pane is a second copy of the app in memory.

### 8.6 Passkey login

- Libraries: `@simplewebauthn/server` and `@simplewebauthn/browser`, as in mindspace.
- New table `user_passkeys`: credential id, public key, counter, transports, device
  type, backed-up flag, name, created and last-used times, user and workspace.
- New server module `core/passkey`. Register (signed-in only), sign in (public),
  list, rename, delete. Challenges are held in Redis for five minutes.
- The passkey site identity is the host name of the installation's configured
  `APP_URL`. One domain per installation. Changing the domain invalidates passkeys.
- Sign-in requires user verification. After the assertion is verified it applies the
  same checks as password login (disabled user, SSO enforcement, email verification),
  then calls `SessionService.createSessionAndToken(user)`, sets the `authToken`
  cookie with the same flags, and writes the login audit event.
- UI: a "Sign in with a passkey" button on the login page; a Passkeys page under
  account settings.
- A passkey sign-in counts as strong sign-in. It does not ask for a second factor.
  (Docmost's two-factor feature is Enterprise and is not present in this build.)
- Mindspace passkeys cannot be moved: a passkey is bound to the site's domain.
  People register a new one in docmost.

### 8.7 Personal access tokens

- New table `personal_access_tokens`: name, SHA-256 hash of the token, a short
  display prefix, scope (`read` or `read+write`), expiry, last-used time, revoked
  time, user and workspace. The raw token is shown once.
- Opaque random tokens, not JWTs. This keeps them clear of the Enterprise `api_key`
  path. The existing `api_keys` table is not used.
- Accepted only by the MCP endpoint. A token acts as its user, with that user's
  permissions.
- UI: an "Access tokens" page under account settings, at a new route. The existing
  Enterprise API-keys pages are not touched.

### 8.8 MCP endpoint

- One stateless HTTP endpoint under `/api/`, not at the reserved `/mcp`. Bearer token
  auth. Plain JSON responses.
- An environment switch turns it off for the whole installation.
- Every tool runs the same permission checks as the user's own requests. A
  read-only token cannot call a tool that writes.
- Writes go through the sync server, so people with the page or block open see the
  change live and nothing is overwritten. Page content uses the existing
  `updatePageContent` path. Block content uses a new server-side apply path of the
  same kind in the live-block service. Neither writes to the database directly.
- Tools, mapped from mindspace's fifteen:

| Docmost tool | Replaces |
|---|---|
| `list_spaces` | `list_workspaces` |
| `list_pages` (optional filter by block kind) | `list_projects`, `list_documents` |
| `create_whiteboard` (optional Excalidraw scene) | `create_whiteboard_project` |
| `create_todo_board` | `create_todo_project` |
| `create_sheet` | `create_sheet_project` |
| `get_sheet`, `set_sheet_cells` | same names |
| `create_page_from_markdown` | `create_doc_project`, `upload_markdown` |
| `update_page_markdown` (keeps comment threads) | `update_markdown` |
| `get_page_comments` (optionally including child pages, filter open / resolved) | `get_document_comments`, `get_project_comments` |
| `reply_to_comment`, `resolve_comment` | same names |

  The three `create_*` block tools make a new page holding the block, or add the
  block to an existing page.
- `update_page_markdown` replaces a page's content. Comment highlights are put back
  by finding each comment's quoted text in the new content. A comment whose text is
  gone stays in the comments panel without a highlight.

### 8.9 Migration and cut-over

A command-line tool in the server app. It reads the mindspace database read-only
and writes through docmost's own services, so docmost's rules apply.

Source format. Mindspace is a Supabase Postgres database. Its schema is in the
mindspace repository under `supabase/migrations/0001` to `0016`. There is no Yjs data.

- People are rows in Supabase's `auth.users`.
- `workspaces` (with `owner_id`) and `workspace_members` (role `editor` or `viewer`).
- `projects`: `kind` is `whiteboard`, `doc`, `todo` or `sheet`; `scene` is JSON;
  `position`; `visibility` is `private` or `link`; `link_expires_at`.
  - whiteboard `scene`: Excalidraw JSON `{elements, appState, files}`, images inline.
  - todo `scene`: the `TodoBoard` type in `board.ts:16-72`.
  - sheet `scene`: the `SheetBook` type in `sheets/model.ts:93-123`.
- `documents`: markdown text in `content`, ordered by `position`, one doc project each.
- `document_comments`: a thread root has `anchor_quote`, `anchor_prefix`,
  `anchor_suffix`, `anchor_start`, `anchor_end`; replies point to the root with
  `parent_id`, one level deep; `resolved_at` and `resolved_by` sit on the root.
- `project_shares`: one email and a role per project.

| Mindspace | Docmost |
|---|---|
| Person (by email) | Existing docmost user with the same email. See Q3 for people with no docmost account. |
| Workspace | Space. Owner becomes space admin, editor becomes writer, viewer becomes reader. |
| Whiteboard, to-do or sheet project | A page titled with the project name, holding one live block. Order is kept. Mindspace keeps whiteboard images inline in the saved scene: it saves with Excalidraw's `serializeAsJSON(..., 'local')` (`Whiteboard.svelte:112`), which keeps the `files` map of data URLs, and it uses no storage bucket. The tool moves each image into a docmost attachment. |
| Doc project | A parent page with one child page per markdown document. |
| Comment thread on a document | Docmost comment thread, highlight placed by finding the quoted text. Replies and resolved state are kept. |
| Project with "anyone with the link" | A docmost share link. For a doc project the link includes its child pages. Superseded by Q6: every link is recreated with its original expiry date, using the link expiry built in the plan's part 8. |
| Project shared with one person | Not mapped automatically. Open-source docmost has no supported way to grant one person one page. See Q4. |
| API tokens, passkeys, allowlist, invites | Not migrated. |

- The tool has a dry-run mode that prints a report and changes nothing.
- It can be re-run safely. It records what it has already moved.
- It ends with counts that must match: projects in, pages out; comments in,
  comments out.
- It writes a list of old mindspace links and their new docmost links.
- Cut-over: make mindspace read-only, run the tool a final time, check the counts,
  point old links at docmost. The mindspace database is kept read-only for a period,
  then deleted. See Q5.

## 9. Order of work

| # | Part | Depends on |
|---|---|---|
| 1 | Live-block foundation + whiteboard block | none |
| 2 | To-do board block | 1 |
| 3 | Spreadsheet block | 1 |
| 4 | Split view | none |
| 5 | Passkey login | none |
| 6 | Access tokens + MCP | 1, 2, 3 for the block tools |
| 7 | Migration tool + cut-over | 1, 2, 3 |

Parts 4 and 5 are independent and can be done at any point.

Each part is planned in detail when it starts, and ships as its own pull requests to
`juspay/docmost` `main` from a `<type>/<description>` branch (`feat/`, `docs/`, …), one commit per pull request.
Nothing is merged without Sachin's approval.

## 10. Upstream files that will be touched

Each edit is a registration line or a small guarded branch. Everything else is new files.

- `packages/editor-ext/src/index.ts`: export the three nodes.
- `apps/client/src/features/editor/extensions/extensions.ts`: register nodes and views.
- `apps/client/src/features/editor/components/slash-menu/menu-items.ts`: menu entries.
- `apps/server/src/collaboration/collaboration.util.ts`: register nodes on the server.
- `apps/server/src/collaboration/extensions/authentication.extension.ts` and
  `persistence.extension.ts`: hand `block.*` documents to the live-block service.
- `apps/server/src/core/page/services/page.service.ts`: clone live blocks on duplicate.
- `apps/server/src/core/core.module.ts`: register the new modules.
- `apps/client/src/App.tsx` and `components/settings/settings-sidebar.tsx`: routes and
  settings entries for passkeys and access tokens.
- The login form, the app layout (pane mode), the page tree menu and page header
  (split view), and the export and share renderers (block output).
- The English locale file, for new strings.

## 11. Testing

- Mindspace's own tests for the board and sheet logic are ported with the code and
  must pass.
- For each block: a test with two clients editing at once, proving both edits survive.
- Server: jest specs for the live-block service, passkey flow, token hashing and
  scope checks, each MCP tool's permission check, and the migration mapping.
- Migration: a dry run against a fixture copy of the mindspace schema.
- Each block, split view and passkey sign-in is checked in a real browser before its
  pull request is opened.

## 12. Left to the builder

- Exact Yjs layout for each block, within the merge rules stated above.
- Table column types, index names, endpoint names and the MCP path.
- Whether MCP uses the official SDK or a small hand-written JSON-RPC handler, as
  mindspace does.
- Component structure and styling, following docmost's existing Mantine patterns.
- How the migration tool records progress.

## 13. Open questions for Sachin

- **Q1. Permission to reuse mindspace code. Answered 2026-11-25:** permission exists.
  The board and spreadsheet logic and their tests are reused directly. Each ported
  file carries a header naming its mindspace source path and commit.
- **Q2. Ticket numbers. Answered 2026-11-25:** not required. Branches are named
  `<type>/<description>` without a `BZ-<n>` part.
- **Q3. People in mindspace with no docmost account**, and which docmost
  installation is the target. Needed for part 7, not before.
- **Q4. Projects shared with one person only.** Options at cut-over: leave them
  unshared and tell the owner; add the person to the whole space; or have the tool
  write page-restriction rows directly, which open-source docmost enforces but gives
  no screen to manage afterwards. The dry-run report will say how many projects this
  affects. Needed for part 7.
- **Q5. How long the mindspace database is kept** after cut-over. Needed for part 7.
- **Q6. Public links. Answered 2026-11-25:** docmost links get an expiry. After the
  date a link stops working for people who are not signed in; signed-in members who can
  view the page still reach it; the page's editor renews it with one click. The plan's
  part 8 builds this, and the migration recreates every mindspace link with its original
  expiry date. This replaces the rule in section 8.9 that links with an expiry are not
  created.
