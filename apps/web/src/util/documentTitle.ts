import { useEffect } from 'react';

export function documentTitle(page?: string | null): string {
  return page ? `${page} – Aldine` : 'Aldine';
}

/** The browser tab says which page this is: "Projects – Aldine". */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => { document.title = documentTitle(page); }, [page]);
}
