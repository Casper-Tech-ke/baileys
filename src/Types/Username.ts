export type UsernameSource = 'FB' | 'IG' | 'USER_INPUT' | 'SUGGESTION'

export type UsernameCheckResult = {
	available: boolean
	username: string
	session_id: string
	suggestions?: string[]
	rejectionReasons?: string[]
	suggestionsEligible?: boolean
}

export type SetUsernameOptions = {
	source?: UsernameSource
	sessionId?: string
	pin?: string
}

export type UsernameUser = {
	jid: string
	contact: boolean
}
