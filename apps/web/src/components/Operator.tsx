import { INSTANCE, instanceDarkLogoSrc, instanceLogoSrc, supportHref, type InstanceInfo } from '../instance';

/**
 * The instance operator's mark (ALDINE_INSTANCE_*), always next to Aldine's
 * own wordmark and never in its place. Nothing renders when the operator set
 * nothing.
 */

function Mark({ i, height }: { i: InstanceInfo; height: number }) {
  const src = instanceLogoSrc(i);
  const dark = instanceDarkLogoSrc(i);
  const alt = i.name ? '' : 'Operator logo';
  // Both images are in the page; the theme on <html> shows one (app.css).
  return (
    <>
      {src && <img className={`operator__logo${dark ? ' operator__logo--light' : ''}`} src={src} alt={alt} style={{ height }} data-testid="operator-logo" />}
      {dark && <img className="operator__logo operator__logo--dark" src={dark} alt={alt} style={{ height }} data-testid="operator-logo-dark" />}
      {i.name && <span className="operator__name" data-testid="operator-name">{i.name}</span>}
    </>
  );
}

/** "| [logo] Kiel University" beside the wordmark in the project list's bar. On a phone only the logo, if there is one. */
export function OperatorBadge({ compact = false, info = INSTANCE }: { compact?: boolean; info?: InstanceInfo | null }) {
  if (!info || (!info.name && !info.logo)) return null;
  const shown = compact ? (info.logo ? { ...info, name: null } : null) : info;
  if (!shown) return null;
  const title = info.name ? `Provided by ${info.name}` : 'Provider of this Aldine instance';
  const body = <Mark i={shown} height={compact ? 18 : 20} />;
  return info.url
    ? <a className="operator operator--bar" href={info.url} target="_blank" rel="noreferrer" title={title} aria-label={title} data-testid="operator">{body}</a>
    : <span className="operator operator--bar" title={title} aria-label={title} role="img" data-testid="operator">{body}</span>;
}

/** The support contact as a link, or null. */
export function SupportLink({ info = INSTANCE, children }: { info?: InstanceInfo | null; children?: React.ReactNode }) {
  if (!info?.support) return null;
  const href = supportHref(info.support);
  return (
    <a href={href} {...(info.support.kind === 'url' ? { target: '_blank', rel: 'noreferrer' } : {})} data-testid="operator-support">
      {children ?? info.support.value}
    </a>
  );
}

/** Under the sign-in card's tagline: who runs this instance, and where to get help. */
export function OperatorCredit({ info = INSTANCE }: { info?: InstanceInfo | null }) {
  if (!info) return null;
  const who = info.name || info.logo;
  return (
    <div className="operator-credit" data-testid="operator-credit">
      {who && (
        <p className="operator-credit__who">
          <span className="operator-credit__label">Provided by</span>{' '}
          {info.url
            ? <a className="operator" href={info.url} target="_blank" rel="noreferrer"><Mark i={info} height={20} /></a>
            : <span className="operator"><Mark i={info} height={20} /></span>}
        </p>
      )}
      {info.support && <p className="operator-credit__help">Need help? <SupportLink info={info}>{info.support.kind === 'email' ? `Email ${info.support.value}` : 'Contact support'}</SupportLink></p>}
    </div>
  );
}
