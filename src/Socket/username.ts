import { randomUUID } from 'crypto'
import type { SetUsernameOptions, UsernameCheckResult, UsernameSource, UsernameUser } from '../Types/Username'
import type { BinaryNode } from '../WABinary'
import { USyncQuery, type USyncQueryResult, USyncUser } from '../WAUSync'
import { executeWMexQuery } from './mex'

// WhatsApp rotates these GraphQL query_ids server-side, so they can go stale.
// Patch them at runtime with setUsernameQueryIds (see below) instead of
// waiting for a release. IDs captured from public Baileys forks.
export const USERNAME_QUERY_IDS = {
	CHECK: '26124072630599518',
	CHECK_MULTI: '27134626522840286',
	SET: '27108705368767936',
	GET: '32618050064506055',
	GET_RECOMMENDATIONS: '26077456248616957',
	PIN_SET: '25529696019976770'
}

export type UsernameQueryIds = typeof USERNAME_QUERY_IDS

export const USERNAME_CHECK_RESULT = {
	SUCCESS: 'SUCCESS',
	INVALID: 'INVALID'
} as const

export const USERNAME_SOURCE = {
	FB: 'FB',
	IG: 'IG',
	USER_INPUT: 'USER_INPUT',
	SUGGESTION: 'SUGGESTION'
} as const

export type UsernameDeps = {
	query: (node: BinaryNode) => Promise<BinaryNode>
	generateMessageTag: () => string
	executeUSyncQuery: (usyncQuery: USyncQuery) => Promise<USyncQueryResult | undefined>
}

const mexQuery = <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	deps: UsernameDeps
): Promise<T> => executeWMexQuery<T>(variables, queryId, dataPath, deps.query, deps.generateMessageTag)

/** Replace one or more username query IDs at runtime (they rotate server-side). */
export const setUsernameQueryIds = (ids: Partial<UsernameQueryIds>) => {
	Object.assign(USERNAME_QUERY_IDS, ids)
	return USERNAME_QUERY_IDS
}

/** Check whether a username is free. Returns suggestions when it is taken. */
export const checkUsername = async (
	username: string,
	deps: UsernameDeps,
	includeSuggestions = true,
	sessionId?: string
): Promise<UsernameCheckResult> => {
	const session_id = sessionId || randomUUID()
	const data = await mexQuery<{
		result?: string
		suggestions?: string[]
		rejection_reasons?: string[]
		suggestions_eligible?: boolean
	}>(
		{
			username,
			include_suggestions: includeSuggestions,
			session_id,
			source: USERNAME_SOURCE.USER_INPUT
		},
		USERNAME_QUERY_IDS.CHECK,
		'xwa2_username_check',
		deps
	)

	if (data?.result === USERNAME_CHECK_RESULT.SUCCESS) {
		return { available: true, username, session_id }
	}

	return {
		available: false,
		username,
		session_id,
		suggestions: data?.suggestions ?? [],
		rejectionReasons: data?.rejection_reasons ?? [],
		suggestionsEligible: data?.suggestions_eligible ?? true
	}
}

/** Check several usernames at once. Returns the raw MEX payload. */
export const checkUsernameMulti = async (usernames: string[], deps: UsernameDeps): Promise<unknown> =>
	mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi', deps)

/** Claim a username for this account. */
export const setUsername = async (
	username: string,
	deps: UsernameDeps,
	options: SetUsernameOptions = {}
): Promise<unknown> => {
	const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options
	const session_id = sessionId || randomUUID()
	const variables: Record<string, unknown> = {
		username,
		reserved: true,
		source,
		session_id,
		...(pin ? { pin } : {})
	}
	return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set', deps)
}

/** Give up this account's username. */
export const deleteUsername = async (deps: UsernameDeps): Promise<unknown> =>
	mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete', deps)

/** This account's current username, or null when it has none. */
export const getMyUsername = async (deps: UsernameDeps): Promise<string | null> => {
	const data = await mexQuery<{ username?: string }>({}, USERNAME_QUERY_IDS.GET, 'xwa2_username_get', deps)
	return data?.username ?? null
}

/** Username suggestions for this account. */
export const getUsernameRecommendations = async (
	deps: UsernameDeps,
	source: UsernameSource | null = null
): Promise<unknown> => {
	const variables: Record<string, unknown> = {}
	if (source) {
		variables.source = source
	}

	return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations', deps)
}

/** Set (or clear, with null) the PIN that protects this account's username. */
export const setUsernamePin = async (pin: string | null, deps: UsernameDeps): Promise<unknown> => {
	const variables = pin !== null ? { pin } : {}
	return mexQuery(variables, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set', deps)
}

/** Resolve a username to a JID. Returns null when no such user exists. */
export const findUserByUsername = async (
	username: string,
	deps: UsernameDeps,
	pin?: string
): Promise<UsernameUser | null> => {
	const usyncQuery = new USyncQuery().withContactProtocol()
	const user = new USyncUser().withUsername(username)
	if (pin) {
		user.withUsernameKey(pin)
	}

	usyncQuery.withUser(user)
	const result = await deps.executeUSyncQuery(usyncQuery)
	if (!result?.list?.length) {
		return null
	}

	const entry = result.list[0]!
	return {
		jid: entry.id,
		contact: (entry.contact as boolean) ?? false
	}
}

/** Look up the usernames of the given JIDs. */
export const fetchContactUsernames = async (jids: string[], deps: UsernameDeps) => {
	const usyncQuery = new USyncQuery().withUsernameProtocol()
	for (const jid of jids) {
		usyncQuery.withUser(new USyncUser().withId(jid))
	}

	const result = await deps.executeUSyncQuery(usyncQuery)
	return result?.list ?? []
}
