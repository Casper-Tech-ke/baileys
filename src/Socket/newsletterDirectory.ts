import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { executeWMexQuery } from './mex'

/**
 * Channel directory (search + browse) — the directory the WhatsApp app shows
 * under Channels > Explore. This is search/discovery only: it does not create,
 * follow or manage channels (that is newsletter.ts) and it is not the
 * `channelsPersonalisedRecommendation` privacy setting (app-state sync) —
 * that setting only decides whether the list below is personalised.
 *
 * APK evidence (decompiled WhatsApp APK on the dev VM):
 *
 * - Jobs: `NewsletterDirectoryV2SearchGraphqlJob` and
 *   `NewsletterDirectoryV2ListGraphqlJob`
 *   (`com/whatsapp/newsletter/directory/job/`), GraphQL operations
 *   `NewsletterDirectorySearch` / `NewsletterDirectoryList`, app id
 *   `whatsapp-android-mex`. Both go through the same `w:mex` IQ mechanism
 *   as the rest of the fork (mex.ts): an `<iq type="get" xmlns="w:mex">`
 *   with a `<query query_id>` child carrying `{ variables }` as JSON.
 * - Persisted query ids, from this APK's
 *   `assets/whatsapp-android-mex_client_persist_ids.json` (`doc_id`):
 *   search `27887355094203575`, list `27480627564903390`.
 * - Variables, from the job code:
 *   - search `input` (`XWA2NewsletterDirectorySearchInput`): `search_text`,
 *     `categories` (null, or a one-element list with the category name),
 *     `limit`, `start_cursor` (null to start), optional `session_fields`
 *     (app analytics; not sent here — Baileys has no such session).
 *   - list `input`: `filters: { categories, country_codes }` (each null or
 *     a one-element list), `limit`, `start_cursor`, `use_personalization`
 *     (app: on unless the user disabled it), `view` (see below).
 *   - both queries also carry top-level `fetch_*` flags, exactly as the
 *     app sets them (`C6ip.A09(r, false)` + `C6in.A0X(r, false)`):
 *     `fetch_state: false`, `fetch_creation_time/name/preview/invite/
 *     followers_count/verification: true`, `fetch_image/description/handle/
 *     viewer_metadata/settings/wamo_sub/pinned_messages: false`, and
 *     `fetch_status_metadata` / `fetch_refresh_after_interval`, which the
 *     app overrides from its status-infra config (`C6in.A0k`) — the fork
 *     defaults both to false (see `fetchStatusMetadata` option).
 * - Response, from the generated models (`C6v7`/`C6v1` -> `C6v6`/`C6v0` ->
 *   `C6v5`, `C6v2`/`C6v3`/`C6v4`, `C02696vc`, `C6vZ`) and the flatbuffer
 *   (`XWA2NewsletterSearchResponse`): the data path is
 *   `xwa2_newsletters_directory_search` / `xwa2_newsletters_directory_list`,
 *   holding `{ page_info: { endCursor }, result: [...],
 *   vertical_metadata: [...] }`. Each `result` entry is a newsletter:
 *   `id`, `thread_metadata` (`name`/`description` as `{ text }`,
 *   `followers_count` + `creation_time` as strings, `handle`, `invite`,
 *   `picture`/`preview` as `{ direct_path, id }`, `verification`),
 *   `viewer_metadata` (`role`), `state` (`type`), `status_metadata`
 *   (`last_status_sent_time`, `last_status_server_id`),
 *   `refresh_after_interval_sec`. A `vertical_metadata` entry is
 *   `{ vertical, vertical_title, newsletter_ids }`.
 * - Categories (`EnumC08147Tk`): BUSINESS, ENTERTAINMENT, LIFESTYLE, NEWS,
 *   ORGANIZATIONS, PEOPLE, SPORTS, SPECIAL_EVENTS, SPECIAL_EVENTS_2..5,
 *   EXPLORE. List views (`EnumC08077Td`): FEATURED, NEW, POPULAR,
 *   RECOMMENDED, TRENDING.
 *
 * Caveats — read before trusting this live:
 * - Query ids rotate server-side when the query text changes (username.ts
 *   already notes this). These ids are from the APK on the dev VM; the
 *   fork's older newsletter ids do NOT match this APK's registry for the
 *   same operations (e.g. NewsletterCreate: fork `8823471724422422` vs this
 *   APK `27009199332109318` — only UsernameSet/UsernamePinSet match), so
 *   the ids here are the currently-registered Android ones and the
 *   `w:mex` gateway accepting them from a Web socket still needs a live
 *   check. If the server rejects them, patch at runtime with
 *   `setNewsletterDirectoryQueryIds` (same pattern as username.ts) instead
 *   of waiting for a release.
 * - `limit` has no fixed value in the app (it comes from an ab-prop), so
 *   the fork defaults to 50; pass `limit` to page differently.
 * - Not built here: `NewsletterDirectoryCategoryPreview` (doc id
 *   `27432651036395658`) and the recommended feed
 *   `NewsletterRecommended` (`GetDirectoryNewslettersGraphqlJob`, doc id
 *   `29094080403564923`, default limit 500) — same mechanism, separate
 *   functions if the directory UI needs them.
 */

/** Directory categories, exactly as the app's `EnumC08147Tk`. */
export const NEWSLETTER_DIRECTORY_CATEGORIES = [
	'BUSINESS',
	'ENTERTAINMENT',
	'LIFESTYLE',
	'NEWS',
	'ORGANIZATIONS',
	'PEOPLE',
	'SPORTS',
	'SPECIAL_EVENTS',
	'SPECIAL_EVENTS_2',
	'SPECIAL_EVENTS_3',
	'SPECIAL_EVENTS_4',
	'SPECIAL_EVENTS_5',
	'EXPLORE'
] as const

export type NewsletterDirectoryCategory = (typeof NEWSLETTER_DIRECTORY_CATEGORIES)[number]

/** List views, exactly as the app's `EnumC08077Td`. */
export const NEWSLETTER_DIRECTORY_VIEWS = ['FEATURED', 'NEW', 'POPULAR', 'RECOMMENDED', 'TRENDING'] as const

export type NewsletterDirectoryView = (typeof NEWSLETTER_DIRECTORY_VIEWS)[number]

/**
 * Persisted GraphQL query ids for the directory operations, from this APK's
 * `whatsapp-android-mex_client_persist_ids.json` (`doc_id`).
 * WhatsApp rotates these server-side, so they can go stale.
 * Patch them at runtime with setNewsletterDirectoryQueryIds (see below).
 */
export const NEWSLETTER_DIRECTORY_QUERY_IDS = {
	SEARCH: '27887355094203575',
	LIST: '27480627564903390'
}

export type NewsletterDirectoryQueryIds = typeof NEWSLETTER_DIRECTORY_QUERY_IDS

/** MEX data paths for the directory operations (see the header comment). */
export const NEWSLETTER_DIRECTORY_DATA_PATHS = {
	SEARCH: 'xwa2_newsletters_directory_search',
	LIST: 'xwa2_newsletters_directory_list'
} as const

/** Default page size. The app takes it from an ab-prop; 50 is the fork's choice. */
export const NEWSLETTER_DIRECTORY_DEFAULT_LIMIT = 50

/** Default list view. */
export const NEWSLETTER_DIRECTORY_DEFAULT_VIEW: NewsletterDirectoryView = 'FEATURED'

/** Replace one or more directory query IDs at runtime (they rotate server-side). */
export const setNewsletterDirectoryQueryIds = (ids: Partial<NewsletterDirectoryQueryIds>) => {
	Object.assign(NEWSLETTER_DIRECTORY_QUERY_IDS, ids)
	return NEWSLETTER_DIRECTORY_QUERY_IDS
}

/** Deps for the directory calls, same query-based shape as channelStatus.ts. */
export type NewsletterDirectoryDeps = {
	query: (node: BinaryNode) => Promise<BinaryNode>
	generateMessageTag: () => string
}

export type NewsletterDirectorySearchOptions = {
	/** Narrow the search to one category. */
	category?: NewsletterDirectoryCategory
	/** Page size (positive integer, default 50). */
	limit?: number
	/** Cursor from a previous page's `endCursor`; omit for the first page. */
	startCursor?: string
	/**
	 * Ask for `status_metadata` on each entry (`fetch_status_metadata` and
	 * `fetch_refresh_after_interval`). The app takes this from its
	 * status-infra config; the fork defaults it to false.
	 */
	fetchStatusMetadata?: boolean
}

export type NewsletterDirectoryListOptions = {
	/** Which browse view to list (default FEATURED). */
	view?: NewsletterDirectoryView
	/** Narrow the list to one category. */
	category?: NewsletterDirectoryCategory
	/** ISO country code (e.g. 'KE'); omit for the global list. */
	countryCode?: string
	/** Page size (positive integer, default 50). */
	limit?: number
	/** Cursor from a previous page's `endCursor`; omit for the first page. */
	startCursor?: string
	/**
	 * Personalise the list for this account (app default: on unless the
	 * user disabled it — the `channelsPersonalisedRecommendation` setting).
	 */
	usePersonalization?: boolean
	/** See NewsletterDirectorySearchOptions.fetchStatusMetadata. */
	fetchStatusMetadata?: boolean
}

/** One channel in a directory search/list page. */
export type NewsletterDirectoryEntry = {
	/** Channel JID, e.g. '120363331321673219@newsletter'. */
	id: string
	name?: string
	description?: string
	/** The channel's @handle, when it has one. */
	handle?: string
	invite?: string
	followersCount?: number
	creationTime?: number
	verification?: string
	picture?: {
		id?: string
		directPath?: string
		url?: string
	}
	preview?: {
		id?: string
		directPath?: string
	}
	/** This account's role in the channel (e.g. 'GUEST', 'SUBSCRIBER'). */
	viewerRole?: string
	/** Channel state type, when the server returns one. */
	state?: string
	refreshAfterIntervalSec?: number
	lastStatusSentTime?: number
	lastStatusServerId?: string
}

/** One vertical (grouping) in a directory page. */
export type NewsletterDirectoryVertical = {
	vertical: string
	title?: string
	newsletterIds: string[]
}

/** One page of directory results. */
export type NewsletterDirectoryResult = {
	entries: NewsletterDirectoryEntry[]
	/** Cursor for the next page; absent when there is no next page. */
	endCursor?: string
	verticals: NewsletterDirectoryVertical[]
}

type RawNewsletterDirectoryEntry = {
	id?: unknown
	thread_metadata?: {
		creation_time?: unknown
		description?: { text?: unknown }
		followers_count?: unknown
		handle?: unknown
		invite?: unknown
		name?: { text?: unknown }
		picture?: { direct_path?: unknown; id?: unknown; url?: unknown }
		preview?: { direct_path?: unknown; id?: unknown }
		verification?: unknown
	}
	viewer_metadata?: { role?: unknown }
	state?: { type?: unknown }
	status_metadata?: { last_status_sent_time?: unknown; last_status_server_id?: unknown }
	refresh_after_interval_sec?: unknown
}

type RawNewsletterDirectoryResponse = {
	page_info?: { endCursor?: unknown }
	result?: unknown
	vertical_metadata?: unknown
}

const mexQuery = <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	deps: NewsletterDirectoryDeps
): Promise<T> => executeWMexQuery<T>(variables, queryId, dataPath, deps.query, deps.generateMessageTag)

const asInt = (value: unknown): number | undefined => {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value
	}

	if (typeof value === 'string' && value !== '') {
		const parsed = parseInt(value, 10)
		return Number.isNaN(parsed) ? undefined : parsed
	}

	return undefined
}

const asText = (value: { text?: unknown } | undefined): string | undefined =>
	typeof value?.text === 'string' ? value.text : undefined

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * The `fetch_*` flags both directory queries carry, exactly as the app sets
 * them (see the header comment). `fetchStatusMetadata` drives the two flags
 * the app takes from its status-infra config.
 */
const directoryFetchFlags = (fetchStatusMetadata: boolean): Record<string, boolean> => ({
	fetch_state: false,
	fetch_creation_time: true,
	fetch_name: true,
	fetch_image: false,
	fetch_preview: true,
	fetch_description: false,
	fetch_invite: true,
	fetch_handle: false,
	fetch_followers_count: true,
	fetch_verification: true,
	fetch_viewer_metadata: false,
	fetch_settings: false,
	fetch_wamo_sub: false,
	fetch_status_metadata: fetchStatusMetadata,
	fetch_refresh_after_interval: fetchStatusMetadata,
	fetch_pinned_messages: false
})

const assertValidLimit = (limit: number): void => {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Boom('newsletter directory limit must be a positive integer', { statusCode: 400 })
	}
}

const assertValidCategory = (category: string | undefined): void => {
	if (category !== undefined && !(NEWSLETTER_DIRECTORY_CATEGORIES as readonly string[]).includes(category)) {
		throw new Boom(`unknown newsletter directory category: ${category}`, { statusCode: 400 })
	}
}

const assertValidView = (view: string | undefined): void => {
	if (view !== undefined && !(NEWSLETTER_DIRECTORY_VIEWS as readonly string[]).includes(view)) {
		throw new Boom(`unknown newsletter directory view: ${view}`, { statusCode: 400 })
	}
}

/** Parse one raw directory entry (see the header comment for the shape). */
export const parseNewsletterDirectoryEntry = (raw: unknown): NewsletterDirectoryEntry | null => {
	if (typeof raw !== 'object' || raw === null) {
		return null
	}

	const entry = raw as RawNewsletterDirectoryEntry
	if (typeof entry.id !== 'string' || !entry.id) {
		return null
	}

	const thread = entry.thread_metadata ?? {}
	const viewer = entry.viewer_metadata ?? {}
	const status = entry.status_metadata ?? {}

	return {
		id: entry.id,
		name: asText(thread.name),
		description: asText(thread.description),
		handle: asString(thread.handle),
		invite: asString(thread.invite),
		followersCount: asInt(thread.followers_count),
		creationTime: asInt(thread.creation_time),
		verification: asString(thread.verification),
		picture: thread.picture
			? {
					id: asString(thread.picture.id),
					directPath: asString(thread.picture.direct_path),
					url: asString(thread.picture.url)
				}
			: undefined,
		preview: thread.preview
			? {
					id: asString(thread.preview.id),
					directPath: asString(thread.preview.direct_path)
				}
			: undefined,
		viewerRole: asString(viewer.role),
		state: asString(entry.state?.type),
		refreshAfterIntervalSec: asInt(entry.refresh_after_interval_sec),
		lastStatusSentTime: asInt(status.last_status_sent_time),
		lastStatusServerId: asString(status.last_status_server_id)
	}
}

/** Parse a raw directory page (`page_info` / `result` / `vertical_metadata`). */
export const parseNewsletterDirectoryResult = (raw: unknown): NewsletterDirectoryResult => {
	const data = (typeof raw === 'object' && raw !== null ? raw : {}) as RawNewsletterDirectoryResponse

	const entries = Array.isArray(data.result)
		? data.result.map(parseNewsletterDirectoryEntry).filter((entry): entry is NewsletterDirectoryEntry => entry !== null)
		: []

	const verticals = Array.isArray(data.vertical_metadata)
		? data.vertical_metadata
				.map((vertical): NewsletterDirectoryVertical | null => {
					if (typeof vertical !== 'object' || vertical === null) {
						return null
					}

					const rawVertical = vertical as { vertical?: unknown; vertical_title?: unknown; newsletter_ids?: unknown }
					if (typeof rawVertical.vertical !== 'string' || !rawVertical.vertical) {
						return null
					}

					return {
						vertical: rawVertical.vertical,
						title: asString(rawVertical.vertical_title),
						newsletterIds: Array.isArray(rawVertical.newsletter_ids)
							? rawVertical.newsletter_ids.filter((id): id is string => typeof id === 'string')
							: []
					}
				})
				.filter((vertical): vertical is NewsletterDirectoryVertical => vertical !== null)
		: []

	return {
		entries,
		endCursor: asString(data.page_info?.endCursor),
		verticals
	}
}

/**
 * Search the channel directory by text, like the app's Channels > Explore
 * search. Page with `startCursor` from the previous result's `endCursor`.
 */
export const newsletterDirectorySearch = async (
	query: string,
	options: NewsletterDirectorySearchOptions = {},
	deps: NewsletterDirectoryDeps
): Promise<NewsletterDirectoryResult> => {
	if (typeof query !== 'string' || query.trim() === '') {
		throw new Boom('newsletterDirectorySearch requires a non-empty query', { statusCode: 400 })
	}

	assertValidCategory(options.category)
	const limit = options.limit ?? NEWSLETTER_DIRECTORY_DEFAULT_LIMIT
	assertValidLimit(limit)

	const variables = {
		input: {
			search_text: query,
			categories: options.category ? [options.category] : null,
			limit,
			start_cursor: options.startCursor ?? null
		},
		...directoryFetchFlags(options.fetchStatusMetadata ?? false)
	}
	const raw = await mexQuery<unknown>(
		variables,
		NEWSLETTER_DIRECTORY_QUERY_IDS.SEARCH,
		NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH,
		deps
	)
	return parseNewsletterDirectoryResult(raw)
}

/**
 * Browse (list) the channel directory — the Explore page — for one view
 * (FEATURED / NEW / POPULAR / RECOMMENDED / TRENDING), optionally narrowed
 * by category and/or country. Page with `startCursor` from the previous
 * result's `endCursor`.
 */
export const newsletterDirectoryList = async (
	options: NewsletterDirectoryListOptions = {},
	deps: NewsletterDirectoryDeps
): Promise<NewsletterDirectoryResult> => {
	assertValidView(options.view)
	assertValidCategory(options.category)
	const limit = options.limit ?? NEWSLETTER_DIRECTORY_DEFAULT_LIMIT
	assertValidLimit(limit)

	const variables = {
		input: {
			filters: {
				categories: options.category ? [options.category] : null,
				country_codes: options.countryCode ? [options.countryCode] : null
			},
			limit,
			start_cursor: options.startCursor ?? null,
			use_personalization: options.usePersonalization ?? true,
			view: options.view ?? NEWSLETTER_DIRECTORY_DEFAULT_VIEW
		},
		...directoryFetchFlags(options.fetchStatusMetadata ?? false)
	}
	const raw = await mexQuery<unknown>(
		variables,
		NEWSLETTER_DIRECTORY_QUERY_IDS.LIST,
		NEWSLETTER_DIRECTORY_DATA_PATHS.LIST,
		deps
	)
	return parseNewsletterDirectoryResult(raw)
}
