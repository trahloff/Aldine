# Aldine runner (experimental preview): runs one command on a throwaway copy
# of a project. docs/RUNNER.md is the design and the threat model; the
# container settings it requires are in deploy/docker-compose.runner.yml, and
# the control process refuses jobs when they are missing.
#
# Both bases are pinned by their multi-arch index digest
# (docker buildx imagetools inspect <image>:<tag>). Node.js is copied from
# the official image onto the Python one, which share the Debian release.
FROM node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS node

FROM python:3.13-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

# Releases pass their version as PACKAGES_REFRESH so this layer reruns and
# carries Debian's current security fixes (as in the compiler's Dockerfile).
ARG PACKAGES_REFRESH=
# The TeX Live parts Matplotlib's PGF backend and usetex need: XeLaTeX (its
# default), pdfLaTeX and LuaLaTeX, fontspec, pgf, the Computer Modern and
# Latin Modern fonts. util-linux brings prlimit and ipcrm.
RUN echo "packages as of: ${PACKAGES_REFRESH:-local build}" \
    && apt-get update && apt-get install -y --no-install-recommends \
       texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-xetex texlive-luatex \
       texlive-pictures texlive-fonts-recommended lmodern cm-super dvipng ghostscript fonts-dejavu-core \
       fontconfig libstdc++6 util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version

# Every package pinned by version and wheel hash; no install at run time.
COPY requirements.txt /opt/aldine-runner/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/aldine-runner/requirements.txt \
    && /opt/venv/bin/pip freeze --all | sort | sha256sum | cut -d' ' -f1 > /opt/aldine-runner/packages.sha256

# fontconfig's cache for every installed font (TeX Live's included), so
# XeLaTeX in a job does not scan them all again in its fresh home.
RUN fc-cache -s -f >/dev/null && fc-cache -s

# Matplotlib's font cache, built once here and copied into each job's home,
# so a job does not spend seconds rebuilding it.
RUN MPLCONFIGDIR=/opt/aldine-runner/mpl /opt/venv/bin/python -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot" \
    && chmod -R a+rX /opt/aldine-runner/mpl

# The job user. Its uid is the one RUNNER.md names (10101), shared with
# neither the app nor the compiler, and it owns nothing in the image.
RUN groupadd --gid 10101 job && useradd --uid 10101 --gid 10101 --no-create-home --home-dir /work/home --shell /usr/sbin/nologin job

COPY frames.js paths.js helper.js server.js /opt/aldine-runner/
ARG VERSION=dev
ENV RUNNER_VERSION=${VERSION}
# User 0 with only SETUID and SETGID (the compose overlay drops the rest): the
# control process starts every job step as uid 10101 and never runs job code.
USER 0
CMD ["node", "/opt/aldine-runner/server.js"]
