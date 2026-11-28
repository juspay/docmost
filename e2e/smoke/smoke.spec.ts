import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ADMIN_NAME = 'Smoke Admin';

// Credentials come only from the environment; nothing is committed.
function admin() {
  const email = process.env.SMOKE_ADMIN_EMAIL;
  const password = process.env.SMOKE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD: the admin to sign in as, or to create when the instance has no workspace.',
    );
  }
  return { email, password };
}
const SPACE = 'general';
const IMAGE = path.join(__dirname, 'fixtures', 'test-image.png');
const KEY_DELAY = 25;
const END_OF_DOC = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

const unique = () => Date.now().toString().slice(-6) + Math.floor(Math.random() * 90 + 10);

type Api = (apiPath: string, body?: unknown) => Promise<any>;

function apiFor(ctx: BrowserContext): Api {
  return async (apiPath, body = {}) => {
    const r = await ctx.request.post('/api' + apiPath, { data: body as object });
    const text = await r.text();
    if (!r.ok()) throw new Error(`${apiPath} answered ${r.status()}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    return json && json.data !== undefined ? json.data : json;
  };
}

// Signs in through the API so the session cookie lands in the context.
async function signIn(ctx: BrowserContext, email = admin().email, password = admin().password) {
  const r = await ctx.request.post('/api/auth/login', { data: { email, password } });
  if (!r.ok()) throw new Error(`sign-in as ${email} answered ${r.status()}: ${(await r.text()).slice(0, 200)}`);
}

async function adminPage(page: Page) {
  await signIn(page.context());
  await page.goto(`/s/${SPACE}`, { waitUntil: 'networkidle' });
}

const bodyEditor = (page: Page) => page.locator('.ProseMirror').nth(1);

async function goToEnd(page: Page) {
  await bodyEditor(page).click();
  await page.keyboard.press(END_OF_DOC);
}

async function newLine(page: Page) {
  await goToEnd(page);
  await page.keyboard.press('Enter');
}

async function slash(page: Page, command: string) {
  await page.waitForTimeout(500);
  await page.keyboard.type('/', { delay: KEY_DELAY });
  await page.waitForTimeout(600);
  await page.keyboard.type(command, { delay: KEY_DELAY });
  await page.waitForTimeout(800);
}

// Creates a page in a space and leaves the cursor in its body.
async function createPage(page: Page, title: string, space = SPACE) {
  await page.goto(`/s/${space}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New page' }).click();
  await page.waitForURL(new RegExp(`/s/${space}/p/`), { timeout: 20_000 });
  await page.waitForSelector('.ProseMirror');
  // Focus lands on a menu button after a page is created, so click the title first.
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type(title, { delay: KEY_DELAY });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.activeElement === document.querySelectorAll('.ProseMirror')[1],
    null,
    { timeout: 5000 },
  );
  return page.url();
}

// Edits reach the database a few seconds after typing; wait until the stored
// page contains the text, as exports, shares and history read from storage.
async function storedPage(page: Page) {
  const slugId = page.url().split('/p/')[1].split(/[?#]/)[0].split('-').pop();
  const r = await page.context().request.post('/api/pages/info', { data: { pageId: slugId } });
  return r.ok() ? await r.json() : '';
}

async function waitForSaved(page: Page, text: string) {
  await expect
    .poll(async () => JSON.stringify(await storedPage(page)), { timeout: 90_000, intervals: [1000] })
    .toContain(text);
}

// Reads the .md entries of a zip with Node's zlib, so no system unzip is needed.
function markdownFromZip(buf: Buffer): string {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.md')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    texts.push((method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'));
  }
  return texts.join('\n');
}

async function uploadImage(page: Page) {
  await newLine(page);
  await slash(page, 'image');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 8000 }),
    page.keyboard.press('Enter'),
  ]);
  await chooser.setFiles(IMAGE);
  const block = page.locator('.ProseMirror .node-image').first();
  await block.waitFor({ timeout: 15_000 });
  await block.scrollIntoViewIfNeeded();
  await block.locator('img').first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const i = document.querySelector<HTMLImageElement>('.ProseMirror .node-image img');
      return !!i && i.complete && i.naturalWidth > 0 && !i.src.startsWith('blob:');
    },
    null,
    { timeout: 20_000 },
  );
}

async function publishToWeb(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share' }).first().click();
  const dlg = page.locator('[role=dialog], .mantine-Popover-dropdown').last();
  const toggle = dlg.locator('input[type=checkbox]').first();
  if (!(await toggle.isChecked())) await toggle.click({ force: true });
  const readLink = async () => {
    const match = (await dlg.innerText()).match(/https?:\/\/\S+\/share\/\S+/);
    if (match) return match[0];
    const input = dlg.locator('input[readonly], input[type=text]').first();
    return (await input.count()) ? await input.inputValue() : '';
  };
  await expect.poll(readLink, { message: 'a share link is shown', timeout: 15_000 }).toMatch(/\/share\//);
  const link = await readLink();
  await page.keyboard.press('Escape');
  return link.replace(/^https?:\/\/[^/]+/, '');
}

async function inviteAndAccept(browser: Browser, admin: Api, label: string) {
  const email = `${label}${unique()}@local.test`;
  await admin('/workspace/invites/create', { emails: [email], role: 'member', groupIds: [] });
  const list = await admin('/workspace/invites', { limit: 100 });
  const invite = (list.items || list).find((i: any) => i.email === email);
  expect(invite, 'invitation is listed').toBeTruthy();
  const l = await admin('/workspace/invites/link', { invitationId: invite.id });
  const link = String(l.inviteLink || l.link || l).replace(/^https?:\/\/[^/]+/, '');

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(link, { waitUntil: 'networkidle' });
  await p.getByLabel(/name/i).first().fill('Smoke Reader');
  await p.getByRole('textbox', { name: 'Password' }).fill('Reader-pass-2026!');
  await p.getByRole('button', { name: /sign up|join|accept|create|continue/i }).first().click();
  await p.waitForURL((u) => !u.toString().includes('/invites/'), { timeout: 20_000 });
  const me = await apiFor(ctx)('/users/me');
  const userId = me.user?.id || me.id;
  expect(userId, 'new member has an id').toBeTruthy();
  return { ctx, page: p, email, userId: userId as string };
}

test.describe('browser smoke check', () => {
  test('create the first workspace', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    test.skip(!page.url().includes('/setup'), 'this instance already has a workspace');
    await page.getByLabel('Workspace Name').fill('Smoke Test');
    await page.getByLabel('Your Name').fill(ADMIN_NAME);
    await page.getByLabel('Your Email').fill(admin().email);
    await page.getByRole('textbox', { name: 'Password' }).fill(admin().password);
    await page.getByRole('button', { name: /setup|create|continue/i }).first().click();
    await page.waitForURL((u) => !u.toString().includes('/setup'), { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    expect(page.url()).not.toContain('/setup');
  });

  test('create a page with headings, lists and bold text', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke formatting ${unique()}`);
    const k = page.keyboard;
    await k.type('## Section heading', { delay: KEY_DELAY });
    await k.press('Enter');
    await k.type('Plain text paragraph.', { delay: KEY_DELAY });
    await k.press('Enter');
    await k.type('- first bullet', { delay: KEY_DELAY });
    await k.press('Enter');
    await k.type('second bullet', { delay: KEY_DELAY });
    await k.press('Enter');
    await k.press('Enter');
    await k.press('ControlOrMeta+b');
    await k.type('bold words', { delay: KEY_DELAY });
    await k.press('ControlOrMeta+b');
    const body = bodyEditor(page);
    await expect(body.locator('h2')).toHaveText('Section heading');
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('strong')).toHaveText('bold words');
  });

  test('two browsers edit the same page live in both directions', async ({ page, browser }) => {
    await adminPage(page);
    const url = await createPage(page, `Smoke live ${unique()}`);
    await page.keyboard.type('Starting line.', { delay: KEY_DELAY });
    await waitForSaved(page, 'Starting line.');

    const ctxB = await browser.newContext();
    await signIn(ctxB);
    const b = await ctxB.newPage();
    await b.goto(url, { waitUntil: 'networkidle' });
    await expect(b.getByText('Starting line.')).toBeVisible();

    const live = 'liveline' + unique();
    await newLine(page);
    await page.keyboard.type(`Typed in A: ${live}`, { delay: KEY_DELAY });
    const t0 = Date.now();
    await expect(b.getByText(live)).toBeVisible({ timeout: 10_000 });
    test.info().annotations.push({ type: 'A to B ms', description: String(Date.now() - t0) });

    const back = 'backline' + unique();
    await newLine(b);
    await b.keyboard.type(`Typed in B: ${back}`, { delay: KEY_DELAY });
    await expect(page.getByText(back)).toBeVisible({ timeout: 10_000 });
    await ctxB.close();
  });

  test('upload an image', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke image ${unique()}`);
    await uploadImage(page);
  });

  test('insert a table with the slash menu', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke table ${unique()}`);
    await slash(page, 'table');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror table')).toBeVisible({ timeout: 8000 });
  });

  test('content is kept across a reload', async ({ page }) => {
    await adminPage(page);
    const word = 'zebrafluent' + unique();
    await createPage(page, `Smoke reload ${unique()}`);
    await page.keyboard.type(`Plain text with the word ${word} in it.`, { delay: KEY_DELAY });
    await uploadImage(page);
    await newLine(page);
    await slash(page, 'table');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror table')).toBeVisible();
    // Saves are debounced; wait for text typed after the last block, so the stored page has all of it.
    const end = 'endmarker' + unique();
    await page.keyboard.type(end, { delay: KEY_DELAY }); // the cursor is in the new table's first cell
    await waitForSaved(page, end);
    expect(JSON.stringify(await storedPage(page))).toContain('"type":"image"');
    expect(JSON.stringify(await storedPage(page))).toContain('"type":"table"');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(word)).toBeVisible();
    await expect(page.locator('.ProseMirror table')).toBeVisible();
    const block = page.locator('.ProseMirror .node-image').first();
    await block.waitFor();
    await block.scrollIntoViewIfNeeded();
    await block.locator('img').first().waitFor();
  });

  test('comment on selected text', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke comment ${unique()}`);
    await page.keyboard.type('## Section heading', { delay: KEY_DELAY });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Commentable sentence.', { delay: KEY_DELAY });
    await waitForSaved(page, 'Commentable sentence.');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(bodyEditor(page).getByText('Commentable sentence.')).toBeVisible();
    // Select the sentence with the keyboard; a double click does not reliably select here.
    await bodyEditor(page).getByText('Commentable sentence.').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await expect(page.getByRole('button', { name: 'Comment', exact: true }).first()).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: 'Comment', exact: true }).first().click({ timeout: 5000 });
    const dialog = page.locator('[data-comment-dialog]');
    const box = dialog.getByRole('textbox');
    await box.waitFor({ timeout: 8000 });
    await box.click();
    const note = 'Looks good from the smoke run ' + unique();
    await page.keyboard.type(note, { delay: KEY_DELAY });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    // The editor also holds the typed text, so check the comment the server stored.
    const slugId = page.url().split('/p/')[1].split(/[?#]/)[0].split('-').pop();
    const info = await apiFor(page.context())('/pages/info', { pageId: slugId });
    await expect
      .poll(async () => JSON.stringify(await apiFor(page.context())('/comments', { pageId: info.id })), {
        timeout: 15_000,
      })
      .toContain(note);
  });

  test('publish a page to the web', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke publish ${unique()}`);
    await page.keyboard.type('Public words.', { delay: KEY_DELAY });
    await waitForSaved(page, 'Public words.');
    const link = await publishToWeb(page);
    expect(link).toContain('/share/');
  });

  test('a signed-out visitor reads a published page, with its image, read-only', async ({ page, browser }) => {
    await adminPage(page);
    const word = 'publicword' + unique();
    await createPage(page, `Smoke public ${unique()}`);
    await page.keyboard.type(`Open to everyone ${word}.`, { delay: KEY_DELAY });
    await uploadImage(page);
    const end = 'endmarker' + unique();
    await newLine(page);
    await page.keyboard.type(end, { delay: KEY_DELAY });
    await waitForSaved(page, end);
    const link = await publishToWeb(page);

    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto(link, { waitUntil: 'networkidle' });
    await expect(v.getByText(word)).toBeVisible();
    await v.locator('.node-image').first().scrollIntoViewIfNeeded();
    await v.locator('.node-image img').first().waitFor();
    await expect
      .poll(() =>
        v.evaluate(() => {
          const i = document.querySelector<HTMLImageElement>('.node-image img');
          return !!i && i.complete && i.naturalWidth > 0;
        }),
      )
      .toBe(true);
    await expect(v.locator('.ProseMirror[contenteditable=true]')).toHaveCount(0);
    await ctx.close();
  });

  test('search finds a page by a word in its body', async ({ page }) => {
    await adminPage(page);
    const word = 'searchable' + unique();
    const title = `Smoke search ${unique()}`;
    await createPage(page, title);
    await page.keyboard.type(`Find me by ${word}.`, { delay: KEY_DELAY });
    await waitForSaved(page, word);
    await page.keyboard.press('ControlOrMeta+k');
    const searchBox = page.getByPlaceholder(/search/i).last();
    await expect(searchBox).toBeVisible();
    await searchBox.fill(word);
    await expect(page.getByText(title).last()).toBeVisible({ timeout: 10_000 });
  });

  test('export a page as Markdown', async ({ page }) => {
    await adminPage(page);
    const word = 'exportword' + unique();
    await createPage(page, `Smoke export ${unique()}`);
    await page.keyboard.type('## Section heading', { delay: KEY_DELAY });
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Body with ${word}.`, { delay: KEY_DELAY });
    await waitForSaved(page, word);
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Export' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Export' })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.getByRole('dialog').getByRole('button', { name: 'Export' }).click(),
    ]);
    const file = test.info().outputPath(download.suggestedFilename());
    await download.saveAs(file);
    const bytes = fs.readFileSync(file);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const text = isZip ? markdownFromZip(bytes) : bytes.toString('utf8');
    expect(text).toContain(word);
    expect(text).toMatch(/##\s+Section heading/);
  });

  test('open page history', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke history ${unique()}`);
    await page.keyboard.type('History body.', { delay: KEY_DELAY });
    await waitForSaved(page, 'History body.');
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Page history' }).click();
    await expect(page.getByRole('dialog', { name: 'Page history' })).toBeVisible({ timeout: 8000 });
  });

  test('insert an Excalidraw drawing block', async ({ page }) => {
    await adminPage(page);
    await createPage(page, `Smoke drawing ${unique()}`);
    await page.keyboard.type('Drawing below.', { delay: KEY_DELAY });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await slash(page, 'excalidraw');
    await page.keyboard.press('Enter');
    // the upstream block only, not a live whiteboard (whose canvas also has an excalidraw class)
    const drawing = page.locator('.ProseMirror .node-excalidraw');
    await expect(drawing.first()).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('.ProseMirror .node-whiteboard')).toHaveCount(0);
  });

  test('move a page to trash and restore it', async ({ page }) => {
    await adminPage(page);
    const title = `Smoke trash ${unique()}`;
    await createPage(page, title);
    await waitForSaved(page, title);
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await Promise.all([
      page.waitForResponse((r) => /\/api\/pages\/delete/.test(r.url()) && r.ok()),
      page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click(),
    ]);

    await page.goto(`/s/${SPACE}/trash`, { waitUntil: 'networkidle' });
    const row = page.locator('tr', { hasText: title });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button').last().click();
    const restored = page.waitForResponse((r) => /\/api\/pages\/restore/.test(r.url()) && r.ok());
    await page.getByRole('menuitem', { name: /restore/i }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: /restore/i });
    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) await confirm.click();
    await restored;

    await page.goto(`/s/${SPACE}`, { waitUntil: 'networkidle' });
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
    await page.goto(`/s/${SPACE}/trash`, { waitUntil: 'networkidle' });
    await expect(page.locator('tr', { hasText: title })).toHaveCount(0);
  });

  test('invite a member and accept the invitation', async ({ page, browser }) => {
    await adminPage(page);
    const member = await inviteAndAccept(browser, apiFor(page.context()), 'invitee');
    expect(member.page.url()).not.toContain('/invites/');
    await member.ctx.close();
  });

  test('a space reader can open a page but cannot edit or create', async ({ page, browser }) => {
    await adminPage(page);
    const admin = apiFor(page.context());
    const reader = await inviteAndAccept(browser, admin, 'reader');
    const slug = 'rt' + unique();
    const space = await admin('/spaces/create', { name: 'Reader Test ' + slug, slug });
    await admin('/spaces/members/add', {
      spaceId: space.id,
      userIds: [reader.userId],
      groupIds: [],
      role: 'reader',
    });
    const marker = 'Body written by the admin ' + unique();
    const url = await createPage(page, 'Readers can see this', slug);
    await page.keyboard.type(marker, { delay: KEY_DELAY });
    await waitForSaved(page, marker);

    await reader.page.goto(url, { waitUntil: 'networkidle' });
    await expect(reader.page.getByText(marker)).toBeVisible({ timeout: 15_000 });
    await expect(reader.page.locator('.ProseMirror[contenteditable=true]')).toHaveCount(0);
    await expect(reader.page.getByRole('button', { name: 'New page' })).toHaveCount(0);
    const write = await reader.ctx.request.post('/api/pages/create', {
      data: { title: 'should fail', spaceId: space.id },
    });
    expect(write.status()).toBe(403);
    await reader.ctx.close();
  });

  test('a signed-out visitor is sent to sign-in for a private page', async ({ page, browser }) => {
    await adminPage(page);
    const marker = 'Private body ' + unique();
    const url = await createPage(page, `Smoke private ${unique()}`);
    await page.keyboard.type(marker, { delay: KEY_DELAY });
    await waitForSaved(page, marker);

    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto(url, { waitUntil: 'networkidle' });
    await expect(v).toHaveURL(/\/login/, { timeout: 10_000 });
    await expect(v.getByText(marker)).toHaveCount(0);
    await ctx.close();
  });
});
