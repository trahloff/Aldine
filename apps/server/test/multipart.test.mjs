/** The single-file multipart parser: browser framing, quoted boundaries, binary bodies, malformed input. */
import { check, eq, throws } from './assert.mjs';

const { parseMultipart, multipartBoundary } = await import('../src/multipart.ts');

eq(multipartBoundary('multipart/form-data; boundary=----WebKitFormBoundaryabc'), '----WebKitFormBoundaryabc', 'bare boundary');
eq(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b"'), 'a b', 'quoted boundary');
eq(multipartBoundary('application/json'), null, 'no boundary');

const bin = Buffer.from([0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x50, 0x4b]);
const body = Buffer.concat([
  Buffer.from('preamble\r\n--XX\r\nContent-Disposition: form-data; name="name"\r\n\r\nMy paper\r\n--XX\r\n'),
  Buffer.from('Content-Disposition: form-data; name="zip"; filename="a.zip"\r\nContent-Type: application/zip\r\n\r\n'),
  bin,
  Buffer.from('\r\n--XX--\r\n'),
]);
const parts = parseMultipart(body, 'XX');
eq(parts.map((p) => p.name), ['name', 'zip'], 'both parts, in order');
eq(parts[0].data.toString(), 'My paper', 'text field bytes');
eq(parts[1].filename, 'a.zip', 'filename');
eq(parts[1].contentType, 'application/zip', 'content type');
check(parts[1].data.equals(bin), 'binary body byte-exact, CRLF and -- inside the data left alone');

eq(parseMultipart(Buffer.from('--XX--'), 'XX'), [], 'empty form');
await throws(() => parseMultipart(Buffer.from('nothing'), 'XX'), 'no boundary', 'body without the boundary');
await throws(() => parseMultipart(Buffer.from('--XX\r\nContent-Disposition: form-data; name="a"\r\n\r\nunterminated'), 'XX'), 'not closed', 'missing closing boundary');
await throws(() => parseMultipart(Buffer.from('--XX\r\nContent-Type: text/plain\r\n\r\nx\r\n--XX--'), 'XX'), 'no field name', 'part without a name');

console.log('multipart: all checks passed');
