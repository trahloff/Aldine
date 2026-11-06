import { describe, it, expect } from 'vitest';
import { gatherDrop, pickedFolder, runPool, toBase64, type DropRoot } from '../upload';

/** A File as a dropped folder's entry hands it out. */
const blob = (name: string, text = 'x', relative = '') => {
  const f = new File([text], name);
  if (relative) Object.defineProperty(f, 'webkitRelativePath', { value: relative });
  return f;
};

type Tree = { [name: string]: string | Tree | Error };

/** Entries the way webkitGetAsEntry gives them, readEntries in batches of two
 *  as a real reader cuts a long folder into several. An Error stands for an
 *  entry that cannot be read. */
function entry(name: string, node: string | Tree | Error): FileSystemEntry {
  if (typeof node === 'string' || node instanceof Error) {
    return {
      name, isFile: true, isDirectory: false,
      file: (ok: (f: File) => void, fail: (e: unknown) => void) => (node instanceof Error ? fail(node) : ok(blob(name, node))),
    } as unknown as FileSystemEntry;
  }
  return {
    name, isFile: false, isDirectory: true,
    createReader: () => {
      const all = Object.entries(node).map(([k, v]) => entry(k, v));
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => ok(all.splice(0, 2)) };
    },
  } as unknown as FileSystemEntry;
}

const folder = (name: string, tree: Tree): DropRoot => ({ entry: entry(name, tree), file: null });

describe('gatherDrop', () => {
  it('walks a dropped folder, nested folders and long ones included, to paths inside it', async () => {
    const got = await gatherDrop([folder('figures', { 'a.png': 'a', 'b.png': 'b', 'c.png': 'c', plots: { 'd.pdf': 'd' } })], 100);
    expect(got.picked.map((p) => p.path).sort()).toEqual(['figures/a.png', 'figures/b.png', 'figures/c.png', 'figures/plots/d.pdf']);
    expect(got).toMatchObject({ unreadable: [], empty: [], tooMany: false });
  });

  it('leaves dot-files and dot-folders such as .git out, but keeps .latexmkrc', async () => {
    const got = await gatherDrop([folder('paper', { 'main.tex': 'x', '.DS_Store': 'x', '.latexmkrc': 'x', '.git': { HEAD: 'ref' } })], 100);
    expect(got.picked.map((p) => p.path).sort()).toEqual(['paper/.latexmkrc', 'paper/main.tex']);
  });

  it('takes a file dropped beside the folder as it is, and names what it could not read', async () => {
    const got = await gatherDrop([
      { entry: null, file: blob('notes.txt') },
      folder('figures', { 'ok.png': 'x', 'gone.png': new Error('NotFoundError') }),
    ], 100);
    expect(got.picked.map((p) => p.path)).toEqual(['notes.txt', 'figures/ok.png']);
    expect(got.unreadable).toEqual(['figures/gone.png']);
  });

  it('names a folder with nothing to upload, a dot-folder dropped on its own too', async () => {
    const got = await gatherDrop([folder('empty', { '.DS_Store': 'x' }), folder('.git', { HEAD: 'x' })], 100);
    expect(got.picked).toEqual([]);
    expect(got.empty).toEqual(['empty', '.git']);
  });

  it('stops past the limit', async () => {
    const many: Tree = {};
    for (let i = 0; i < 12; i++) many[`f${i}.png`] = 'x';
    const got = await gatherDrop([folder('figures', many)], 10);
    expect(got.tooMany).toBe(true);
    expect((await gatherDrop([folder('figures', many)], 12)).tooMany).toBe(false);
  });
});

describe('pickedFolder', () => {
  it('keeps each file at its path inside the chosen folder, without dot-files and dot-folders', () => {
    const picked = pickedFolder([
      blob('a.png', 'x', 'figures/a.png'),
      blob('.DS_Store', 'x', 'figures/.DS_Store'),
      blob('config', 'x', 'figures/.git/config'),
      blob('b.pdf', 'x', 'figures/plots/b.pdf'),
    ]);
    expect(picked.map((p) => p.path)).toEqual(['figures/a.png', 'figures/plots/b.pdf']);
  });
});

describe('runPool', () => {
  it('runs every item, never more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5 * (n % 3)));
      seen.push(n);
      running -= 1;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });
});

describe('toBase64', () => {
  it('encodes bytes past one chunk', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 251);
    expect(toBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
