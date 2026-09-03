import type { TemplateInfo } from '../api';

/** The template id to preselect: the current pick when the server offers it,
 *  otherwise the first template that is not the built-in blank one. '' means
 *  no pick: the server then seeds its default article, which a server without
 *  a templates directory can only provide that way. */
export function pickTemplate(list: TemplateInfo[], current: string): string {
  if (list.some((t) => t.id === current)) return current;
  return list.find((t) => t.id !== 'blank')?.id ?? '';
}

/** The id to post with the create request, or undefined for the server
 *  default: only an id the server listed is ever sent. */
export function templateToPost(list: TemplateInfo[], pick: string): string | undefined {
  return pick && list.some((t) => t.id === pick) ? pick : undefined;
}
