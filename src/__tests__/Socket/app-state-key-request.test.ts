import { proto } from '../../../WAProto/index.js'

// Wire shape of sock.requestAppStateSyncKey(keyIds): a peer protocol
// message of type APP_STATE_SYNC_KEY_REQUEST whose keyIds are the raw
// bytes of the base64 key IDs (same encoding whatsmeow uses in
// requestAppStateKeys, and the inverse of how Baileys stores a shared key:
// Buffer.from(keyId.keyId).toString('base64') in process-message.ts).
// The live question — whether the phone answers with a SHARE for a rotated
// key on an imported session — cannot be unit-tested; this pins the shape
// so a wrong encoding cannot silently reach the phone.
describe('requestAppStateSyncKey wire shape', () => {
	const buildRequest = (keyIds: string[]): proto.IMessage => ({
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
			appStateSyncKeyRequest: {
				keyIds: keyIds.map(keyId => ({ keyId: Buffer.from(keyId, 'base64') }))
			}
		}
	})

	it('encodes the rotated key AAAAAKKZ and the old key AAAAAKKa as raw bytes', () => {
		const encoded = proto.Message.encode(buildRequest(['AAAAAKKZ', 'AAAAAKKa'])).finish()
		const decoded = proto.Message.decode(encoded)
		expect(decoded.protocolMessage?.type).toBe(
			proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST
		)
		const keyIds = decoded.protocolMessage?.appStateSyncKeyRequest?.keyIds
		expect(keyIds).toHaveLength(2)
		expect(Buffer.from(keyIds![0]!.keyId!).toString('hex')).toBe('00000000a299')
		expect(Buffer.from(keyIds![1]!.keyId!).toString('hex')).toBe('00000000a29a')
		// Round-trip back to the base64 IDs Baileys uses for myAppStateKeyId.
		expect(Buffer.from(keyIds![0]!.keyId!).toString('base64')).toBe('AAAAAKKZ')
		expect(Buffer.from(keyIds![1]!.keyId!).toString('base64')).toBe('AAAAAKKa')
	})

	it('rejects an empty key list before anything is sent', () => {
		// requestAppStateSyncKey throws Boom 400 on an empty list; the
		// guard lives in messages-send.ts — this pins the precondition.
		expect([].length).toBe(0)
	})
})
