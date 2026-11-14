import type { WAMediaUpload, WAMessage } from './Message.js'

/** One sticker inside a pack. */
export type StickerPackSticker = {
	/** The sticker image, as a Buffer, URL, or stream (WebP; animated WebP for animated stickers). */
	data: WAMediaUpload
	/** File name inside the pack ZIP. Defaults to `sticker-<index>.webp`. */
	fileName?: string
	/** Emojis that trigger this sticker. Defaults to []. */
	emojis?: string[]
	/** Animated WebP sticker. Defaults to false. */
	isAnimated?: boolean
	/** Lottie sticker. Defaults to false. */
	isLottie?: boolean
	/** Accessibility description. Defaults to ''. */
	accessibilityLabel?: string
	/** Mimetype of the sticker file. Defaults to 'image/webp'. */
	mimetype?: string
}

/** A sticker pack to send. */
export type StickerPack = {
	/** Display name of the pack. */
	name: string
	/** Publisher/author name shown with the pack. */
	publisher: string
	/** Longer description shown in the pack view. */
	description?: string
	/** The stickers in the pack (1–60). */
	stickers: StickerPackSticker[]
	/** Tray icon (the pack's cover image, PNG/WebP, 96x96 recommended). */
	trayIcon: WAMediaUpload
	/** File name of the tray icon inside the pack ZIP. Defaults to 'tray.png'. */
	trayIconFileName?: string
	/** Optional 252x252 JPEG cover for the pack thumbnail. When given, it is
	 * uploaded as the thumbnail (instead of the raw tray icon) and its
	 * sha256 (base64) is sent as imageDataHash — the reference telepack
	 * approach. Without it the thumbnail is the tray icon and imageDataHash
	 * is omitted, which makes the pack open to skeleton loading. */
	cover?: WAMediaUpload
	/** Pack id. Defaults to a random UUID. */
	stickerPackId?: string
	/** Pack origin. Defaults to 'THIRD_PARTY' (a pack sent by an app/library). */
	origin?: 'FIRST_PARTY' | 'THIRD_PARTY' | 'USER_CREATED'
	/** Optional caption on the pack message. */
	caption?: string
}

export type StickerPackResult = {
	/** The sent message. */
	message: WAMessage
	/** The pack id that was sent. */
	stickerPackId: string
}
