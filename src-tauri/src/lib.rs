use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, process::{Command, Stdio}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::{LogicalSize, Manager, PhysicalPosition, Position, WebviewWindow};

/// The Codex App Server is expensive to start. Keep a short-lived reading in
/// memory and degrade to it as stale if the next refresh fails.
struct CachedUsage {
  snapshot: Value,
  read_at: Instant,
}

static USAGE_CACHE: OnceLock<Mutex<Option<CachedUsage>>> = OnceLock::new();
const USAGE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

fn usage_cache() -> &'static Mutex<Option<CachedUsage>> {
  USAGE_CACHE.get_or_init(|| Mutex::new(None))
}

fn read_response(reader: &mut BufReader<std::process::ChildStdout>, id: i64) -> Result<Value, String> {
  loop {
    let mut line = String::new();
    if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
      return Err("O App Server do Codex encerrou sem responder.".into());
    }
    let message: Value = serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
    if message.get("id").and_then(Value::as_i64) != Some(id) { continue; }
    if let Some(error) = message.get("error").and_then(|value| value.get("message")).and_then(Value::as_str) {
      return Err(error.to_string());
    }
    return message.get("result").cloned().ok_or_else(|| "Resposta sem resultado.".into());
  }
}

fn send_request(input: &mut std::process::ChildStdin, message: Value) -> Result<(), String> {
  writeln!(input, "{}", message).map_err(|error| error.to_string())?;
  input.flush().map_err(|error| error.to_string())
}

fn read_codex_usage_blocking() -> Result<Value, String> {
  let mut child = Command::new("cmd")
    .args(["/D", "/S", "/C", "codex app-server --stdio"])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|_| "Codex CLI não foi encontrado. Abra o Codex Desktop ou instale o Codex CLI e entre com sua conta Plus.".to_string())?;

  let mut input = child.stdin.take().ok_or_else(|| "Não foi possível abrir o App Server.".to_string())?;
  let stdout = child.stdout.take().ok_or_else(|| "Não foi possível ler o App Server.".to_string())?;
  let mut output = BufReader::new(stdout);

  let result = (|| -> Result<Value, String> {
    send_request(&mut input, json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "widgetaai", "title": "WidgetaAI", "version": env!("CARGO_PKG_VERSION") } } }))?;
    read_response(&mut output, 1)?;
    send_request(&mut input, json!({ "method": "initialized", "params": {} }))?;
    send_request(&mut input, json!({ "id": 2, "method": "account/read", "params": { "refreshToken": false } }))?;
    let account = read_response(&mut output, 2)?;
    send_request(&mut input, json!({ "id": 3, "method": "account/rateLimits/read" }))?;
    let limits = read_response(&mut output, 3)?;

    let windows = ["primary", "secondary"].into_iter().filter_map(|key| {
      let window = limits.get("rateLimits")?.get(key)?;
      Some(json!({
        "usedPercent": window.get("usedPercent")?.as_f64()?,
        "windowDurationMins": window.get("windowDurationMins")?.as_i64()?,
        "resetsAt": window.get("resetsAt").and_then(Value::as_i64),
      }))
    }).collect::<Vec<_>>();

    Ok(json!({
      "status": "ready",
      "source": "tauri-codex-app-server",
      "fidelity": "official",
      "updatedAt": Value::Null,
      "plan": account.get("account").and_then(|value| value.get("planType")).and_then(Value::as_str),
      "windows": windows,
      "error": Value::Null,
    }))
  })();

  let _ = child.kill();
  result
}

#[tauri::command]
async fn read_codex_usage() -> Result<Value, String> {
  if let Ok(cache) = usage_cache().lock() {
    if let Some(cached) = cache.as_ref() {
      if cached.read_at.elapsed() < USAGE_REFRESH_INTERVAL {
        return Ok(cached.snapshot.clone());
      }
    }
  }

  match tauri::async_runtime::spawn_blocking(read_codex_usage_blocking)
    .await
    .map_err(|error| error.to_string())?
  {
    Ok(snapshot) => {
      if let Ok(mut cache) = usage_cache().lock() {
        *cache = Some(CachedUsage { snapshot: snapshot.clone(), read_at: Instant::now() });
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

fn resize_and_anchor_window(window: &WebviewWindow, tooltip_open: bool) -> Result<(), String> {
  let logical_width = 400.0;
  let logical_height = if tooltip_open { 320.0 } else { 148.0 };
  let scale = window.scale_factor().map_err(|error| error.to_string())?;
  let physical_width = (logical_width * scale).round() as u32;
  let physical_height = (logical_height * scale).round() as u32;

  window
    .set_size(LogicalSize::new(logical_width, logical_height))
    .map_err(|error| error.to_string())?;

  if let Some(monitor) = window
    .current_monitor()
    .map_err(|error| error.to_string())?
    .or(window.primary_monitor().map_err(|error| error.to_string())?)
  {
    let work_area = monitor.work_area();
    let x = work_area.position.x
      + work_area.size.width.saturating_sub(physical_width) as i32;
    let y = work_area.position.y
      + work_area.size.height.saturating_sub(physical_height) as i32;
    window
      .set_position(Position::Physical(PhysicalPosition::new(x, y)))
      .map_err(|error| error.to_string())?;
  }

  Ok(())
}

#[tauri::command]
fn set_widget_window_state(window: WebviewWindow, tooltip_open: bool) -> Result<(), String> {
  resize_and_anchor_window(&window, tooltip_open)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![read_codex_usage, set_widget_window_state])
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
