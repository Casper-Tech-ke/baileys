import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

const mockKeys: jest.Mocked<SignalKeyStoreWithTransaction> = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`12345_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping']) // Simulate not found in DB

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})

		it('should return the PN without a :0 device suffix for a primary-device LID', async () => {
			const lid = '265726069833797@lid'
			const pnUser = '254181847643'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`265726069833797_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBe(`${pnUser}@s.whatsapp.net`)
		})
	})

	describe('storeLIDPNMappings round-trip', () => {
		const makeMemoryKeys = () => {
			const store: Record<string, Record<string, string>> = {}
			return {
				get: jest.fn(async (_type: string, ids: string[]) => {
					const out: Record<string, string> = {}
					for (const id of ids) {
						const value = store[_type]?.[id]
						if (value !== undefined) {
							out[id] = value
						}
					}

					return out
				}),
				set: jest.fn(async (data: Record<string, Record<string, string>>) => {
					for (const [type, values] of Object.entries(data)) {
						store[type] = { ...store[type], ...values }
					}
				}),
				transaction: jest.fn(async (work: () => unknown) => await work()),
				isInTransaction: jest.fn(() => false)
			} as unknown as SignalKeyStoreWithTransaction
		}

		it('stores both directions and reads them back in canonical form', async () => {
			const memoryKeys = makeMemoryKeys()
			const store = new LIDMappingStore(memoryKeys, logger, mockPnToLIDFunc)
			await store.storeLIDPNMappings([{ lid: '265726069833797@lid', pn: '254181847643@s.whatsapp.net' }])

			expect(await store.getPNForLID('265726069833797@lid')).toBe('254181847643@s.whatsapp.net')
			expect(await store.getLIDForPN('254181847643@s.whatsapp.net')).toBe('265726069833797@lid')
		})

		it('persists the reverse mapping so a fresh store instance can read it', async () => {
			const memoryKeys = makeMemoryKeys()
			const store = new LIDMappingStore(memoryKeys, logger, mockPnToLIDFunc)
			await store.storeLIDPNMappings([{ lid: '265726069833797@lid', pn: '254181847643@s.whatsapp.net' }])

			const freshStore = new LIDMappingStore(memoryKeys, logger, mockPnToLIDFunc)
			expect(await freshStore.getPNForLID('265726069833797@lid')).toBe('254181847643@s.whatsapp.net')
		})
	})
})
