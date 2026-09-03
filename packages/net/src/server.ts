/**
 * `@hitreg/net/server` — the Node-only half of the package (imports `ws`).
 * Browser code imports `@hitreg/net`; a dedicated server imports this.
 */
export type { WebSocketHostTransportOptions } from "./websocket-server.js";
export { WebSocketHostTransport } from "./websocket-server.js";
export * from "./index.js";
