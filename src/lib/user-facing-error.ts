// 把后端的错误变成给用户看的文字。
//
// 后端有些错误以机器可读的前缀开头（`[interaction_stale]`、`[no_active_session]`——给程序分支
// 用，见 DEVELOP_READ §16.10「结构化错误前缀」），有些在结尾的括号里照抄了引擎的英文原话
//（原话是给日志看的）。界面上只留中间那句人话。
// 二轮评审 R3（域 4 P2-8 的前端部分）：交互卡提交失败时这些文字会直接显示在卡上。

/** 去掉开头的机器前缀；去掉结尾括号里没有中文的那段（英文原文 / 内部标识）。 */
export function userFacingError(error: unknown): string {
  const original = error instanceof Error ? error.message : String(error);
  let text = original.replace(/^\[[a-z0-9_]+\]\s*/i, "");
  // 结尾的括号段：全角或半角；里面不含中文才去掉——「（10 秒无响应）」这类说明要留着
  text = text.replace(/\s*[（(]([^（）()]*)[）)]\s*$/u, (whole, inner: string) =>
    /[\u4e00-\u9fff]/.test(inner) ? whole : "",
  );
  text = text.trim();
  // 洗完什么都没有（整条就是一个前缀）：原样给出，不显示一个空的报错
  return text || original;
}
