import { Boom } from '@hapi/boom'
import crypto from 'crypto'
import { proto } from '../../WAProto/index.js'
import type {
	PaymentBackground,
	PaymentInviteOptions,
	PaymentResult,
	RequestPaymentOptions,
	SendPaymentOptions
} from '../Types/index.js'
import type { WAMessageKey } from '../Types/index.js'
import { generateWAMessageFromContent, unixTimestampSeconds } from '../Utils/index.js'

export type PaymentDeps = {
	relayMessage: (jid: string, message: proto.IMessage, opts: { messageId: string }) => Promise<unknown>
	userJid?: string
	meJid?: string
}

/** Currencies with no minor unit (0 decimals) or three decimals; everything else defaults to 2. */
const CURRENCY_DECIMALS: Record<string, number> = {
	JPY: 0,
	KRW: 0,
	VND: 0,
	CLP: 0,
	ISK: 0,
	UGX: 0,
	XAF: 0,
	XOF: 0,
	BHD: 3,
	IQD: 3,
	JOD: 3,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	TND: 3
}

const decimalsFor = (currency: string) => CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2

/** The app lets a payment request live for 7 days. */
const PAYMENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000

const toUnixSeconds = (value: Date | number | undefined, fallbackMs: number) => {
	if (value instanceof Date) return Math.floor(value.getTime() / 1000)
	if (typeof value === 'number') return Math.floor(value / 1000)
	return Math.floor(fallbackMs / 1000)
}

const defaultBackground = (background?: PaymentBackground) =>
	background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 }

const send = async (jid: string, content: proto.IMessage, deps: PaymentDeps): Promise<PaymentResult> => {
	const messageSecret = crypto.randomBytes(32)
	const wrapped = generateWAMessageFromContent(jid, { messageContextInfo: { messageSecret }, ...content }, {
		userJid: deps.userJid
	} as any)
	await deps.relayMessage(jid, wrapped.message!, { messageId: wrapped.key.id! })
	return { message: wrapped }
}

/**
 * Request a payment — sends a `requestPaymentMessage` card with the amount,
 * currency and an optional note. The amount is given in the currency's
 * major units (500 = 500 KES); it is sent as `amount1000` (thousandths)
 * and as a `Money` value in the currency's minor units.
 *
 * This only sends the request message. Moving money still needs a payment
 * provider (WhatsApp Pay / UPI / M-Pesa); the library does not settle it.
 */
export const requestPayment = async (
	jid: string,
	options: RequestPaymentOptions,
	deps: PaymentDeps
): Promise<PaymentResult> => {
	if (!options.amount || options.amount <= 0) {
		throw new Boom('payment request needs an amount greater than 0', { statusCode: 400 })
	}

	if (!options.currency) {
		throw new Boom('payment request needs a currency code', { statusCode: 400 })
	}

	const decimals = decimalsFor(options.currency)
	const currencyCode = options.currency.toUpperCase()
	const noteMessage = options.note ? { extendedTextMessage: { text: options.note } } : undefined

	return send(
		jid,
		{
			requestPaymentMessage: {
				currencyCodeIso4217: currencyCode,
				amount1000: Math.round(options.amount * 1000),
				requestFrom: options.from || deps.meJid || deps.userJid || '',
				expiryTimestamp: toUnixSeconds(options.expiry, Date.now() + PAYMENT_REQUEST_TTL_MS),
				amount: {
					value: Math.round(options.amount * 10 ** decimals),
					offset: decimals,
					currencyCode
				},
				noteMessage,
				background: defaultBackground(options.background)
			}
		},
		deps
	)
}

/**
 * Mark a payment as sent against a request — a `sendPaymentMessage`
 * referencing the request's key. `transactionData` is the opaque data
 * from the payment provider; without a provider it is just a note that
 * the payment was made.
 */
export const sendPayment = async (
	jid: string,
	options: SendPaymentOptions,
	deps: PaymentDeps
): Promise<PaymentResult> => {
	if (!options.requestMessageKey?.id) {
		throw new Boom('sendPayment needs the key of the payment request', { statusCode: 400 })
	}

	return send(
		jid,
		{
			sendPaymentMessage: {
				requestMessageKey: options.requestMessageKey,
				noteMessage: options.note ? { extendedTextMessage: { text: options.note } } : undefined,
				background: defaultBackground(options.background),
				transactionData: options.transactionData
			}
		},
		deps
	)
}

/** Decline a payment request, referencing it by its message key. */
export const declinePaymentRequest = async (
	jid: string,
	requestMessageKey: WAMessageKey,
	deps: PaymentDeps
): Promise<PaymentResult> => {
	if (!requestMessageKey?.id) {
		throw new Boom('declinePaymentRequest needs the key of the payment request', { statusCode: 400 })
	}

	return send(jid, { declinePaymentRequestMessage: { key: requestMessageKey } }, deps)
}

/** Cancel your own payment request, referencing it by its message key. */
export const cancelPaymentRequest = async (
	jid: string,
	requestMessageKey: WAMessageKey,
	deps: PaymentDeps
): Promise<PaymentResult> => {
	if (!requestMessageKey?.id) {
		throw new Boom('cancelPaymentRequest needs the key of the payment request', { statusCode: 400 })
	}

	return send(jid, { cancelPaymentRequestMessage: { key: requestMessageKey } }, deps)
}

/**
 * Invite someone to a payment service — a `paymentInviteMessage` card.
 * serviceType: 1 = FBPAY, 2 = NOVI, 3 = UPI.
 */
export const sendPaymentInvite = async (
	jid: string,
	options: PaymentInviteOptions = {},
	deps: PaymentDeps
): Promise<PaymentResult> => {
	return send(
		jid,
		{
			paymentInviteMessage: {
				serviceType: options.serviceType ?? 3,
				expiryTimestamp: options.expiry
					? toUnixSeconds(options.expiry, 0)
					: unixTimestampSeconds() + Math.floor(PAYMENT_REQUEST_TTL_MS / 1000)
			}
		},
		deps
	)
}
