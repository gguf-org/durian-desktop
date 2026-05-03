use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console_window(_: &mut Command) {}

#[derive(Clone, serde::Serialize)]
struct OutputChunk {
    id: String,
    text: String,
    done: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
struct Workspace {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    added_at: u64,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
struct Settings {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    toolsets: String,
    #[serde(default)]
    project_path: String,
    #[serde(default)]
    workspaces: Vec<Workspace>,
    #[serde(default)]
    current_workspace_id: String,
}

struct AppState {
    running: Mutex<HashMap<String, Child>>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
}

struct WorkspaceWatcher {
    stop: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<()>,
}

fn strip_ansi(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some(&'[') => {
                    chars.next();
                    for c2 in chars.by_ref() {
                        if c2.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        } else if c != '\r' {
            result.push(c);
        }
    }
    result
}

fn executable_path_from_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn append_unique_path_dir(dirs: &mut Vec<PathBuf>, dir: impl Into<PathBuf>) {
    let dir = dir.into();
    if !dir.as_os_str().is_empty() && !dirs.iter().any(|existing| existing == &dir) {
        dirs.push(dir);
    }
}

fn durian_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            append_unique_path_dir(&mut dirs, dir);
        }
    }

    if cfg!(target_os = "macos") {
        append_unique_path_dir(&mut dirs, "/opt/homebrew/bin");
        append_unique_path_dir(&mut dirs, "/usr/local/bin");
        append_unique_path_dir(&mut dirs, "/usr/bin");
        append_unique_path_dir(&mut dirs, "/bin");
        append_unique_path_dir(&mut dirs, "/usr/sbin");
        append_unique_path_dir(&mut dirs, "/sbin");

        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            append_unique_path_dir(&mut dirs, home.join(".durian/bin"));
            append_unique_path_dir(&mut dirs, home.join(".local/bin"));
            append_unique_path_dir(&mut dirs, home.join("bin"));
            append_unique_path_dir(&mut dirs, home.join(".npm-global/bin"));
            append_unique_path_dir(&mut dirs, home.join(".cargo/bin"));
            append_unique_path_dir(&mut dirs, home.join(".bun/bin"));
        }
    }

    dirs
}

fn path_env_with_search_dirs(extra_dir: Option<&Path>) -> Option<std::ffi::OsString> {
    let mut dirs = durian_search_dirs();
    if let Some(dir) = extra_dir {
        append_unique_path_dir(&mut dirs, dir);
    }

    std::env::join_paths(dirs).ok()
}

fn find_durian_in_login_shell() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    let output = Command::new("/bin/zsh")
        .arg("-lc")
        .arg("command -v durian")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }

    let candidate = PathBuf::from(path);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn find_durian_executable() -> Option<PathBuf> {
    for dir in durian_search_dirs() {
        if let Some(path) = executable_path_from_dir(&dir, "durian") {
            return Some(path);
        }
    }

    find_durian_in_login_shell()
}

fn durian_command() -> Command {
    let resolved_path = find_durian_executable();
    let resolved_dir = resolved_path
        .as_ref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf);

    let mut cmd = if let Some(path) = resolved_path {
        Command::new(path)
    } else {
        Command::new("durian")
    };

    if let Some(path) = path_env_with_search_dirs(resolved_dir.as_deref()) {
        cmd.env("PATH", path);
    }

    cmd
}

/// Get the durian config.yaml path
fn durian_config_path() -> Option<std::path::PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA").ok().map(|base| {
            std::path::PathBuf::from(base)
                .join("durian")
                .join("config.yaml")
        })
    } else {
        std::env::var("HOME").ok().map(|home| {
            std::path::PathBuf::from(home)
                .join(".durian")
                .join("config.yaml")
        })
    }
}

/// Apply settings to durian's config.yaml by editing key values directly.
fn apply_settings_to_config(settings: &Settings) -> Result<(), String> {
    let config_path = durian_config_path().ok_or("Could not find durian config path")?;
    if !config_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut modified = false;

    let mut in_model_section = false;
    let mut replacements: Vec<(usize, String)> = vec![];

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();

        if trimmed.starts_with("model:") && line.len() - trimmed.len() == 0 {
            in_model_section = true;
            continue;
        }

        if in_model_section {
            let current_indent = line.len() - trimmed.len();
            if !trimmed.is_empty() && current_indent == 0 && !trimmed.starts_with('#') {
                in_model_section = false;
                continue;
            }

            let prefix = "  ";

            if !settings.model.is_empty() && trimmed.starts_with("default:") {
                replacements.push((idx, format!("{}default: {}", prefix, settings.model)));
            }
            if !settings.provider.is_empty()
                && trimmed.starts_with("provider:")
                && !trimmed.starts_with("provider_s")
            {
                replacements.push((idx, format!("{}provider: {}", prefix, settings.provider)));
            }
            if !settings.endpoint.is_empty() && trimmed.starts_with("base_url:") {
                replacements.push((idx, format!("{}base_url: {}", prefix, settings.endpoint)));
            }
            if !settings.api_key.is_empty() && trimmed.starts_with("api_key:") {
                replacements.push((idx, format!("{}api_key: {}", prefix, settings.api_key)));
            }
        }
    }

    // Also update terminal.cwd to the project path
    let mut in_terminal_section = false;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();

        if trimmed.starts_with("terminal:") && line.len() - trimmed.len() == 0 {
            in_terminal_section = true;
            continue;
        }

        if in_terminal_section {
            let current_indent = line.len() - trimmed.len();
            if !trimmed.is_empty() && current_indent == 0 && !trimmed.starts_with('#') {
                in_terminal_section = false;
                continue;
            }

            if !settings.project_path.is_empty() && trimmed.starts_with("cwd:") {
                let prefix = "  ";
                replacements.push((idx, format!("{}cwd: {}", prefix, settings.project_path)));
            }
        }
    }

    for (idx, new_line) in replacements {
        lines[idx] = new_line;
        modified = true;
    }

    if modified {
        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        let mut f = fs::File::create(&config_path).map_err(|e| e.to_string())?;
        f.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── File system commands for the explorer ──────────────────────────────

#[derive(Clone, serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

/// List directory contents for the file tree explorer
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs (starting with .) and node_modules
        if name.starts_with('.')
            || name == "node_modules"
            || name == "__pycache__"
            || name == ".git"
        {
            continue;
        }

        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified: metadata
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                })
                .unwrap_or(0),
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Read a text file's content (for viewing)
#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    let max_size = 500_000; // 500KB limit
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > max_size {
        return Err("File too large to preview".into());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── Helper functions for session file watcher ─────────────────────────

/// Get the modification time of the newest session file (or 0 if none).
fn newest_session_mtime(dir: &std::path::Path) -> u128 {
    std::fs::read_dir(dir)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|e| e.to_str()) == Some("json"))
                .filter_map(|e| {
                    let meta = e.metadata().ok()?;
                    let modified = meta.modified().ok()?;
                    Some(
                        modified
                            .duration_since(std::time::UNIX_EPOCH)
                            .ok()?
                            .as_millis(),
                    )
                })
                .max()
        })
        .unwrap_or(0)
}

/// Find a session file newer than `pre_mtime`. Returns the first one found.
fn find_new_session(dir: &std::path::Path, pre_mtime: u128) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<(std::path::PathBuf, u128)> = None;
    for entry in entries.filter_map(|e| e.ok()) {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let meta = entry.metadata().ok()?;
        let mtime = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        if mtime > pre_mtime {
            match &newest {
                Some((_, best)) if mtime <= *best => {}
                _ => newest = Some((entry.path(), mtime)),
            }
        }
    }
    newest.map(|(p, _)| p)
}

/// Shorten a file path for display: keep first and last segments.
fn shorten_path(path: &str) -> String {
    if path.len() <= 60 {
        return path.to_string();
    }
    // Try to keep the filename and last directory
    let parts: Vec<&str> = path.split(&['/', '\\'][..]).collect();
    if parts.len() >= 3 {
        format!("…/…/{}", parts[parts.len() - 1])
    } else {
        let truncated: String = path.chars().skip(path.len() - 55).collect();
        format!("…{}", truncated)
    }
}

/// Shorten a terminal command for display.
fn shorten_cmd(cmd: &str) -> String {
    // Take just the first line
    let first_line = cmd.lines().next().unwrap_or(cmd);
    if first_line.len() <= 70 {
        return first_line.to_string();
    }
    let truncated: String = first_line.chars().take(67).collect();
    format!("{}…", truncated)
}

/// Map a tool name + arguments to a human-readable detail string, icon, action type, and path.
struct ToolActivityInfo {
    detail: String,
    icon: &'static str,
    action_type: &'static str, // read, write, terminal, search, browser, memory, skill, delegate, generic
    path: String,              // file path, URL, command, or key info
}

fn format_tool_activity(tool_name: &str, args: &serde_json::Value) -> ToolActivityInfo {
    match tool_name {
        // ── File operations ───────────────────────────────────────
        "read_file" | "read_file_content" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Reading {}", shorten_path(path)),
                icon: "📄",
                action_type: "read",
                path: path.to_string(),
            }
        }
        "write_file" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Writing {}", shorten_path(path)),
                icon: "✏️",
                action_type: "write",
                path: path.to_string(),
            }
        }
        "patch" => {
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Editing {}", shorten_path(path)),
                icon: "🔧",
                action_type: "write",
                path: path.to_string(),
            }
        }
        "search_files" => {
            let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("?");
            let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let detail = if path.is_empty() {
                format!("Searching: {}", pattern)
            } else {
                format!("Searching {} for: {}", shorten_path(path), pattern)
            };
            ToolActivityInfo {
                detail,
                icon: "🔍",
                action_type: "search",
                path: if path.is_empty() {
                    pattern.to_string()
                } else {
                    path.to_string()
                },
            }
        }

        // ── Terminal ──────────────────────────────────────────────
        "terminal" => {
            let cmd = args.get("command").and_then(|c| c.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("$ {}", shorten_cmd(cmd)),
                icon: "⌨",
                action_type: "terminal",
                path: cmd.to_string(),
            }
        }
        "process" => {
            let action = args
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("process");
            ToolActivityInfo {
                detail: format!("Process: {}", action),
                icon: "⌨",
                action_type: "terminal",
                path: action.to_string(),
            }
        }

        // ── Browser ───────────────────────────────────────────────
        "browser_navigate" => {
            let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Navigating {}", shorten_path(url)),
                icon: "🌐",
                action_type: "browser",
                path: url.to_string(),
            }
        }
        "browser_click" => {
            let r#ref = args.get("ref").and_then(|r| r.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Clicking {}", r#ref),
                icon: "👆",
                action_type: "browser",
                path: r#ref.to_string(),
            }
        }
        "browser_type" => {
            let r#ref = args.get("ref").and_then(|r| r.as_str()).unwrap_or("?");
            ToolActivityInfo {
                detail: format!("Typing into {}", r#ref),
                icon: "⌨",
                action_type: "browser",
                path: r#ref.to_string(),
            }
        }
        "browser_snapshot" => ToolActivityInfo {
            detail: "Taking snapshot…".to_string(),
            icon: "📸",
            action_type: "browser",
            path: String::new(),
        },
        "browser_vision" => ToolActivityInfo {
            detail: "Analyzing page visually…".to_string(),
            icon: "👁",
            action_type: "browser",
            path: String::new(),
        },
        "browser_console" => ToolActivityInfo {
            detail: "Reading browser console…".to_string(),
            icon: "🌐",
            action_type: "browser",
            path: String::new(),
        },
        "browser_back" => ToolActivityInfo {
            detail: "Navigating back…".to_string(),
            icon: "🌐",
            action_type: "browser",
            path: String::new(),
        },
        "browser_scroll" => ToolActivityInfo {
            detail: "Scrolling page…".to_string(),
            icon: "🌐",
            action_type: "browser",
            path: String::new(),
        },
        "browser_press" => {
            let key = args.get("key").and_then(|k| k.as_str()).unwrap_or("key");
            ToolActivityInfo {
                detail: format!("Pressing {}", key),
                icon: "⌨",
                action_type: "browser",
                path: key.to_string(),
            }
        }
        "browser_get_images" => ToolActivityInfo {
            detail: "Scanning page images…".to_string(),
            icon: "🌐",
            action_type: "browser",
            path: String::new(),
        },

        // ── Memory & skills ───────────────────────────────────────
        "memory" => {
            let action = args
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("update");
            ToolActivityInfo {
                detail: format!("Memory: {}", action),
                icon: "🧠",
                action_type: "memory",
                path: action.to_string(),
            }
        }
        "skill_manage" => {
            let action = args
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("manage");
            ToolActivityInfo {
                detail: format!("Skill: {}", action),
                icon: "📋",
                action_type: "skill",
                path: action.to_string(),
            }
        }
        "skill_view" => ToolActivityInfo {
            detail: "Loading skill…".to_string(),
            icon: "📋",
            action_type: "skill",
            path: String::new(),
        },
        "skills_list" => ToolActivityInfo {
            detail: "Listing skills…".to_string(),
            icon: "📋",
            action_type: "skill",
            path: String::new(),
        },

        // ── Delegation ────────────────────────────────────────────
        "delegate_task" => {
            let goal = args.get("goal").and_then(|g| g.as_str()).unwrap_or("task");
            ToolActivityInfo {
                detail: format!("Delegating: {}", shorten_cmd(goal)),
                icon: "🤖",
                action_type: "delegate",
                path: goal.to_string(),
            }
        }

        // ── Communication ─────────────────────────────────────────
        "clarify" => ToolActivityInfo {
            detail: "Asking for clarification…".to_string(),
            icon: "❓",
            action_type: "generic",
            path: String::new(),
        },
        "text_to_speech" => ToolActivityInfo {
            detail: "Generating speech…".to_string(),
            icon: "🔊",
            action_type: "generic",
            path: String::new(),
        },
        "cronjob" => {
            let action = args
                .get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("cron");
            ToolActivityInfo {
                detail: format!("Cron: {}", action),
                icon: "⏰",
                action_type: "generic",
                path: action.to_string(),
            }
        }

        // ── Generic fallback ──────────────────────────────────────
        _ => {
            let friendly = tool_name.replace('_', " ");
            ToolActivityInfo {
                detail: format!("{}…", friendly),
                icon: "⚡",
                action_type: "generic",
                path: String::new(),
            }
        }
    }
}

// ── Durian commands ────────────────────────────────────────────────────

#[tauri::command]
fn check_durian() -> bool {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C")
            .arg("durian")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        suppress_console_window(&mut cmd);
        cmd.status().map(|status| status.success()).unwrap_or(false)
    } else {
        let mut cmd = durian_command();
        cmd.arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        suppress_console_window(&mut cmd);
        cmd.status().map(|status| status.success()).unwrap_or(false)
    }
}

#[tauri::command]
fn run_durian_query(
    app: AppHandle,
    state: tauri::State<AppState>,
    id: String,
    query: String,
    model: Option<String>,
    toolsets: Option<String>,
) -> Result<(), String> {
    // Kill any previous process with this id
    if let Some(mut old) = state.running.lock().unwrap().remove(&id) {
        old.kill().ok();
    }

    // Load saved settings and apply to durian config
    let saved = load_settings_inner(&app)?;
    apply_settings_to_config(&saved)?;

    // Build the command line arguments
    let mut args: Vec<String> = vec![
        "chat".into(),
        "-q".into(),
        query.clone(),
        "-Q".into(),
        "--source".into(),
        "desktop".into(),
    ];

    // Model: per-query override > saved setting > whatever is in config
    let effective_model = if model.is_some() {
        model.clone()
    } else if !saved.model.is_empty() {
        Some(saved.model.clone())
    } else {
        None
    };
    if let Some(ref m) = effective_model {
        args.push("--model".into());
        args.push(m.clone());
    }

    // Toolsets: per-query override > saved setting
    let effective_toolsets = toolsets.or_else(|| {
        if saved.toolsets.is_empty() {
            None
        } else {
            Some(saved.toolsets.clone())
        }
    });
    if let Some(ref t) = effective_toolsets {
        args.push("--toolsets".into());
        args.push(t.clone());
    }

    // Provider
    if !saved.provider.is_empty() {
        args.push("--provider".into());
        args.push(saved.provider.clone());
    }

    // Get project path for working directory
    let project_path = if !saved.project_path.is_empty() {
        Some(saved.project_path.clone())
    } else {
        None
    };

    // On Windows: batch file approach for proper quoting and shell resolution.
    let mut child = if cfg!(target_os = "windows") {
        let mut bat_lines = vec!["@echo off".to_string()];

        // Add cd /D to project path so durian works in the selected folder
        if let Some(ref cwd) = project_path {
            bat_lines.push(format!("cd /D \"{}\"", cwd));
        }

        // Add env vars for clean output
        bat_lines.push("set NO_COLOR=1".to_string());
        bat_lines.push("set FORCE_COLOR=0".to_string());
        bat_lines.push("set PYTHONIOENCODING=utf-8".to_string());

        let mut bat_cmd = String::from("durian");
        for arg in &args {
            if arg.contains(' ') || arg.contains('"') {
                bat_cmd.push_str(&format!(" \"{}\"", arg.replace('"', "\"\"")));
            } else {
                bat_cmd.push_str(&format!(" {}", arg));
            }
        }
        bat_cmd.push_str(" 2>NUL");
        bat_lines.push(bat_cmd);

        let temp_dir = std::env::var("TEMP").unwrap_or_else(|_| "C:\\Temp".into());
        let bat_path = std::path::PathBuf::from(&temp_dir).join(format!("durian_query_{}.bat", id));
        fs::write(&bat_path, bat_lines.join("\r\n"))
            .map_err(|e| format!("Failed to write batch file: {e}"))?;

        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C")
            .arg(&bat_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        suppress_console_window(&mut cmd);

        let child = cmd.spawn().map_err(|e| {
            format!("Failed to start durian: {e}. Make sure durian is installed and in your PATH.")
        })?;

        let bat_path_clone = bat_path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            fs::remove_file(&bat_path_clone).ok();
        });

        child
    } else {
        let mut cmd = durian_command();
        cmd.args(&args)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("TERM", "dumb")
            .env("PYTHONIOENCODING", "utf-8")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref cwd) = project_path {
            cmd.current_dir(cwd);
        }

        suppress_console_window(&mut cmd);

        cmd.spawn().map_err(|e| {
            format!("Failed to start durian: {e}. Make sure durian is installed and in your PATH.")
        })?
    };

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take();

    state.running.lock().unwrap().insert(id.clone(), child);

    // Read stdout line-by-line, emit as durian-output events
    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let clean = strip_ansi(&l);
                    let trimmed = clean.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with("session_id:") {
                        app_out
                            .emit(
                                "durian-output",
                                OutputChunk {
                                    id: id_out.clone(),
                                    text: clean,
                                    done: false,
                                },
                            )
                            .ok();
                    }
                }
                Err(_) => break,
            }
        }
        app_out
            .emit(
                "durian-output",
                OutputChunk {
                    id: id_out,
                    text: String::new(),
                    done: true,
                },
            )
            .ok();
    });

    // Read stderr only if it was piped (Linux/macOS path)
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        let id_err = id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(err_line) = line {
                    let clean = strip_ansi(&err_line);
                    let trimmed = clean.trim();
                    if !trimmed.is_empty()
                        && (trimmed.contains("Error")
                            || trimmed.contains("error")
                            || trimmed.contains("WARNING")
                            || trimmed.contains("Failed")
                            || trimmed.contains("failed"))
                        && !trimmed.contains("DEBUG")
                    {
                        app_err
                            .emit(
                                "durian-output",
                                OutputChunk {
                                    id: id_err.clone(),
                                    text: format!("⚠ {}", clean),
                                    done: false,
                                },
                            )
                            .ok();
                    }
                }
            }
        });
    }

    // ── Watch durian session file for real-time tool activity ──────────
    // The session JSON contains every tool_call with name + arguments (paths,
    // commands, URLs, etc.) — much richer than the agent.log which only has
    // high-level module messages.
    let app_sess = app.clone();
    let id_sess = id.clone();
    std::thread::spawn(move || {
        // Locate the durian sessions directory
        let sessions_dir = if cfg!(target_os = "windows") {
            let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                let userprofile =
                    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
                format!("{}\\AppData\\Local", userprofile)
            });
            std::path::PathBuf::from(localappdata)
                .join("durian")
                .join("sessions")
        } else {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            std::path::PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("durian")
                .join("sessions")
        };

        if !sessions_dir.exists() {
            return;
        }

        // Emit an initial "starting" event
        let _ = app_sess.emit(
            "durian-activity",
            serde_json::json!({
                "id": id_sess,
                "phase": "init",
                "tool": "agent",
                "detail": "Starting agent…",
            }),
        );

        // Snapshot the current newest file *before* our query creates a new one
        let pre_newest = newest_session_mtime(&sessions_dir);

        // Wait for durian to create a new session file
        let session_path = {
            let mut found: Option<std::path::PathBuf> = None;
            for _ in 0..40 {
                // up to ~10 s
                std::thread::sleep(std::time::Duration::from_millis(250));
                if let Some(p) = find_new_session(&sessions_dir, pre_newest) {
                    found = Some(p);
                    break;
                }
            }
            match found {
                Some(p) => p,
                None => return, // no session file appeared
            }
        };

        let _ = app_sess.emit(
            "durian-activity",
            serde_json::json!({
                "id": id_sess,
                "phase": "thinking",
                "tool": "agent",
                "detail": "Processing request…",
            }),
        );

        let mut last_msg_count: usize = 0;
        let mut idle_ticks: usize = 0;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(400));

            let content = match std::fs::read_to_string(&session_path) {
                Ok(c) => c,
                Err(_) => {
                    idle_ticks += 1;
                    if idle_ticks > 60 {
                        break;
                    } // ~24 s with no file access
                    continue;
                }
            };

            let session: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => {
                    idle_ticks += 1;
                    if idle_ticks > 60 {
                        break;
                    }
                    continue;
                }
            };

            let messages = match session.get("messages").and_then(|m| m.as_array()) {
                Some(arr) => arr,
                None => {
                    idle_ticks += 1;
                    if idle_ticks > 60 {
                        break;
                    }
                    continue;
                }
            };

            // Process new messages that appeared since last check
            if messages.len() > last_msg_count {
                idle_ticks = 0;
                for msg in &messages[last_msg_count..] {
                    // ── tool_calls in assistant messages ────────────────
                    if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                        for tc in tool_calls {
                            if let Some(func) = tc.get("function") {
                                let tool_name = func
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("unknown");
                                let args_str = func
                                    .get("arguments")
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("{}");
                                let args: serde_json::Value =
                                    serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));

                                let info = format_tool_activity(tool_name, &args);

                                let _ = app_sess.emit(
                                    "durian-activity",
                                    serde_json::json!({
                                        "id": id_sess,
                                        "phase": "tool",
                                        "tool": tool_name,
                                        "detail": info.detail,
                                        "icon": info.icon,
                                        "actionType": info.action_type,
                                        "path": info.path,
                                    }),
                                );
                            }
                        }
                    }

                    // ── tool result messages (completion) ───────────────
                    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
                    if role == "tool" {
                        // A tool finished — we can optionally note this
                        // but the main display is the "starting" event above
                    }

                    // ── assistant text messages (thinking/compressing) ───
                    if role == "assistant" {
                        if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                            if !content.is_empty() && msg.get("tool_calls").is_none() {
                                // The agent is generating a text response
                                let _ = app_sess.emit(
                                    "durian-activity",
                                    serde_json::json!({
                                        "id": id_sess,
                                        "phase": "thinking",
                                        "tool": "model",
                                        "detail": "Generating response…",
                                    }),
                                );
                            }
                        }
                    }
                }
                last_msg_count = messages.len();
            } else {
                idle_ticks += 1;
                if idle_ticks > 60 {
                    break;
                }
            }
        }
    });

    // ── Also watch agent.log for errors / warnings (lightweight) ───────
    let app_log = app.clone();
    let id_log = id.clone();
    std::thread::spawn(move || {
        let log_path = if cfg!(target_os = "windows") {
            let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                let userprofile =
                    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
                format!("{}\\AppData\\Local", userprofile)
            });
            std::path::PathBuf::from(localappdata)
                .join("durian")
                .join("logs")
                .join("agent.log")
        } else {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            std::path::PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("durian")
                .join("logs")
                .join("agent.log")
        };

        if !log_path.exists() {
            return;
        }
        let mut file = match std::fs::File::open(&log_path) {
            Ok(f) => f,
            Err(_) => return,
        };
        if file.seek(std::io::SeekFrom::End(0)).is_err() {
            return;
        }
        let mut reader = BufReader::new(file);

        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    continue;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Only forward ERROR / WARNING lines
                    let is_error = trimmed.contains("ERROR");
                    let is_warning = trimmed.contains("WARNING");
                    if !is_error && !is_warning {
                        continue;
                    }

                    let (phase, detail) = if is_error {
                        ("error", format!("Error: {}", trimmed))
                    } else {
                        ("warning", format!("Warning: {}", trimmed))
                    };

                    let _ = app_log.emit(
                        "durian-activity",
                        serde_json::json!({
                            "id": id_log,
                            "phase": phase,
                            "tool": "agent",
                            "detail": detail,
                        }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_durian(state: tauri::State<AppState>, id: String) {
    if let Some(mut child) = state.running.lock().unwrap().remove(&id) {
        child.kill().ok();
    }
}

#[tauri::command]
fn save_session(app: AppHandle, session: serde_json::Value) -> Result<(), String> {
    let id = session["id"].as_str().ok_or("missing session id")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(sessions_dir.join(format!("{id}.json")), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_sessions(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sessions_dir = dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions: Vec<serde_json::Value> = vec![];
    for entry in std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    sessions.push(val);
                }
            }
        }
    }
    sessions.sort_by(|a, b| {
        b["createdAt"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["createdAt"].as_i64().unwrap_or(0))
    });
    Ok(sessions)
}

#[tauri::command]
fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("sessions").join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_settings_inner(app: &AppHandle) -> Result<Settings, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Settings>(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), content).map_err(|e| e.to_string())?;

    // Also apply settings to durian's config.yaml immediately
    if let Err(e) = apply_settings_to_config(&settings) {
        eprintln!("Warning: failed to apply settings to durian config: {e}");
    }

    Ok(())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    load_settings_inner(&app)
}

/// Add a workspace folder. Returns updated settings.
#[tauri::command]
fn add_workspace(app: AppHandle, path: String, name: Option<String>) -> Result<Settings, String> {
    let mut settings = load_settings_inner(&app)?;

    // Check if already exists
    if settings.workspaces.iter().any(|w| w.path == path) {
        return Err("This folder is already in your workspaces".into());
    }

    // Derive name from folder path if not provided
    let ws_name = name.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone())
    });

    let id = format!(
        "ws_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let workspace = Workspace {
        id,
        name: ws_name,
        path: path.clone(),
        added_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    settings.workspaces.push(workspace.clone());
    settings.current_workspace_id = workspace.id;
    settings.project_path = path;

    // Save and apply
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), content).map_err(|e| e.to_string())?;

    if let Err(e) = apply_settings_to_config(&settings) {
        eprintln!("Warning: failed to apply settings to durian config: {e}");
    }

    Ok(settings)
}

/// Remove a workspace by id. Returns updated settings.
#[tauri::command]
fn remove_workspace(app: AppHandle, workspace_id: String) -> Result<Settings, String> {
    let mut settings = load_settings_inner(&app)?;

    settings.workspaces.retain(|w| w.id != workspace_id);

    // If we removed the current workspace, switch to first or clear
    if settings.current_workspace_id == workspace_id {
        if let Some(first) = settings.workspaces.first() {
            settings.current_workspace_id = first.id.clone();
            settings.project_path = first.path.clone();
        } else {
            settings.current_workspace_id = String::new();
            settings.project_path = String::new();
        }
    }

    // Save and apply
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), content).map_err(|e| e.to_string())?;

    if let Err(e) = apply_settings_to_config(&settings) {
        eprintln!("Warning: failed to apply settings to durian config: {e}");
    }

    Ok(settings)
}

/// Switch current workspace. Returns updated settings.
#[tauri::command]
fn switch_workspace(app: AppHandle, workspace_id: String) -> Result<Settings, String> {
    let mut settings = load_settings_inner(&app)?;

    let ws = settings
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;

    settings.current_workspace_id = workspace_id;
    settings.project_path = ws.path.clone();

    // Save and apply
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), content).map_err(|e| e.to_string())?;

    if let Err(e) = apply_settings_to_config(&settings) {
        eprintln!("Warning: failed to apply settings to durian config: {e}");
    }

    Ok(settings)
}

/// Start watching a workspace directory for file changes.
/// Helper: recursively collect file paths and modification times
fn collect_dir_state(dir: &std::path::Path) -> HashMap<String, u64> {
    let mut result = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.')
                || name.ends_with(".tmp")
                || name == "node_modules"
                || name == "__pycache__"
                || name == ".git"
                || name == "target"
            {
                continue;
            }
            let key = path.to_string_lossy().to_string();
            let mtime = path
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            result.insert(key, mtime);
            if path.is_dir() {
                for (k, v) in collect_dir_state(&path) {
                    result.insert(k, v);
                }
            }
        }
    }
    result
}

fn stop_workspace_watcher(state: &tauri::State<AppState>) {
    let watcher = {
        let mut watcher_guard = state.watcher.lock().unwrap();
        watcher_guard.take()
    };

    if let Some(watcher) = watcher {
        watcher.stop.store(true, Ordering::Relaxed);
        let _ = watcher.handle.join();
    }
}

fn watcher_log_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(base).join("durian-desktop-watcher.log");
        }
    } else if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("durian-desktop-watcher.log");
    }

    std::env::temp_dir().join("durian-desktop-watcher.log")
}

fn append_watcher_log(message: &str) {
    let log_path = watcher_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .and_then(|mut f| f.write_all(message.as_bytes()));
}

/// Start watching a workspace directory using simple polling.
#[tauri::command]
fn watch_workspace(
    app: AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> Result<(), String> {
    // Debug: write to log file
    let log_msg = format!("[watch_workspace] called with path: {}\n", path);
    append_watcher_log(&log_msg);

    stop_workspace_watcher(&state);

    let watch_path = std::path::PathBuf::from(&path);
    if !watch_path.is_dir() {
        let log_msg = format!("[watch_workspace] NOT a directory: {}\n", path);
        append_watcher_log(&log_msg);
        return Err(format!("Not a directory: {}", path));
    }

    let app_clone = app.clone();
    let watch_dir = watch_path.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    // Spawn a polling thread
    let handle = std::thread::spawn(move || {
        let mut last_state = collect_dir_state(&watch_dir);

        let log_msg = format!(
            "[watch_workspace] Polling started for: {} ({} files)\n",
            watch_dir.display(),
            last_state.len()
        );
        append_watcher_log(&log_msg);

        while !stop_thread.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(800));
            if stop_thread.load(Ordering::Relaxed) {
                break;
            }

            let current_state = collect_dir_state(&watch_dir);

            // Find changes
            let mut changes = Vec::new();

            // New or modified files
            for (path, mtime) in &current_state {
                match last_state.get(path) {
                    None => changes.push(("create", path.clone())),
                    Some(old_mtime) if old_mtime != mtime => changes.push(("modify", path.clone())),
                    _ => {}
                }
            }

            // Deleted files
            for path in last_state.keys() {
                if !current_state.contains_key(path) {
                    changes.push(("remove", path.clone()));
                }
            }

            // Emit events for changes
            for (kind, path_str) in &changes {
                let _ = app_clone.emit(
                    "fs-change",
                    serde_json::json!({
                        "path": path_str,
                        "kind": kind,
                    }),
                );
            }

            if !changes.is_empty() {
                let log_msg = format!("[watcher] {} changes detected\n", changes.len());
                append_watcher_log(&log_msg);
            }

            last_state = current_state;
        }
    });

    let log_msg = format!("[watch_workspace] NOW WATCHING: {}\n", path);
    append_watcher_log(&log_msg);

    let mut watcher_guard = state.watcher.lock().unwrap();
    *watcher_guard = Some(WorkspaceWatcher { stop, handle });

    Ok(())
}

/// Stop watching the current workspace directory.
#[tauri::command]
fn stop_watching(state: tauri::State<AppState>) {
    stop_workspace_watcher(&state);
}

/// Test command to verify frontend-backend communication
#[tauri::command]
fn ping_test(msg: String) -> Result<String, String> {
    let log_msg = format!("[ping_test] received: {}\n", msg);
    append_watcher_log(&log_msg);
    Ok(format!("pong: {}", msg))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            running: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            check_durian,
            run_durian_query,
            stop_durian,
            save_session,
            load_sessions,
            delete_session,
            save_settings,
            load_settings,
            list_dir,
            read_file_content,
            add_workspace,
            remove_workspace,
            switch_workspace,
            watch_workspace,
            stop_watching,
            ping_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running taurian application");
}
