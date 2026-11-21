import type { BinaryNode } from '../WABinary'
import type { WAMessage } from './Message'

/**
 * `spam_flow` values, from the official client's own flow enum (recovered
 * from the decompiled WhatsApp app, `C1938J8b`). The server validates this
 * attribute against that list. This object covers every value in that
 * enum that can appear in a report — 36 report flows plus the 13 bare
 * entry-point values; the `_block` values are block entry points, not
 * report flows, and are left out. The public whatsapp-rust library uses
 * PascalCase names for the same flows (MessageMenu, ContactInfo,
 * GroupInfoReport, StatusReport, GroupSpamBannerReport); the app sends the
 * snake_case forms below. Both casings are exported here so either style
 * resolves to the same wire value.
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
	EVENT_HOME: 'event_home_report',

	// Every other report flow in the app's validated enum (decompiled APK
	// enum C1938J8b) — the entry point the report was started from.
	/** report from account info while signed in as a guest user */
	ACCOUNT_INFO_REPORT_AS_GUEST_USER: 'account_info_report_as_guest_user',
	/** report from an album's media menu */
	ALBUM_MEDIA_MENU_REPORT: 'album_media_menu_report',
	/** report from a call's detail screen overflow menu */
	CALL_DETAIL_OVERFLOW_REPORT: 'call_detail_overflow_report',
	/** report from a call's detail screen safety tools */
	CALL_DETAIL_SAFETY_TOOLS_REPORT: 'call_detail_safety_tools_report',
	/** report from the spam-call dialog */
	CALL_SPAM_DIALOG_REPORT: 'call_spam_dialog_report',
	/** report from a chat's safety card while signed in as a guest user */
	CHAT_FMX_CARD_REPORT_AS_GUEST_USER: 'chat_fmx_card_report_as_guest_user',
	/** report from a chat's safety card */
	CHAT_FMX_CARD_SAFETY_TOOLS_REPORT: 'chat_fmx_card_safety_tools_report',
	/** report a suspicious chat from its safety card */
	CHAT_FMX_CARD_SAFETY_TOOLS_REPORT_SUSPICIOUS: 'chat_fmx_card_safety_tools_report_suspicious',
	/** report offered when swiping to delete a chat */
	CHAT_LIST_SWIPE_DELETE_REPORT_UPSELL: 'chat_list_swipe_delete_report_upsell',
	/** report from the chat theme screen's overflow menu */
	CHAT_THEME_SCREEN_OVERFLOW_MENU_REPORT: 'chat_theme_screen_overflow_menu_report',
	/** report offered when declining a chat request from the banner */
	DEPENDANT_CHAT_REQUEST_BANNER_DECLINE_REPORT_UPSELL: 'dependant_chat_request_banner_decline_report_upsell',
	/** report from the extension menu */
	EXTENSION_MENU_REPORT: 'extension_menu_report',
	/** report offered when leaving a group from the chat list */
	GROUP_CHATLIST_LEAVE_REPORT_UPSELL: 'group_chatlist_leave_report_upsell',
	/** report offered when swiping to leave a group */
	GROUP_CHATLIST_SWIPE_LEAVE_REPORT_UPSELL: 'group_chatlist_swipe_leave_report_upsell',
	/** report offered when leaving a group from its info screen */
	GROUP_INFO_LEAVE_REPORT_UPSELL: 'group_info_leave_report_upsell',
	/** report offered when leaving a group from its overflow menu */
	GROUP_OVERFLOW_MENU_LEAVE_REPORT_UPSELL: 'group_overflow_menu_leave_report_upsell',
	/** report a participant of a guest call */
	GUEST_CALL_PARTICIPANT_REPORT: 'guest_call_participant_report',
	/** report a guest call */
	GUEST_CALL_REPORT: 'guest_call_report',
	/** report from the in-app browser menu */
	IAB_MENU_REPORT: 'iab_menu_report',
	/** report from the banner of a group already left */
	LEFT_GROUP_SPAM_BANNER_REPORT: 'left_group_spam_banner_report',
	/** report an answer to a channel question */
	NEWSLETTER_QUESTION_RESPONSE_REPORT: 'newsletter_question_response_report',
	/** report a community from the overflow menu */
	OVERFLOW_MENU_COMMUNITY_REPORT: 'overflow_menu_community_report',
	/** report a payment transaction */
	PAYMENT_TRANSACTION_REPORT: 'payment_transaction_report',
	/** report from the safety card of a chat you started */
	USER_INITIATED_CHAT_FMX_CARD_SAFETY_TOOLS_REPORT: 'user_initiated_chat_fmx_card_safety_tools_report',
	/** report from the suspicious-chat banner's safety tools */
	USER_INITIATED_CHAT_SUSPICIOUS_BANNER_SAFETY_TOOLS_REPORT:
		'user_initiated_chat_suspicious_banner_safety_tools_report',

	// Bare entry-point values from the same enum — the screen the report was
	// started from, without going through a named report dialog.
	/** report from the account info screen */
	ACCOUNT_INFO_SCREEN: 'account_info',
	/** report from the group info screen */
	GROUP_INFO_SCREEN: 'group_info',
	/** report from a chat's overflow menu */
	OVERFLOW_MENU_SCREEN: 'overflow_menu',
	/** report from the call log */
	CALL_LOG: 'call_log',
	/** report from the media viewer */
	MEDIA_VIEWER: 'media_viewer',
	/** report from the community home screen */
	COMMUNITY_HOME: 'community_home',
	/** report from an enterprise client entry point */
	ENT_CLIENT: 'ent_client',
	/** report from the FRX entry point (app-internal name, meaning not pinned down) */
	FRX: 'frx',
	/** report a status question answer */
	STATUS_QUESTION_ANSWER: 'status_question_answer',
	/** report from the view-once viewer */
	VIEW_ONCE_VIEWER: 'view_once_viewer',
	/** report from a comment's actions sheet */
	COMMENT_ACTIONS_BOTTOM_SHEET: 'comment_actions_bottom_sheet',

	// PascalCase aliases for the same flows (whatsapp-rust / other forks
	// name them this way); every alias carries the identical wire value.
	/** 1:1 chat (default for a contact report) */
	Chat: 'chat',
	/** report from a message's menu */
	MessageMenu: 'message_menu',
	/** report from the overflow menu */
	OverflowMenuReport: 'overflow_menu_report',
	/** report from the contact/chat info screen */
	AccountInfoReport: 'account_info_report',
	/** report from the contact/chat info screen (whatsapp-rust name) */
	ContactInfo: 'account_info_report',
	/** report from the contact/chat info screen (WA-JS / WhatsApp Web name; its default) */
	ChatInfoReport: 'account_info_report',
	/** report from the 1:1 spam banner */
	OneToOneSpamBannerReport: '1_1_spam_banner_report',
	/** report from group info */
	GroupInfoReport: 'group_info_report',
	/** report from the group spam banner */
	GroupSpamBannerReport: 'group_spam_banner_report',
	/** report a personal status post */
	StatusPostReport: 'status_post_report',
	/** report a personal status post (whatsapp-rust name) */
	StatusReport: 'status_post_report',
	/** report a channel (newsletter) */
	NewsletterInfoReport: 'newsletter_info_report',
	/** report a channel (WA Business / WAMO variant) */
	WamoChannelReport: 'wamo_channel_report',
	/** report a channel status */
	ChannelStatusReport: 'channel_status_report',
	/** report an event */
	EventInfoReport: 'event_info_report',
	/** report from the event home screen */
	EventHomeReport: 'event_home_report'
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
	/** Alias of `spamFlow` (other forks call the option `flow`). `spamFlow` wins when both are given. */
	flow?: SpamFlow
	/**
	 * Client trace id, sent as `wi_trace_id`. Must be 24 characters when
	 * present; one is generated when omitted.
	 */
	traceId?: string
	/** Group JID, for group reports (also sets the spam_list `jid`). */
	groupJid?: string
	/** Group subject, for group reports (sets the spam_list `subject`). */
	groupSubject?: string
	/**
	 * The reported member inside a group (sets the spam_list `source`
	 * attribute, per the app's own spam report builder). Only meaningful
	 * when the target is a group.
	 */
	source?: string
	/** Messages to attach to a target report (used by the JID-based form). */
	messages?: WAMessage[]
	/** Reason chosen in the dialog. Not sent on the wire (see above). */
	reason?: SpamReportReason
}

export type SpamReportResult = {
	/** The `report_id` the server returned, or null when it sent none. */
	reportId: string | null
	/** The reported message's id. */
	messageId: string
}

/**
 * What a JID-based report call returns: one report for one target. `reported`
 * is true when the server accepted the report IQ (a rejected report throws
 * instead); `node` is the stanza that was sent.
 */
export type SpamReportTargetResult = {
	/** The reported chat, group, channel or status owner JID. */
	jid: string
	/** The flow the report was sent with. */
	flow: SpamFlow
	/** True when the server accepted the report. */
	reported: boolean
	/** The `report_id` the server returned, or null when it sent none. */
	reportId: string | null
	/** The spam IQ that was sent. */
	node: BinaryNode
}

/** What a report call takes: the target and the messages to report. */
export type SpamReportTarget = {
	/** The reported chat, group, channel or status owner JID. */
	jid: string
	/** The messages being reported (up to 5, per WhatsApp's FAQ). */
	messages: WAMessage[]
}
