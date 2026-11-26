/**
 * The largest project ZIP the import accepts: ALDINE_IMPORT_MAX_MB, whole
 * megabytes from 1 to 1024, 60 when unset. There is no "unlimited": the whole
 * archive is in memory while it is imported, next to its unpacked files, so a
 * limit is what keeps one upload from taking the server down. A reverse proxy
 * in front must allow `proxyBodyMb` or it refuses the upload first.
 */
export const IMPORT_DEFAULT_MB = 60;
export const IMPORT_CEILING_MB = 1024;

/** Unpacked, an archive may hold this many times the ZIP limit, and never less than 200 MB. */
const UNPACKED_FACTOR = 3;
const UNPACKED_FLOOR_BYTES = 200 * 1024 * 1024;

export interface ImportLimit {
  mb: number;
  zipBytes: number;
  unpackedBytes: number;
  /** Request body the import route accepts: the ZIP base64-encoded inside JSON, plus 1 MB. */
  bodyBytes: number;
  warning: string | null;
}

export function importLimit(env: NodeJS.ProcessEnv = process.env): ImportLimit {
  const raw = (env.ALDINE_IMPORT_MAX_MB ?? '').trim();
  let mb = IMPORT_DEFAULT_MB;
  let warning: string | null = null;
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      warning = `[aldine] ALDINE_IMPORT_MAX_MB="${raw}" is not a whole number of megabytes from 1 to ${IMPORT_CEILING_MB}; ZIP import stays at ${IMPORT_DEFAULT_MB} MB`;
    } else if (n > IMPORT_CEILING_MB) {
      mb = IMPORT_CEILING_MB;
      warning = `[aldine] ALDINE_IMPORT_MAX_MB=${raw} is above the ${IMPORT_CEILING_MB} MB this server accepts; ZIP import is limited to ${IMPORT_CEILING_MB} MB`;
    } else {
      mb = n;
    }
  }
  const zipBytes = mb * 1024 * 1024;
  return {
    mb,
    zipBytes,
    unpackedBytes: Math.max(UNPACKED_FLOOR_BYTES, zipBytes * UNPACKED_FACTOR),
    bodyBytes: Math.ceil(zipBytes * 4 / 3) + 1024 * 1024,
    warning,
  };
}

export const IMPORT_LIMIT = importLimit();

/** What a reverse proxy in front has to allow, in whole megabytes. */
export const proxyBodyMb = (limit: ImportLimit = IMPORT_LIMIT) => Math.ceil(limit.bodyBytes / (1024 * 1024));
