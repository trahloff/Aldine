import { describe, expect, it, vi } from 'vitest';
import { pageLinks, rectToBox, resolveDest, safeLinkUrl, toPage, type DestLookup, type PageView } from '../pdfLinks';

// pdf.js's viewport at scale 1 for a US Letter page (612 × 792 pt): y flips.
const LETTER: PageView = { transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 };
// The same page with a crop box from (50, 50): the origin moves, nothing else.
const CROPPED: PageView = { transform: [1, 0, 0, -1, -50, 842], width: 612, height: 792 };
// /Rotate 90: what was the top edge is now the right one.
const TURNED: PageView = { transform: [0, 1, 1, 0, 0, 0], width: 792, height: 612 };

describe('safeLinkUrl', () => {
  it('keeps absolute web and mail addresses, normalized', () => {
    expect(safeLinkUrl('https://example.org')).toBe('https://example.org/');
    expect(safeLinkUrl('http://example.org/a b?q=1#x')).toBe('http://example.org/a%20b?q=1#x');
    expect(safeLinkUrl('  HTTPS://Example.ORG/Path ')).toBe('https://example.org/Path');
    expect(safeLinkUrl('mailto:someone@example.org')).toBe('mailto:someone@example.org');
  });
  it('drops scripts, local files, data and every other scheme', () => {
    for (const raw of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.org/1234',
      'ftp://example.org/file',
      'tel:+4912345',
      'vbscript:msgbox(1)',
    ]) expect(safeLinkUrl(raw), raw).toBeNull();
  });
  it('drops relative targets: there is no base to resolve them against', () => {
    for (const raw of ['chapter2.pdf', '../secrets.tex', '/api/projects', '//evil.example/x', '#section.1', '', '   ']) {
      expect(safeLinkUrl(raw), raw).toBeNull();
    }
  });
  it('drops anything that is not a string', () => {
    for (const raw of [undefined, null, 42, {}, ['https://example.org']]) expect(safeLinkUrl(raw)).toBeNull();
  });
});

describe('toPage', () => {
  it('maps user space to pixels from the top left', () => {
    expect(toPage(LETTER, 72, 720)).toEqual([72, 72]);
    expect(toPage(CROPPED, 122, 770)).toEqual([72, 72]);
    expect(toPage(TURNED, 72, 720)).toEqual([720, 72]);
  });
});

describe('rectToBox', () => {
  it('turns a user-space rectangle into percent of the page', () => {
    const box = rectToBox([72, 692, 172, 712], LETTER)!;
    expect(box.left).toBeCloseTo((72 / 612) * 100);
    expect(box.top).toBeCloseTo((80 / 792) * 100);
    expect(box.width).toBeCloseTo((100 / 612) * 100);
    expect(box.height).toBeCloseTo((20 / 792) * 100);
  });
  it('does not care which corners come first', () => {
    expect(rectToBox([172, 712, 72, 692], LETTER)).toEqual(rectToBox([72, 692, 172, 712], LETTER));
  });
  it('follows a crop box that does not start at the origin', () => {
    const a = rectToBox([72, 692, 172, 712], LETTER)!;
    const b = rectToBox([122, 742, 222, 762], CROPPED)!;
    for (const k of ['left', 'top', 'width', 'height'] as const) expect(b[k]).toBeCloseTo(a[k]);
  });
  it('follows a rotated page', () => {
    // 100 pt wide, 20 pt tall in user space: 20 wide, 100 tall once turned
    const box = rectToBox([72, 692, 172, 712], TURNED)!;
    expect(box.left).toBeCloseTo((692 / 792) * 100);
    expect(box.top).toBeCloseTo((72 / 612) * 100);
    expect(box.width).toBeCloseTo((20 / 792) * 100);
    expect(box.height).toBeCloseTo((100 / 612) * 100);
  });
  it('is null for a rectangle without area or a page without size', () => {
    expect(rectToBox([72, 700, 72, 720], LETTER)).toBeNull();
    expect(rectToBox([72, 700, 172, 700], LETTER)).toBeNull();
    expect(rectToBox([Number.NaN, 700, 172, 720], LETTER)).toBeNull();
    expect(rectToBox([72, 700, 172, 720], { ...LETTER, width: 0 })).toBeNull();
  });
});

describe('pageLinks', () => {
  const rect = [72, 692, 172, 712];
  it('keeps Link annotations with a safe URL or a destination', () => {
    const links = pageLinks([
      { subtype: 'Link', rect, url: 'https://example.org' },
      { subtype: 'Link', rect, dest: 'section.1' },
      { subtype: 'Link', rect, dest: [{ num: 12, gen: 0 }, { name: 'Fit' }] },
    ], LETTER);
    expect(links.map((l) => ('url' in l ? l.url : l.dest))).toEqual(['https://example.org/', 'section.1', [{ num: 12, gen: 0 }, { name: 'Fit' }]]);
    expect(links[0].box).toEqual(rectToBox(rect, LETTER));
  });
  it('drops unsafe URLs without falling back to anything else', () => {
    expect(pageLinks([
      { subtype: 'Link', rect, url: 'javascript:alert(1)' },
      { subtype: 'Link', rect, url: 'file:///etc/passwd', dest: 'section.1' },
      // pdf.js leaves `url` unset for a target it refuses and keeps it as unsafeUrl
      { subtype: 'Link', rect, unsafeUrl: 'javascript:alert(1)' },
    ], LETTER)).toEqual([]);
  });
  it('drops other annotations, actions without a target and links without a box', () => {
    expect(pageLinks([
      null,
      'Link',
      { subtype: 'Widget', rect, url: 'https://example.org' },
      { subtype: 'Text', rect, dest: 'section.1' },
      { subtype: 'Link', rect, action: 'NextPage' },
      { subtype: 'Link', rect, dest: 7 },
      { subtype: 'Link', url: 'https://example.org' },
      { subtype: 'Link', rect: [72, 700, 72, 700], url: 'https://example.org' },
    ], LETTER)).toEqual([]);
  });
});

describe('resolveDest', () => {
  const ref = { num: 40, gen: 0 };
  const lookup = (dests: Record<string, unknown[]>, pages: Record<number, number> = { 40: 1 }): DestLookup & { getDestination: ReturnType<typeof vi.fn> } => ({
    numPages: 3,
    getDestination: vi.fn(async (id: string) => dests[id] ?? null),
    getPageIndex: vi.fn(async (r: { num: number }) => {
      if (!(r.num in pages)) throw new Error('Invalid pageIndex request.');
      return pages[r.num];
    }),
  });

  it('looks a name up and finds its page and point', async () => {
    const doc = lookup({ 'section.2': [ref, { name: 'XYZ' }, 133.77, 667.2, null] });
    expect(await resolveDest(doc, 'section.2')).toEqual({ page: 2, x: 133.77, y: 667.2 });
    expect(doc.getDestination).toHaveBeenCalledWith('section.2');
  });
  it('takes an explicit destination as it is', async () => {
    const doc = lookup({});
    expect(await resolveDest(doc, [ref, { name: 'FitH' }, 500])).toEqual({ page: 2, x: null, y: 500 });
    expect(doc.getDestination).not.toHaveBeenCalled();
  });
  it('accepts a page index where a page reference belongs', async () => {
    expect(await resolveDest(lookup({}), [2, { name: 'XYZ' }, 0, 792, 0])).toEqual({ page: 3, x: 0, y: 792 });
  });
  it('reads the point of each kind of destination', async () => {
    const doc = lookup({});
    expect(await resolveDest(doc, [ref, { name: 'Fit' }])).toEqual({ page: 2, x: null, y: null });
    expect(await resolveDest(doc, [ref, { name: 'FitB' }])).toEqual({ page: 2, x: null, y: null });
    expect(await resolveDest(doc, [ref, { name: 'FitBH' }, 400])).toEqual({ page: 2, x: null, y: 400 });
    expect(await resolveDest(doc, [ref, { name: 'FitV' }, 90])).toEqual({ page: 2, x: 90, y: null });
    expect(await resolveDest(doc, [ref, { name: 'FitR' }, 72, 300, 300, 420])).toEqual({ page: 2, x: 72, y: 420 });
    // null means "keep the current one": there is none to keep here
    expect(await resolveDest(doc, [ref, { name: 'XYZ' }, null, null, null])).toEqual({ page: 2, x: null, y: null });
  });
  it('is null for a name the PDF does not define, or a lookup that fails', async () => {
    expect(await resolveDest(lookup({}), 'section.9')).toBeNull();
    const failing = lookup({});
    failing.getDestination.mockRejectedValueOnce(new Error('worker gone'));
    expect(await resolveDest(failing, 'section.1')).toBeNull();
  });
  it('is null for a page the PDF does not have', async () => {
    expect(await resolveDest(lookup({}), [{ num: 99, gen: 0 }, { name: 'Fit' }])).toBeNull();
    expect(await resolveDest(lookup({}), [3, { name: 'Fit' }])).toBeNull();
    expect(await resolveDest(lookup({}), [-1, { name: 'Fit' }])).toBeNull();
    expect(await resolveDest(lookup({}, { 40: 7 }), [ref, { name: 'Fit' }])).toBeNull();
  });
  it('is null for a malformed destination', async () => {
    const doc = lookup({ odd: ['section.1'] });
    for (const dest of [[], [ref], ['page', { name: 'Fit' }], [{ num: 'x', gen: 0 }, { name: 'Fit' }], [1.5, { name: 'Fit' }], 'odd']) {
      expect(await resolveDest(doc, dest as string | unknown[])).toBeNull();
    }
  });
});
