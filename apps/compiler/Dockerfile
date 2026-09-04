# Two selectable TeX Live schemes (build arg TEXLIVE_SCHEME=medium|full):
#
#   medium (default) — ~1.3 GB of packages plus a pinned set of extras real
#     papers commonly need, the publisher classes, and the Arabic/Persian,
#     Cyrillic, Greek and "other" script collections. CJK is the one family
#     left to full. About 3.7 GB on disk; this is the published
#     aldine-compiler:<version> image.
#   full — everything on CTAN preinstalled (~9 GB on disk). Every script and
#     language TeX Live supports compiles out of the box. Published as
#     aldine-compiler:<version>-full (ALDINE_TEXLIVE=-full in compose), or
#     built locally:
#       ALDINE_TEXLIVE_SCHEME=full docker compose -f docker-compose.full.yml up -d --build
#
# Both bases are pinned by digest. For medium the pin keeps tlmgr revisions
# reproducible (a floating tag makes the snapshot-repository date below drift
# out of sync and the build fail); its digest must be OLDER than the snapshot
# date, never newer. For full nothing is installed at build time, so the pin
# only makes a rebuild reproduce the same image. Each digest is the multi-arch
# index digest reported by
#   docker buildx imagetools inspect texlive/texlive:<tag>
# (the top-level "Digest:" line, not a per-platform manifest).
ARG TEXLIVE_SCHEME=medium

FROM texlive/texlive:latest-medium@sha256:0a5aa82d0d9d6e3b3a25f87e221ef61d7c077e83639ab5065cf298b1a01ec00c AS texlive-medium

# Packages beyond scheme-medium that real papers commonly need (newtx fonts,
# cleveref, etc.) plus collection-publishers: the journal and conference
# classes (elsarticle, IEEEtran, acmart, revtex4-2, agujournal, copernicus, …)
# that scheme-medium leaves out, the script collections (langarabic makes
# xepersian/bidi/polyglossia compile — verified against a Persian document —
# and needs zref from latexextra), and cyrillic/greek/other. A dated tlnet snapshot (not a random CTAN
# mirror) because live mirrors regularly lag the texlive image's revisions,
# which makes `tlmgr install` fail with "remote database is older than the
# local installation". Bump the date together with the base-image digest.
RUN tlmgr option repository https://texlive.info/tlnet-archive/2026/07/18/tlnet/ \
    && tlmgr update --self \
    && tlmgr install collection-publishers collection-langarabic collection-langcyrillic \
       collection-langgreek collection-langother zref newtx txfonts fontaxes lastpage titlesec xstring fancyhdr cleveref \
       enumitem wrapfig threeparttable placeins multirow doclicense algorithmicx xurl sttools acro translations

FROM texlive/texlive:latest-full@sha256:4984977ccf5afe883cb382d0163f267de0d029d140bb7a9e8f4c19f0b781d57b AS texlive-full
# scheme-full already contains every CTAN package — nothing to install.

FROM texlive-${TEXLIVE_SCHEME} AS base

# Node.js for the compile service wrapper
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Warm biber's PAR self-extraction cache at build time. Cold extraction takes
# ~90s, which would blow the compile timeout on a user's very first biblatex
# compile — and the killed half-extracted cache then wedges every compile after.
RUN biber --version

# Restricted (partial) shell-escape: allow only the vetted whitelist (epstopdf,
# kpsewhich, bibtex, …) so EPS auto-conversion works and the epstopdf warning
# goes away — but arbitrary \write18 commands stay blocked. Same posture as
# Overleaf/TeX Live default; safe alongside the no-egress + dropped-caps sandbox.
RUN tlmgr conf texmf shell_escape p

WORKDIR /srv
COPY server.js catalog.js ./
# server.js reports the scheme at GET /health; the ARG must be re-declared
# after FROM to be visible in this stage.
ARG TEXLIVE_SCHEME
RUN echo "${TEXLIVE_SCHEME}" > /srv/texlive-scheme
ENV PORT=4020 \
    DATA_DIR=/data \
    openin_any=p \
    openout_any=p

EXPOSE 4020
CMD ["node", "server.js"]
