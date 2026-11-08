/** ACP `auth_required` (`RequestError.authRequired`) is JSON-RPC error code -32000. */
export const AUTH_REQUIRED_CODE = -32000;

/**
 * Code only, never message text: matching /auth.?required/ misread e.g. an MCP server's
 * "OAuth required" as agent auth, ran the auth flow and re-sent the prompt (a duplicate turn).
 * Pure (no `vscode`) so it is unit-testable; `auth.ts` re-exports it.
 */
export function isAuthRequiredError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === AUTH_REQUIRED_CODE;
}
