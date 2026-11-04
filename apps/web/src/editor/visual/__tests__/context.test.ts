import { describe, it, expect, vi } from 'vitest';

vi.mock('../refresh', () => ({ pokeViews: vi.fn() }));
vi.mock('../../../api', () => ({ api: { bib: () => Promise.resolve([]) } }));

import { pokeViews } from '../refresh';
import { figureFile, fileVersion, setVisualContext, setVisualFiles } from '../context';

describe('figure previews and the file listing (vis-23)', () => {
  it('redraw when a figure\'s own file changes or a file comes or goes, never for another file\'s new mtime', () => {
    const poke = vi.mocked(pokeViews);
    setVisualContext('p', 'main');
    setVisualFiles('p', 'main', [{ path: 'main.tex', mtime: 1 }, { path: 'plot.png', mtime: 1 }]);
    expect(figureFile('plot')).toBe('plot.png');
    expect(fileVersion('plot.png')).toBe(1);
    poke.mockClear();

    setVisualFiles('p', 'main', [{ path: 'main.tex', mtime: 2 }, { path: 'plot.png', mtime: 1 }]);
    expect(poke).not.toHaveBeenCalled();
    expect(fileVersion('main.tex')).toBe(2);

    setVisualFiles('p', 'main', [{ path: 'main.tex', mtime: 2 }, { path: 'plot.png', mtime: 3 }]);
    expect(poke).toHaveBeenCalledTimes(1);
    expect(fileVersion('plot.png')).toBe(3);

    setVisualFiles('p', 'main', [{ path: 'main.tex', mtime: 2 }, { path: 'plot.png', mtime: 3 }, { path: 'other.tex', mtime: 1 }]);
    expect(poke).toHaveBeenCalledTimes(2);
  });
});
