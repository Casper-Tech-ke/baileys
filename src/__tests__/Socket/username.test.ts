import {
	checkUsername,
	checkUsernameMulti,
	deleteUsername,
	fetchContactUsernames,
	findUserByUsername,
	getMyUsername,
	getUsernameRecommendations,
	setUsername,
	setUsernamePin,
	setUsernameQueryIds,
	USERNAME_QUERY_IDS,
	type UsernameDeps
} from '../../Socket/username.js'
import type { BinaryNode } from '../../WABinary/index.js'
import { USyncQuery } from '../../WAUSync/index.js'

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

const mockDeps = (handler: (node: BinaryNode) => BinaryNode): UsernameDeps => ({
	query: async (node: BinaryNode) => handler(node),
	generateMessageTag: () => 'test-tag',
	executeUSyncQuery: async () => undefined
})

const sentQuery = (node: BinaryNode) => {
	const queryNode = (node.content as BinaryNode[])[0]!
	const variables = JSON.parse((queryNode.content as Buffer).toString()).variables as Record<string, unknown>
	return { queryId: queryNode.attrs.query_id as string, variables }
}

it('checks a free username as available', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_check', { result: 'SUCCESS' })
	})

	const result = await checkUsername('new_name_here', deps)
	expect(result.available).toBe(true)
	expect(result.username).toBe('new_name_here')
	expect(result.session_id).toBeTruthy()

	const sent = sentQuery(seen!)
	expect(sent.queryId).toBe(USERNAME_QUERY_IDS.CHECK)
	expect(sent.variables.username).toBe('new_name_here')
	expect(sent.variables.include_suggestions).toBe(true)
	expect(sent.variables.source).toBe('USER_INPUT')
})

it('reports a taken username with suggestions', async () => {
	const deps = mockDeps(() =>
		mexResult('xwa2_username_check', {
			result: 'INVALID',
			suggestions: ['new_name_here1', 'new_name_here2'],
			rejection_reasons: ['TAKEN'],
			suggestions_eligible: true
		})
	)

	const result = await checkUsername('taken_name', deps)
	expect(result.available).toBe(false)
	expect(result.suggestions).toEqual(['new_name_here1', 'new_name_here2'])
	expect(result.rejectionReasons).toEqual(['TAKEN'])
})

it('returns your username, or null when you have none', async () => {
	const withUsername = mockDeps(() => mexResult('xwa2_username_get', { username: 'baba_hany' }))
	expect(await getMyUsername(withUsername)).toBe('baba_hany')

	const withoutUsername = mockDeps(() => mexResult('xwa2_username_get', {}))
	expect(await getMyUsername(withoutUsername)).toBeNull()
})

it('claims a username with reserved true', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_set', {})
	})

	await setUsername('my_bot_name', deps, { sessionId: 'sess-1' })
	const sent = sentQuery(seen!)
	expect(sent.queryId).toBe(USERNAME_QUERY_IDS.SET)
	expect(sent.variables.username).toBe('my_bot_name')
	expect(sent.variables.reserved).toBe(true)
	expect(sent.variables.session_id).toBe('sess-1')
})

it('deletes a username with a null username', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_delete', {})
	})

	await deleteUsername(deps)
	const sent = sentQuery(seen!)
	expect(sent.queryId).toBe(USERNAME_QUERY_IDS.SET)
	expect(sent.variables.username).toBeNull()
})

it('sets and clears the username pin', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_pin_set', {})
	})

	await setUsernamePin('1234', deps)
	expect(sentQuery(seen!).variables.pin).toBe('1234')

	await setUsernamePin(null, deps)
	expect(sentQuery(seen!).variables).toEqual({})
})

it('resolves a username to a JID via USync', async () => {
	const deps: UsernameDeps = {
		...mockDeps(() => {
			throw new Error('MEX must not be used for username lookup')
		}),
		executeUSyncQuery: async (query: USyncQuery) => {
			expect(query.protocols.map(p => p.name)).toContain('contact')
			return {
				list: [{ id: '254143947797@s.whatsapp.net', contact: true }],
				sideList: []
			}
		}
	}

	const user = await findUserByUsername('baba_hany', deps)
	expect(user).toEqual({ jid: '254143947797@s.whatsapp.net', contact: true })
	expect(
		await findUserByUsername('nobody_here', {
			...deps,
			executeUSyncQuery: async () => ({ list: [], sideList: [] })
		})
	).toBeNull()
})

it('fetches contact usernames via the username USync protocol', async () => {
	const deps: UsernameDeps = {
		...mockDeps(() => {
			throw new Error('MEX must not be used for contact usernames')
		}),
		executeUSyncQuery: async (query: USyncQuery) => {
			expect(query.protocols.map(p => p.name)).toContain('username')
			expect(query.users.map(u => u.id)).toEqual(['254143947797@s.whatsapp.net'])
			return {
				list: [{ id: '254143947797@s.whatsapp.net', username: 'baba_hany' }],
				sideList: []
			}
		}
	}

	const list = await fetchContactUsernames(['254143947797@s.whatsapp.net'], deps)
	expect(list).toEqual([{ id: '254143947797@s.whatsapp.net', username: 'baba_hany' }])
})

it('checks several usernames and fetches recommendations', async () => {
	let seen: BinaryNode | undefined
	const deps = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_check_multi', {})
	})

	await checkUsernameMulti(['one', 'two'], deps)
	const sent = sentQuery(seen!)
	expect(sent.queryId).toBe(USERNAME_QUERY_IDS.CHECK_MULTI)
	expect(sent.variables.usernames).toEqual(['one', 'two'])

	const recs = mockDeps(node => {
		seen = node
		return mexResult('xwa2_username_get_recommendations', { recommendations: [] })
	})
	await getUsernameRecommendations(recs, 'FB')
	expect(sentQuery(seen!).queryId).toBe(USERNAME_QUERY_IDS.GET_RECOMMENDATIONS)
	expect(sentQuery(seen!).variables.source).toBe('FB')
})

it('lets query IDs be patched at runtime and restored', () => {
	const original = USERNAME_QUERY_IDS.CHECK
	setUsernameQueryIds({ CHECK: '999' })
	expect(USERNAME_QUERY_IDS.CHECK).toBe('999')
	setUsernameQueryIds({ CHECK: original })
	expect(USERNAME_QUERY_IDS.CHECK).toBe(original)
})
