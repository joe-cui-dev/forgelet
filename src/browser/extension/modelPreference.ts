export type WorkbenchModel = "deepseek-flash" | "deepseek-v4-pro";

/** Reads a stored Workbench model preference. The legacy `deepseek-v4-flash`
 * id, retired when DeepSeek renamed Flash, migrates to `deepseek-flash` so a
 * user who picked Flash keeps Flash instead of silently falling back to the
 * Route. Anything else selects no model and leaves the choice to the Route. */
export function normalizeWorkbenchModel(raw: unknown): WorkbenchModel | undefined {
  if (raw === "deepseek-v4-flash") return "deepseek-flash";
  return raw === "deepseek-flash" || raw === "deepseek-v4-pro" ? raw : undefined;
}
