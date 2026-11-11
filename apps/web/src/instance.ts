import { withBase } from './basePath';

/**
 * Who runs this instance (server: instance.ts, ALDINE_INSTANCE_* and
 * ALDINE_SUPPORT), stamped into index.html. Shown beside Aldine's own name,
 * never instead of it. null when the operator set none of it.
 */
export interface InstanceInfo {
  name: string | null;
  logo: string | null;
  logoDark: string | null;
  url: string | null;
  support: { kind: 'email' | 'url'; value: string } | null;
}

export function parseInstance(raw: string | null | undefined): InstanceInfo | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<InstanceInfo>;
    const str = (s: unknown) => (typeof s === 'string' && s ? s : null);
    const https = (s: unknown) => { const u = str(s); return u && /^https?:\/\//i.test(u) ? u : null; };
    const sup = v.support && (v.support.kind === 'email' || v.support.kind === 'url') && str(v.support.value) ? v.support : null;
    const info: InstanceInfo = {
      name: str(v.name),
      logo: str(v.logo) && /^[0-9a-f]{1,32}$/.test(v.logo!) ? v.logo! : null,
      logoDark: str(v.logo) && str(v.logoDark) && /^[0-9a-f]{1,32}$/.test(v.logoDark!) ? v.logoDark! : null,
      url: https(v.url),
      support: sup && (sup.kind === 'email' || https(sup.value)) ? { kind: sup.kind, value: sup.value } : null,
    };
    return info.name || info.logo || info.support ? info : null;
  } catch { return null; }
}

function readInstance(): InstanceInfo | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="aldine-instance"]') as HTMLMetaElement | null;
  return parseInstance(meta?.content);
}

export const INSTANCE: InstanceInfo | null = readInstance();

export const instanceLogoSrc = (i: InstanceInfo) => (i.logo ? withBase(`/api/instance/logo?v=${i.logo}`) : null);
export const instanceDarkLogoSrc = (i: InstanceInfo) => (i.logo && i.logoDark ? withBase(`/api/instance/logo/dark?v=${i.logoDark}`) : null);

/** Where the support contact leads: a mailto: link or the operator's help page. */
export function supportHref(s: NonNullable<InstanceInfo['support']>): string {
  return s.kind === 'email' ? `mailto:${s.value}` : s.value;
}
