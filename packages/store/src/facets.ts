/**
 * The `<source>_items` column for a facet meta key: `appName` → `app_name`. Same mapping as
 * `memindex.facet_column` in the facet-columns migration; tests assert they agree.
 */
export function facetColumn(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
