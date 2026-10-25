/**
 * A minimal SMTP listener on a free local port for tests that check what the
 * instance mails: every accepted message lands in `mails` as raw text.
 */
import net from 'node:net';

export async function startSmtp() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const cmd = buf.slice(0, nl).slice(0, 4).toUpperCase();
        buf = buf.slice(nl + 2);
        if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  /** Wait until `n` mails arrived in total, then return the newest. */
  const waitFor = async (n, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (mails.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (mails.length < n) throw new Error(`expected ${n} mails, got ${mails.length}`);
    return mails[n - 1];
  };
  return { port: server.address().port, mails, waitFor, close: () => server.close() };
}

/** The message with quoted-printable undone, plus any base64 part decoded. */
export function decoded(raw) {
  const qp = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/gi)]
    .map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));
  return [qp, ...b64].join('\n');
}

/** Every body part as text: raw and decoded. */
export function readable(raw) {
  return `${raw}\n${decoded(raw)}`;
}
