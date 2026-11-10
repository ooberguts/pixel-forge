# API and AI connections

Pixel Forge exposes the **running desktop editor** through an optional local HTTP API and a bundled MCP adapter. A test script or AI client can inspect converted images, read animation timing and metadata, make pixel edits, and retrieve finished files. The editor remains the source of truth; changes appear in its workspaces.

## Start a connection

1. Open **App settings → API & AI connections** in the desktop app.
2. Leave **Allow edits through the API** off for inspection and export, or enable it to allow document changes.
3. Choose **Start connection**. Copy its address and access token, or use **Copy MCP configuration**.
4. Close App settings before asking a client to edit. Editing and export reject conflicting dialogs, playback, painting, and other active work.

The API binds only to `127.0.0.1`, normally on port `47831`. A fresh token is generated for each connection. It is held in memory, expires on Stop connection or app exit, and is not saved in the project. Stop and restart to change edit access; update the AI client's configuration with the new token. Browser preview does not start a server.

Access includes the current media and project content. Give the token only to a client you want to inspect those assets; enabling edits also lets that client replace or modify work. Sprite edits, batches, and imports enter the existing undo history. Converter changes require the current revision but do not have a separate undo history. Save valuable work before allowing replacement.

## Connect an MCP client on this computer

Install Node.js 24 or newer on the computer running the AI client. **Copy MCP configuration** supplies the bundled adapter's absolute path. Use the following shape if configuring it manually:

```json
{
  "mcpServers": {
    "pixel-forge": {
      "command": "node",
      "args": ["/absolute/path/to/pixel-forge-mcp.mjs"],
      "env": {
        "PIXEL_FORGE_API_URL": "http://127.0.0.1:47831",
        "PIXEL_FORGE_API_TOKEN": "PASTE_THE_CURRENT_SESSION_TOKEN"
      }
    }
  }
}
```

In a source checkout, the adapter is `scripts/pixel-forge-mcp.mjs`. It needs no npm dependencies and can also be run with `npm run mcp`. Use an absolute path to the Node executable if the AI client's environment does not include Node in `PATH`. Client configuration locations differ; use the client's documented MCP server settings. Do not commit a configuration containing a live token.

The adapter uses MCP stdio and protocol version `2025-03-26`: newline-delimited JSON-RPC, initialization, ping, tool discovery/calls, bounded batches, and cancellation notifications. It exposes tools only, with PNG previews as image content and exported files as embedded binary resources. It writes protocol messages to stdout and startup errors to stderr. This follows the official [transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle), and [tool](https://modelcontextprotocol.io/specification/2025-03-26/server/tools) specifications. The HTTP API below is not itself an MCP Streamable HTTP endpoint.

## Connect an AI client on another computer

Use an SSH tunnel to the computer running Pixel Forge. This requires an SSH account and SSH service already configured there; Pixel Forge does not enable remote login or change firewall settings.

On the **AI client's computer**, run:

```sh
ssh -N -L 127.0.0.1:47832:127.0.0.1:47831 user@pixel-forge-computer
```

Keep that SSH process running. Copy `pixel-forge-mcp.mjs` to the AI client's computer and install Node.js 24 or newer there. Use the MCP configuration above with:

- `args`: the adapter's absolute path on the AI client's computer.
- `PIXEL_FORGE_API_URL`: `http://127.0.0.1:47832`.
- `PIXEL_FORGE_API_TOKEN`: the current token shown on the Pixel Forge computer.

The tunnel carries authenticated API requests to the editor. Pixel Forge continues listening only on its own loopback interface. The adapter refuses non-loopback URLs and redirects. No public server, cloud account, or provider API key is required by Pixel Forge. Your chosen AI client controls which model receives its tool results.

## Available tools

Frame numbers in API arguments are **zero-based**. Read state immediately before an edit and supply the returned revision string. A stale revision is rejected instead of overwriting intervening user changes. Operations are limited to the documented editor actions; no shell command or arbitrary filesystem tool is exposed.

| MCP tool                          | HTTP method name      | Behavior                                                                       |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `pixel_forge_connection_status`   | `GET /v1/status`      | Connection and access mode.                                                    |
| `pixel_forge_app_state`           | `app.get_state`       | Workspace and document summaries.                                              |
| `pixel_forge_set_workspace`       | `app.set_workspace`   | Switch Adjust media / Edit frames without replacing work.                      |
| `pixel_forge_converter_state`     | `converter.get_state` | Source, settings, timing, trim, and revision.                                  |
| `pixel_forge_converter_preview`   | `converter.preview`   | Current 1× converted PNG without guides.                                       |
| `pixel_forge_configure_converter` | `converter.configure` | Change settings, sampling FPS, or trim.                                        |
| `pixel_forge_import_media`        | `converter.import`    | Import base64 PNG/JPEG/WebP/GIF or WebM/MP4 source.                            |
| `pixel_forge_create_game_asset`   | `converter.transfer`  | Copy the conversion into Edit frames at 1×.                                    |
| `pixel_forge_sprite_state`        | `sprite.get_state`    | Dimensions, durations, tags, pivot, selection, revision, undo state.           |
| `pixel_forge_sprite_frame`        | `sprite.get_frame`    | A frame's lossless RGBA PNG without guides.                                    |
| `pixel_forge_export_sprite`       | `sprite.export`       | Editable project, game asset ZIP, or GIF bytes.                                |
| `pixel_forge_edit_sprite`         | `sprite.apply`        | One undoable batch of pixel, timing, pivot, tag, frame, name, or canvas edits. |
| `pixel_forge_import_sprite`       | `sprite.import`       | Import a base64 GIF or `.pixelforge` project.                                  |
| `pixel_forge_undo_sprite`         | `sprite.undo`         | Undo one sprite change.                                                        |
| `pixel_forge_redo_sprite`         | `sprite.redo`         | Redo one sprite change.                                                        |

Tool discovery returns complete JSON schemas, including ranges and required fields. `sprite.apply` accepts `pixels`, `duration`, `pivot`, `tag`, `remove_tag`, `rename`, `duplicate_frame`, `delete_frame`, `move_frame`, and `resize_canvas` operations. The whole batch is validated before committing. Canvas resize pads or crops at top-left, without resampling.

Imports require `replace: true` and the destination's `expectedRevision`. A converter transfer also requires `expectedSpriteRevision`. GIF sources imported through `converter.import` retain original frame timing; video sources use the configured sampling rate. Internal workspace values remain `converter` and `sprites` even though the interface labels are Adjust media and Edit frames. These explicit fields authorize replacement for that API request; there is no unattended confirmation dialog. Read both states again if the user edits either document in between.

## Use the HTTP API directly

Every request requires `Authorization: Bearer <token>`. Commands use `POST /v1/commands`, `Content-Type: application/json`, and a body with `method` and `params`. A successful response is `{ "result": ... }`; failures return `{ "error": "message" }` with an HTTP error status. Send one command at a time.

Set `PIXEL_FORGE_API_TOKEN` in the client environment to the session token, then inspect the document:

```sh
curl --fail-with-body http://127.0.0.1:47831/v1/commands \
  -H "Authorization: Bearer $PIXEL_FORGE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"method":"sprite.get_state","params":{}}'
```

Use the returned `revision` in an edit:

```json
{
  "method": "sprite.apply",
  "params": {
    "expectedRevision": "REVISION_FROM_SPRITE_STATE",
    "operations": [
      { "type": "duration", "frame": 0, "duration": 120 },
      { "type": "pixels", "frame": 0, "pixels": [{ "x": 4, "y": 6, "rgba": [255, 80, 40, 255] }] }
    ]
  }
}
```

An export request is:

```json
{ "method": "sprite.export", "params": { "format": "pack" } }
```

Use `project`, `pack`, or `gif`. The result contains `name`, `mimeType`, `base64`, and `revision`. The client decides where to save those bytes. API export does not open a Save dialog, write an arbitrary path, or mark the project saved in the editor. Project and PNG asset formats preserve RGBA, timing, tags, and pivot. GIF has palette, binary transparency, and 10 ms timing limits and carries no game metadata.

Typical errors:

| Status | Meaning / recovery                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `401`  | Token is missing or expired. Copy the current connection token.                                                                         |
| `403`  | Editing is disabled, or a browser-origin request was rejected. Enable edit access in the app when wanted; use a non-browser API client. |
| `409`  | Another command is running. Wait for its result.                                                                                        |
| `413`  | Request is too large. Import the file through the app instead.                                                                          |
| `422`  | Invalid input, stale revision, or conflicting editor activity. Read state and correct the request.                                      |
| `503`  | Connection stopped or editor unavailable.                                                                                               |
| `504`  | Command timed out. Inspect state before retrying; an already committed edit is not rolled back.                                         |

## Limits and verification

- API imports: at most 8 MiB of decoded file data. Exports: at most 64 MiB of file data. HTTP/stdio requests: 16 MiB; HTTP responses: 96 MiB. Large files can still be imported or exported through the ordinary app within its existing limits.
- Sprite limits remain 512 × 512, 256 frames, and 16 million total frame pixels. An API edit batch allows 64 operations and 4096 changed pixels.
- Native commands time out after 60 seconds; the MCP adapter waits up to 65 seconds. Cancellation stops waiting and cancels work where possible; it does not undo a committed operation. Never blindly retry a mutation after a connection failure.
- The default API port is 47831. If another Pixel Forge preview has its connection running, stop that connection before starting one in a different app instance.
- The API does not run while the app is closed. It is off by default on each launch. Browser requests with `Origin` headers are rejected; the service provides no CORS access.
- The MCP adapter's tests cover protocol lifecycle, schemas, byte limits, cancellation, errors, image/file outputs, authentication, and a real stdio subprocess against a temporary HTTP server. Run `node --test scripts/pixel-forge-mcp.test.mjs`; it needs permission to bind a temporary loopback port.
- End-to-end local native verification also used the bundled adapter against the real app: inspection, authenticated read-only rejection, pixel/timing/tag/pivot edits, byte-exact project export and undo, converter video import/configuration/transfer, and GIF/game-pack exports.
- Real remote SSH connectivity and individual AI-client integration require the user's destination computer/account and were not exercised during this implementation.
