import { jest } from '@jest/globals'
import type { AuthenticationState } from '../../Types'
import { makeSyncKeyAutoResolver } from '../../Utils/sync-key-auto-resolve'

const silentLogger = { warn: jest.fn() }

const fakeAuthState = (keyId: string | undefined, stored: Record<string, object>) => {
	return {
		creds: { myAppStateKeyId: keyId },
		keys: {
			get: jest.fn(async (_type: string, ids: string[]) => {
				const out: Record<string, object> = {}
				for (const id of ids) {
					if (stored[id]) {
						out[id] = stored[id]
					}
				}

				return out
			})
		}
	} as unknown as AuthenticationState
}

describe('makeSyncKeyAutoResolver', () => {
	it('does nothing when the session has no id yet', async () => {
		const requestKey = jest.fn(async () => 'msg-id')
		const resolve = makeSyncKeyAutoResolver({
			authState: fakeAuthState(undefined, {}),
			requestKey,
			logger: silentLogger
		})

		expect(await resolve()).toBe('no-id')
		expect(requestKey).not.toHaveBeenCalled()
	})

	it('does nothing when the value is already stored', async () => {
		const requestKey = jest.fn(async () => 'msg-id')
		const resolve = makeSyncKeyAutoResolver({
			authState: fakeAuthState('AAAAANW7', { AAAAANW7: { keyData: Buffer.from('x') } }),
			requestKey,
			logger: silentLogger
		})

		expect(await resolve()).toBe('present')
		expect(requestKey).not.toHaveBeenCalled()
	})

	it('asks once for a missing value and not again', async () => {
		const requestKey = jest.fn(async () => 'msg-id')
		const resolve = makeSyncKeyAutoResolver({
			authState: fakeAuthState('AAAAANW7', {}),
			requestKey,
			logger: silentLogger
		})

		expect(await resolve()).toBe('requested')
		expect(requestKey).toHaveBeenCalledTimes(1)
		expect(requestKey).toHaveBeenCalledWith(['AAAAANW7'])
		expect(await resolve()).toBe('already-asked')
		expect(requestKey).toHaveBeenCalledTimes(1)
	})

	it('retries after a failed ask', async () => {
		const requestKey = jest.fn(async () => 'msg-id')
		requestKey.mockRejectedValueOnce(new Error('send failed'))
		const resolve = makeSyncKeyAutoResolver({
			authState: fakeAuthState('AAAAANW7', {}),
			requestKey,
			logger: silentLogger
		})

		expect(await resolve()).toBe('failed')
		expect(await resolve()).toBe('requested')
		expect(requestKey).toHaveBeenCalledTimes(2)
	})

	it('sees a value that arrives between calls', async () => {
		const stored: Record<string, object> = {}
		const requestKey = jest.fn(async () => 'msg-id')
		const resolve = makeSyncKeyAutoResolver({
			authState: fakeAuthState('AAAAANW7', stored),
			requestKey,
			logger: silentLogger
		})

		expect(await resolve()).toBe('requested')
		stored['AAAAANW7'] = { keyData: Buffer.from('x') }
		expect(await resolve()).toBe('present')
		expect(requestKey).toHaveBeenCalledTimes(1)
	})
})
