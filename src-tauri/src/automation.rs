//! Opt-in loopback bridge. The editor owns document operations; this module has no file or shell API.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

const DEFAULT_PORT: u16 = 47831;
const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = 96 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 4;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

type Reply = Result<Value, String>;
type Dispatcher = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;
type CancelDispatcher = Arc<dyn Fn(String) + Send + Sync>;
type Pending = Option<(String, mpsc::Sender<Reply>)>;

#[derive(Default)]
pub struct AutomationState(Mutex<Option<Arc<Server>>>);

struct Server {
    port: u16,
    token: String,
    allow_edits: bool,
    stopped: AtomicBool,
    connections: AtomicUsize,
    command: Mutex<()>,
    pending: Mutex<Pending>,
    listener: Mutex<Option<JoinHandle<()>>>,
    cancel: CancelDispatcher,
    timeout: Duration,
}

impl Server {
    fn start(port: u16, allow_edits: bool, dispatch: Dispatcher, cancel: CancelDispatcher, timeout: Duration) -> Result<Arc<Self>, String> {
        let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .map_err(|error| format!("Could not start local API on port {port}: {error}"))?;
        socket.set_nonblocking(true).map_err(|error| error.to_string())?;
        let server = Arc::new(Self {
            port: socket.local_addr().map_err(|error| error.to_string())?.port(),
            token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
            allow_edits,
            stopped: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            command: Mutex::new(()),
            pending: Mutex::new(None),
            listener: Mutex::new(None),
            cancel,
            timeout,
        });
        let active = server.clone();
        let listener = thread::Builder::new().name("pixel-forge-api".into()).spawn(move || {
            while !active.stopped.load(Ordering::Acquire) {
                match socket.accept() {
                    Ok((mut stream, address)) => {
                        if !address.ip().is_loopback() { continue; }
                        if active.connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                            active.connections.fetch_sub(1, Ordering::AcqRel);
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
                            respond(&mut stream, 503, json!({"error":"Too many local API connections."}));
                            continue;
                        }
                        let server = active.clone();
                        let dispatch = dispatch.clone();
                        thread::spawn(move || {
                            struct Connection(Arc<Server>);
                            impl Drop for Connection {
                                fn drop(&mut self) { self.0.connections.fetch_sub(1, Ordering::AcqRel); }
                            }
                            let _connection = Connection(server.clone());
                            handle(stream, &server, &dispatch);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        }).map_err(|error| error.to_string())?;
        *server.listener.lock().map_err(|error| error.to_string())? = Some(listener);
        Ok(server)
    }

    fn status(&self, include_token: bool) -> Value {
        let mut status = json!({
            "running": !self.stopped.load(Ordering::Acquire),
            "endpoint": format!("http://127.0.0.1:{}", self.port),
            "allowEdits": self.allow_edits,
        });
        if include_token { status["token"] = json!(self.token); }
        status
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            if let Some((id, sender)) = pending.take() {
                (self.cancel)(id);
                let _ = sender.send(Err("The local API was stopped.".into()));
            }
        }
        if let Ok(mut listener) = self.listener.lock() {
            if let Some(handle) = listener.take() { let _ = handle.join(); }
        }
    }

    fn complete(&self, id: &str, reply: Reply) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
        if pending.as_ref().is_none_or(|(expected, _)| expected != id) {
            return Err("This API request expired or was cancelled.".into());
        }
        let (_, sender) = pending.take().expect("pending response checked above");
        sender.send(reply).map_err(|_| "This API request expired or was cancelled.".into())
    }
}

impl Drop for AutomationState {
    fn drop(&mut self) {
        if let Ok(server) = self.0.get_mut() {
            if let Some(server) = server.take() { server.stop(); }
        }
    }
}

fn stopped_status() -> Value {
    json!({"running":false,"endpoint":null,"token":null,"allowEdits":false})
}

#[tauri::command]
pub fn automation_mcp_path(app: tauri::AppHandle) -> Result<String, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let path = resources.join("automation/pixel-forge-mcp.mjs");
        if path.is_file() { return Ok(path.to_string_lossy().into_owned()); }
    }
    #[cfg(debug_assertions)]
    {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/pixel-forge-mcp.mjs");
        if path.is_file() {
            return path.canonicalize().map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string());
        }
    }
    Err("The bundled MCP adapter could not be found. Reinstall Pixel Forge or run it from the development workspace.".into())
}

#[tauri::command]
pub fn automation_start(app: tauri::AppHandle, state: State<'_, AutomationState>, allow_edits: bool, port: Option<u16>) -> Result<Value, String> {
    let mut slot = state.0.lock().map_err(|error| error.to_string())?;
    if slot.is_some() { return Err("Stop the local API before changing its access settings.".into()); }
    let cancellation_app = app.clone();
    let cancel: CancelDispatcher = Arc::new(move |id| {
        let _ = cancellation_app.emit_to("main", "automation-cancel", json!({"id":id}));
    });
    let dispatch: Dispatcher = Arc::new(move |request| {
        app.emit_to("main", "automation-request", request).map_err(|error| error.to_string())
    });
    let server = Server::start(port.unwrap_or(DEFAULT_PORT), allow_edits, dispatch, cancel, COMMAND_TIMEOUT)?;
    let status = server.status(true);
    *slot = Some(server);
    Ok(status)
}

#[tauri::command]
pub fn automation_stop(state: State<'_, AutomationState>) -> Result<Value, String> {
    let mut slot = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(server) = slot.take() { server.stop(); }
    Ok(stopped_status())
}

#[tauri::command]
pub fn automation_status(state: State<'_, AutomationState>) -> Result<Value, String> {
    Ok(state.0.lock().map_err(|error| error.to_string())?.as_ref()
        .map(|server| server.status(true)).unwrap_or_else(stopped_status))
}

#[tauri::command]
pub fn automation_respond(state: State<'_, AutomationState>, id: String, result: Option<Value>, error: Option<String>) -> Result<(), String> {
    let server = state.0.lock().map_err(|error| error.to_string())?.clone()
        .ok_or("The local API is not running.")?;
    server.complete(&id, match error { Some(error) => Err(error), None => Ok(result.unwrap_or(Value::Null)) })
}

fn method_writes(method: &str) -> Option<bool> {
    match method {
        "app.get_state" | "converter.get_state" | "converter.preview" |
        "sprite.get_state" | "sprite.get_frame" | "sprite.export" => Some(false),
        "app.set_workspace" | "converter.configure" | "converter.import" | "converter.transfer" |
        "sprite.apply" | "sprite.import" | "sprite.undo" | "sprite.redo" => Some(true),
        _ => None,
    }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

type HttpError = (u16, &'static str);
fn read_request(stream: &mut TcpStream) -> Result<Request, HttpError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let end = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if index + 4 > MAX_HEADERS { return Err((431, "Request headers are too large.")); }
            break index + 4;
        }
        if bytes.len() >= MAX_HEADERS { return Err((431, "Request headers are too large.")); }
        if Instant::now() > deadline { return Err((408, "Request timed out.")); }
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).map_err(|_| (408, "Request timed out."))?;
        if count == 0 { return Err((400, "Incomplete HTTP request.")); }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let head = std::str::from_utf8(&bytes[..end]).map_err(|_| (400, "Invalid HTTP headers."))?;
    let mut lines = head.split("\r\n");
    let first: Vec<_> = lines.next().unwrap_or_default().split(' ').collect();
    if first.len() != 3 || !["HTTP/1.0", "HTTP/1.1"].contains(&first[2]) {
        return Err((400, "Invalid HTTP request line."));
    }
    let method = first[0].to_owned();
    let path = first[1].to_owned();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or((400, "Invalid HTTP header."))?;
        if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') || value.chars().any(|c| c.is_control() && c != '\t') {
            return Err((400, "Invalid HTTP header."));
        }
        if headers.insert(name.to_ascii_lowercase(), value.trim().to_owned()).is_some() {
            return Err((400, "Duplicate HTTP headers are not supported."));
        }
    }
    if headers.contains_key("transfer-encoding") { return Err((400, "Use Content-Length, not chunked encoding.")); }
    if headers.contains_key("origin") { return Err((403, "Browser-origin requests are not allowed.")); }
    let host = headers.get("host").ok_or((400, "A loopback Host header is required."))?;
    let hostname = host.rsplit_once(':').filter(|(_, port)| port.parse::<u16>().is_ok()).map(|(name, _)| name).unwrap_or(host);
    if !["127.0.0.1", "localhost", "[::1]"].contains(&hostname) {
        return Err((403, "Only loopback Host headers are allowed."));
    }
    let length = match headers.get("content-length") {
        Some(length) => length.parse::<usize>().map_err(|_| (400, "Invalid Content-Length."))?,
        None if method == "POST" => return Err((411, "Content-Length is required.")),
        None => 0,
    };
    if length > MAX_BODY { return Err((413, "Request exceeds the 16 MB limit.")); }
    let mut body = bytes[end..].to_vec();
    if body.len() > length { return Err((400, "Unexpected data after the request body.")); }
    while body.len() < length {
        if Instant::now() > deadline { return Err((408, "Request timed out.")); }
        let mut chunk = [0u8; 16384];
        let remaining = (length - body.len()).min(chunk.len());
        let count = stream.read(&mut chunk[..remaining]).map_err(|_| (408, "Request timed out."))?;
        if count == 0 { return Err((400, "Incomplete request body.")); }
        body.extend_from_slice(&chunk[..count]);
    }
    Ok(Request { method, path, headers, body })
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() { return false; }
    left.iter().zip(right).fold(0, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn handle(mut stream: TcpStream, server: &Arc<Server>, dispatch: &Dispatcher) {
    // macOS may inherit O_NONBLOCK from the listener. Reads below rely on socket timeouts,
    // so an accepted connection must be blocking even when headers arrive after accept().
    if stream.set_nonblocking(false).is_err() { return; }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let (code, result) = match read_request(&mut stream) {
        Ok(request) => execute(request, server, dispatch),
        Err((code, error)) => (code, json!({"error":error})),
    };
    respond(&mut stream, code, result);
}

fn execute(request: Request, server: &Arc<Server>, dispatch: &Dispatcher) -> (u16, Value) {
    let expected = format!("Bearer {}", server.token);
    if !constant_time_equal(request.headers.get("authorization").map(String::as_bytes).unwrap_or_default(), expected.as_bytes()) {
        return (401, json!({"error":"A valid local API bearer token is required."}));
    }
    if server.stopped.load(Ordering::Acquire) { return (503, json!({"error":"The local API was stopped."})); }
    if request.method == "GET" && request.path == "/v1/status" { return (200, json!({"result":server.status(false)})); }
    if request.path != "/v1/commands" { return (404, json!({"error":"Unknown API route."})); }
    if request.method != "POST" { return (405, json!({"error":"Use POST for commands."})); }
    if request.headers.get("content-type").is_none_or(|value| !value.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case("application/json")) {
        return (415, json!({"error":"Use Content-Type: application/json."}));
    }
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(body) => body,
        Err(_) => return (400, json!({"error":"Invalid JSON request."})),
    };
    let Some(method) = body.get("method").and_then(Value::as_str) else { return (400, json!({"error":"A method name is required."})); };
    let Some(writes) = method_writes(method) else { return (400, json!({"error":"Unknown automation method."})); };
    if writes && !server.allow_edits { return (403, json!({"error":"Editing is disabled. Enable Allow edits in the app's AI connection settings."})); }
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() { return (400, json!({"error":"Command params must be an object."})); }
    let Ok(_command) = server.command.try_lock() else { return (409, json!({"error":"Another API command is active. Wait for it to finish."})); };
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() + server.timeout.as_millis();
    let dispatched = {
        let Ok(mut pending) = server.pending.lock() else { return (503, json!({"error":"The local API is unavailable."})); };
        if server.stopped.load(Ordering::Acquire) { return (503, json!({"error":"The local API was stopped."})); }
        *pending = Some((id.clone(), sender));
        // Queue the request before stop can queue its cancellation. Otherwise a stop between
        // registration and emit could cancel an unknown id, then allow a late edit to begin.
        dispatch(json!({"id":id,"method":method,"params":params,"deadline":deadline as u64}))
    };
    let result = match dispatched {
        Ok(()) => match receiver.recv_timeout(server.timeout) {
            Ok(Ok(result)) => (200, json!({"result":result})),
            Ok(Err(error)) => (422, json!({"error":error})),
            Err(_) => (504, json!({"error":"The editor request timed out. Inspect its state before retrying an edit."})),
        },
        Err(_) => (503, json!({"error":"Could not reach the editor window."})),
    };
    if let Ok(mut pending) = server.pending.lock() {
        if pending.as_ref().is_some_and(|(pending_id, _)| pending_id == &id) {
            pending.take();
            (server.cancel)(id);
        }
    }
    result
}

fn respond(stream: &mut TcpStream, mut code: u16, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"Could not encode response.\"}".to_vec());
    if bytes.len() > MAX_RESPONSE {
        code = 413;
        bytes = b"{\"error\":\"Response exceeds the 96 MB limit. Export a smaller document.\"}".to_vec();
    }
    let reason = match code { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 408 => "Request Timeout", 409 => "Conflict", 411 => "Length Required", 413 => "Content Too Large", 415 => "Unsupported Media Type", 422 => "Unprocessable Content", 431 => "Request Header Fields Too Large", 503 => "Service Unavailable", 504 => "Gateway Timeout", _ => "Error" };
    let header = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n", bytes.len());
    let mut response = header.into_bytes();
    response.extend_from_slice(&bytes);
    let _ = stream.write_all(&response);
    let _ = stream.shutdown(Shutdown::Write);
    // Drain a bounded amount after rejecting a partial request so closing an unread socket
    // does not discard the HTTP error in a TCP reset. This never waits beyond 50 ms per read.
    if code >= 400 {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
        let mut remainder = [0u8; 4096];
        for _ in 0..16 {
            match stream.read(&mut remainder) { Ok(0) | Err(_) => break, Ok(_) => {} }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(edits: bool, timeout: Duration) -> (Arc<Server>, mpsc::Receiver<Value>, mpsc::Receiver<String>) {
        let (requests, received) = mpsc::channel();
        let (cancelled, cancellations) = mpsc::channel();
        let server = Server::start(0, edits, Arc::new(move |value| requests.send(value).map_err(|error| error.to_string())), Arc::new(move |id| { let _ = cancelled.send(id); }), timeout).unwrap();
        (server, received, cancellations)
    }

    fn send(port: u16, request: String) -> (u16, Value) {
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        read_response(stream)
    }

    fn read_response(mut stream: TcpStream) -> (u16, Value) {
        let mut response = Vec::new();
        if let Err(error) = stream.read_to_end(&mut response) {
            // Rejecting an oversized header can close with unread request bytes, causing TCP RST.
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        }
        let split = response.windows(4).position(|part| part == b"\r\n\r\n").unwrap();
        let headers = std::str::from_utf8(&response[..split]).unwrap();
        assert!(headers.contains("Cache-Control: no-store"));
        assert!(!headers.contains("Access-Control-Allow-Origin"));
        (headers.split(' ').nth(1).unwrap().parse().unwrap(), serde_json::from_slice(&response[split + 4..]).unwrap())
    }

    fn request(server: &Server, method: &str, path: &str, body: &str, extras: &str) -> String {
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extras}\r\n{body}", server.port, server.token, body.len())
    }

    fn command(server: &Server, method: &str) -> String {
        request(server, "POST", "/v1/commands", &json!({"method":method,"params":{}}).to_string(), "")
    }

    #[test]
    fn authenticates_and_rejects_browser_origins_and_nonlocal_hosts() {
        let (server, received, _) = start(false, Duration::from_secs(2));
        let req = request(&server, "GET", "/v1/status", "", "");
        assert_eq!(send(server.port, req.replace(&server.token, "incorrect")).0, 401);
        assert_eq!(send(server.port, request(&server, "GET", "/v1/status", "", "Origin: https://example.com\r\n")).0, 403);
        assert_eq!(send(server.port, req.replace("Host: 127.0.0.1", "Host: example.com")).0, 403);
        let (status, body) = send(server.port, req);
        assert_eq!(status, 200);
        assert_eq!(body["result"]["running"], true);
        assert!(body["result"].get("token").is_none(), "HTTP status must not expose credentials");
        assert!(received.try_recv().is_err());
        server.stop();
    }

    #[test]
    fn readonly_denies_mutations_and_forwards_valid_reads_with_deadlines() {
        let (server, received, _) = start(false, COMMAND_TIMEOUT);
        assert_eq!(send(server.port, command(&server, "sprite.apply")).0, 403);
        assert_eq!(send(server.port, command(&server, "shell.exec")).0, 400);
        assert!(received.try_recv().is_err());
        let req = command(&server, "sprite.get_frame");
        let port = server.port;
        let client = thread::spawn(move || send(port, req));
        let payload = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(payload["method"], "sprite.get_frame");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        assert!(payload["deadline"].as_u64().unwrap() >= now + 59_000);
        server.complete(payload["id"].as_str().unwrap(), Ok(json!({"width":32,"pixels":[1,2,3,4]}))).unwrap();
        assert_eq!(client.join().unwrap(), (200, json!({"result":{"width":32,"pixels":[1,2,3,4]}})));
        server.stop();
    }

    #[test]
    fn edits_are_opt_in_and_commands_are_serialized() {
        let (server, received, _) = start(true, Duration::from_secs(2));
        let req = command(&server, "sprite.apply");
        let port = server.port;
        let client = thread::spawn(move || send(port, req));
        let payload = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(send(server.port, command(&server, "app.get_state")).0, 409);
        assert!(server.complete("wrong-id", Ok(Value::Null)).is_err());
        server.complete(payload["id"].as_str().unwrap(), Err("Revision changed; inspect the document again.".into())).unwrap();
        assert_eq!(client.join().unwrap().0, 422);
        assert!(server.complete(payload["id"].as_str().unwrap(), Ok(Value::Null)).is_err());
        server.stop();
    }

    #[test]
    fn limits_headers_bodies_and_ambiguous_http_framing() {
        let (server, _, _) = start(false, Duration::from_secs(2));
        let oversize = format!("POST /v1/commands HTTP/1.1\r\nHost: localhost:{}\r\nContent-Length: {}\r\n\r\n", server.port, MAX_BODY + 1);
        assert_eq!(send(server.port, oversize).0, 413);
        assert_eq!(send(server.port, request(&server, "POST", "/v1/commands", "{}", "Content-Length: 2\r\n")).0, 400);
        assert_eq!(send(server.port, request(&server, "POST", "/v1/commands", "{}", "Transfer-Encoding: chunked\r\n")).0, 400);
        assert_eq!(send(server.port, request(&server, "POST", "/v1/commands", "not JSON", "")).0, 400);
        assert_eq!(send(server.port, request(&server, "POST", "/v1/commands", "{\"method\":\"app.get_state\",\"params\":[]}", "")).0, 400);
        let too_long = request(&server, "GET", "/v1/status", "", &format!("X-Long: {}\r\n", "a".repeat(MAX_HEADERS)));
        assert_eq!(send(server.port, too_long).0, 431);
        server.stop();
    }

    #[test]
    fn timeout_cancels_frontend_request_and_rejects_late_completion() {
        let (server, received, cancellations) = start(false, Duration::from_millis(50));
        let req = command(&server, "app.get_state");
        let port = server.port;
        let client = thread::spawn(move || send(port, req));
        let payload = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(client.join().unwrap().0, 504);
        let id = payload["id"].as_str().unwrap();
        assert_eq!(cancellations.recv_timeout(Duration::from_secs(1)).unwrap(), id);
        assert!(server.complete(id, Ok(Value::Null)).is_err());
        server.stop();
    }

    #[test]
    fn stopping_cancels_active_request_releases_listener_and_rotates_token() {
        let (server, received, cancellations) = start(true, Duration::from_secs(2));
        let req = command(&server, "sprite.import");
        let port = server.port;
        let client = thread::spawn(move || send(port, req));
        let payload = received.recv_timeout(Duration::from_secs(2)).unwrap();
        server.stop();
        assert_eq!(cancellations.recv_timeout(Duration::from_secs(1)).unwrap(), payload["id"].as_str().unwrap());
        assert_eq!(client.join().unwrap().0, 422);
        assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
        let replacement = Server::start(port, false, Arc::new(|_| Ok(())), Arc::new(|_| {}), COMMAND_TIMEOUT).unwrap();
        assert_ne!(replacement.token, server.token);
        let req = request(&replacement, "GET", "/v1/status", "", "").replace(&replacement.token, &server.token);
        assert_eq!(send(port, req).0, 401);
        replacement.stop();
    }
    #[test]
    fn stop_cannot_emit_cancellation_before_the_request_is_queued() {
        let (requests, received) = mpsc::channel();
        let (cancelled, cancellations) = mpsc::channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let blocked = barrier.clone();
        let server = Server::start(0, true, Arc::new(move |value| {
            requests.send(value).unwrap();
            blocked.wait();
            Ok(())
        }), Arc::new(move |id| { let _ = cancelled.send(id); }), Duration::from_secs(2)).unwrap();
        let req = command(&server, "sprite.apply");
        let port = server.port;
        let client = thread::spawn(move || send(port, req));
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        let stopping = server.clone();
        let stop = thread::spawn(move || stopping.stop());
        while !server.stopped.load(Ordering::Acquire) { thread::yield_now(); }
        assert!(cancellations.try_recv().is_err());
        barrier.wait();
        stop.join().unwrap();
        cancellations.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(client.join().unwrap().0, 422);
    }

    #[test]
    fn accepts_headers_and_body_arriving_in_delayed_chunks() {
        let (server, received, _) = start(false, Duration::from_secs(2));
        let req = command(&server, "app.get_state");
        let port = server.port;
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let body_start = req.find("\r\n\r\n").unwrap() + 4;
            let chunks = [&req[..20], &req[20..body_start], &req[body_start..body_start + 5], &req[body_start + 5..]];
            for chunk in chunks {
                // Accepted sockets can inherit O_NONBLOCK on macOS. Delayed/chunked arrival
                // reproduces fetch's separate connect/header/body writes rather than one write.
                thread::sleep(Duration::from_millis(50));
                stream.write_all(chunk.as_bytes()).unwrap();
            }
            read_response(stream)
        });
        let payload = received.recv_timeout(Duration::from_secs(2)).unwrap();
        server.complete(payload["id"].as_str().unwrap(), Ok(json!({"ok":true}))).unwrap();
        assert_eq!(client.join().unwrap(), (200, json!({"result":{"ok":true}})));
        server.stop();
    }

}
