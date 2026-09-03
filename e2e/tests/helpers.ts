import { APIRequestContext, Page, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PAPER_DIR = process.env.PAPER_DIR || path.resolve(__dirname, '..', 'fixtures', 'demo-paper');

export async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/projects', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

/** Every LaTeX source file under the paper dir (recursive: chapters/, figs/, …). */
function paperSourceFiles(dir = PAPER_DIR, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue; // skip build/artifact dotfiles
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...paperSourceFiles(dir, r));
    else if (/\.(tex|bib|cls|bbx|cbx|sty)$/.test(e.name)) out.push(r);
  }
  return out;
}

/** Create a project seeded with the demo paper fixture (all source files). */
export async function createPaperProject(request: APIRequestContext, name = 'Demo Paper'): Promise<string> {
  const id = await createProject(request, name);
  for (const f of paperSourceFiles()) {
    const content = fs.readFileSync(path.join(PAPER_DIR, f), 'utf8');
    const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: f, content } });
    expect(res.ok()).toBeTruthy();
  }
  return id;
}

export async function openProject(page: Page, id: string, branch?: string): Promise<void> {
  await page.goto(`/p/${id}${branch ? `?branch=${branch}` : ''}`);
  await expect(page.getByTestId('editor-shell')).toBeVisible();
  await expect(page.getByTestId('code-pane')).toBeVisible();
  // editor content mounted
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** Type into the CodeMirror editor at the end of the document. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End').catch(() => {});
  // Meta+End is not a CM default everywhere; use Ctrl/Cmd-less fallback
  await page.keyboard.press('PageDown');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

export async function typeset(page: Page): Promise<void> {
  await page.getByTestId('typeset-button').click();
}

export async function expectTypesetOk(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout });
  await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 20_000 });
}

export async function cleanup(request: APIRequestContext, id: string): Promise<void> {
  // permanent: tests must actually remove their data, not fill the trash
  await request.delete(`/api/projects/${id}?permanent=1`).catch(() => {});
}

/**
 * A stored (method 0) ZIP with entry names written verbatim — the `zip` CLI
 * refuses the `../x` names an import test needs to send.
 */
export function buildZip(entries: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const count = Object.keys(entries).length;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
