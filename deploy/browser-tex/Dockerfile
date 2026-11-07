# The app image with the browser TeX build baked in: no download at first
# start, and the exact build pinned by this image. Build it yourself:
#
#   docker build -f deploy/browser-tex/Dockerfile \
#     --build-arg ALDINE_VERSION=1.9.1 --build-arg BROWSER_TEX_PROFILE=recommended \
#     -t aldine-app:1.9.1-browser .
#
# then use it as the image in docker-compose.browser.yml. The build's
# license texts (TeXlyre's AGPL-3.0 and NOTICE) are baked in beside it and
# served with it; TeX Live's own licenses travel inside its data bundles.
ARG ALDINE_VERSION=1.9.1
FROM ghcr.io/trahloff/aldine-app:${ALDINE_VERSION}
ARG BROWSER_TEX_PROFILE=recommended
# Another build (a newer release, your own mirror): COPY a manifest of the
# shape apps/server/src/browsertex/manifest.ts describes into the image and
# set ALDINE_BROWSER_TEX_MANIFEST to it before this RUN, in a derived file.
RUN node dist/browsertex/fetch.js --into /srv/browser-tex --profile "$BROWSER_TEX_PROFILE"
ENV ALDINE_TYPESET=browser \
    ALDINE_BROWSER_TEX_PROFILE=${BROWSER_TEX_PROFILE} \
    ALDINE_BROWSER_TEX_DIR=/srv/browser-tex
