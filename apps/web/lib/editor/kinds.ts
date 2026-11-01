/**
 * Clip kinds with no upload behind them (a blank New edit, a New slideshow): their first document is empty and
 * nothing is spoken until the founder adds it. No server imports, so the editor and the server share one rule.
 */
export const startsEmpty = (kind: string | null | undefined): boolean => kind === "blank" || kind === "slideshow";
