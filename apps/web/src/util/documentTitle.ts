import { useEffect } from 'react';
import { INSTANCE } from '../instance';

/** "Projects – Aldine", or "Projects – Aldine · Kiel University" when the operator named itself. */
export function documentTitle(page?: string | null, operator: string | null | undefined = INSTANCE?.name): string {
  const app = operator ? `Aldine · ${operator}` : 'Aldine';
  return page ? `${page} – ${app}` : app;
}

/** The browser tab says which page this is: "Projects – Aldine". */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => { document.title = documentTitle(page); }, [page]);
}
