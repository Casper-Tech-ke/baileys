import { jest } from '@jest/globals'
import {
	cancelPaymentRequest,
	declinePaymentRequest,
	requestPayment,
	sendPayment,
	sendPaymentInvite
} from '../../Socket/payment'

const JID = '254143947797@s.whatsapp.net'
const ME_JID = '254181847643@s.whatsapp.net'
const REQUEST_KEY = { remoteJid: JID, fromMe: true, id: '3EB0REQUESTKEY000000000000' }

describe('requestPayment', () => {
	const relayMessage = jest.fn(async () => {})
	const deps = { relayMessage, userJid: ME_JID, meJid: ME_JID } as any

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('rejects a non-positive amount', async () => {
		await expect(requestPayment(JID, { amount: 0, currency: 'KES' }, deps)).rejects.toThrow('greater than 0')
		await expect(requestPayment(JID, { amount: -5, currency: 'KES' }, deps)).rejects.toThrow('greater than 0')
	})

	it('rejects a missing currency', async () => {
		await expect(requestPayment(JID, { amount: 500, currency: '' }, deps)).rejects.toThrow('currency code')
	})

	it('builds a KES request in major units, with a 7-day expiry and the note', async () => {
		const before = Math.floor(Date.now() / 1000)
		const { message } = await requestPayment(JID, { amount: 500, currency: 'KES', note: 'lunch money' }, deps)
		const after = Math.floor(Date.now() / 1000)

		expect(relayMessage).toHaveBeenCalledTimes(1)
		const [relayJid, relayed] = relayMessage.mock.calls[0]!
		expect(relayJid).toBe(JID)
		expect(message.key.remoteJid).toBe(JID)

		const req = (relayed as any).requestPaymentMessage
		expect(req.currencyCodeIso4217).toBe('KES')
		expect(req.amount1000).toBe(500000)
		expect(req.amount).toEqual({ value: 50000, offset: 2, currencyCode: 'KES' })
		expect(req.requestFrom).toBe(ME_JID)
		expect(req.noteMessage.extendedTextMessage.text).toBe('lunch money')
		expect(req.background.id).toBe('DEFAULT')
		expect(req.expiryTimestamp).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60)
		expect(req.expiryTimestamp).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60)
	})

	it('uses 3 decimals for KWD and 0 for JPY', async () => {
		await requestPayment(JID, { amount: 10, currency: 'KWD' }, deps)
		const kwd = (relayMessage.mock.calls[0]![1] as any).requestPaymentMessage
		expect(kwd.amount).toEqual({ value: 10000, offset: 3, currencyCode: 'KWD' })
		expect(kwd.amount1000).toBe(10000)

		jest.clearAllMocks()
		await requestPayment(JID, { amount: 1000, currency: 'JPY' }, deps)
		const jpy = (relayMessage.mock.calls[0]![1] as any).requestPaymentMessage
		expect(jpy.amount).toEqual({ value: 1000, offset: 0, currencyCode: 'JPY' })
		expect(jpy.amount1000).toBe(1000000)
	})

	it('honours an explicit expiry', async () => {
		const expiry = new Date('2027-01-01T00:00:00Z')
		await requestPayment(JID, { amount: 1, currency: 'KES', expiry }, deps)
		const req = (relayMessage.mock.calls[0]![1] as any).requestPaymentMessage
		expect(req.expiryTimestamp).toBe(Math.floor(expiry.getTime() / 1000))
	})
})

describe('sendPayment', () => {
	const relayMessage = jest.fn(async () => {})
	const deps = { relayMessage, userJid: ME_JID, meJid: ME_JID } as any

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('rejects a missing request key', async () => {
		await expect(sendPayment(JID, { requestMessageKey: {} as any }, deps)).rejects.toThrow('key of the payment request')
	})

	it('references the request key and carries the note', async () => {
		await sendPayment(JID, { requestMessageKey: REQUEST_KEY, note: 'paid, thanks' }, deps)
		const pay = (relayMessage.mock.calls[0]![1] as any).sendPaymentMessage
		expect(pay.requestMessageKey).toEqual(REQUEST_KEY)
		expect(pay.noteMessage.extendedTextMessage.text).toBe('paid, thanks')
	})
})

describe('declinePaymentRequest / cancelPaymentRequest', () => {
	const relayMessage = jest.fn(async () => {})
	const deps = { relayMessage, userJid: ME_JID, meJid: ME_JID } as any

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('declines with the request key', async () => {
		await declinePaymentRequest(JID, REQUEST_KEY, deps)
		const msg = (relayMessage.mock.calls[0]![1] as any).declinePaymentRequestMessage
		expect(msg.key).toEqual(REQUEST_KEY)
	})

	it('cancels with the request key', async () => {
		await cancelPaymentRequest(JID, REQUEST_KEY, deps)
		const msg = (relayMessage.mock.calls[0]![1] as any).cancelPaymentRequestMessage
		expect(msg.key).toEqual(REQUEST_KEY)
	})

	it('rejects a key without an id', async () => {
		await expect(declinePaymentRequest(JID, {} as any, deps)).rejects.toThrow('key of the payment request')
		await expect(cancelPaymentRequest(JID, {} as any, deps)).rejects.toThrow('key of the payment request')
	})
})

describe('sendPaymentInvite', () => {
	const relayMessage = jest.fn(async () => {})
	const deps = { relayMessage, userJid: ME_JID, meJid: ME_JID } as any

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('defaults to UPI with a 7-day expiry', async () => {
		const before = Math.floor(Date.now() / 1000)
		await sendPaymentInvite(JID, {}, deps)
		const invite = (relayMessage.mock.calls[0]![1] as any).paymentInviteMessage
		expect(invite.serviceType).toBe(3)
		expect(invite.expiryTimestamp).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60)
	})

	it('honours an explicit service type', async () => {
		await sendPaymentInvite(JID, { serviceType: 1 }, deps)
		const invite = (relayMessage.mock.calls[0]![1] as any).paymentInviteMessage
		expect(invite.serviceType).toBe(1)
	})
})
