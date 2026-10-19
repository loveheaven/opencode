// opencode backend — version-dispatched.
//
// opencode's server has two incompatible HTTP generations:
//   • v1 (the old `packages/opencode`): unauthenticated /session, /event,
//     /session/:id/prompt_async, /doc, part-based messages.
//   • v2 (the current `packages/server`): authenticated /api/*, /openapi.json,
//     tagged-union messages with inline content, granular streaming events.
//
// The host probes the running server (probeOpencode in server-manager.ts) and
// picks the matching implementation; both implement the same Backend interface
// and emit the same neutral model, so the webview never sees the difference.

export { OpencodeV1Backend } from "./opencode-v1"
export { OpencodeV2Backend } from "./opencode-v2"
