const fs = require("fs");
const p = "src-tauri/src/agent/tool_plugin.rs";
let s = fs.readFileSync(p, "utf8");
const CRLF = s.includes("\r\n");
const j = (t) => t.replace(/\n/g, CRLF ? "\r\n" : "\r\n");
const anchor = j("    #[test]\n    fn strip_is_idempotent_and_handles_crlf() {");
if (!s.includes(anchor)) { console.error("anchor miss"); process.exit(1); }
const t = j(`    /// v0.9.5 需求2：图片委派标记对剥离 + 旧前缀行兼容（2026-09-26 修复前
    /// 历史数据以「[图片处理] …」纯行前缀注入）。
    #[test]
    fn strips_image_dispatch_and_legacy_prefix() {
        let injected = "<jishu-image-dispatch>提示内容</jishu-image-dispatch>\\n\\n帮我看图";
        assert_eq!(strip_tool_block(injected), "帮我看图");
        let legacy = "[图片处理] 本条消息含图片提示长文\\n帮我看图";
        assert_eq!(strip_tool_block(legacy), "帮我看图");
        assert_eq!(strip_tool_block("普通消息"), "普通消息");
    }

`);
s = s.replace(anchor, t + anchor);
fs.writeFileSync(p, s);
console.log("test added");
