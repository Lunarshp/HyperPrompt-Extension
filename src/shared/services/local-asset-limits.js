export const LOCAL_ASSET_MAX_BYTES = 409600;
export function jsonUtf8Bytes(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }
