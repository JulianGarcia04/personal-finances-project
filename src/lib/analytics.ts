// Product analytics, browser errors and web vitals through PostHog.
//
// Privacy: users are identified by their Firebase uid only, and every event passes
// `sanitizeEvent` before it leaves the browser: only the events listed here are sent,
// app events keep only their declared properties, URLs lose their query string and
// hash, and error messages lose emails, URL queries and every number (amounts can
// appear in them). Campaign parameters are not saved.
// Without a key and host (development, tests, emulators) nothing is loaded or sent.
import type { CaptureResult, PostHog } from 'posthog-js'
import type { AccountType, TransactionType } from '@/types'

type AuthMethod = 'email' | 'google'

/** Properties each app event may carry. Never amounts, names, emails or free text. */
export interface AnalyticsEventProperties {
  signed_up: { method: AuthMethod }
  logged_in: { method: AuthMethod }
  onboarding_finished: { push_enabled: boolean }
  bank_account_created: { type: AccountType; pocket: boolean }
  transaction_created: { type: TransactionType }
  statement_imported: { transactions: number }
  advisor_message_sent: undefined
  budget_created: { kind: string }
  goal_created: undefined
  workspace_created: undefined
  member_invited: undefined
  data_exported: undefined
  push_enabled: undefined
}

type AnalyticsEventName = keyof AnalyticsEventProperties

/** Runtime allowlist of the same properties, enforced by `sanitizeEvent`. */
export const ANALYTICS_EVENTS = {
  signed_up: ['method'],
  logged_in: ['method'],
  onboarding_finished: ['push_enabled'],
  bank_account_created: ['type', 'pocket'],
  transaction_created: ['type'],
  statement_imported: ['transactions'],
  advisor_message_sent: [],
  budget_created: ['kind'],
  goal_created: [],
  workspace_created: [],
  member_invited: [],
  data_exported: [],
  push_enabled: []
} as const satisfies Record<AnalyticsEventName, readonly string[]>

/** PostHog's own events that may be sent; everything else (autocapture, replay, flags...) is dropped. */
const POSTHOG_EVENTS = new Set(['$pageview', '$pageleave', '$exception', '$web_vitals', '$identify'])

/** Non-`$` properties PostHog adds to every event. */
const CONTEXT_PROPERTIES = new Set(['token', 'distinct_id'])

type Properties = Record<string, unknown>
type Capture = Pick<CaptureResult, 'event' | 'properties'> & { $set?: Properties; $set_once?: Properties }

const stripUrls = (value: unknown): unknown => {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value.split(/[?#]/)[0] : value
  if (Array.isArray(value)) return value.map(stripUrls)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripUrls(item)]))
  }
  return value
}

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"'.,;:]+/g
const URL_QUERY = /(https?:\/\/[^\s?#]*)[?#]\S*/gi

const scrubMessage = (value: unknown) => typeof value === 'string'
  ? value.replace(EMAIL, '[email]').replace(URL_QUERY, '$1').replace(/\d[\d.,]*/g, '#')
  : value

function scrubException(properties: Properties): Properties {
  const { $exception_steps: _breadcrumbs, ...rest } = properties
  return {
    ...rest,
    ...(Array.isArray(rest.$exception_list) ? {
      $exception_list: rest.$exception_list.map(entry =>
        entry && typeof entry === 'object' ? { ...entry, value: scrubMessage((entry as Properties).value) } : entry)
    } : {}),
    ...(Array.isArray(rest.$exception_values) ? { $exception_values: rest.$exception_values.map(scrubMessage) } : {}),
    ...('$exception_message' in rest ? { $exception_message: scrubMessage(rest.$exception_message) } : {})
  }
}

/** Applied to every event before it is sent (`before_send`); `null` drops the event. */
export function sanitizeEvent<T extends Capture>(captured: T | null): T | null {
  if (!captured) return null
  const declared: readonly string[] | undefined = Object.hasOwn(ANALYTICS_EVENTS, captured.event)
    ? ANALYTICS_EVENTS[captured.event as AnalyticsEventName]
    : undefined
  if (!declared && !POSTHOG_EVENTS.has(captured.event)) return null

  let properties = stripUrls(captured.properties) as Properties
  if (declared) {
    properties = Object.fromEntries(Object.entries(properties).filter(([key]) =>
      key.startsWith('$') || CONTEXT_PROPERTIES.has(key) || declared.includes(key)))
  }
  if (captured.event === '$exception') properties = scrubException(properties)

  return {
    ...captured,
    properties,
    ...(captured.$set ? { $set: stripUrls(captured.$set) } : {}),
    ...(captured.$set_once ? { $set_once: stripUrls(captured.$set_once) } : {})
  }
}

export interface AnalyticsEnv {
  DEV?: boolean
  VITE_POSTHOG_KEY?: string
  VITE_POSTHOG_HOST?: string
}

/** Key and host to send to, or `null` when analytics must stay off. */
export function analyticsConfig(env: AnalyticsEnv): { key: string; host: string } | null {
  const key = env.VITE_POSTHOG_KEY?.trim()
  const host = env.VITE_POSTHOG_HOST?.trim().replace(/\/+$/, '')
  if (env.DEV || !key || !host) return null
  return { key, host }
}

let client: Promise<PostHog | null> = Promise.resolve(null)

const withClient = (use: (posthog: PostHog) => void) => {
  client.then(posthog => { if (posthog) use(posthog) }).catch(() => undefined)
}

/**
 * Loads PostHog only when configured, so development and tests never send anything.
 * Returns whether analytics is on.
 */
export function initAnalytics(env: AnalyticsEnv = import.meta.env): boolean {
  const config = analyticsConfig(env)
  if (!config) return false
  client = import('posthog-js').then(({ default: posthog }) => {
    posthog.init(config.key, {
      api_host: config.host,
      person_profiles: 'identified_only',
      // Remote settings could turn features back on; this config is the whole contract.
      advanced_disable_flags: true,
      autocapture: false,
      capture_pageview: 'history_change',
      capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true, capture_console_errors: true },
      capture_performance: { web_vitals: true, network_timing: false },
      disable_session_recording: true,
      disable_surveys: true,
      save_campaign_params: false,
      before_send: sanitizeEvent
    })
    return posthog
  }).catch(error => {
    console.warn('Analytics could not be loaded', error)
    return null
  })
  return true
}

/** Production Vue passes `https://vuejs.org/error-reference/#runtime-N`; keep the code that URL stripping would drop. */
export const vueErrorInfo = (info: string): string => info.includes('#') ? info.slice(info.lastIndexOf('#') + 1) : info

export function identifyUser(uid: string): void {
  withClient(posthog => posthog.identify(uid))
}

/** Forgets the signed-in user on this device (sign-out, account deletion, lost session). */
export function resetAnalytics(): void {
  withClient(posthog => {
    if (posthog.get_property('$user_state') === 'identified') posthog.reset()
  })
}

export function track<E extends AnalyticsEventName>(
  event: E,
  ...properties: AnalyticsEventProperties[E] extends undefined ? [] : [AnalyticsEventProperties[E]]
): void {
  withClient(posthog => posthog.capture(event, properties[0] as Properties | undefined))
}

export function captureError(error: unknown, context?: Properties): void {
  withClient(posthog => posthog.captureException(error, context))
}
