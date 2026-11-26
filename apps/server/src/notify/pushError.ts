export class PushError extends Error {}

/** Apple says the phone has stopped listening (app deleted, token old). */
export class GonePushError extends PushError {}
