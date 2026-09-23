/** App entry. Replace with your framework bootstrap (see products/degent/apps/web in DegentClub/degent for React + Vite). */
export function title(product: string): string {
  return `${product} - built from templates/app`;
}

if (typeof document !== "undefined") {
  document.title = title("__component__");
}
