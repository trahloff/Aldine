/**
 * multipart/form-data for a single file upload, parsed from a buffered body.
 * The import route needs the whole ZIP in memory anyway (random access into
 * the central directory), so buffering costs nothing extra and keeps the
 * server free of a multipart dependency. Field bodies are returned as raw
 * bytes; text fields are decoded as UTF-8 by the caller.
 */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function multipartBoundary(contentType: string | undefined): string | null {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const b = (m?.[1] ?? m?.[2])?.trim();
  return b || null;
}

/** RFC 7578 parts, in order; throws on a body that does not fit the framing. */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new Error('multipart body has no boundary');
  pos += delim.length;
  for (;;) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts; // closing "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;
    else throw new Error('multipart boundary is not followed by a line break');
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new Error('multipart part has no header block');
    const headers = body.toString('latin1', pos, headerEnd);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), dataStart);
    if (next < 0) throw new Error('multipart part is not closed by a boundary');
    const disposition = /^content-disposition:\s*(.*)$/im.exec(headers)?.[1] || '';
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) throw new Error('multipart part has no field name');
    const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    const contentType = /^content-type:\s*(.*)$/im.exec(headers)?.[1]?.trim();
    parts.push({ name, filename, contentType, data: body.subarray(dataStart, next) });
    pos = next + 2 + delim.length;
  }
}
