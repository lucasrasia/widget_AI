use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, Position, WebviewWindow};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct CachedUsage {
    snapshot: Value,
    read_at: Instant,
}

static USAGE_CACHE: OnceLock<Mutex<Option<CachedUsage>>> = OnceLock::new();
static USAGE_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TOOLTIP_PAYLOAD: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
const USAGE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const APP_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

fn usage_cache() -> &'static Mutex<Option<CachedUsage>> {
    USAGE_CACHE.get_or_init(|| Mutex::new(None))
}

fn usage_refresh_lock() -> &'static Mutex<()> {
    USAGE_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

fn tooltip_payload() -> &'static Mutex<Option<Value>> {
    TOOLTIP_PAYLOAD.get_or_init(|| Mutex::new(None))
}

struct CodexProcess {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Result<Value, String>>,
}

impl CodexProcess {
    fn start() -> Result<Self, String> {
        let mut command = Command::new("cmd");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .args(["/D", "/S", "/C", "codex app-server --stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                "Codex CLI was not found. Open Codex Desktop or install the Codex CLI and sign in."
                    .to_string()
            })?;

        let Some(input) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not open the Codex App Server input.".into());
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not read the Codex App Server output.".into());
        };
        let (sender, responses) = mpsc::channel();

        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ =
                            sender.send(Err("Codex App Server exited without responding.".into()));
                        break;
                    }
                    Ok(_) => {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let parsed = serde_json::from_str(line)
                            .map_err(|error| format!("Invalid Codex App Server response: {error}"));
                        if sender.send(parsed).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });

        Ok(Self {
            child,
            input,
            responses,
        })
    }

    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({ "method": method, "params": params }))
    }

    fn request(&mut self, id: i64, method: &str, params: Option<Value>) -> Result<Value, String> {
        let mut message = json!({ "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(message)?;

        let deadline = Instant::now() + APP_SERVER_REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("{method} timed out."));
            }
            let message =
                self.responses
                    .recv_timeout(remaining)
                    .map_err(|error| match error {
                        mpsc::RecvTimeoutError::Timeout => format!("{method} timed out."),
                        mpsc::RecvTimeoutError::Disconnected => {
                            "Codex App Server response channel closed.".into()
                        }
                    })??;
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = message
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
            {
                return Err(error.to_string());
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex App Server response had no result.".into());
        }
    }

    fn write(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.input, "{message}").map_err(|error| error.to_string())?;
        self.input.flush().map_err(|error| error.to_string())
    }
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let mut command = Command::new("taskkill");
            command.creation_flags(CREATE_NO_WINDOW);
            let _ = command.args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn normalize_window(window: &Value) -> Option<Value> {
    let duration = window.get("windowDurationMins")?.as_i64()?;
    let percent = window.get("usedPercent")?.as_f64()?.clamp(0.0, 100.0);
    Some(json!({
      "usedPercent": percent,
      "windowDurationMins": duration,
      "resetsAt": window.get("resetsAt").and_then(Value::as_i64),
    }))
}

fn windows_for_bucket(bucket: &Value) -> Vec<Value> {
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| bucket.get(key).and_then(normalize_window))
        .collect()
}

fn normalize_rate_limits(snapshot: &Value) -> (Vec<Value>, Vec<Value>) {
    let legacy = snapshot.get("rateLimits");
    let by_id = snapshot
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object);
    let mut windows = legacy.map(windows_for_bucket).unwrap_or_default();

    if let Some(buckets) = by_id {
        for bucket in buckets.values() {
            for window in windows_for_bucket(bucket) {
                let duration = window.get("windowDurationMins").and_then(Value::as_i64);
                if !windows.iter().any(|candidate| {
                    candidate.get("windowDurationMins").and_then(Value::as_i64) == duration
                }) {
                    windows.push(window);
                }
            }
        }
    }
    windows.sort_by_key(|window| {
        window
            .get("windowDurationMins")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });

    let models = by_id.into_iter().flat_map(|buckets| buckets.iter()).map(|(key, bucket)| {
    let bucket_windows = windows_for_bucket(bucket);
    let five_hour = bucket_windows.iter().find(|window| window.get("windowDurationMins").and_then(Value::as_i64) == Some(300)).cloned();
    let weekly = bucket_windows.iter().find(|window| window.get("windowDurationMins").and_then(Value::as_i64) == Some(10_080)).cloned();
    let model = bucket.get("limitName").and_then(Value::as_str)
      .or_else(|| bucket.get("normalModelSlug").and_then(Value::as_str))
      .or_else(|| bucket.get("limitId").and_then(Value::as_str))
      .unwrap_or(key);
    json!({
      "id": bucket.get("limitId").and_then(Value::as_str).unwrap_or(key),
      "provider": "OpenAI",
      "model": model,
      "tokens": Value::Null,
      "cost": Value::Null,
      "usedPercent": five_hour.as_ref().and_then(|window| window.get("usedPercent")).cloned().unwrap_or(Value::Null),
      "fiveHour": five_hour,
      "weekly": weekly,
      "fidelity": "official",
      "updatedAt": Value::Null,
      "aggregate": true,
    })
  }).collect();

    (windows, models)
}

fn read_codex_usage_blocking() -> Result<Value, String> {
    let mut server = CodexProcess::start()?;
    server.request(1, "initialize", Some(json!({ "clientInfo": { "name": "widgetaai", "title": "WidgetaAI", "version": env!("CARGO_PKG_VERSION") } })))?;
    server.send_notification("initialized", json!({}))?;
    let account = server
        .request(2, "account/read", Some(json!({ "refreshToken": false })))
        .ok();
    let limits = server.request(3, "account/rateLimits/read", None)?;
    let usage = server
        .request(4, "account/usage/read", Some(json!({})))
        .ok();
    let (windows, models) = normalize_rate_limits(&limits);
    let plan = account
        .as_ref()
        .and_then(|value| value.get("account"))
        .and_then(|value| value.get("planType"))
        .and_then(Value::as_str)
        .or_else(|| {
            limits
                .get("rateLimits")
                .and_then(|value| value.get("planType"))
                .and_then(Value::as_str)
        });

    Ok(json!({
      "status": "ready",
      "source": "tauri-codex-app-server",
      "fidelity": "official",
      "updatedAt": Value::Null,
      "plan": plan,
      "windows": windows,
      "models": models,
      "lifetimeTokens": usage.as_ref().and_then(|value| value.get("summary")).and_then(|value| value.get("lifetimeTokens")).and_then(Value::as_i64),
      "error": Value::Null,
    }))
}

fn fresh_cached_usage() -> Option<Value> {
    if let Ok(cache) = usage_cache().lock() {
        if let Some(cached) = cache.as_ref() {
            if cached.read_at.elapsed() < USAGE_REFRESH_INTERVAL {
                return Some(cached.snapshot.clone());
            }
        }
    }
    None
}

fn read_codex_usage_single_flight() -> Result<Value, String> {
    if let Some(cached) = fresh_cached_usage() {
        return Ok(cached);
    }
    let _refresh = usage_refresh_lock()
        .lock()
        .map_err(|_| "Usage refresh lock was poisoned.".to_string())?;
    if let Some(cached) = fresh_cached_usage() {
        return Ok(cached);
    }

    match read_codex_usage_blocking() {
        Ok(snapshot) => {
            if let Ok(mut cache) = usage_cache().lock() {
                *cache = Some(CachedUsage {
                    snapshot: snapshot.clone(),
                    read_at: Instant::now(),
                });
            }
            Ok(snapshot)
        }
        Err(error) => {
            if let Ok(cache) = usage_cache().lock() {
                if let Some(cached) = cache.as_ref() {
                    let mut stale = cached.snapshot.clone();
                    stale["status"] = Value::String("stale".into());
                    stale["error"] = Value::String(error);
                    return Ok(stale);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
async fn read_codex_usage() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(read_codex_usage_single_flight)
        .await
        .map_err(|error| error.to_string())?
}

fn resize_and_anchor_window(
    window: &WebviewWindow,
    expanded: bool,
) -> Result<(), String> {
    let logical_width = if expanded { 640.0 } else { 400.0 };
    let logical_height = if expanded { 500.0 } else { 148.0 };
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let physical_width = (logical_width * scale).round() as u32;
    let physical_height = (logical_height * scale).round() as u32;

    window
        .set_size(LogicalSize::new(logical_width, logical_height))
        .map_err(|error| error.to_string())?;

    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
    {
        let work_area = monitor.work_area();
        let x = work_area.position.x + work_area.size.width.saturating_sub(physical_width) as i32;
        let y = work_area.position.y + work_area.size.height.saturating_sub(physical_height) as i32;
        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn set_widget_window_state(
    window: WebviewWindow,
    expanded: bool,
) -> Result<(), String> {
    resize_and_anchor_window(&window, expanded)?;
    if expanded {
        if let Some(tooltip) = window.app_handle().get_webview_window("tooltip") {
            tooltip.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_widget_tooltip(window: WebviewWindow, model: Value, left: f64, arrow: f64) -> Result<(), String> {
    let app = window.app_handle();
    let main = app.get_webview_window("main").ok_or("Main window unavailable")?;
    let tooltip = app.get_webview_window("tooltip").ok_or("Tooltip window unavailable")?;
    let main_position = main.outer_position().map_err(|error| error.to_string())?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let tooltip_height = (132.0 * scale).round() as i32;
    tooltip.set_position(Position::Physical(PhysicalPosition::new(
        main_position.x,
        main_position.y - tooltip_height,
    ))).map_err(|error| error.to_string())?;
    let payload = json!({ "model": model, "left": left, "arrow": arrow });
    *tooltip_payload().lock().map_err(|error| error.to_string())? = Some(payload.clone());
    app.emit_to("tooltip", "widget-tooltip-model", payload)
        .map_err(|error| error.to_string())?;
    tooltip.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_widget_tooltip() -> Result<Option<Value>, String> {
    tooltip_payload().lock().map(|payload| payload.clone()).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_widget_tooltip(window: WebviewWindow) -> Result<(), String> {
    if let Some(tooltip) = window.app_handle().get_webview_window("tooltip") {
        tooltip.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_codex_usage,
            set_widget_window_state,
            set_widget_tooltip,
            get_widget_tooltip,
            hide_widget_tooltip
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(tooltip) = window.app_handle().get_webview_window("tooltip") {
                    let _ = tooltip.close();
                }
                window.app_handle().exit(0);
            } else if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                resize_and_anchor_window(&window, false).map_err(std::io::Error::other)?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_legacy_rate_limits() {
        let snapshot = json!({
          "rateLimits": {
            "primary": { "usedPercent": 125, "windowDurationMins": 300, "resetsAt": 123 },
            "secondary": { "usedPercent": -5, "windowDurationMins": 10080, "resetsAt": null }
          }
        });
        let (windows, models) = normalize_rate_limits(&snapshot);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["usedPercent"], 100.0);
        assert_eq!(windows[1]["usedPercent"], 0.0);
        assert!(models.is_empty());
    }

    #[test]
    fn normalizes_multi_bucket_rate_limits_without_inventing_usage() {
        let snapshot = json!({
          "rateLimits": { "primary": null, "secondary": null },
          "rateLimitsByLimitId": {
            "codex": {
              "limitId": "codex",
              "normalModelSlug": "gpt-5-codex",
              "primary": { "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 456 },
              "secondary": { "usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 789 }
            }
          }
        });
        let (windows, models) = normalize_rate_limits(&snapshot);
        assert_eq!(windows.len(), 2);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["model"], "gpt-5-codex");
        assert!(models[0]["tokens"].is_null());
        assert!(models[0]["cost"].is_null());
    }
}
