import {
	NEWSLETTER_DIRECTORY_DATA_PATHS,
	NEWSLETTER_DIRECTORY_DEFAULT_LIMIT,
	NEWSLETTER_DIRECTORY_QUERY_IDS,
	newsletterDirectoryList,
	newsletterDirectorySearch,
	parseNewsletterDirectoryEntry,
	parseNewsletterDirectoryResult,
	setNewsletterDirectoryQueryIds,
	type NewsletterDirectoryDeps
} from '../../Socket/newsletterDirectory.js'
import type { BinaryNode } from '../../WABinary/index.js'

const mexResult = (dataPath: string, payload: Record<string, unknown>): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ data: { [dataPath]: payload } }), 'utf-8')
		}
	]
})

const mexErrorResult = (message: string): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ data: {}, errors: [{ message }] }), 'utf-8')
		}
	]
})

const mockDeps = (handler: (node: BinaryNode) => BinaryNode): NewsletterDirectoryDeps => ({
	query: async (node: BinaryNode) => handler(node),
	generateMessageTag: () => 'test-tag'
})

const sentQuery = (node: BinaryNode) => {
	const queryNode = (node.content as BinaryNode[])[0]!
	const variables = JSON.parse((queryNode.content as Buffer).toString()).variables as Record<string, unknown>
	return { queryNode, queryId: queryNode.attrs.query_id as string, variables, node }
}

/** The fetch_* flags the app sends on both directory queries (see newsletterDirectory.ts). */
const expectedFetchFlags = {
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
	fetch_status_metadata: false,
	fetch_refresh_after_interval: false,
	fetch_pinned_messages: false
}

/** Raw page fixture, shaped like the app's response models (C6v5/C6v2/C6v3/C6v4). */
const rawPage = {
	page_info: { endCursor: 'cursor-next-page' },
	result: [
		{
			id: '120363331321673219@newsletter',
			thread_metadata: {
				creation_time: '1700000000',
				description: { id: 'd1', text: 'Tech news and tools' },
				followers_count: '1234',
				handle: 'xcasper',
				invite: 'https://whatsapp.com/channel/0029VaX',
				name: { id: 'n1', text: 'XCASPER SPACE' },
				picture: { direct_path: '/pic/direct/path', id: 'pic1' },
				preview: { direct_path: '/preview/direct/path', id: 'prev1' },
				verification: 'VERIFIED'
			},
			viewer_metadata: { role: 'GUEST' },
			state: { type: 'ACTIVE' },
			status_metadata: { last_status_sent_time: '1794223368', last_status_server_id: '136' },
			refresh_after_interval_sec: 3600
		},
		{
			id: '120363999999999999@newsletter',
			thread_metadata: {
				creation_time: '1690000000',
				description: { id: 'd2', text: 'Daily news' },
				followers_count: '55',
				handle: null,
				invite: 'https://whatsapp.com/channel/0029VbY',
				name: { id: 'n2', text: 'News Daily' },
				picture: { direct_path: '/pic2/direct/path', id: 'pic2' },
				verification: 'UNVERIFIED'
			},
			viewer_metadata: { role: 'SUBSCRIBER' }
		}
	],
	vertical_metadata: [
		{ vertical: 'NEWS', vertical_title: 'News', newsletter_ids: ['120363999999999999@newsletter'] },
		{ vertical: 'TECH', vertical_title: 'Tech', newsletter_ids: ['120363331321673219@newsletter'] }
	]
}

it('searches the directory with a w:mex IQ carrying the search doc id and input', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, rawPage)
	})

	const result = await newsletterDirectorySearch('casper', { limit: 20, startCursor: 'cursor-first' }, deps)

	expect(seen).toBeDefined()
	const sent = sentQuery(seen!)
	expect(sent.node.tag).toBe('iq')
	expect(sent.node.attrs.type).toBe('get')
	expect(sent.node.attrs.xmlns).toBe('w:mex')
	expect(sent.node.attrs.to).toBe('@s.whatsapp.net')
	expect(sent.node.attrs.id).toBe('test-tag')
	expect(sent.queryId).toBe(NEWSLETTER_DIRECTORY_QUERY_IDS.SEARCH)
	expect(sent.variables.input).toEqual({
		search_text: 'casper',
		categories: null,
		limit: 20,
		start_cursor: 'cursor-first'
	})
	for (const [key, value] of Object.entries(expectedFetchFlags)) {
		expect(sent.variables[key]).toBe(value)
	}

	expect(result.entries).toHaveLength(2)
	expect(result.endCursor).toBe('cursor-next-page')
	expect(result.verticals).toHaveLength(2)
})

it('searches within one category as a one-element categories list', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, { result: [], page_info: {} })
	})

	await newsletterDirectorySearch('news', { category: 'NEWS' }, deps)

	const sent = sentQuery(seen!)
	expect((sent.variables.input as Record<string, unknown>).categories).toEqual(['NEWS'])
	expect((sent.variables.input as Record<string, unknown>).limit).toBe(NEWSLETTER_DIRECTORY_DEFAULT_LIMIT)
	expect((sent.variables.input as Record<string, unknown>).start_cursor).toBeNull()
})

it('parses directory entries from thread/viewer metadata', async () => {
	const deps = mockDeps(() => mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, rawPage))

	const { entries, verticals } = await newsletterDirectorySearch('casper', {}, deps)

	const first = entries[0]!
	expect(first.id).toBe('120363331321673219@newsletter')
	expect(first.name).toBe('XCASPER SPACE')
	expect(first.description).toBe('Tech news and tools')
	expect(first.handle).toBe('xcasper')
	expect(first.invite).toBe('https://whatsapp.com/channel/0029VaX')
	expect(first.followersCount).toBe(1234)
	expect(first.creationTime).toBe(1700000000)
	expect(first.verification).toBe('VERIFIED')
	expect(first.picture).toEqual({ id: 'pic1', directPath: '/pic/direct/path', url: undefined })
	expect(first.preview).toEqual({ id: 'prev1', directPath: '/preview/direct/path' })
	expect(first.viewerRole).toBe('GUEST')
	expect(first.state).toBe('ACTIVE')
	expect(first.refreshAfterIntervalSec).toBe(3600)
	expect(first.lastStatusSentTime).toBe(1794223368)
	expect(first.lastStatusServerId).toBe('136')

	const second = entries[1]!
	expect(second.name).toBe('News Daily')
	expect(second.followersCount).toBe(55)
	expect(second.handle).toBeUndefined()
	expect(second.viewerRole).toBe('SUBSCRIBER')
	expect(second.preview).toBeUndefined()

	expect(verticals[0]).toEqual({
		vertical: 'NEWS',
		title: 'News',
		newsletterIds: ['120363999999999999@newsletter']
	})
})

it('refuses an empty search query without sending anything', async () => {
	let calls = 0
	const deps = mockDeps(() => {
		calls += 1
		return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, rawPage)
	})

	await expect(newsletterDirectorySearch('   ', {}, deps)).rejects.toThrow('non-empty query')
	expect(calls).toBe(0)
})

it('refuses a bad limit or category for search', async () => {
	const deps = mockDeps(() => mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, rawPage))

	await expect(newsletterDirectorySearch('casper', { limit: 0 }, deps)).rejects.toThrow('positive integer')
	await expect(
		newsletterDirectorySearch('casper', { category: 'NOPE' as never }, deps)
	).rejects.toThrow('unknown newsletter directory category')
})

it('lists the directory with the list doc id, default view and personalization on', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.LIST, rawPage)
	})

	const result = await newsletterDirectoryList({}, deps)

	const sent = sentQuery(seen!)
	expect(sent.queryId).toBe(NEWSLETTER_DIRECTORY_QUERY_IDS.LIST)
	expect(sent.variables.input).toEqual({
		filters: { categories: null, country_codes: null },
		limit: NEWSLETTER_DIRECTORY_DEFAULT_LIMIT,
		start_cursor: null,
		use_personalization: true,
		view: 'FEATURED'
	})
	for (const [key, value] of Object.entries(expectedFetchFlags)) {
		expect(sent.variables[key]).toBe(value)
	}
	expect(result.entries).toHaveLength(2)
	expect(result.endCursor).toBe('cursor-next-page')
})

it('lists one view, category and country with personalization off', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.LIST, { result: [], page_info: {} })
	})

	await newsletterDirectoryList(
		{ view: 'POPULAR', category: 'SPORTS', countryCode: 'KE', usePersonalization: false, limit: 10 },
		deps
	)

	const sent = sentQuery(seen!)
	expect((sent.variables.input as Record<string, unknown>).view).toBe('POPULAR')
	expect((sent.variables.input as Record<string, unknown>).use_personalization).toBe(false)
	expect((sent.variables.input as Record<string, unknown>).limit).toBe(10)
	expect((sent.variables.input as Record<string, unknown>).filters).toEqual({
		categories: ['SPORTS'],
		country_codes: ['KE']
	})
})

it('refuses an unknown list view', async () => {
	const deps = mockDeps(() => mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.LIST, rawPage))
	await expect(newsletterDirectoryList({ view: 'NOPE' as never }, deps)).rejects.toThrow(
		'unknown newsletter directory view'
	)
})

it('surfaces a GraphQL error from the directory query', async () => {
	const deps = mockDeps(() => mexErrorResult('directory unavailable'))

	await expect(newsletterDirectorySearch('casper', {}, deps)).rejects.toThrow('directory unavailable')
	await expect(newsletterDirectoryList({}, deps)).rejects.toThrow('directory unavailable')
})

it('parses an empty or partial directory page without crashing', () => {
	expect(parseNewsletterDirectoryResult(undefined)).toEqual({ entries: [], endCursor: undefined, verticals: [] })
	expect(parseNewsletterDirectoryResult({})).toEqual({ entries: [], endCursor: undefined, verticals: [] })
	expect(parseNewsletterDirectoryResult({ result: [{ noId: true }, null] })).toEqual({
		entries: [],
		endCursor: undefined,
		verticals: []
	})

	expect(parseNewsletterDirectoryEntry(null)).toBeNull()
	expect(parseNewsletterDirectoryEntry({})).toBeNull()
	expect(parseNewsletterDirectoryEntry({ id: '120363331321673219@newsletter' })).toEqual({
		id: '120363331321673219@newsletter',
		name: undefined,
		description: undefined,
		handle: undefined,
		invite: undefined,
		followersCount: undefined,
		creationTime: undefined,
		verification: undefined,
		picture: undefined,
		preview: undefined,
		viewerRole: undefined,
		state: undefined,
		refreshAfterIntervalSec: undefined,
		lastStatusSentTime: undefined,
		lastStatusServerId: undefined
	})
})

it('lets the directory query ids be patched at runtime', async () => {
	const original = { ...NEWSLETTER_DIRECTORY_QUERY_IDS }
	try {
		const patched = setNewsletterDirectoryQueryIds({ SEARCH: '111', LIST: '222' })
		expect(patched.SEARCH).toBe('111')
		expect(patched.LIST).toBe('222')

		let seen: BinaryNode | undefined
		const deps = mockDeps(node => {
			seen = node
			return mexResult(NEWSLETTER_DIRECTORY_DATA_PATHS.SEARCH, { result: [] })
		})
		await newsletterDirectorySearch('casper', {}, deps)
		expect(sentQuery(seen!).queryId).toBe('111')
	} finally {
		setNewsletterDirectoryQueryIds(original)
	}
	expect(NEWSLETTER_DIRECTORY_QUERY_IDS.SEARCH).toBe(original.SEARCH)
	expect(NEWSLETTER_DIRECTORY_QUERY_IDS.LIST).toBe(original.LIST)
})
