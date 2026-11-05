import { logger } from "firebase-functions";

// Unexpected function errors go to PostHog error tracking, next to the app's browser
// errors. Messages lose emails, URL queries and every number (amounts can appear in
// them), and users are identified by their uid only. Off in the emulator and without
// POSTHOG_KEY and POSTHOG_HOST in functions/.env. Reporting never fails the function.

type Env = Record<string, string | undefined>;

export interface ErrorReportingConfig {
  key: string;
  host: string;
}

export function errorReportingConfig(env: Env): ErrorReportingConfig | null {
  const key = env.POSTHOG_KEY?.trim();
  const host = env.POSTHOG_HOST?.trim().replace(/\/+$/, "");
  if (env.FUNCTIONS_EMULATOR === "true" || !key || !host) return null;
  return { key, host };
}

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"'.,;:]+/g;
const URL_QUERY = /(https?:\/\/[^\s?#]*)[?#]\S*/gi;

const scrubMessage = (text: string) =>
  text.replace(EMAIL, "[email]").replace(URL_QUERY, "$1").replace(/\d[\d.,]*/g, "#");

/** Copy of the error whose message (also in the stack's first line) has no emails, URL queries or numbers. */
export function scrubError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const scrubbed = new Error(scrubMessage(original.message));
  scrubbed.name = original.name;
  const frames = (original.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  scrubbed.stack = [`${scrubbed.name}: ${scrubbed.message}`, ...frames].join("\n");
  return scrubbed;
}

interface ExceptionClient {
  captureExceptionImmediate(error: unknown, distinctId?: string, properties?: Record<string, unknown>): Promise<void>;
}

export interface ErrorContext {
  /** Function that failed. */
  source: string;
  /** Signed-in caller, when known. */
  uid?: string;
}

export function createErrorReporter(
  env: Env,
  createClient: (config: ErrorReportingConfig) => ExceptionClient | Promise<ExceptionClient>
): (error: unknown, context: ErrorContext) => Promise<void> {
  let client: ExceptionClient | undefined;
  return async (error, context) => {
    const config = errorReportingConfig(env);
    if (!config) return;
    try {
      client ??= await createClient(config);
      const properties = context.uid
        ? { function: context.source }
        : { function: context.source, $process_person_profile: false };
      await client.captureExceptionImmediate(scrubError(error), context.uid ?? "server", properties);
    } catch (reportFailure) {
      logger.warn(`Could not report the ${context.source} error to PostHog`, reportFailure);
    }
  };
}

// Loaded on first use, so functions that never fail do not pay for it at cold start.
export const reportError = createErrorReporter(process.env, async (config) => {
  const { PostHog } = await import("posthog-node");
  return new PostHog(config.key, { host: config.host, flushAt: 1, flushInterval: 0 });
});
