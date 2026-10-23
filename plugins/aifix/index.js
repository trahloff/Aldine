/**
 * AI error-fix plugin. On a failed typeset, sends the errors + source to the
 * server's AI route (which proxies an LLM with a server-held key) and renders a
 * plain-English explanation plus one-click fixes applied as exact find/replace.
 */

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

export default {
  activate(aldine) {
    aldine.ui.registerSidebarPanel({
      id: 'aifix',
      title: 'Fix',
      render(root) {
        let busy = false;
        let result = null;   // { explanation, fixes: [...] }
        let configured = null; // null=unknown, true/false
        let autoFix = false;   // ALDINE_AI_AUTOFIX on the server
        let error = '';
        let diagnosed = new Set(); // the errors the result answers

        // warnings stay after a fix, so only errors say whether a result still applies
        const errorKeys = (c) => (c && !c.ok ? c.errors.filter((e) => e.type !== 'warning').map((e) => `${e.file ?? ''}\n${e.message}`) : []);

        const jfetch = async (url, init) => {
          const res = await aldine.fetch(url, init ? { headers: { 'content-type': 'application/json' }, ...init } : undefined);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          return body;
        };

        const checkConfig = async () => {
          try {
            const status = await jfetch('/api/ai/status');
            configured = status.configured;
            autoFix = !!status.autoFix;
          } catch { configured = false; }
          draw();
        };

        const diagnose = async () => {
          const compile = aldine.project.lastCompile();
          if (!compile) { aldine.toast('Typeset the document first to check for errors.', 'info'); return; }
          if (compile.ok) { aldine.toast('Your document compiles cleanly — no errors to fix.', 'ok'); return; }
          busy = true; error = ''; result = null; diagnosed = new Set(errorKeys(compile)); draw();
          try {
            result = await jfetch(`/api/projects/${aldine.project.id}/ai/fix`, {
              method: 'POST',
              body: JSON.stringify({ branch: aldine.project.branch, errors: compile.errors, log: compile.log }),
            });
          } catch (err) {
            error = err.message;
          }
          busy = false; draw();
        };

        const applyFix = async (fix) => {
          try {
            const res = await aldine.fetch(`/api/projects/${aldine.project.id}/file?branch=${encodeURIComponent(aldine.project.branch)}&path=${encodeURIComponent(fix.file)}`);
            if (!res.ok) throw new Error(`could not read ${fix.file}`);
            const content = await res.text();
            if (!content.includes(fix.find)) throw new Error('the target text has changed — re-run diagnosis');
            const updated = content.replace(fix.find, () => fix.replace); // literal replace (LaTeX $$/$& are not patterns)
            const put = await aldine.fetch(`/api/projects/${aldine.project.id}/file`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ branch: aldine.project.branch, path: fix.file, content: updated }),
            });
            if (!put.ok) throw new Error('could not save the fix');
            aldine.toast(`Applied fix to ${fix.file}`, 'ok');
            fix._applied = true;
            draw();
            aldine.compile();
          } catch (err) {
            aldine.toast(`Could not apply: ${err.message}`, 'error');
          }
        };

        function draw() {
          const wrap = h('div', { class: 'panel-list', dataset: { testid: 'aifix-panel' }, style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' } });

          if (configured === false) {
            wrap.append(
              h('div', { class: 'menu__label', style: { padding: '0 2px' } }, 'AI fix'),
              h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: 0 } },
                'AI error-fix is off. Set ', h('code', {}, 'ANTHROPIC_API_KEY'), ' on the Aldine server (BYO key) and restart to enable one-click LaTeX fixes.'),
            );
            root.replaceChildren(wrap);
            return;
          }

          wrap.append(h('div', { class: 'menu__label', style: { padding: '0 2px' } }, 'AI fix'));

          const compile = aldine.project.lastCompile();
          const hasErrors = compile && !compile.ok;
          const hint = hasErrors ? 'Diagnose the current compile errors and apply fixes.'
            : compile && compile.ok ? 'Your document compiles cleanly — nothing to fix right now. This tool fixes compile errors, not warnings.'
            : 'Typeset the document; if it fails, come back here to diagnose and fix.';

          wrap.append(
            h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: 0 } }, hint),
            h('button', {
              class: 'btn btn--primary',
              style: { width: '100%', justifyContent: 'center' },
              dataset: { testid: 'aifix-diagnose' },
              disabled: busy ? '' : null,
              onclick: diagnose,
            }, busy ? 'Diagnosing…' : 'Diagnose & fix'),
          );

          if (autoFix) wrap.append(h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: 0 }, dataset: { testid: 'aifix-auto' } },
            'A failed typeset opens this tab and runs the diagnosis on its own.'));

          if (error) wrap.append(h('p', { style: { color: 'var(--error)', fontSize: '12px' } }, error));

          if (result) {
            wrap.append(
              h('div', { style: { fontSize: '12.5px', lineHeight: '1.5', background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: '8px', padding: '10px' }, dataset: { testid: 'aifix-explanation' } },
                result.explanation || 'No explanation.'),
            );
            if (!result.fixes || !result.fixes.length) {
              wrap.append(h('p', { style: { color: 'var(--text-2)', fontSize: '12px' } }, 'No automatic fix proposed — check the explanation.'));
            }
            for (let i = 0; i < (result.fixes || []).length; i++) {
              const fix = result.fixes[i];
              wrap.append(h('div', { style: { border: '1px solid var(--hairline)', borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: { fontSize: '11px', color: 'var(--text-2)' } }, `${fix.file}${fix.note ? ' · ' + fix.note : ''}`),
                h('pre', { style: { margin: 0, fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--error)' } }, '- ' + fix.find.slice(0, 200)),
                h('pre', { style: { margin: 0, fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--ok)' } }, '+ ' + fix.replace.slice(0, 200)),
                h('button', {
                  class: 'btn btn--small',
                  style: { alignSelf: 'flex-start' },
                  dataset: { testid: `aifix-apply-${i}` },
                  disabled: fix._applied ? '' : null,
                  onclick: () => applyFix(fix),
                }, fix._applied ? 'Applied ✓' : 'Apply fix'),
              ));
            }
          }

          root.replaceChildren(wrap);
        }

        draw();
        checkConfig();

        // keep the hint fresh as the user typesets, and drop a result once the
        // errors it answered are gone, fixed here or by hand
        let lastHadErrors = null;
        const poll = setInterval(() => {
          if (!root.isConnected) { clearInterval(poll); return; }
          const c = aldine.project.lastCompile();
          const has = !!(c && !c.ok);
          if (busy) return;
          const keys = errorKeys(c);
          const stale = (result || error) && (!has || (diagnosed.size > 0 && !keys.some((k) => diagnosed.has(k))));
          if (stale) { result = null; error = ''; diagnosed = new Set(); }
          // once per new error, so auto-typeset re-running the same failure costs nothing
          if (autoFix && configured && keys.some((k) => !diagnosed.has(k))) {
            lastHadErrors = has;
            aldine.ui.showPanel('aifix');
            diagnose();
            return;
          }
          if (has !== lastHadErrors || stale) { lastHadErrors = has; draw(); }
        }, 1500);
      },
    });
  },
};
