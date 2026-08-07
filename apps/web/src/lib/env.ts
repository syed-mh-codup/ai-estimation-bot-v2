/**
 * WS28-01: server environment / secrets contract. No secret is hardcoded — they
 * all come from the environment. `requiredServerEnv` is validated at boot (and
 * by /api/health); the integration secrets are optional and only needed for the
 * features that use them.
 */
export const REQUIRED_SERVER_ENV = ['DATABASE_URL', 'AUTH_SECRET'] as const;

export const OPTIONAL_SERVER_ENV = [
  'OPENROUTER_API_KEY', // agent runs (chat) + embeddings
  'TAVILY_API_KEY', // Detective search grounding — without it findings are model-only
  'GOOGLE_SERVICE_ACCOUNT_JSON', // Sheets export
  'GOOGLE_DRIVE_FOLDER_ID', // Sheets export
  'ENCRYPTION_KEY', // MCP connector secret storage
  'SMTP_HOST', // completion emails (defaults to smtp.resend.com)
  'SMTP_PORT', // completion emails (defaults to 465)
  'SMTP_USER', // completion emails (Resend: "resend")
  'SMTP_PASSWORD', // completion emails (Resend API key)
  'EMAIL_FROM', // completion emails (verified sender)
  'APP_URL', // absolute origin for links inside emails
] as const;

export type EnvCheck = {
  ok: boolean;
  missingRequired: string[];
  presentOptional: string[];
};

export function checkServerEnv(): EnvCheck {
  const missingRequired = REQUIRED_SERVER_ENV.filter((k) => !process.env[k]);
  const presentOptional = OPTIONAL_SERVER_ENV.filter((k) => !!process.env[k]);
  return { ok: missingRequired.length === 0, missingRequired, presentOptional };
}

/** Throw on missing required env — call from a boot path in production. */
export function assertServerEnv(): void {
  const { ok, missingRequired } = checkServerEnv();
  if (!ok) {
    throw new Error(`Missing required environment variables: ${missingRequired.join(', ')}`);
  }
}
