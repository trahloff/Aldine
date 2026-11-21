const MB = 1024 * 1024;

/** "0.4 MB", "7.5 MB", "512 MB": the server's refusals use the same figures. */
export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  const r = Math.round(mb * 10) / 10;
  return `${r === 0 && bytes > 0 ? 0.1 : r} MB`;
}

/** "120 MB of 500 MB", or "120 MB" without a limit. */
export function storageLine(usedBytes: number, limitBytes: number): string {
  return limitBytes > 0 ? `${formatMb(usedBytes)} of ${formatMb(limitBytes)}` : formatMb(usedBytes);
}
