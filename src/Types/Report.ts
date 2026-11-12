import type { WAMessage } from './Message'

/**
 * `spam_flow` values, from the official client's own flow enum (recovered
 * from the decompiled WhatsApp app, `C1938J8b`). The server validates this
 * attribute against that list. The public whatsapp-rust library uses
 * PascalCase names for the same flows (MessageMenu, ContactInfo,
 * GroupInfoReport, StatusReport, GroupSpamBannerReport); the app sends the
 * snake_case forms below.
 */
export const SPAM_FLOWS = {
	/** 1:1 chat (default for a contact report) */
	CHAT: 'chat',
	/** report from a message's menu */
	MESSAGE_MENU: 'message_menu',
	/** report from the overflow menu */
	OVERFLOW_MENU: 'overflow_menu_report',
	/** report from the contact/chat info screen */
	ACCOUNT_INFO: 'account_info_report',
	/** report from the 1:1 spam banner */
	ONE_TO_ONE_SPAM_BANNER: '1_1_spam_banner_report',
	/** report from group info */
	GROUP_INFO: 'group_info_report',
	/** report from the group spam banner */
	GROUP_SPAM_BANNER: 'group_spam_banner_report',
	/** report a personal status post */
	STATUS_POST: 'status_post_report',
	/** report a channel (newsletter) */
	NEWSLETTER_INFO: 'newsletter_info_report',
	/** report a channel (WA Business / WAMO variant) */
	WAMO_CHANNEL: 'wamo_channel_report',
	/** report a channel status */
	CHANNEL_STATUS: 'channel_status_report',
	/** report an event */
	EVENT_INFO: 'event_info_report',
	/** report from the event home screen */
	EVENT_HOME: 'event_home_report'
} as const

export type SpamFlow = (typeof SPAM_FLOWS)[keyof typeof SPAM_FLOWS]

/**
 * Report reason codes, from the official client's reason mapper (`C7pY` in
 * the decompiled app). NOTE: the report IQ itself carries no reason field —
 * these codes are what the app's dialog maps a chosen reason to, and are
 * kept here for callers that log or display the reason. The wire format
 * only carries the flow and the messages.
 */
export const SPAM_REPORT_REASONS = {
	NO_LONGER_INTERESTED: 1,
	NO_SIGN_UP: 2,
	SPAM: 3,
	OFFENSIVE_MESSAGES: 4,
	OTP_DID_NOT_REQUEST: 5,
	SCAM_OR_FRAUD: 6
} as const

export type SpamReportReason = (typeof SPAM_REPORT_REASONS)[keyof typeof SPAM_REPORT_REASONS]

export type SpamReportOptions = {
	/** Which flow this report comes from. Defaults depend on the report type. */
	spamFlow?: SpamFlow
	/**
	 * Client trace id, sent as `wi_trace_id`. Must be 24 characters when
	 * present; one is generated when omitted.
	 */
	traceId?: string
	/** Group JID, for group reports (also sets the spam_list `jid`). */
	groupJid?: string
	/** Group subject, for group reports (sets the spam_list `subject`). */
	groupSubject?: string
	/** Reason chosen in the dialog. Not sent on the wire (see above). */
	reason?: SpamReportReason
}

export type SpamReportResult = {
	/** The `report_id` the server returned, or null when it sent none. */
	reportId: string | null
	/** The reported message's id. */
	messageId: string
}

/** What a report call takes: the target and the messages to report. */
export type SpamReportTarget = {
	/** The reported chat, group, channel or status owner JID. */
	jid: string
	/** The messages being reported (up to 5, per WhatsApp's FAQ). */
	messages: WAMessage[]
}
