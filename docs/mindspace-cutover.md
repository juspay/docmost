# Mindspace to docmost cut-over runbook

A checklist for the person who moves mindspace into docmost. Follow it in
order. Each step says what to run and what you should see.

The tool is `apps/server/src/mindspace-import`. It reads mindspace, writes
into one docmost workspace, and checks its own work. It exits 0 only when every
mindspace row is accounted for, every imported item holds at least what it held
in mindspace, every public link has its original expiry, and every loss has
been accepted by name.

> **Decisions** (Sachin, 2026-11-27, rulings R42 and R43):
>
> |     | Question                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
> | --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | Q3  | What happens to mindspace people with no docmost account? | They are **invited** to the docmost workspace (role member) with `--invite-unmatched`, through docmost's own invitation service; no user is created directly. Their content is skipped until they accept; a **re-run** after they accept imports it (step 7). Anyone with a pending invitation is not invited again. A workspace whose owner has no docmost account stays skipped until then, unless `--grant-fallback-admin` is passed. Comments whose author has no account are attributed to the fallback owner with "(from their email)" in front. |
> | Q4  | Projects shared with one person only (`project_shares`)?  | The person becomes a **member of the project owner's space**: mindspace editor → writer, viewer → reader, never admin; a higher role they already have is kept. The grant covers the whole space, not only that project; each one is listed as `space-member-granted-from-share`. A recipient with no docmost account is invited as in Q3 and added by the re-run.                                                                                                                                                                                     |
> | Q5  | How long is the mindspace database kept after cut-over?   | **7 days**, read-only. Then the database and the Supabase project are deleted, and a follow-up pull request removes the redirect table and the import code (step 10).                                                                                                                                                                                                                                                                                                                                                                                  |
> | Q6  | Public links                                              | Recreated with their original expiry date, including links that have already expired. Mindspace does not store the period a person picked, so every imported link gets a 7-day "Renew" period.                                                                                                                                                                                                                                                                                                                                                         |

## What you need

| Name               | What it is                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOCMOST_DB_URL`   | The docmost database as the **containers** reach it (the server's `DATABASE_URL`, host `db` in the stock compose file). Backups and restores below run inside the `db` container, so they need no address on the host.                                                                                             |
| `MINDSPACE_RO_URL` | Mindspace's database, as the read-only role made in "Access".                                                                                                                                                                                                                                                      |
| `WORKSPACE_ID`     | The docmost workspace to import into: `select id, name from workspaces;`                                                                                                                                                                                                                                           |
| `FALLBACK_OWNER`   | Email of an active docmost **owner or admin** with a verified email. It is the author of comments whose author has no docmost account, the inviter named in every invitation email (`--invite-unmatched` refuses anyone else), and, with `--grant-fallback-admin`, the admin of spaces whose owner has no account. |
| `OLD_BASE_URL`     | Mindspace's public address, e.g. `https://mindspace.example.com`.                                                                                                                                                                                                                                                  |

**The real import (step 5) runs only inside the production docmost image**, in a
one-off container next to the stopped app, so it writes to the database and the
file storage that production uses. The image has no `pnpm`: the tool is run with
`node`. Dry runs (step 1) use the same command. The report must land on a host
directory mounted into the container, because a `--rm` container's own files
are gone when it exits.

On the Docker host, once:

```bash
mkdir -p /srv/mindspace-cutover
chown 1000:1000 /srv/mindspace-cutover   # the image runs as user "node" (uid 1000)
chmod 700 /srv/mindspace-cutover          # the reports hold email addresses
```

Every run is then exactly this, with both database addresses written out (the
compose service is `docmost`; the image's working directory is
`/app/apps/server`). `<flags>` is `--dry-run` or `--accept-loss <ids>`, and
`<name>` is the report's file name:

```bash
docker compose run --rm \
  -v /srv/mindspace-cutover:/cutover \
  -e DATABASE_URL="$DOCMOST_DB_URL" \
  -e MINDSPACE_DATABASE_URL="$MINDSPACE_RO_URL" \
  docmost node dist/mindspace-import/main \
  --docmost-workspace "$WORKSPACE_ID" --fallback-owner "$FALLBACK_OWNER" \
  --old-base-url "$OLD_BASE_URL" --report /cutover/<name>.json <flags>
```

The report and the links CSV are then on the host in `/srv/mindspace-cutover`.
`docker compose run` keeps a terminal attached, so the workspace-name prompt of
a real run works.

(For the rehearsal on another machine, step 2: `pnpm --filter server build`, then
from `apps/server` the same tool as
`DATABASE_URL=… MINDSPACE_DATABASE_URL=… node dist/mindspace-import/main <same flags>`,
with a local `--report` path.)

First of all, before it reads mindspace, the tool prints its target:

```
Target: docmost workspace "<name>" (<id>)
  database <host>:<port>/<database>
  storage  <driver>, <bucket, container or directory>
```

**Read these three lines before you type anything.** They must name the
production database and the production storage. The tool refuses to start when
`MINDSPACE_DATABASE_URL` and `DATABASE_URL` name the same database, or when the
two connections turn out to reach the same database on the same server (it
compares the server's system identifier, address and database name from each
connection). It refuses an `--accept-loss` id that is not a mindspace project. A
real run (without `--dry-run`) then asks you to type the docmost workspace name
before it writes anything.

Flags you will use:

| Flag                                 | Meaning                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                          | Do everything except write: every conversion and every check. Problems a real run would hit show up here.                                       |
| `--report <file>`                    | Write the report (JSON) to `<file>` and the redirect list to `<file>.links.csv`.                                                                |
| `--accept-loss <project ids>`        | Comma-separated mindspace project ids whose losses you accept (see "Losses").                                                                   |
| `--invite-unmatched`                 | Q3/Q4: invite everyone with no docmost account (workspace members, workspace owners, share recipients). A dry run lists them and sends nothing. |
| `--no-new-invites`                   | For the last runs (step 7): send and renew no invitation; list everyone invited who never accepted as `invited-not-accepted`, expired or not.   |
| `--grant-fallback-admin`             | Q3: also migrate workspaces whose owner has no docmost account, with the fallback owner as their only admin.                                    |
| `--only people,projects,docs,shares` | Run part of the import (never with `--dry-run`). Normally not needed.                                                                           |

### Losses

A loss is mindspace data that would not reach docmost intact. The tool fails
(exit 1) until each one is either fixed in mindspace or accepted by passing the
project id to `--accept-loss`:

| Code                       | Meaning                                                                                                      | What docmost gets                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `scene-invalid`            | A whiteboard or board whose saved scene is broken JSON or fails validation.                                  | The page, with an empty block, so its link still works.      |
| `whiteboard-file-skipped`  | An image inside a whiteboard that is not PNG, JPEG, GIF or WebP, is over the upload limit, or is unreadable. | The whiteboard without that image.                           |
| `document-convert-failed`  | A document whose markdown could not be converted.                                                            | The page, with the markdown kept verbatim in one code block. |
| `document-content-shorter` | A document page holds fewer words than its markdown renders to (the sample lists some).                      | The page as converted.                                       |

A comment whose quoted text can no longer be found (`comment-orphaned`) is not
a loss: it is imported, only without its highlight.

## 1. Two weeks before

- [ ] Deploy the docmost release that contains the import tool and let it start
      once, so its migrations run. **Before every import run** (dry runs and
      re-runs included), make sure docmost has run the migrations of the
      release in use: the tool runs none, and refuses to start, naming the
      missing migration, while `mindspace_import_map` or its `verified_at`
      column does not exist. A rehearsal database created by an earlier build
      needs only that (`pnpm --filter server migration:latest`), not a new copy.
- [ ] Count docmost accounts whose email was never verified. They never match a
      mindspace person, and an existing account is never invited:

  ```bash
  docker compose exec db psql -U docmost -d docmost -c \
    "select email, created_at from users where workspace_id = '$WORKSPACE_ID' and email_verified_at is null and deleted_at is null order by email;"
  ```

  docmost (open source) has no way for such an account to verify itself later.
  For each one that a mindspace person needs: confirm out of band that the
  account belongs to that person (ask them, by a channel you already trust),
  then mark that one account verified:

  ```bash
  docker compose exec db psql -U docmost -d docmost -c \
    "update users set email_verified_at = now() where workspace_id = '$WORKSPACE_ID' and lower(email) = lower('<their email>') and email_verified_at is null;"
  ```

  Do it one named person at a time, never for the whole list. The tool never
  does this itself.

- [ ] Create the read-only role (step 3, "Access") on production mindspace now.
      The dry run uses it.
- [ ] Run a dry run against production mindspace and the production docmost workspace:

  ```bash
  docker compose run --rm \
    -v /srv/mindspace-cutover:/cutover \
    -e DATABASE_URL="$DOCMOST_DB_URL" \
    -e MINDSPACE_DATABASE_URL="$MINDSPACE_RO_URL" \
    docmost node dist/mindspace-import/main \
    --docmost-workspace "$WORKSPACE_ID" --fallback-owner "$FALLBACK_OWNER" \
    --old-base-url "$OLD_BASE_URL" --report /cutover/dryrun-$(date +%F).json \
    --dry-run --invite-unmatched
  ```

  The app can keep running for a dry run: it writes nothing and sends no
  invitation. With `--invite-unmatched` its report lists, under "Invited", who
  the real run would invite (`would-invite`), and who already has a pending
  invitation (`already-invited`).

  Expect: the mindspace source counts, then the report. Exit code 0, or 1 with a
  list of problems.

  Mindspace is not frozen yet, and the tool reads each table in its own
  transaction. Someone editing mindspace during the dry run can therefore make a
  count disagree (a comment added between reading documents and reading
  comments). Run it again before treating a count mismatch as real; after the
  freeze (step 4) this cannot happen.

- [ ] Cross-check the source counts the tool printed against counts taken as the
      database owner, so row-level security cannot hide rows from the import role:

  ```sql
  select (select count(*) from auth.users) users, (select count(*) from public.workspaces) workspaces,
         (select count(*) from public.projects) projects, (select count(*) from public.documents) documents,
         (select count(*) from public.document_comments) comments, (select count(*) from public.project_shares) shares;
  ```

- [ ] Send Sachin, from the dry-run report (two weeks before the date):
  - the **invite list**: the "Invited" section (`would-invite`; `cannot-accept` names people docmost would never let in, because of enforced SSO or the allowed email domains; `invalid-email` names share addresses that are not addresses). Say that an invited share recipient who accepts becomes a **workspace member, joins the default group**, and gets the whole space, where in mindspace they saw one project. With it: `workspace-owner-unmatched` (workspaces that wait for their owner, with project counts), `user-unmatched`, `user-unconfirmed` and `member-unmatched`;
  - the **share-grant list**: `space-member-granted-from-share` (who becomes a member of which space, and that it covers the whole space) and `project-share-unmatched` (recipients who could not be matched: only those with no docmost account are invited; unverified, deactivated or deleted accounts are listed but never invited), and `share-role-unknown` (shares whose role mindspace data does not define: nothing is granted);
  - every loss, so each can be fixed in mindspace or accepted.
  - the removed whiteboard elements: `whiteboard-element-removed` lists, per board, the elements left out or cleaned (iframes, embeds of pages not on the allow-list, unsafe links, generated HTML, repeated ids). Review the list; these are removed on purpose and do not fail the run.
- [ ] For anyone listed as `user-unmatched` with "the docmost account has not verified its email", follow the verification step above.
- [ ] Tell the people on the invite list that a docmost invitation will arrive on the day, and that their mindspace content appears after they accept it.
- [ ] Announce the date to mindspace users. Say that passkeys and API tokens are
      not carried over and must be created again in docmost (Settings > Account).

## 2. Rehearsal

On a machine that is not production.

- [ ] Restore a copy of the production docmost database and storage:

  ```bash
  # on the production Docker host
  docker compose exec -T db pg_dump -U docmost -Fc docmost > docmost-copy.dump
  # copy docmost-copy.dump to the rehearsal machine, then there:
  createdb docmost_rehearsal && pg_restore --no-owner -d docmost_rehearsal docmost-copy.dump
  ```

  Point a local docmost at `docmost_rehearsal` (its `.env` `DATABASE_URL`) and run
  `pnpm --filter server migration:latest`.

- [ ] Build a copy of mindspace from its schema and production data. Plain
      PostgreSQL lacks the Supabase objects mindspace's migrations need; the stub
      adds them.

  ```bash
  createdb mindspace_rehearsal
  psql -v ON_ERROR_STOP=1 -d mindspace_rehearsal -f apps/server/src/mindspace-import/testing/supabase-stub.sql
  for f in <mindspace checkout>/supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d mindspace_rehearsal -f "$f"; done
  # only the three auth columns the import reads
  psql "$MINDSPACE_RO_URL" -c "\copy (select id, email, email_confirmed_at from auth.users) to 'users.csv' csv"
  psql -d mindspace_rehearsal -c "\copy auth.users (id, email, email_confirmed_at) from 'users.csv' csv"
  # --enable-row-security: the role reads through its policies; --disable-triggers:
  # replies may be dumped before their thread (pg_dump warns about this; expected)
  pg_dump "$MINDSPACE_RO_URL" --data-only --no-owner --enable-row-security --disable-triggers \
    -t public.workspaces -t public.workspace_members -t public.projects -t public.documents \
    -t public.document_comments -t public.project_shares -f mindspace-data.sql
  psql -v ON_ERROR_STOP=1 -d mindspace_rehearsal -f mindspace-data.sql   # as a superuser, for --disable-triggers
  ```

- [ ] Run the real import against the copies and time it. Pass the `--accept-loss`
      list agreed in step 1.

  ```bash
  cd apps/server
  # Every place the import writes is set here, so nothing comes from a .env:
  # DATABASE_URL: the rehearsal copy.
  # REDIS_URL: a Redis database no docmost server reads, so the rehearsal's
  #   invitations are queued where no worker can ever mail them.
  # STORAGE_DRIVER=local: images go to <checkout>/data/storage on this machine.
  #   Pointed at the production bucket it would write real files under the same
  #   paths the cut-over uses, which a later clean-up here could then delete.
  mkdir -p ../../data/storage
  time (DATABASE_URL=postgresql://localhost/docmost_rehearsal \
    MINDSPACE_DATABASE_URL=postgresql://localhost/mindspace_rehearsal \
    REDIS_URL=redis://localhost:6379/15 \
    STORAGE_DRIVER=local \
    node dist/mindspace-import/main \
    --docmost-workspace "$WORKSPACE_ID" --fallback-owner "$FALLBACK_OWNER" \
    --old-base-url "$OLD_BASE_URL" --accept-loss <ids> --report rehearsal.json \
    --invite-unmatched)
  redis-cli -n 15 flushdb   # the queued rehearsal emails, unsent
  ```

  Before running it, stop the local docmost started on the copy: it came with
  production settings, and must not read database 15 either. When the tool
  prints its "Target" lines, check that storage says `local, directory …` on
  this machine and the database is `docmost_rehearsal`; if not, answer the
  prompt with anything else and fix the command.

  Expect: exit 0, `Result: everything is accounted for.` Write down the time.

- [ ] Run it again. Expect: exit 0 and every count is `already-imported`.
- [ ] Open ten migrated items of each kind by hand (whiteboard, to-do board,
      document with comments, public link) and compare them with mindspace.
- [ ] Have one person who did not write this document walk through the rehearsal
      using only this document. Fix the document where they got stuck.

## 3. Access

- [ ] On production mindspace, as the database owner, create a role that can
      only read the seven tables the import reads. Mindspace's tables use
      row-level security, so the role also needs read policies; without them it
      would silently see no rows.

  ```sql
  create role docmost_import login password '<generated>';
  alter role docmost_import set default_transaction_read_only = on;
  grant usage on schema public, auth to docmost_import;
  grant select on public.workspaces, public.workspace_members, public.projects,
    public.documents, public.document_comments, public.project_shares to docmost_import;
  grant select (id, email, email_confirmed_at) on auth.users to docmost_import;
  create policy docmost_import_read on public.workspaces        for select to docmost_import using (true);
  create policy docmost_import_read on public.workspace_members for select to docmost_import using (true);
  create policy docmost_import_read on public.projects          for select to docmost_import using (true);
  create policy docmost_import_read on public.documents         for select to docmost_import using (true);
  create policy docmost_import_read on public.document_comments for select to docmost_import using (true);
  create policy docmost_import_read on public.project_shares    for select to docmost_import using (true);
  ```

- [ ] Use this role, and only this role, in `MINDSPACE_DATABASE_URL`. The tool
      also reads every table inside its own `BEGIN READ ONLY` transaction.

## 4. Freeze

- [ ] Make mindspace read-only for everyone, the service role included. The
      change lives in the mindspace repository as a migration that adds a
      trigger to every table people write to:

  ```sql
  -- supabase/migrations/0017_freeze_for_docmost_cutover.sql
  create or replace function public.mindspace_frozen() returns trigger language plpgsql as $$
  begin
    raise exception 'mindspace has moved to docmost and is read-only' using errcode = 'read_only_sql_transaction';
  end; $$;
  do $$ declare t text; begin
    -- not passkeys or api_tokens: signing in updates their counters and
    -- last_used_at, and people still sign in to read mindspace
    foreach t in array array['workspaces','workspace_members','projects','documents',
                             'document_comments','project_shares',
                             'app_members','app_invites'] loop
      execute format('create trigger mindspace_frozen before insert or update or delete on public.%I
                      for each statement execute function public.mindspace_frozen()', t);
    end loop; end $$;
  ```

  **To do before the day:** commit this in sinha-sahil/mindspace and write its
  commit here: `<mindspace commit sha>`. Apply it with the Supabase SQL editor or
  `supabase db push`.

- [ ] Check the freeze: saving a whiteboard in mindspace now shows an error, and
      `insert into public.workspaces (name, owner_id) values ('x', '<any user id>')`
      fails with "mindspace has moved to docmost".

## 5. Import

This step is a **maintenance window**: docmost is down from the backup until the
check (step 6) passes or the rollback (step 9) is done. Nobody can change docmost
in between, so the backup stays a complete copy, and no open editor can touch a
page while the import writes it.

- [ ] Announce the window, then stop the docmost server and the collaboration
      server (scale the app container to zero, or stop its service). Keep the
      database and the storage running. The import runs in a one-off container
      from the same image (`docker compose run --rm docmost …`, below), so the
      server process need not be up.
- [ ] Write down the time in milliseconds (`date -u +%s000`): if the rollback
      (step 9) is needed, it removes only email jobs queued after it.
- [ ] Back up docmost: the database and the file storage (whiteboard images become attachments).

  ```bash
  docker compose exec -T db pg_dump -U docmost -Fc docmost > docmost-before-mindspace-$(date +%F).dump
  # local storage: copy the data/storage directory; S3: note the bucket state or enable versioning
  ```

- [ ] Run the real import with the agreed `--accept-loss` list:

  ```bash
  docker compose run --rm \
    -v /srv/mindspace-cutover:/cutover \
    -e DATABASE_URL="$DOCMOST_DB_URL" \
    -e MINDSPACE_DATABASE_URL="$MINDSPACE_RO_URL" \
    docmost node dist/mindspace-import/main \
    --docmost-workspace "$WORKSPACE_ID" --fallback-owner "$FALLBACK_OWNER" \
    --old-base-url "$OLD_BASE_URL" --report /cutover/cutover-$(date +%F-%H%M).json \
    --accept-loss <ids>
  ```

  Check the three "Target" lines (production database and storage), then type
  the workspace name. It must exit 0. If it exits 1, read the "Mismatches" list
  at the end of the output. If the only lines are `failed (error)` items (for
  example a storage timeout), run this step once more, inside the window: those
  items are retried and nothing else is touched. Any other line: do the step-6
  hand checks; if the mismatch is real, go to step 9.

  This first run sends **no invitation** (no `--invite-unmatched`): the
  invitations are sent in step 6, once the hand checks have passed, so a
  rollback never leaves people with invitations to a cut-over that was undone.

- [ ] Check that `/srv/mindspace-cutover/cutover-<date-time>.json` and
      `cutover-<date-time>.json.links.csv` are on the host (step 8 needs the CSV).
      Every run writes its own file (date and time in the name), so a re-run
      never replaces this one.
- [ ] Keep `cutover-<date-time>.json` and `cutover-<date-time>.json.links.csv`. They are
      the record of the migration, and the JSON report holds people's email
      addresses (unmatched people, comment authors, single-person shares).
      Store both in the team's restricted operations folder, **not** with the
      release notes or in the repository, and delete them when the mindspace
      database is deleted (step 10). Delete the dry-run and rehearsal reports
      once the import is done.

## 6. Check (still inside the window)

- [ ] The tool exited 0. That means the counts, the content of every item this
      run imported (document text included), every imported space's members
      and every link match, and there is no unaccepted loss.
- [ ] Start docmost **for the operator only**: bring the app up but keep it off
      the public address (stop the proxy route, or bind the app to localhost and
      reach it through an SSH tunnel). People cannot see or change anything,
      so the restore in step 9 is still valid.
- [ ] By hand, as operator: five items of each kind (whiteboard, to-do board,
      sheet, document with its comments); one public link opened in a private
      window; one comment thread with replies and its resolved state.
- [ ] If a check fails: step 9, inside the window.
- [ ] If mindspace users relied on agent or MCP access, a workspace admin or
      owner switches it on: Settings > Account > Access tokens
      (`/settings/account/access-tokens`), the **Agent access** switch at the
      top of the page. It is off by default for every workspace; until it is on,
      members see "Agent access is switched off for this workspace. An admin has
      to switch it on before you can create tokens." and cannot create tokens.
      The server must also not have `AGENT_MCP_ENABLED=false` in its
      environment (unset means on).
- [ ] If they pass: open docmost to users. The window ends here; the restore is
      no longer allowed after this point.
- [ ] Send the invitations: run the import once more as in step 5, adding
      `--invite-unmatched`. Everything else is `already-imported`; this run
      invites the people step 1 listed, and their emails go out at once.
- [ ] The mindspace database may be deleted later only if the **last** step-5
      run's report (after any retry of `failed (error)` items), and every later
      run's, shows zero unaccepted losses (`"mismatches": []` in the JSON
      report).

## 7. Re-run once the invitations are accepted

Content of people who were invited (step 5) waits until they accept: their
workspaces, their memberships and the spaces shared with them. The import is
resumable, so the same command picks it up. Invitations expire after **7
days**, the same time the mindspace database is kept (step 10).

- [ ] Watch the workspace's pending invitations (Settings > Members, tab
      Pending). Run the real import again, as in step 5 with the same
      `--accept-loss` list and `--invite-unmatched`, **every day** (or whenever someone accepts) until
      day 6. The app keeps running: the re-run only adds what is missing, each
      item in its own transaction, and sends no invitation twice.
- [ ] Each thing the import writes (a space, a page, a link, one member, one
      share grant, one comment) has its own row in `mindspace_import_map`, and
      is held to mindspace until it has **passed** verification once (column
      `verified_at`). After that, differences on it are people's own changes
      and are listed as `drift` warnings, not failures; they need no
      `--accept-loss`. A thing that has never passed (a run stopped before its
      verification, or failed it) still fails on every later run until fixed.
      When a re-run writes something new into a space or document that passed
      before, only that new member, grant or comment is held strictly; the rest
      stays drift. For example: on day 3 an admin had made Asha a space admin;
      the day-3 run adds Ravi; only Ravi is checked strictly, and Asha's change
      is listed as drift.
- [ ] A re-run that exits 1 must be resolved before the next one: read its
      "Mismatches", fix the cause (or accept a loss by project id), and run
      again.
- [ ] Expect the newly accepted people to be mapped, their workspaces imported
      and their share grants added, and everything else `already-imported`.
      Comments they wrote on other people's projects stay as they were
      imported on the day: by the fallback owner, starting "(from their
      email)". A re-run does not move them to the new account.
- [ ] If an invitation email failed (`invited-email-failed` in the report,
      exit 1), resend it from Settings > Members, tab Pending, Resend.
- [ ] Memberships the import made are made once: a member, a share recipient
      or the owner whom a space admin later removes or demotes stays that way.
      A re-run with `--invite-unmatched` does invite again anyone whose
      invitation an admin revoked; to stop that for someone, leave the flag out
      once they are on no further list.
- [ ] After each re-run, rebuild `redirects.json` (step 8) from that run's
      `.links.csv`, which lists every project, and deploy it: projects imported
      by the re-run get their redirect then.
- [ ] **The last runs, on day 7, before the mindspace database is deleted:**
      replace `--invite-unmatched` with `--no-new-invites`. With it nothing is
      sent and no expired invitation is renewed; everyone who was invited and
      never accepted is listed as `invited-not-accepted`, whether or not the
      invitation has expired.
  1. A dry run with `--dry-run --no-new-invites`. Send Sachin its "Invited"
     section. Everyone listed there loses for good what step 1 listed for them
     (their workspaces, memberships and share grants): `invited-not-accepted`
     and `not-invited` people, `would-invite-later` share recipients whose
     workspace still waits for its owner, `cannot-accept` people (enforced SSO
     or email domains) and `invalid-email` addresses.
  2. The final real run with `--no-new-invites`, for anyone who accepted since.

## 8. Redirect

- [ ] Point old mindspace project URLs at docmost, using the links CSV. Each line
      is `old_url,new_url`, one per project. A project with a public link points
      at the public share, so anonymous visitors keep working; other projects
      point at the docmost page.
- [ ] Turn the CSV into a redirect table on the mindspace domain. For example,
      in the mindspace app (sinha-sahil/mindspace), a `src/hooks.server.ts`
      handle that answers `/p/<id>` with a 301 to `redirects[<id>]`, built with:

  ```bash
  python3 -c 'import csv,json,sys; r=csv.DictReader(open(sys.argv[1])); print(json.dumps({row["old_url"].rsplit("/p/",1)[1]: row["new_url"] for row in r}, indent=1))' \
    cutover-<date>.json.links.csv > redirects.json
  ```

  Commit it in the mindspace repository: `<mindspace commit sha>`.

- [ ] Check three old links: one whiteboard, one doc project, one public link.

## 9. Roll back, if a check fails

Restoring the backup puts back the **whole** docmost database as it was before
the import: everything anyone changed after the backup is lost, in every space.
So the restore below is valid **only inside the window**, while docmost is
stopped or reachable by the operator alone (step 6).

**After docmost is open to users, never restore and never delete whole spaces**
(people's new work is in them, and mindspace is frozen). Fix forward, one
project at a time:

1. Find what the import made for that project. The map holds every target;
   select by it, never by a space's name or description (both can be edited):

   ```sql
   select source_type, source_id, target_type, target_id from mindspace_import_map
   where workspace_id = '<docmost workspace id>' and source_id in ('<mindspace project id>', '<its document ids>');
   ```

2. As a space admin, delete that project's page (and its sub-pages) in
   docmost, then delete it from the trash.
3. Wait until docmost has removed the deleted page's files; the re-import
   reuses the same ids, and a late clean-up would delete the new images:

   ```sql
   select count(*) from attachments where page_id = '<page id>';   -- until 0
   ```

   If it stays above 0 for more than an hour, a storage delete failed and
   docmost kept those rows: delete their files from storage (`file_path` of
   each row) and then the rows by hand.

4. Delete its map rows:

   ```sql
   delete from mindspace_import_map
   where workspace_id = '<docmost workspace id>'
     and (source_id in ('<mindspace project id>', '<its document ids>', '<its comment ids>')
          or (source_type = 'link' and source_id = '<mindspace project id>'));
   ```

5. Run the import again as in step 7: it imports that project anew.

For a whole workspace's space, the same with `source_type = 'workspace'` to find
it (`target_id` is the space id). To withdraw the import's pending invitations,
revoke each one listed in the report's "Invited" section (Settings > Members,
tab Pending, Revoke).

- [ ] Stop docmost again: the app, the collaboration server and the workers
      (step 6 started them for the operator). Then make sure nothing is
      connected to the database, which must print 0:

  ```bash
  docker compose exec db psql -U docmost -d docmost -Atc \
    "select count(*) from pg_stat_activity where datname = 'docmost' and pid <> pg_backend_pid();"
  ```

- [ ] Restore the docmost backup:

  ```bash
  docker compose exec -T db pg_restore -U docmost --clean --if-exists --no-owner -d docmost < docmost-before-mindspace-<date>.dump
  ```

  Restore the storage copy too, or leave the imported images: without the
  database rows they are unreferenced files.

- [ ] Still before the server starts: delete any email the window queued. The
      window's import sends no invitation, but if `--invite-unmatched` was run
      by mistake, its invitations no longer exist after the restore and every
      link would fail. This removes only email jobs added after the time
      written down in step 5; anything older (a password reset waiting when the
      app was stopped) stays:

  ```bash
  docker compose run --rm -e SINCE=<the time from step 5> docmost node -e '
    const { Queue } = require("bullmq"); const u = new URL(process.env.REDIS_URL);
    const q = new Queue("{email-queue}", { connection: { host: u.hostname, port: Number(u.port) || 6379,
      username: u.username || undefined, password: decodeURIComponent(u.password) || undefined,
      db: Number(u.pathname.slice(1)) || 0, tls: u.protocol === "rediss:" ? {} : undefined } });
    (async () => { let n = 0;
      for (const j of await q.getJobs(["wait", "delayed", "paused", "prioritized"]))
        if (j.timestamp >= Number(process.env.SINCE)) { await j.remove(); n++; }
      console.log("removed", n); await q.close(); })();'
  ```

- [ ] Lift the mindspace freeze: revert the freeze commit, or run
      `drop trigger mindspace_frozen on public.<table>` for each table.
- [ ] Remove the redirects (revert the redirect commit).
- [ ] Tell mindspace users the move is postponed.

## 10. Afterwards

- [ ] Check that agent access matches what mindspace users need: as a workspace
      admin, Settings > Account > Access tokens shows the **Agent access** switch
      on if they used agents or MCP, otherwise off; and `AGENT_MCP_ENABLED` is
      not `false` where it should be on.
- [ ] Keep the mindspace database read-only for **7 days** after the cut-over
      (Q5). Then delete it and the Supabase project.
- [ ] When the mindspace database is deleted (after the final step 7 run, not
      before: every re-run reads mindspace through this role), remove the
      import's access to mindspace:

  ```sql
  drop policy docmost_import_read on public.workspaces;
  drop policy docmost_import_read on public.workspace_members;
  drop policy docmost_import_read on public.projects;
  drop policy docmost_import_read on public.documents;
  drop policy docmost_import_read on public.document_comments;
  drop policy docmost_import_read on public.project_shares;
  drop owned by docmost_import;   -- its remaining grants
  drop role docmost_import;
  ```

- [ ] Delete the cut-over reports (step 5) when the mindspace database is deleted, after 7 days.
- [ ] After the 7 days, open a follow-up pull request that removes the redirect
      table (step 8) and `apps/server/src/mindspace-import`, the
      `mindspace_import_map` table (a migration that drops it) and the
      `mindspace:import` script in `apps/server/package.json`. Old mindspace
      links stop redirecting when the redirect table goes; say so in the
      announcement of the date.
