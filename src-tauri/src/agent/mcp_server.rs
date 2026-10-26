//! Hub MCP 聚合 server（v0.9.0 需求1 P2，方案 b——用户裁决主案；二期三传输）。
//!
//! `jishu-cli mcp serve` 启动本模块：一个 stdio MCP server（换行分隔
//! JSON-RPC 2.0），聚合两层工具——
//! ①hub 内置工具（projects/models/usage/memory 数据面直读，无 Tauri 依赖）；
//! ②启用的 [mcp] 声明插件（外部 MCP server，lazy 连接 + 转发，工具名以
//!   `<plugin_id>__<tool>` 命名空间隔离）。二期起分传输（02 §七 M8）：
//!   stdio → spawn 子进程；http → Streamable HTTP（POST JSON-RPC +
//!   Mcp-Session-Id）；sse → 旧式 SSE（GET 流 + endpoint 事件 + POST）。
//! 四家智能体只需配置一条 `jishu-hub` 条目（见 mcp_inject.rs；注入门控 =
//! mcp-resolver 系统插件启用态），插件启停经每次 tools/list 重读清单动态
//! 生效（条目常驻）。
//!
//! 协议面（MVP 最小实现）：initialize / notifications/initialized /
//! tools/list / tools/call / ping；未知方法回 -32601。
//! 已知限制（02 §十）：插件读写为阻塞式（单插件挂起会阻塞当次调用；
//! http/sse 请求超时 30s）；resources/prompts 面与 tools/list_changed 通知
//! 留后续。reqwest blocking 客户端只能在无 tokio runtime 的上下文构造
//! （CLI serve 进程 / 普通 #[test]）。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Duration;

use crate::agent::tool_plugin;

pub const HUB_MCP_ENTRY_NAME: &str = "jishu-hub";
const PROTOCOL_VERSION: &str = "2024-11-05";
/// 远程插件（http/sse）单请求超时（参考图「超时 MS」字段不入本期，固定值）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// v0.9.4 需求9 A1：单后端 spawn+handshake 整体截止。串行时代一个 npx 冷启动
/// （首次下载包）可拖住 tools/list 60-150s；并行化后总耗时 = 最慢后端，
/// 截止保证含「一个后端无响应」场景的 tools/list 稳定 <5s。
const SPAWN_DEADLINE: Duration = Duration::from_secs(4);
/// v0.9.4 需求9 A1：失败后端冷却——Failed 连接（超时/握手失败）在冷却期内
/// 不重试，避免每次 tools/list 被同个慢后端反复拖住（稳态响应时间）；
/// 冷却过后允许重试（npx 下载完成等场景自愈）。
const FAILED_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// 工具定义与命名空间
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// 插件工具命名空间：`<plugin_id>__<tool_name>`。plugin id 与工具名内的
/// `_` 歧义由「首个 `__` 分割」消解（plugin id 来自 TOML key，约定不含
/// 连续双下划线）。
pub fn namespaced_tool_name(plugin_id: &str, tool: &str) -> String {
    format!("{plugin_id}__{tool}")
}

pub fn split_namespaced(name: &str) -> Option<(String, String)> {
    let (plugin, tool) = name.split_once("__")?;
    if plugin.is_empty() || tool.is_empty() {
        return None;
    }
    Some((plugin.to_string(), tool.to_string()))
}

// ---------------------------------------------------------------------------
// hub 内置工具（数据面直读）
// ---------------------------------------------------------------------------

fn obj_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

pub fn builtin_tool_defs() -> Vec<McpToolDef> {
    vec![
        McpToolDef {
            name: "hub_projects_list".into(),
            description: "列出 jishu-hub 管理的项目（扫描 + 手动登记）".into(),
            input_schema: obj_schema(json!({}), &[]),
        },
        McpToolDef {
            name: "hub_models_list".into(),
            description: "列出 jishu-self（pi）的模型配置（models.json）".into(),
            input_schema: obj_schema(json!({}), &[]),
        },
        McpToolDef {
            name: "hub_usage_get".into(),
            description: "查询某会话的累计用量（token/费用/压缩次数）".into(),
            input_schema: obj_schema(
                json!({ "sessionId": { "type": "string", "description": "会话 id" } }),
                &["sessionId"],
            ),
        },
        McpToolDef {
            name: "hub_memory_get".into(),
            description: "读取 jishu-hub 项目记忆 KV（memory.db）".into(),
            input_schema: obj_schema(
                json!({
                    "project": { "type": "string" },
                    "key": { "type": "string" },
                }),
                &["project", "key"],
            ),
        },
        McpToolDef {
            name: "hub_memory_set".into(),
            description: "写入 jishu-hub 项目记忆 KV（memory.db）".into(),
            input_schema: obj_schema(
                json!({
                    "project": { "type": "string" },
                    "key": { "type": "string" },
                    "value": { "type": "string" },
                }),
                &["project", "key", "value"],
            ),
        },
        McpToolDef {
            name: "hub_memory_list".into(),
            description: "列出某项目的全部记忆 KV".into(),
            input_schema: obj_schema(
                json!({ "project": { "type": "string" } }),
                &["project"],
            ),
        },
        // v0.9.4 需求9 P1：MCP 解析器动态发现入口（永不过期，随 builtin
        // 注册）——pi 册子上的工具集是 spawn 时静态抄录，运行中启停的插件
        // 工具无法进入册子；模型经这两个入口「先查后调」实现热插拔（02 §二）。
        McpToolDef {
            name: "hub_mcp_list".into(),
            description: "实时列出 hub 当前启用的 MCP 插件与全部工具（含参数说明；插件启停即时反映）。未注册的插件工具可经 hub_mcp_call 代理调用".into(),
            input_schema: obj_schema(json!({}), &[]),
        },
        McpToolDef {
            name: "hub_mcp_call".into(),
            description: "经 MCP 解析器代理调用插件工具：传入 hub_mcp_list 返回的工具名（如 插件id__工具名）与参数。册子上已直接注册的 插件id__ 工具优先直接调用".into(),
            input_schema: obj_schema(
                json!({
                    "tool": { "type": "string", "description": "目标工具名（插件id__工具名 或 builtin 名）" },
                    "arguments": { "type": "object", "description": "目标工具的参数对象" },
                }),
                &["tool"],
            ),
        },
    ]
}

/// 内置工具调用分发。Ok(text) → 工具内容；Err(msg) → isError 工具结果。
pub fn call_builtin_tool(name: &str, arguments: &Value) -> Result<String, String> {
    let arg = |k: &str| -> Result<String, String> {
        arguments
            .get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("missing required argument: {k}"))
    };
    match name {
        "hub_projects_list" => {
            let mut items = Vec::new();
            for p in crate::project::scan_projects() {
                items.push(json!({ "name": p.name, "path": p.path }));
            }
            if let Ok(manual) = crate::hub::load_manual_projects() {
                for path in manual {
                    items.push(json!({ "name": null, "path": path, "manual": true }));
                }
            }
            serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
        }
        "hub_models_list" => {
            let config = crate::agent::jishu_self::pi_models_config::load()?;
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
        }
        "hub_usage_get" => {
            let session_id = arg("sessionId")?;
            let row = crate::usage_store::get(&session_id)?;
            serde_json::to_string_pretty(&row).map_err(|e| e.to_string())
        }
        "hub_memory_get" => {
            let value = crate::memory_store::get(&arg("project")?, &arg("key")?)?;
            Ok(value.unwrap_or_default())
        }
        "hub_memory_set" => {
            crate::memory_store::set(&arg("project")?, &arg("key")?, &arg("value")?)?;
            Ok("ok".into())
        }
        "hub_memory_list" => {
            let entries = crate::memory_store::list(&arg("project")?)?;
            serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown builtin tool: {name}")),
    }
}

// ---------------------------------------------------------------------------
// 插件声明（可注入数据源，测试用）
// ---------------------------------------------------------------------------

/// 启用的 MCP 插件声明（分传输，02 §七 M8）。stdio = 本地子进程；
/// http / sse = 远程服务（headers 随连接发送）。
#[derive(Debug, Clone)]
pub enum McpPluginDecl {
    Stdio {
        plugin_id: String,
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    Http {
        plugin_id: String,
        url: String,
        headers: Vec<(String, String)>,
    },
    Sse {
        plugin_id: String,
        url: String,
        headers: Vec<(String, String)>,
    },
}

impl McpPluginDecl {
    pub fn plugin_id(&self) -> &str {
        match self {
            McpPluginDecl::Stdio { plugin_id, .. }
            | McpPluginDecl::Http { plugin_id, .. }
            | McpPluginDecl::Sse { plugin_id, .. } => plugin_id,
        }
    }
}

/// schema [mcp] 段 → 传输声明（纯映射，可单测）。
pub fn decl_from_section(
    plugin_id: &str,
    mcp: &crate::agent::manifest::schema::McpSection,
) -> McpPluginDecl {
    use crate::agent::manifest::schema::McpTransportKind;
    fn pairs<V>(m: Option<std::collections::HashMap<String, V>>) -> Vec<(String, V)> {
        m.map(|m| m.into_iter().collect()).unwrap_or_default()
    }
    match mcp.transport {
        McpTransportKind::Stdio => McpPluginDecl::Stdio {
            plugin_id: plugin_id.to_string(),
            command: mcp.command.clone().unwrap_or_default(),
            args: mcp.args.clone().unwrap_or_default(),
            env: pairs(mcp.env.clone()),
        },
        McpTransportKind::Http => McpPluginDecl::Http {
            plugin_id: plugin_id.to_string(),
            url: mcp.url.clone().unwrap_or_default(),
            headers: pairs(mcp.headers.clone()),
        },
        McpTransportKind::Sse => McpPluginDecl::Sse {
            plugin_id: plugin_id.to_string(),
            url: mcp.url.clone().unwrap_or_default(),
            headers: pairs(mcp.headers.clone()),
        },
    }
}

/// 生产数据源：启用的 [mcp] 声明工具插件（读取 plugins.json disabled 集）。
pub fn load_mcp_plugin_decls() -> Vec<McpPluginDecl> {
    let disabled = crate::agent::plugin::load_plugin_config().disabled.into_iter().collect();
    tool_plugin::load_tool_plugins(&disabled)
        .into_iter()
        .filter(|p| p.enabled)
        .filter_map(|p| p.file.mcp.as_ref().map(|m| decl_from_section(p.id(), m)))
        .collect()
}

// ---------------------------------------------------------------------------
// 分传输插件客户端（stdio 子进程 / Streamable HTTP / 旧式 SSE）
// ---------------------------------------------------------------------------

/// 下游插件连接的统一抽象：request = 有 id 请求-响应；notify = 单向通知
/// （stdio 写行；http/sse POST 无 id 报文，不等响应）。握手
/// （initialize → notifications/initialized → tools/list）为默认实现共用。
trait PluginTransport: Send {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String>;
    fn notify(&mut self, method: &str) -> Result<(), String> {
        let _ = method;
        Ok(())
    }
    /// 回收连接（stdio kill 子进程；http/sse 连接对象随 drop 关闭）。
    fn kill(&mut self) {}
    fn handshake(&mut self) -> Result<Vec<McpToolDef>, String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "jishu-hub-mcp", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        let _ = self.notify("notifications/initialized");
        let result = self.request("tools/list", json!({}))?;
        Ok(parse_tool_list(&result))
    }
}

/// JSON-RPC 响应消息 → result（error 字段转 Err）。
fn message_result(v: &Value, plugin_id: &str) -> Result<Value, String> {
    if let Some(err) = v.get("error") {
        return Err(format!(
            "plugin `{plugin_id}` error: {}",
            err.get("message").and_then(Value::as_str).unwrap_or("?")
        ));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

struct StdioChild {
    plugin_id: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl StdioChild {
    fn spawn(decl: &McpPluginDecl) -> Result<StdioChild, String> {
        let McpPluginDecl::Stdio {
            plugin_id,
            command,
            args,
            env,
        } = decl
        else {
            return Err(format!(
                "stdio transport expected for plugin `{}`",
                decl.plugin_id()
            ));
        };
        // Windows：npm/npx 等需 cmd /C 包装（与 install_mcp_standalone 的
        // shell_command 同纪律；本模块为同步 std 进程，就地等价实现）。
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = Command::new("cmd");
            let mut full_args = vec!["/C".to_string(), command.clone()];
            full_args.extend(args.iter().cloned());
            c.args(&full_args);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = Command::new(command);
            c.args(args);
            c
        };
        // v0.9.1 需求7：stdio MCP 插件为后台常驻子进程——Windows 下不加
        // CREATE_NO_WINDOW 每次启动都会弹黑色命令行窗口（与 codex 模型
        // 探测同根源），静默化。
        crate::process_command::std_no_window(&mut cmd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn mcp plugin `{plugin_id}` failed: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("plugin `{plugin_id}` stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("plugin `{plugin_id}` stdout unavailable"))?;
        Ok(StdioChild {
            plugin_id: plugin_id.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }
}

impl PluginTransport for StdioChild {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.stdin
            .write_all(format!("{}\n", msg).as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("write to plugin `{}` failed: {e}", self.plugin_id))?;
        loop {
            let mut line = String::new();
            let n = self
                .stdout
                .read_line(&mut line)
                .map_err(|e| format!("read from plugin `{}` failed: {e}", self.plugin_id))?;
            if n == 0 {
                return Err(format!("plugin `{}` exited", self.plugin_id));
            }
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v.get("id") != Some(&json!(id)) {
                continue; // 通知或别人的响应——跳过（MVP 串行，不应出现）
            }
            return message_result(&v, &self.plugin_id);
        }
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        self.stdin
            .write_all(format!("{}\n", msg).as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("write to plugin `{}` failed: {e}", self.plugin_id))
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

/// 共享 blocking 客户端构造（连接超时 10s；GET SSE 长流不受整体超时约束，
/// 整体超时在 POST 请求级设置）。仅可在无 tokio runtime 的上下文调用。
fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))
}

/// Streamable HTTP 客户端（type = "http"）：每请求 POST JSON-RPC；
/// initialize 响应的 `Mcp-Session-Id` 头在后续请求回传；响应体
/// application/json 直取，text/event-stream 时解析 SSE 帧取首条匹配 id
/// 的消息。
struct HttpStreamableClient {
    plugin_id: String,
    url: String,
    headers: Vec<(String, String)>,
    client: reqwest::blocking::Client,
    session_id: Option<String>,
    next_id: i64,
}

impl HttpStreamableClient {
    fn spawn(decl: &McpPluginDecl) -> Result<HttpStreamableClient, String> {
        let McpPluginDecl::Http {
            plugin_id,
            url,
            headers,
        } = decl
        else {
            return Err(format!(
                "http transport expected for plugin `{}`",
                decl.plugin_id()
            ));
        };
        Ok(HttpStreamableClient {
            plugin_id: plugin_id.clone(),
            url: url.clone(),
            headers: headers.clone(),
            client: blocking_client()?,
            session_id: None,
            next_id: 1,
        })
    }

    fn post(&mut self, body: &Value) -> Result<reqwest::blocking::Response, String> {
        let mut req = self
            .client
            .post(&self.url)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid);
        }
        let method = body
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let resp = req
            .json(body)
            .send()
            .map_err(|e| format!("plugin `{}` http request `{}` failed: {e}", self.plugin_id, method))?;
        if !resp.status().is_success() {
            return Err(format!(
                "plugin `{}` http request `{}` returned {}",
                self.plugin_id,
                method,
                resp.status()
            ));
        }
        Ok(resp)
    }
}

impl PluginTransport for HttpStreamableClient {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let resp = self.post(&body)?;
        if method == "initialize" {
            if let Some(sid) = resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
            {
                self.session_id = Some(sid.to_string());
            }
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if content_type.contains("text/event-stream") {
            let msg = read_sse_message(resp, id, &self.plugin_id)?;
            return message_result(&msg, &self.plugin_id);
        }
        let v: Value = resp
            .json()
            .map_err(|e| format!("plugin `{}` http response decode failed: {e}", self.plugin_id))?;
        message_result(&v, &self.plugin_id)
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method });
        self.post(&body).map(|_| ())
    }
}

/// SSE 帧累积器：逐行喂入，帧结束（空行）时产出 (event, data)。纯函数可单测。
struct SseFrameAcc {
    event: String,
    data: String,
}

impl SseFrameAcc {
    fn new() -> SseFrameAcc {
        SseFrameAcc {
            event: String::new(),
            data: String::new(),
        }
    }

    fn feed(&mut self, line: &str) -> Option<(String, String)> {
        if line.is_empty() {
            let out = (!self.data.is_empty())
                .then(|| (self.event.clone(), self.data.clone()));
            self.event.clear();
            self.data.clear();
            return out;
        }
        if let Some(e) = line.strip_prefix("event:") {
            self.event = e.trim().to_string();
        } else if let Some(d) = line.strip_prefix("data:") {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(d.strip_prefix(' ').unwrap_or(d));
        }
        // 其余字段（id:/retry:/注释行）忽略。
        None
    }
}

/// Streamable HTTP 的 SSE 响应体：读帧取首条 id 匹配的消息。
fn read_sse_message(
    resp: reqwest::blocking::Response,
    want_id: i64,
    plugin_id: &str,
) -> Result<Value, String> {
    let reader = BufReader::new(resp);
    let mut acc = SseFrameAcc::new();
    for line in reader.lines() {
        let line =
            line.map_err(|e| format!("plugin `{plugin_id}` sse response read failed: {e}"))?;
        if let Some((event, data)) = acc.feed(&line) {
            if event != "ping" {
                if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    if v.get("id") == Some(&json!(want_id)) {
                        return Ok(v);
                    }
                }
            }
        }
    }
    Err(format!(
        "plugin `{plugin_id}` sse response ended without message id {want_id}"
    ))
}

/// 旧式 HTTP+SSE 客户端（type = "sse"）：GET 长流接收消息（独立线程解析
/// SSE 帧回投通道），`endpoint` 事件给出消息 POST 地址（相对路径按 base
/// origin 拼接）；请求 POST 到 endpoint，响应按 id 从流通道匹配读取。
enum SseEvent {
    Endpoint(String),
    Message(Value),
    Closed(String),
}

struct SseClient {
    plugin_id: String,
    post_url: String,
    headers: Vec<(String, String)>,
    client: reqwest::blocking::Client,
    rx: std::sync::mpsc::Receiver<SseEvent>,
    next_id: i64,
}

impl SseClient {
    fn spawn(decl: &McpPluginDecl) -> Result<SseClient, String> {
        let McpPluginDecl::Sse {
            plugin_id,
            url,
            headers,
        } = decl
        else {
            return Err(format!(
                "sse transport expected for plugin `{}`",
                decl.plugin_id()
            ));
        };
        let client = blocking_client()?;
        let mut req = client
            .get(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache");
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req
            .send()
            .map_err(|e| format!("plugin `{plugin_id}` sse connect failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "plugin `{plugin_id}` sse connect returned {}",
                resp.status()
            ));
        }
        let base = url.clone();
        let (tx, rx) = std::sync::mpsc::channel::<SseEvent>();
        // 读流线程：帧 → 通道。发送失败（接收端已 drop，插件被回收）即退出，
        // Response 随线程结束 drop 关闭连接（无 keepalive 的 server 下线程
        // 可能阻塞至 TCP 关闭，见 02 §六 风险注记）。
        std::thread::spawn(move || {
            let mut acc = SseFrameAcc::new();
            for line in BufReader::new(resp).lines() {
                let Ok(line) = line else {
                    let _ = tx.send(SseEvent::Closed("read error".into()));
                    return;
                };
                let Some((event, data)) = acc.feed(&line) else {
                    continue;
                };
                let ev = if event == "endpoint" {
                    SseEvent::Endpoint(data)
                } else if event == "ping" {
                    continue;
                } else if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    SseEvent::Message(v)
                } else {
                    continue; // 非 JSON data（自定义事件）忽略
                };
                if tx.send(ev).is_err() {
                    return;
                }
            }
            let _ = tx.send(SseEvent::Closed("stream ended".into()));
        });
        // 等待 endpoint 事件（10s）。
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let post_url = loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(format!(
                    "plugin `{plugin_id}` sse endpoint event timed out"
                ));
            }
            match rx.recv_timeout(deadline - now) {
                Ok(SseEvent::Endpoint(u)) => break join_url(&base, &u),
                Ok(SseEvent::Closed(e)) => {
                    return Err(format!(
                        "plugin `{plugin_id}` sse stream closed before endpoint: {e}"
                    ))
                }
                Ok(SseEvent::Message(_)) => continue, // endpoint 前不应有响应，容忍跳过
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "plugin `{plugin_id}` sse endpoint event timed out"
                    ))
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "plugin `{plugin_id}` sse reader exited before endpoint"
                    ))
                }
            }
        };
        Ok(SseClient {
            plugin_id: plugin_id.clone(),
            post_url,
            headers: headers.clone(),
            client,
            rx,
            next_id: 1,
        })
    }

    fn post_message(&mut self, body: &Value) -> Result<(), String> {
        let mut req = self
            .client
            .post(&self.post_url)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/json");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        let resp = req
            .json(body)
            .send()
            .map_err(|e| format!("plugin `{}` sse post failed: {e}", self.plugin_id))?;
        if !resp.status().is_success() {
            return Err(format!(
                "plugin `{}` sse post returned {}",
                self.plugin_id,
                resp.status()
            ));
        }
        Ok(()) // 响应经 SSE 流回传（POST 通常返回 202）
    }
}

impl PluginTransport for SseClient {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.post_message(&body)?;
        loop {
            match self.rx.recv_timeout(REQUEST_TIMEOUT) {
                Ok(SseEvent::Message(v)) if v.get("id") == Some(&json!(id)) => {
                    return message_result(&v, &self.plugin_id)
                }
                Ok(SseEvent::Message(_)) | Ok(SseEvent::Endpoint(_)) => continue,
                Ok(SseEvent::Closed(e)) => {
                    return Err(format!(
                        "plugin `{}` sse stream closed: {e}",
                        self.plugin_id
                    ))
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "plugin `{}` sse response timed out ({method})",
                        self.plugin_id
                    ))
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "plugin `{}` sse reader exited ({method})",
                        self.plugin_id
                    ))
                }
            }
        }
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method });
        self.post_message(&body)
    }
}

/// SSE endpoint 相对地址 → 绝对 URL（origin 拼接；绝对地址原样）。纯函数可单测。
fn join_url(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    let Some(scheme_idx) = base.find("://") else {
        return target.to_string();
    };
    let after = scheme_idx + 3;
    let origin_end = base[after..].find('/').map(|i| after + i).unwrap_or(base.len());
    let origin = &base[..origin_end];
    if target.starts_with('/') {
        format!("{origin}{target}")
    } else {
        format!("{origin}/{target}")
    }
}

fn parse_tool_list(result: &Value) -> Vec<McpToolDef> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(McpToolDef {
                        name: t.get("name")?.as_str()?.to_string(),
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input_schema: t
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 聚合 server
// ---------------------------------------------------------------------------

/// 已连接的下游插件（握手完成）。
struct LivePlugin {
    plugin_id: String,
    transport: Box<dyn PluginTransport>,
    /// 子 server 的原始工具清单（未命名空间化）。
    tools: Vec<McpToolDef>,
}

/// 已装载的插件连接：Live = 已握手；Failed = 连接/握手失败（错误以
/// `<plugin>__error` 占位工具暴露，不拖垮整个 server）。
/// v0.9.4 需求9 A1：Failed 记录最近一次尝试时刻——冷却期内 refresh 跳过
/// 重试（稳态 tools/list 不被慢后端反复拖住），过期后重新 spawn。
enum PluginChild {
    Live(LivePlugin),
    Failed {
        plugin_id: String,
        error: String,
        last_attempt: std::time::Instant,
    },
}

impl PluginChild {
    fn plugin_id(&self) -> &str {
        match self {
            PluginChild::Live(c) => &c.plugin_id,
            PluginChild::Failed { plugin_id, .. } => plugin_id,
        }
    }
}

/// 按声明建立分传输连接并握手。
fn spawn_transport(decl: &McpPluginDecl) -> Result<LivePlugin, String> {
    let (plugin_id, mut transport): (String, Box<dyn PluginTransport>) = match decl {
        McpPluginDecl::Stdio { .. } => (
            decl.plugin_id().to_string(),
            Box::new(StdioChild::spawn(decl)?),
        ),
        McpPluginDecl::Http { .. } => (
            decl.plugin_id().to_string(),
            Box::new(HttpStreamableClient::spawn(decl)?),
        ),
        McpPluginDecl::Sse { .. } => (
            decl.plugin_id().to_string(),
            Box::new(SseClient::spawn(decl)?),
        ),
    };
    let tools = transport.handshake()?;
    Ok(LivePlugin {
        plugin_id,
        transport,
        tools,
    })
}

/// v0.9.4 需求9 A1：并行 spawn + 单后端截止。每个后端一**独立线程**
/// `spawn_transport`（含握手），结果经 mpsc 回收；主线程等待至
/// `deadline`，到点未归位的记超时 Err 并放弃等待（detached 线程不阻塞
/// 返回——晚归线程 send 失败后连接随 drop 关闭：stdio 关 stdin 子进程
/// 自然退出。不 join 逃逸线程，避免为 kill 而共享可变状态）。返回按
/// plugin_id 归位，顺序与完成序元关。
fn spawn_transports_parallel(
    decls: &[McpPluginDecl],
    deadline: Duration,
) -> Vec<(String, Result<LivePlugin, String>)> {
    if decls.is_empty() {
        return Vec::new();
    }
    let (tx, rx) = std::sync::mpsc::channel::<(String, Result<LivePlugin, String>)>();
    for decl in decls {
        let tx = tx.clone();
        let decl = decl.clone();
        std::thread::spawn(move || {
            let plugin_id = decl.plugin_id().to_string();
            let _ = tx.send((plugin_id, spawn_transport(&decl)));
        });
    }
    drop(tx);
    let expires = std::time::Instant::now() + deadline;
    let mut out: Vec<(String, Result<LivePlugin, String>)> = Vec::new();
    let mut pending: Vec<&McpPluginDecl> = decls.iter().collect();
    while !pending.is_empty() {
        let remaining = expires.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((plugin_id, outcome)) => {
                pending.retain(|d| d.plugin_id() != plugin_id);
                out.push((plugin_id, outcome));
            }
            Err(_) => {
                // 到点（或通道意外关闭）：所有未归位后端记超时。
                for decl in pending.drain(..) {
                    out.push((
                        decl.plugin_id().to_string(),
                        Err(format!(
                            "连接超时（>{}s，含握手）",
                            deadline.as_secs()
                        )),
                    ));
                }
            }
        }
    }
    out
}

pub struct McpServer {
    children: Vec<PluginChild>,
    /// 插件声明数据源（生产 = load_mcp_plugin_decls；测试可注入）。
    decl_source: Box<dyn Fn() -> Vec<McpPluginDecl> + Send>,
}

impl McpServer {
    pub fn new() -> McpServer {
        McpServer {
            children: Vec::new(),
            decl_source: Box::new(load_mcp_plugin_decls),
        }
    }

    fn with_decl_source(source: Box<dyn Fn() -> Vec<McpPluginDecl> + Send>) -> McpServer {
        McpServer {
            children: Vec::new(),
            decl_source: source,
        }
    }

    /// 按当前插件声明同步下游连接集（lazy 建立新插件、回收禁用/失联插件），
    /// 返回聚合工具清单（内置 + 命名空间化插件工具）。单插件失败不拖垮
    /// 整个 server：失败原因以 `<plugin>__error` 占位工具暴露给客户端。
    ///
    /// v0.9.4 需求9 A1：新增后端的 spawn+handshake **并行化**（scoped
    /// threads），单后端整体截止 `SPAWN_DEADLINE`——串行时代一个 npx 冷
    /// 启动即可拖住 tools/list 数分钟；并行 + 截止后，含慢/挂后端的
    /// 响应时间上界 = 截止时长。到点未回的记 Failed，late 线程的连接随
    /// drop 关闭（stdio kill 子进程）。Failed 冷却见 `FAILED_RETRY_COOLDOWN`。
    fn refresh_and_list(&mut self) -> Vec<McpToolDef> {
        let decls = (self.decl_source)();
        // 回收声明已消失的连接（stdio kill 子进程；http/sse 随 drop 关闭）。
        self.children.retain_mut(|c| {
            let alive = decls.iter().any(|d| d.plugin_id() == c.plugin_id());
            if !alive {
                if let PluginChild::Live(live) = c {
                    live.transport.kill();
                }
            }
            alive
        });
        // 需要新建的后端（不存在，或 Failed 已过冷却期）。
        let now = std::time::Instant::now();
        let to_spawn: Vec<McpPluginDecl> = decls
            .iter()
            .filter(|decl| {
                match self
                    .children
                    .iter()
                    .find(|c| c.plugin_id() == decl.plugin_id())
                {
                    None => true,
                    Some(PluginChild::Live(_)) => false,
                    Some(PluginChild::Failed { last_attempt, .. }) => {
                        now.duration_since(*last_attempt) >= FAILED_RETRY_COOLDOWN
                    }
                }
            })
            .cloned()
            .collect();
        if !to_spawn.is_empty() {
            let results = spawn_transports_parallel(&to_spawn, SPAWN_DEADLINE);
            for (plugin_id, outcome) in results {
                match outcome {
                    Ok(live) => {
                        // 冷却重试成功：替换旧 Failed 条目（若有）。
                        self.children
                            .retain(|c| c.plugin_id() != plugin_id);
                        self.children.push(PluginChild::Live(live));
                    }
                    Err(error) => {
                        log::warn!("[hub-mcp] {error}");
                        self.children
                            .retain(|c| c.plugin_id() != plugin_id);
                        self.children.push(PluginChild::Failed {
                            plugin_id,
                            error,
                            last_attempt: std::time::Instant::now(),
                        });
                    }
                }
            }
        }
        let mut tools = builtin_tool_defs();
        for c in &self.children {
            match c {
                PluginChild::Failed { plugin_id, error, .. } => {
                    tools.push(McpToolDef {
                        name: namespaced_tool_name(plugin_id, "error"),
                        description: format!("插件 MCP server 不可用：{error}"),
                        input_schema: json!({ "type": "object" }),
                    });
                }
                PluginChild::Live(live) => {
                    for t in &live.tools {
                        tools.push(McpToolDef {
                            name: namespaced_tool_name(&live.plugin_id, &t.name),
                            description: t.description.clone(),
                            input_schema: t.input_schema.clone(),
                        });
                    }
                }
            }
        }
        tools
    }

    /// tools/call 分发：内置直调；命名空间工具路由到下游连接并转发结果。
    fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<Value, String> {
        // v0.9.4 需求9 P1：MCP 解析器动态发现入口——内置分支之前处理
        //（需读/写 children 状态，独立函数 call_builtin_tool 无状态不可用）。
        // pi 册子上的工具集在 spawn 时静态抄录，运行中启停的插件工具无法
        // 进入册子；两个入口工具永不过期，模型经它们「先查后调」，
        // 全程不依赖换进程（02 §二 P1）。
        match name {
            "hub_mcp_list" => {
                self.refresh_and_list();
                let plugins = self.plugin_catalog();
                let text = serde_json::to_string_pretty(&plugins)
                    .map_err(|e| e.to_string())?;
                return Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                }));
            }
            "hub_mcp_call" => {
                let tool = arguments
                    .get("tool")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "missing required argument: tool".to_string())?
                    .to_string();
                if tool == "hub_mcp_call" || tool == "hub_mcp_list" {
                    return Err(format!(
                        "hub_mcp_call 不允许嵌套调用解析器入口工具（got {tool}）；请直接调 {tool} 或先 hub_mcp_list 查看插件工具"
                    ));
                }
                let inner = arguments
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                // 复用既有路由：builtin 直调 / 插件工具转发（不存在或
                // Failed 时错误信息含原因，模型可据提示先 hub_mcp_list）。
                return self.call_tool(&tool, &inner);
            }
            _ => {}
        }
        if let Some((plugin_id, tool)) = split_namespaced(name) {
            let child = self
                .children
                .iter_mut()
                .find(|c| c.plugin_id() == plugin_id)
                .ok_or_else(|| format!("unknown plugin tool: {name}；可先调 hub_mcp_list 查看当前启用的插件与工具"))?;
            match child {
                PluginChild::Failed { error, .. } => return Err(error.clone()),
                PluginChild::Live(live) => {
                    let result = live.transport.request(
                        "tools/call",
                        json!({ "name": tool, "arguments": arguments }),
                    )?;
                    return Ok(result);
                }
            }
        }
        match call_builtin_tool(name, arguments) {
            Ok(text) => Ok(json!({
                "content": [{ "type": "text", "text": text }],
            })),
            Err(e) => Ok(json!({
                "content": [{ "type": "text", "text": e }],
                "isError": true,
            })),
        }
    }

    /// v0.9.4 需求9 P1：hub_mcp_list 的插件目录（不含 builtin 自身）。
    /// 与 refresh_and_list 的状态遍历同源（children 为唯一真源），
    /// Failed 插件如实暴露不可用原因——模型可据提示重试或等待冷却自愈。
    fn plugin_catalog(&self) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        for child in &self.children {
            match child {
                PluginChild::Failed { plugin_id, error, .. } => {
                    out.push(json!({
                        "plugin": plugin_id,
                        "status": "unavailable",
                        "error": error,
                        "tools": [],
                    }));
                }
                PluginChild::Live(live) => {
                    let tools: Vec<Value> = live
                        .tools
                        .iter()
                        .map(|t| {
                            json!({
                                "name": namespaced_tool_name(&live.plugin_id, &t.name),
                                "description": t.description,
                                "inputSchema": t.input_schema,
                            })
                        })
                        .collect();
                    out.push(json!({
                        "plugin": live.plugin_id,
                        "status": "connected",
                        "error": null,
                        "tools": tools,
                    }));
                }
            }
        }
        out
    }
}

/// 处理单条 JSON-RPC 请求，返回响应（通知返回 None）。纯度足够单测。
fn handle_request(server: &mut McpServer, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str)?;
    // 通知（无 id）无响应。
    let id = id?;
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "jishu-hub",
                "version": env!("CARGO_PKG_VERSION"),
            },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools: Vec<Value> = server
                .refresh_and_list()
                .into_iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "inputSchema": t.input_schema,
                    })
                })
                .collect();
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            server
                .call_tool(name, &arguments)
                .map_err(|e| (-32000, e))
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    })
}

/// serve 主循环（stdin 行读 → stdout 行写）。返回 Ok(()) 于 stdin EOF。
pub fn serve() -> Result<(), String> {
    let mut server = McpServer::new();
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("stdin read failed: {e}"))?;
        if n == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(resp) = handle_request(&mut server, &msg) {
            let mut serialized = serde_json::to_string(&resp)
                .map_err(|e| format!("serialize response failed: {e}"))?;
            serialized.push('\n');
            out.write_all(serialized.as_bytes())
                .and_then(|_| out.flush())
                .map_err(|e| format!("stdout write failed: {e}"))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_server() -> McpServer {
        McpServer::with_decl_source(Box::new(Vec::new))
    }

    fn request(server: &mut McpServer, method: &str, params: Value) -> Value {
        handle_request(
            server,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
        )
        .expect("request has id → response expected")
    }

    #[test]
    fn initialize_and_ping() {
        let mut s = empty_server();
        let resp = request(&mut s, "initialize", json!({}));
        assert_eq!(
            resp["result"]["serverInfo"]["name"],
            HUB_MCP_ENTRY_NAME
        );
        let resp = request(&mut s, "ping", json!({}));
        assert_eq!(resp["result"], json!({}));
    }

    #[test]
    fn tools_list_contains_builtins_without_plugins() {
        let mut s = empty_server();
        let resp = request(&mut s, "tools/list", json!({}));
        let tools = resp["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for builtin in builtin_tool_defs() {
            assert!(names.contains(&builtin.name.as_str()), "{}", builtin.name);
        }
    }

    #[test]
    fn unknown_method_returns_32601() {
        let mut s = empty_server();
        let resp = request(&mut s, "resources/list", json!({}));
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn notification_gets_no_response() {
        let mut s = empty_server();
        assert!(handle_request(
            &mut s,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
        )
        .is_none());
    }

    #[test]
    fn builtin_tool_call_success_and_is_error() {
        let mut s = empty_server();
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_projects_list", "arguments": {} }),
        );
        assert!(resp["result"]["content"][0]["text"].is_string());
        // 缺参会话参数 → 工具级 isError（非 JSON-RPC error）。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_usage_get", "arguments": {} }),
        );
        assert_eq!(resp["result"]["isError"], true);
        // 未知工具名 → JSON-RPC error（-32000）。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "x__y", "arguments": {} }),
        );
        assert_eq!(resp["error"]["code"], -32000);
    }

    #[test]
    fn namespace_roundtrip() {
        assert_eq!(
            split_namespaced(&namespaced_tool_name("gh-cli", "repo.view")),
            Some(("gh-cli".to_string(), "repo.view".to_string()))
        );
        assert!(split_namespaced("no-sep").is_none());
        assert!(split_namespaced("__lead").is_none());
    }

    #[test]
    fn failed_plugin_surfaces_error_tool() {
        // 声明一个不存在的命令：spawn 失败 → Failed 占位（__error 工具），
        // 内置工具不受影响。
        let mut s = McpServer::with_decl_source(Box::new(|| {
            vec![McpPluginDecl::Stdio {
                plugin_id: "broken".into(),
                command: "definitely-not-a-command-xyz".into(),
                args: vec![],
                env: vec![],
            }]
        }));
        let resp = request(&mut s, "tools/list", json!({}));
        let tools = resp["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"broken__error"));
        assert!(names.contains(&"hub_projects_list"));
    }

    #[test]
    fn decl_from_section_maps_three_transports() {
        use crate::agent::manifest::schema::{McpSection, McpTransportKind};
        // 缺省 stdio（command 必填由 schema 校验兜底，映射层只搬运）。
        let mut sec = McpSection {
            transport: McpTransportKind::Stdio,
            command: Some("npx".into()),
            args: Some(vec!["-y".into(), "pkg".into()]),
            env: Some([("K".to_string(), "v".to_string())].into_iter().collect()),
            url: None,
            headers: None,
        };
        match decl_from_section("p1", &sec) {
            McpPluginDecl::Stdio { plugin_id, command, args, env } => {
                assert_eq!(plugin_id, "p1");
                assert_eq!(command, "npx");
                assert_eq!(args, vec!["-y".to_string(), "pkg".to_string()]);
                assert_eq!(env, vec![("K".to_string(), "v".to_string())]);
            }
            other => panic!("expected Stdio, got {other:?}"),
        }
        sec.transport = McpTransportKind::Http;
        sec.url = Some("https://x/mcp".into());
        sec.headers = Some([("Authorization".to_string(), "Bearer t".to_string())].into_iter().collect());
        match decl_from_section("p2", &sec) {
            McpPluginDecl::Http { plugin_id, url, headers } => {
                assert_eq!(plugin_id, "p2");
                assert_eq!(url, "https://x/mcp");
                assert_eq!(headers, vec![("Authorization".to_string(), "Bearer t".to_string())]);
            }
            other => panic!("expected Http, got {other:?}"),
        }
        sec.transport = McpTransportKind::Sse;
        match decl_from_section("p3", &sec) {
            McpPluginDecl::Sse { .. } => {}
            other => panic!("expected Sse, got {other:?}"),
        }
    }

    #[test]
    fn join_url_resolves_relative_endpoints() {
        assert_eq!(join_url("https://h.io/base/sse", "/messages?sid=1"), "https://h.io/messages?sid=1");
        assert_eq!(join_url("https://h.io/base/sse", "messages?sid=1"), "https://h.io/messages?sid=1");
        assert_eq!(join_url("https://h.io:8080/sse", "/m"), "https://h.io:8080/m");
        // origin 无路径（base 以 host 结尾）。
        assert_eq!(join_url("https://h.io", "/m"), "https://h.io/m");
        // 绝对地址原样。
        assert_eq!(join_url("https://h.io/sse", "http://other:9/x"), "http://other:9/x");
        // base 异常（无 scheme）→ 原样返回，交由后续请求报错。
        assert_eq!(join_url("not-a-url", "/m"), "/m");
    }

    #[test]
    fn sse_frame_acc_parses_events() {
        let mut acc = SseFrameAcc::new();
        assert!(acc.feed("event: endpoint").is_none());
        assert!(acc.feed("data: /messages?sessionId=42").is_none());
        let (event, data) = acc.feed("").expect("frame ends on blank line");
        assert_eq!(event, "endpoint");
        assert_eq!(data, "/messages?sessionId=42");
        // data 多行拼接；event 缺省为空（ping/普通消息）。
        assert!(acc.feed("data: {\"id\":1}").is_none());
        assert!(acc.feed("data: tail").is_none());
        let (event, data) = acc.feed("").expect("frame");
        assert_eq!(event, "");
        assert_eq!(data, "{\"id\":1}\ntail");
        // 注释行与 id:/retry: 忽略。
        assert!(acc.feed(": keepalive").is_none());
        assert!(acc.feed("id: 7").is_none());
        assert!(acc.feed("data: x").is_none());
        let (_, data) = acc.feed("").expect("frame");
        assert_eq!(data, "x");
        // 连续空行不产出空帧。
        assert!(acc.feed("").is_none());
    }

    #[test]
    fn message_result_maps_error_field() {
        assert_eq!(message_result(&json!({"result": {"ok": 1}}), "p"), Ok(json!({"ok": 1})));
        assert!(message_result(&json!({"error": {"message": "boom"}}), "p")
            .unwrap_err()
            .contains("boom"));
        assert_eq!(message_result(&json!({}), "p"), Ok(Value::Null));
    }

    /// v0.9.4 需求9 A1：无响应后端被截止为 Failed 占位，且不拖垮内置工具；
    /// 冷却期内 refresh 不重试（第二次 tools/list 不再等待后端）。
    /// 慢后端 = 一个 spawn 后不产出任何 stdout 的子进程（握手 read 阻塞）。
    #[test]
    fn unresponsive_backend_times_out_and_cooldown_skips_retry() {
        let slow_decl = McpPluginDecl::Stdio {
            plugin_id: "slow".into(),
            // Windows: waitfor 定时等待且无 stdout（ping 会持续输出行、
            // timeout 会倒计时输出，都无法阻塞握手 read）；Unix: sleep。
            command: if cfg!(windows) { "waitfor".into() } else { "sleep".into() },
            args: if cfg!(windows) {
                vec!["/t".into(), "30".into(), "jishuTest".into()]
            } else {
                vec!["30".into()]
            },
            env: vec![],
        };
        let mut s = McpServer::with_decl_source(Box::new(move || vec![slow_decl.clone()]));
        let t0 = std::time::Instant::now();
        let resp = request(&mut s, "tools/list", json!({}));
        let elapsed = t0.elapsed();
        assert!(
            elapsed < SPAWN_DEADLINE + Duration::from_secs(2),
            "tools/list 应在截止+余量内返回，实际 {elapsed:?}"
        );
        let tools = resp["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(
            names.contains(&"slow__error"),
            "无响应后端应以 __error 占位暴露: {names:?}"
        );
        assert!(names.contains(&"hub_projects_list"), "内置工具不受影响");

        // 第二次（冷却期内）：不再 spawn——立即返回，且占位仍在。
        let t1 = std::time::Instant::now();
        let resp2 = request(&mut s, "tools/list", json!({}));
        let elapsed2 = t1.elapsed();
        assert!(
            elapsed2 < Duration::from_secs(1),
            "冷却期内 refresh 不应重试慢后端，实际耗时 {elapsed2:?}"
        );
        let names2: Vec<&str> = resp2["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names2.contains(&"slow__error"));
    }

    /// v0.9.4 需求9 P1：hub_mcp_list 动态发现——无插件空数组；Failed 插件
    /// 如实暴露不可用状态与原因；hub_mcp_call 路由 builtin、拒绝嵌套、
    /// 未知插件错误含 hub_mcp_list 提示。
    #[test]
    fn mcp_resolver_discovery_tools() {
        // 无插件：hub_mcp_list 返回空数组（builtin 不进目录）。
        let mut s = empty_server();
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_list", "arguments": {} }),
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let catalog: Vec<serde_json::Value> = serde_json::from_str(text).unwrap();
        assert!(catalog.is_empty(), "无插件时应为空数组: {text}");

        // hub_mcp_call 路由 builtin：合法（复用既有分发）。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_call", "arguments": { "tool": "hub_projects_list" } }),
        );
        assert_eq!(resp["result"]["isError"], serde_json::Value::Null, "builtin 路由应成功");

        // hub_mcp_call 拒绝嵌套解析器入口。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_call", "arguments": { "tool": "hub_mcp_call" } }),
        );
        assert_eq!(resp["error"]["code"], -32000, "嵌套应拒绝");
        assert!(
            resp["error"]["message"].as_str().unwrap().contains("嵌套"),
            "错误信息应说明嵌套: {}",
            resp["error"]["message"]
        );

        // Failed 插件：目录如实暴露 unavailable + 原因。
        let mut s = McpServer::with_decl_source(Box::new(|| {
            vec![McpPluginDecl::Stdio {
                plugin_id: "broken".into(),
                command: "definitely-not-a-command-xyz".into(),
                args: vec![],
                env: vec![],
            }]
        }));
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_list", "arguments": {} }),
        );
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let catalog: Vec<serde_json::Value> = serde_json::from_str(text).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0]["plugin"], "broken");
        assert_eq!(catalog[0]["status"], "unavailable");
        assert!(!catalog[0]["error"].as_str().unwrap().is_empty(), "失败原因应非空");

        // hub_mcp_call 调 Failed 插件工具：错误含原因。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_call", "arguments": { "tool": "broken__anything" } }),
        );
        assert_eq!(resp["error"]["code"], -32000);

        // 未知插件：错误信息含 hub_mcp_list 提示。
        let resp = request(
            &mut s,
            "tools/call",
            json!({ "name": "hub_mcp_call", "arguments": { "tool": "nosuch__tool" } }),
        );
        let msg = resp["error"]["message"].as_str().unwrap();
        assert!(msg.contains("hub_mcp_list"), "未知插件错误应提示先查目录: {msg}");
    }
}
