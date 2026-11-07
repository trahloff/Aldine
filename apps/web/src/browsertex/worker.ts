/**
 * The TeX engine's worker: a classic worker (the build's scripts load with
 * importScripts) and the only code in Aldine that knows the build's API —
 * BusytexPipeline from TeXlyre's busytex_pipeline.js, which the server hands
 * out as opaque files (apps/server/src/browsertex/manifest.ts). Speaks
 * host.ts's messages on the other side; another engine would be another
 * worker behind the same messages.
 *
 * No imports: a module worker has no importScripts.
 */
(() => {
  const scope = self as any;

  type Init = { type: 'init'; base: string; bundle: string; biber: boolean };
  type Compile = {
    type: 'compile';
    id: number;
    files: Array<{ path: string; contents: Uint8Array | string }>;
    main: string;
    engine: string;
    draft: boolean;
    endpoint: string;
  };

  const DRIVERS: Record<string, string> = {
    pdf: 'pdftex_bibtex8',
    xelatex: 'xetex_bibtex8_dvipdfmx',
    lualatex: 'luahbtex_bibtex8',
  };

  let pipeline: any = null;
  let bundleUrl = '';

  const post = (msg: unknown, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

  function print(text: string) {
    const m = /Downloading data\.\.\. \((\d+)\/(\d+)\)/.exec(text);
    if (m) post({ type: 'progress', loaded: Number(m[1]), total: Number(m[2]) });
  }

  async function init(msg: Init) {
    const at = (name: string) => new URL(name, msg.base).toString();
    scope.importScripts(at('busytex_biber.js'), at('busytex_pipeline.js'));
    const Pipeline = scope.BusytexPipeline;
    bundleUrl = at(msg.bundle);
    pipeline = new Pipeline(
      at('busytex.js'), at('busytex.wasm'),
      [bundleUrl], [bundleUrl], [],
      print, () => {}, true, Pipeline.ScriptLoaderWorker,
      msg.biber ? at('biber.js') : null, msg.biber ? at('biber.wasm') : null, msg.biber ? at('biber.data') : null,
    );
    // TeX wraps log lines at 79 columns unless told otherwise, and a wrapped
    // file name or "on input line" defeats the log parser. The environment is
    // copied into the module before its first run.
    if (pipeline.env && typeof pipeline.env === 'object') pipeline.env.max_print_line = '10000';
    await pipeline.Module;
    await pipeline.on_initialized_promise;
  }

  async function compile(msg: Compile) {
    const r = await pipeline.compile(
      msg.files, msg.main,
      msg.draft ? false : null, // bibtex: auto-detect, none in a draft
      msg.draft ? false : null, // biber: auto-detect from backend=biber
      msg.draft ? false : null, // makeindex
      !msg.draft,               // rerun until references settle
      'silent',
      DRIVERS[msg.engine] ?? DRIVERS.pdf,
      [bundleUrl],
      msg.endpoint || '',
      false,
    );
    const logs: Array<{ cmd: string; log: string; stdout: string }> = Array.isArray(r.logs) ? r.logs : [];
    const isTex = (cmd: string) => !/^(bibtex|biber|makeindex|xdvipdfmx)/.test(cmd);
    const tex = [...logs].reverse().find((l) => isTex(l.cmd) && l.log);
    const bib = [...logs].reverse().find((l) => /^(bibtex|biber)/.test(l.cmd));
    const pdf: Uint8Array | null = r.pdf && r.pdf.length ? r.pdf : null;
    const synctex: Uint8Array | null = r.synctex && r.synctex.length ? r.synctex : null;
    post({
      type: 'result', id: msg.id,
      exitCode: typeof r.exit_code === 'number' ? r.exit_code : 1,
      pdf, synctex,
      log: tex?.log ?? '',
      blg: bib?.log ?? '',
      transcript: typeof r.log === 'string' ? r.log : '',
    }, [pdf?.buffer, synctex?.buffer].filter(Boolean) as Transferable[]);
  }

  scope.onmessage = async ({ data }: MessageEvent<Init | Compile>) => {
    try {
      if (data.type === 'init') { await init(data); post({ type: 'ready' }); }
      else if (data.type === 'compile') await compile(data);
    } catch (err: any) {
      post({ type: 'error', id: (data as Compile).id, message: String(err?.message ?? err) });
    }
  };
})();
