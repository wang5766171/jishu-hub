const fs = require("fs");

// 1. tool_plugin.rs：修复字符常量（\r \n 被写成实际控制字符）
let p = "src-tauri/src/agent/tool_plugin.rs";
let s = fs.readFileSync(p, "utf8");
const bad = "result.push_str(after.trim_start_matches(['\r', '\n']));";
const good = "result.push_str(after.trim_start_matches(['\\r', '\\n']));";
// strip_image_dispatch_block 里的坏行（实际 CR 字符形态）
const re = /result\.push_str\(after\.trim_start_matches\(\['.?', '.?'\]\)\);/s;
if (s.includes(bad)) {
  s = s.split(bad).join(good);
} else {
  // 找含实际控制字符的行（image dispatch 块内）
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("trim_start_matches") && lines[i].includes("'") && /[\x00-\x1f]/.test(lines[i])) {
      lines[i] = "        result.push_str(after.trim_start_matches(['\\r', '\\n']));";
      console.log("fixed ctrl-char line", i + 1);
    }
  }
  s = lines.join("\n");
}
fs.writeFileSync(p, s);

// 2. chat.rs：提示改标记对包裹（避开 heredoc 转义——直接定位 format! 块）
p = "src-tauri/src/chat.rs";
s = fs.readFileSync(p, "utf8");
const anchor = '"[图片处理] 本条消息含图片';
const i = s.indexOf(anchor);
if (i === -1) { console.error("chat anchor miss"); process.exit(1); }
// 找该 format! 的完整字面量（从 "[图片处理] 到 "\n{}" 结束）
const litStart = s.lastIndexOf('"', i);
// 从 [图片处理] 开始向后找字面量结束（",\n        message 前的闭引号）
const tail = '",\\n{}",';
const litEnd = s.indexOf(tail, i);
if (litEnd === -1) { console.error("tail miss"); process.exit(1); }
const oldLit = s.slice(litStart, litEnd + tail.length);
const newLit = '"{}本条消息含图片，而你不支持图像输入——直接调用 dispatch_subagent 工具识别：images 参数取上方附件行「图片N（批次 …）」中的磁盘路径，省略 model（自动选择识图模型），task 写清要识别什么。不要自行读图、不要查询其他智能体。{}\\n{}",';
s = s.replace(oldLit, newLit);
// format! 参数补两个常量
const argAnchor = "        message\n    )";
const argIdx = s.indexOf(argAnchor, litEnd);
if (argIdx === -1) { console.error("arg anchor miss"); process.exit(1); }
s = s.replace(argAnchor, "        agent::tool_plugin::IMAGE_DISPATCH_OPEN,\n        agent::tool_plugin::IMAGE_DISPATCH_CLOSE,\n        message\n    )");
fs.writeFileSync(p, s);
console.log("chat.rs ok");
