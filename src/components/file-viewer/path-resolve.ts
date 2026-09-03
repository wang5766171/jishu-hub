/**
 * v0.8.0 需求4 补充修复：read 类工具的路径按各家协议可为相对路径（pi 的
 * read 工具 schema 即 "relative or absolute"，agent 内部对 cwd 自行归一），
 * Hub 工具卡片把原始路径原样传给预览面板，后端按进程 cwd 解析相对路径导致
 * 「系统找不到指定的文件 (os error 2)」（write/edit 的路径恰好是绝对路径，
 * 故只有 read 卡片打不开同一文件）。openViewer 时以当前项目根把相对路径
 * 解析为绝对路径。绝对路径（盘符 / UNC / POSIX 根）原样透传；无项目根时
 * 保持原样（维持既有行为，由后端报错兜底）。
 */
export function resolveViewerPath(
  path: string,
  projectPath: string | null | undefined,
): string {
  if (!path || !projectPath || isAbsolutePath(path)) return path;
  const rel = path.replace(/\\/g, "/");
  const base = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${rel}`;
}

function isAbsolutePath(p: string): boolean {
  // 盘符（C:\ / C:/）、UNC（\\server\share）、POSIX 根（/ 与 //）。
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}
