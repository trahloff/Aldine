# Venue kits fetched from the publisher (spec)

Context: issue #9 asked for "as many journal and conference templates as
possible". The gallery in PR #22 covers the fifteen venue classes TeX Live
actually installs. Every remaining venue (NeurIPS, ICLR, ICML, ACL, CVPR,
AAAI, USENIX, IJCAI, SIAM, MDPI, Copernicus, Springer Nature, Elsevier CAS,
IOP, SAGE, Taylor & Francis, PLOS, Frontiers, eLife and friends) publishes a
zip on its own site and is absent from TeX Live.

Decision by the owner (2026-09-04): **fetch the kit from the publisher when
the user creates the project**. Aldine redistributes nothing, so the licence
question is the publisher's own terms between them and the author. Ship as
many venues as can be made to work.

## Rules

1. **The server fetches, never the compiler.** The compiler has no egress by
   design (deploy/docker-compose): keep it that way.
2. **A fixed registry, no user-supplied URLs.** `templates/venues.json` in the
   repo is the only source of kit URLs. Nothing in a request may influence the
   URL, so there is no SSRF surface. Reject a registry entry at load time whose
   URL is not `https:` or whose host is not in the entry's own allowlist.
3. **A failed fetch never fails project creation.** The project is created from
   the generated skeleton plus a short `README-venue.md` naming the venue, the
   kit URL and what to do. The user sees one toast saying the kit could not be
   downloaded and the project was created from a skeleton.
4. **Nothing from a publisher is committed to this repo.** Fixtures for tests
   are built in-test.
5. Caps and manners: 20 s timeout, 25 MB per kit, redirects followed only to
   the same host (max 3), `content-type` must look like a zip or a tex/style
   file, `User-Agent: Aldine/<version> (+https://aldine.dev)`. Cache a
   successful kit under `CACHE_DIR/venue-kits/<id>/` and reuse it for 7 days;
   a cached kit is used when the fetch fails, whatever its age.
6. Unpack with the project's own hardened `unzip.ts`. Take only the files the
   registry entry names (globs), never the whole archive, and never anything
   that `importPath` rejects. A kit that does not contain the named files is a
   failure, so rule 3 applies.

## Registry entry

```json
{
  "id": "neurips",
  "name": "NeurIPS",
  "category": "Conferences",
  "description": "Neural Information Processing Systems submission.",
  "homepage": "https://neurips.cc/Conferences/2025/PaperInformation/StyleFiles",
  "termsUrl": "https://neurips.cc/...",
  "kit": {
    "url": "https://media.neurips.cc/Conferences/NeurIPS2025/Styles.zip",
    "host": "media.neurips.cc",
    "take": ["*.sty", "*.bst", "*.tex"],
    "rename": { "neurips_2025.sty": "neurips.sty" }
  },
  "documentClass": "article",
  "preamble": ["\\usepackage{neurips}"],
  "bibStyle": "plainnat",
  "main": "main.tex"
}
```

`main` names the file the kit itself provides as a starting document when it
has one; otherwise Aldine generates the skeleton and loads the kit's style
from the preamble list. The tile shows the venue name, the category, and
"downloads the official kit from <host>".

## Research stage (do this first)

For every venue below, find the current official kit URL and record what the
page says about reuse. Verify each URL actually returns a zip or style file
(HEAD or a ranged GET, do not download the whole thing repeatedly). Drop a
venue that has no stable public URL, and say so in the summary rather than
guessing a URL.

Conferences: NeurIPS, ICLR, ICML, ACL/EMNLP/NAACL, CVPR/ICCV/ECCV, AAAI,
IJCAI, USENIX, SIGGRAPH, CHI (acmart covers CHI, note it), KDD/WWW (acmart),
COLING, ECAI, AISTATS, CoRL, ICRA/IROS (IEEEtran, note it).

Journals: SIAM, MDPI, Copernicus, Springer Nature (sn-jnl), Elsevier CAS,
IOP, SAGE, Taylor & Francis (interact), PLOS, Frontiers, eLife, Wiley,
Optica, APS (REVTeX covers), Nature (no public LaTeX kit — check), Science
(check), Cell Press, BMJ, JMLR (already a class), Physical Review (REVTeX).

A venue already covered by an installed class must NOT get a second tile:
name it in the summary instead.

## Acceptance

- Unit tests for the fetcher against a local HTTP server: success, 404,
  timeout, oversize, wrong content type, corrupt zip, missing named files,
  redirect off-host, cache hit, stale cache after a failure. No network in
  tests.
- Registry validation test: every entry parses, has an https URL whose host
  matches `kit.host`, a homepage, a category, and either `main` or a
  preamble.
- One e2e: a venue tile whose kit URL points at a local fixture server creates
  a project containing the kit's files; with the server down, the project is
  created from the skeleton and the toast says so.
- The gallery lists installed-class venues and fetched venues together,
  deduplicated by venue.
- CHANGELOG entry. No publisher file in the repo. `npm run templates:check`
  still passes.
- Report in the summary: how many venues the registry carries, which were
  dropped and why, and which are covered by an installed class instead.
