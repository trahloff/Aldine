import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ForMeRow } from '../../api';
import { useAuth } from '../Auth';
import { friendlyDate } from '../../util/dates';

/** Open review threads that wait on the signed-in account: assigned to it,
 *  or @mentioning it. Each opens the project at the thread. */
export default function ForYouStrip({ refresh = 0 }: { /** Bumped to fetch the list again. */ refresh?: number }) {
  const { user } = useAuth();
  const [items, setItems] = useState<ForMeRow[]>([]);
  useEffect(() => {
    if (!user) { setItems([]); return; }
    let cancelled = false;
    api.forMe().then((list) => { if (!cancelled) setItems(list); }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [user?.id, refresh]);

  if (!items.length) return null;
  const shown = items.slice(0, 5);
  const href = (r: ForMeRow) => `/p/${encodeURIComponent(r.project.id)}?${r.comment.branch !== 'main' ? `branch=${encodeURIComponent(r.comment.branch)}&` : ''}comment=${encodeURIComponent(r.comment.id)}`;
  return (
    <section className="invites-strip for-you" aria-labelledby="for-you-title" data-testid="home-for-you">
      <h2 id="for-you-title" className="invites-strip__title">For you ({items.length})</h2>
      <ul role="list" className="invites-strip__list">
        {shown.map((r) => (
          <li key={`${r.project.id}/${r.comment.id}`} className="invites-strip__item" data-testid="home-for-you-item" data-reason={r.reason}>
            <Link className="for-you__link" to={href(r)}>
              <span className="for-you__what">
                {r.reason === 'assigned' ? 'Assigned to you' : `${r.comment.author} mentioned you`} in <strong>{r.project.name}</strong>
              </span>
              <span className="for-you__quote">“{r.comment.quote.slice(0, 80)}{r.comment.quote.length > 80 ? '…' : ''}”</span>
            </Link>
            <span className="for-you__when">{friendlyDate(r.at)}</span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className="for-you__more">And {items.length - shown.length} more: open a project’s Review panel and choose For me.</p>}
    </section>
  );
}
