import type { WAMessage, WAMessageKey } from './Message.js'

/** Colour/id background for a payment message (no image upload in v1). */
export type PaymentBackground = {
	/** Background id, e.g. 'DEFAULT'. */
	id?: string
	/** ARGB colour behind the amount, e.g. 0xfff0f0f0. */
	placeholderArgb?: number
	/** ARGB colour of the amount text, e.g. 0xffffffff. */
	textArgb?: number
	/** ARGB colour of the subtext, e.g. 0xffaa00ff. */
	subtextArgb?: number
}

export type RequestPaymentOptions = {
	/** Amount in the currency's major units, e.g. 500 = 500 KES. */
	amount: number
	/** ISO 4217 currency code, e.g. 'KES'. */
	currency: string
	/** Note shown with the request. */
	note?: string
	/** When the request expires, as a Date or unix ms. Defaults to 7 days from now (as the app does). */
	expiry?: Date | number
	/** Background of the request card. Defaults to the DEFAULT colour background. */
	background?: PaymentBackground
	/** JID of the requester. Defaults to the own account. */
	from?: string
}

export type SendPaymentOptions = {
	/** Key of the payment request being paid. */
	requestMessageKey: WAMessageKey
	/** Note shown with the payment. */
	note?: string
	/** Opaque transaction data from the payment provider. */
	transactionData?: string
	/** Background of the payment card. */
	background?: PaymentBackground
}

export type PaymentInviteOptions = {
	/** Payment service: 1 = FBPAY, 2 = NOVI, 3 = UPI. */
	serviceType?: 1 | 2 | 3
	/** When the invite expires, as a Date or unix ms. */
	expiry?: Date | number
}

export type PaymentResult = {
	/** The sent message. */
	message: WAMessage
}
