/**
 * v0.9.7 需求6 F2：react-markdown urlTransform 扩展——放行自有产物引用协议
 * `jishu-artifact://<项目相对路径>`（默认 defaultUrlTransform 会清空非白名单
 * scheme）；其余 URL 走默认安全转换。只接助手消息两处（Q14：message-view
 * 回放 + streaming-message 流式）。
 */
import { defaultUrlTransform } from "react-markdown";

export const ARTIFACT_SCHEME = "jishu-artifact://";

export const jishuUrlTransform = (url: string): string =>
  url.startsWith(ARTIFACT_SCHEME) ? url : defaultUrlTransform(url);
