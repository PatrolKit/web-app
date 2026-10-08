/**
 * A slug from an organization's name, as the form fills it in while the name
 * is typed: lowercase letters, numbers and hyphens, accents dropped, at most
 * 50 characters (the server's rule). "Mt. Hood Ski Patrol" is "mt-hood-ski-patrol".
 */
export function slugFrom(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}
