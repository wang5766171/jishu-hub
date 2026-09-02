//! Hub MCP 聚合 server（v0.9.0 需求1 P2，方案 b——用户裁决主案）。
//!
//! `jishu-cli mcp serve` 启动本模块：一个 stdio MCP server（换行分隔
//! JSON-RPC 2.0），聚合两层工具——
//! ①hub 内置工具（projects/models/usage/memory 数据面直读，无 Tauri 依赖）；
//! ②启用的 [mcp] 声明插件（外部 MCP stdio server，lazy spawn + 转发，
//!   工具名以 `<plugin_id>__<tool>` 命名空间隔离）。
//! 四家智能体只需配置一条 `jishu-hub` 条目（见 mcp_inject.rs），插件启停
//! 经每次 tools/list 重读清单动态生效（条目常驻）。
//!
//! 协议面（MVP 最小实现）：initialize / notifications/initialized /
//! tools/list / tools/call / ping；未知方法回 -32601。
//! 已知限制（02 §五）：子进程读写为阻塞式（单插件挂起会阻塞当次调用）；
//! resources/prompts 面与 tools/list_changed 通知留后续。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use crate::agent::tool_plugin;

pub const HUB_MCP_ENTRY_NAME: &str = "jishu-hub";
const PROTOCOL_VERSION: &str = "2024-11-05";

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

#[derive(Debug, Clone)]
pub struct McpPluginDecl {
    pub plugin_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// 生产数据源：启用的 [mcp] 声明工具插件（读取 plugins.json disabled 集）。
pub fn load_mcp_plugin_decls() -> Vec<McpPluginDecl> {
    let disabled = crate::agent::plugin::load_plugin_config().disabled.into_iter().collect();
    tool_plugin::load_tool_plugins(&disabled)
        .into_iter()
        .filter(|p| p.enabled)
        .filter_map(|p| {
            let mcp = p.file.mcp.as_ref()?;
            Some(McpPluginDecl {
                plugin_id: p.id().to_string(),
                command: mcp.command.clone(),
                args: mcp.args.clone().unwrap_or_default(),
                env: mcp
                    .env
                    .clone()
                    .map(|m| m.into_iter().collect::<Vec<_>>())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 子进程 MCP 客户端
// ---------------------------------------------------------------------------

struct ChildClient {
    plugin_id: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    /// 子 server 的原始工具清单（未命名空间化）。
    tools: Vec<McpToolDef>,
}

impl ChildClient {
    fn spawn(decl: &McpPluginDecl) -> Result<ChildClient, String> {
        // Windows：npm/npx 等需 cmd /C 包装（与 install_mcp_standalone 的
        // shell_command 同纪律；本模块为同步 std 进程，就地等价实现）。
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = Command::new("cmd");
            let mut full_args = vec!["/C".to_string(), decl.command.clone()];
            full_args.extend(decl.args.iter().cloned());
            c.args(&full_args);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = Command::new(&decl.command);
            c.args(&decl.args);
            c
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in &decl.env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn mcp plugin `{}` failed: {e}", decl.plugin_id))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("plugin `{}` stdin unavailable", decl.plugin_id))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("plugin `{}` stdout unavailable", decl.plugin_id))?;
        Ok(ChildClient {
            plugin_id: decl.plugin_id.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            tools: Vec::new(),
        })
    }

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
            if let Some(err) = v.get("error") {
                return Err(format!(
                    "plugin `{}` error: {}",
                    self.plugin_id,
                    err.get("message").and_then(Value::as_str).unwrap_or("?")
                ));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        self.stdin
            .write_all(format!("{}\n", msg).as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("write to plugin `{}` failed: {e}", self.plugin_id))
    }

    /// initialize 握手 + 工具清单。
    fn handshake(&mut self) -> Result<(), String> {
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
        self.tools = parse_tool_list(&result);
        Ok(())
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

/// 已装载的插件子连接：Live = 已握手；Failed = spawn/握手失败（错误以
/// `<plugin>__error` 占位工具暴露，不拖垮整个 server）。
enum PluginChild {
    Live(ChildClient),
    Failed {
        plugin_id: String,
        error: String,
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

    /// 按当前插件声明同步子进程集（lazy spawn 新插件、回收禁用/失联插件），
    /// 返回聚合工具清单（内置 + 命名空间化插件工具）。单插件失败不拖垮
    /// 整个 server：失败原因以 `<plugin>__error` 占位工具暴露给客户端。
    fn refresh_and_list(&mut self) -> Vec<McpToolDef> {
        let decls = (self.decl_source)();
        // 回收声明已消失的子进程。
        self.children.retain_mut(|c| {
            let alive = decls.iter().any(|d| d.plugin_id == c.plugin_id());
            if !alive {
                if let PluginChild::Live(live) = c {
                    let _ = live.child.kill();
                }
            }
            alive
        });
        for decl in &decls {
            if self
                .children
                .iter()
                .any(|c| c.plugin_id() == decl.plugin_id)
            {
                continue;
            }
            match ChildClient::spawn(decl).and_then(|mut c| {
                c.handshake()?;
                Ok(c)
            }) {
                Ok(c) => self.children.push(PluginChild::Live(c)),
                Err(e) => {
                    log::warn!("[hub-mcp] {e}");
                    self.children.push(PluginChild::Failed {
                        plugin_id: decl.plugin_id.clone(),
                        error: e,
                    });
                }
            }
        }
        let mut tools = builtin_tool_defs();
        for c in &self.children {
            match c {
                PluginChild::Failed { plugin_id, error } => {
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

    /// tools/call 分发：内置直调；命名空间工具路由到子进程并转发结果。
    fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<Value, String> {
        if let Some((plugin_id, tool)) = split_namespaced(name) {
            let child = self
                .children
                .iter_mut()
                .find(|c| c.plugin_id() == plugin_id)
                .ok_or_else(|| format!("unknown plugin tool: {name}"))?;
            match child {
                PluginChild::Failed { error, .. } => return Err(error.clone()),
                PluginChild::Live(live) => {
                    let result = live.request(
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
            vec![McpPluginDecl {
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
}
