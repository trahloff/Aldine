export interface ZipEntry {
  data?: Buffer | string;
  /** 0 store (default), 8 deflate, any other id written as-is (bzip2 12, LZMA 14, AES 99). */
  method?: number;
  /** General-purpose bits: 0x1 encrypted, 0x800 UTF-8 name. */
  flags?: number;
  /** Raw name bytes in place of the key's UTF-8 (cp437 / Latin-1 names). */
  nameBytes?: Buffer;
  /** Extra field bytes for the central directory header. */
  extra?: Buffer;
}
export function buildZip(entries: Record<string, Buffer | string | ZipEntry>, opts?: { zip64?: boolean }): Buffer;
export function unicodePathExtra(rawName: Buffer, utf8Name: string): Buffer;
