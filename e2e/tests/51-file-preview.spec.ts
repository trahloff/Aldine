import zlib from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { cleanup, createProject, openProject } from './helpers';

/** File previews (#194): a file the code editor cannot show opens in its
 *  place from the tree. Fixtures are generated here. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGBA PNG, its right half transparent. */
function png(w: number, h: number): Buffer {
  const row = w * 4 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row + 1 + x * 4;
      raw[o] = 46; raw[o + 1] = 98; raw[o + 2] = 233; raw[o + 3] = x < w / 2 ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF of `pages` portrait pages (300 × 400 pt), with a correct xref. */
function pdf(pages: number): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objs.push(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    const content = `0.18 0.38 0.91 rg 40 40 ${80 + i * 60} 60 re f`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Script in two places: neither may ever run on the app's origin. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80" onload="window.__svgRan = 1">'
  + '<script>window.__svgRan = 2</script><rect id="svg-marker" width="120" height="80" fill="#2e62e9"/></svg>';

async function previewViolations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).include('[data-testid="file-preview"]').analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
}

test.describe('file previews', () => {
  test('images, PDFs and other files open as previews from the tree; a .tex opens the editor again', async ({ page, request }) => {
    const id = await createProject(request, 'File Previews');
    try {
      await openProject(page, id);
      const texName = (await page.getByTestId('active-file').textContent())!.trim();
      await page.getByTestId('upload-input').setInputFiles([
        { name: 'figure.png', mimeType: 'image/png', buffer: png(320, 200) },
        { name: 'panorama.png', mimeType: 'image/png', buffer: png(4000, 200) },
        { name: 'supplement.pdf', mimeType: 'application/pdf', buffer: pdf(3) },
        { name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) },
        { name: 'dataset.zip', mimeType: 'application/zip', buffer: Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(12)]) },
      ]);
      await expect(page.getByTestId('file-figure.png')).toBeVisible({ timeout: 10_000 });

      const preview = page.getByTestId('file-preview');
      const zoomLabel = page.getByTestId('preview-zoom-fit');
      const img = page.getByTestId('preview-image');

      // ---- an image: fit, zoom, pixel size ----
      await page.getByTestId('file-figure.png').click();
      await expect(preview).toHaveAttribute('data-kind', 'image');
      await expect(page.getByTestId('code-pane')).toHaveCount(0);
      await expect(page.getByTestId('active-file')).toHaveText('figure.png');
      await expect(page.getByTestId('preview-dimensions')).toHaveText('320 × 200 px');
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
      await expect(zoomLabel).toHaveText('100%'); // fitting never enlarges a small image
      await page.getByTestId('preview-zoom-in').click();
      await expect(zoomLabel).toHaveText('150%');
      await expect.poll(async () => Math.round((await img.boundingBox())!.width)).toBe(480);
      // the keys work wherever focus is in the preview
      await page.getByTestId('preview-stage').focus();
      await page.keyboard.press('-');
      await expect(zoomLabel).toHaveText('100%');
      await page.keyboard.press('-');
      await expect(zoomLabel).toHaveText('75%');
      await page.keyboard.press('0');
      await expect(zoomLabel).toHaveText('100%');
      await expect(page.getByTestId('preview-download')).toHaveAttribute('download', 'figure.png');
      expect(await previewViolations(page)).toEqual([]);

      // a wide image fits the pane, and zooming makes it scroll
      await page.getByTestId('file-panorama.png').click();
      await expect(page.getByTestId('preview-dimensions')).toHaveText('4000 × 200 px');
      const stage = page.getByTestId('preview-stage');
      await expect.poll(async () => (await img.boundingBox())!.width).toBeLessThanOrEqual((await stage.boundingBox())!.width);
      await expect(zoomLabel).not.toHaveText('100%');
      await page.getByTestId('preview-zoom-in').click();
      await expect.poll(() => stage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

      // ---- an SVG: only ever an <img> from the file route ----
      await page.getByTestId('file-diagram.svg').click();
      await expect(page.getByTestId('preview-dimensions')).toHaveText('120 × 80 px');
      await expect(img).toHaveAttribute('src', /\/api\/projects\/[^/]+\/file\?branch=main&path=diagram\.svg/);
      await expect(page.locator('#svg-marker')).toHaveCount(0);
      expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
      const svgUrl = `/api/projects/${id}/file?branch=main&path=diagram.svg`;
      const res = await request.get(svgUrl);
      expect(res.headers()['content-type']).toBe('image/svg+xml');
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
      const csp = res.headers()['content-security-policy'];
      expect(csp).toContain('sandbox');
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/script-src|'self'/);
      // opened as a page of its own, it still runs nothing
      const tab = await page.context().newPage();
      await tab.goto(svgUrl);
      expect(await tab.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
      await tab.close();

      // ---- a PDF: its own pages, apart from the typeset preview ----
      await page.getByTestId('file-supplement.pdf').click();
      await expect(preview).toHaveAttribute('data-kind', 'pdf');
      const pages = page.getByTestId('preview-pdf-page');
      await expect(pages).toHaveCount(3);
      await expect(page.getByTestId('preview-pages')).toHaveText('Page 1 / 3');
      await expect.poll(() => pages.first().evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
      const fitWidth = (await pages.first().boundingBox())!.width;
      await page.getByTestId('preview-zoom-in').click();
      await expect(zoomLabel).toHaveText('125%');
      await expect.poll(async () => (await pages.first().boundingBox())!.width).toBeGreaterThan(fitWidth * 1.2);
      await zoomLabel.click();
      await expect(zoomLabel).toHaveText('100%');
      await expect.poll(async () => Math.round((await pages.first().boundingBox())!.width)).toBe(Math.round(fitWidth));
      await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(page.getByTestId('preview-pages')).toHaveText('Page 3 / 3');
      await expect.poll(() => pages.last().evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
      await expect(page.getByTestId('pdf-pane')).toBeVisible();
      expect(await previewViolations(page)).toEqual([]);

      // ---- any other file: name, size and a download ----
      await page.getByTestId('source-only').click(); // the source view hides a .zip
      await page.getByTestId('file-dataset.zip').click();
      await expect(preview).toHaveAttribute('data-kind', 'file');
      await expect(page.getByTestId('preview-file-card')).toContainText('dataset.zip');
      await expect(page.getByTestId('preview-size')).toHaveText('16 bytes');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('preview-download').click()]);
      expect(download.suggestedFilename()).toBe('dataset.zip');
      expect(await previewViolations(page)).toEqual([]);

      // ---- back to the source ----
      await page.getByTestId(`file-${texName}`).click();
      await expect(preview).toHaveCount(0);
      await expect(page.getByTestId('code-pane')).toBeVisible();
      await expect(page.locator('.cm-content')).toBeVisible();
      await expect(page.getByTestId('active-file')).toHaveText(texName);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a replaced image shows its new bytes', async ({ page, request }) => {
    const id = await createProject(request, 'Replaced Figure');
    try {
      await openProject(page, id);
      await page.getByTestId('upload-input').setInputFiles({ name: 'plot.png', mimeType: 'image/png', buffer: png(64, 32) });
      await page.getByTestId('file-plot.png').click();
      await expect(page.getByTestId('preview-dimensions')).toHaveText('64 × 32 px');
      await page.getByTestId('upload-input').setInputFiles({ name: 'plot.png', mimeType: 'image/png', buffer: png(90, 45) });
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('preview-dimensions')).toHaveText('90 × 45 px');
    } finally {
      await cleanup(request, id);
    }
  });
});
