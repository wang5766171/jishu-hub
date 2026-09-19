// 回合花销（需求25 P3 验收件样例）：turns 源 × composer-trailing 挂载 ×
// @file: 混合代码组件。API v1 契约：无 import、无 JSX，元素经 h() 构造，
// 尾调 JishuPlugin.register(插件id, { version, component })。
//
// 口径说明：turns 源 payload（{kind:"turns", turns, activeIndex}）暂不含
// token 用量数据——当前以轮次口径代替（「¥ 第 N/M 轮」）；后续接入 usage
// 数据面后，改为真实花销口径「输入 X tok · 输出 Y tok」（见下方 TODO 处）。
JishuPlugin.register("session.turn-cost", {
  version: 1,
  component: function (api) {
    var h = api.h;
    var useMemo = api.useMemo;
    var cn = api.cn;

    return function TurnCostLabel(props) {
      var payload = (props && props.payload) || {};
      var options = (props && props.options) || {};

      // 币种配置（[[config]] select，插件详情配置面保存即热生效）：
      // CNY → ¥ 前缀 / USD → $ 前缀；未配置时回默认 CNY。
      var currencyPrefix = options.currency === "USD" ? "$" : "¥";

      var stats = useMemo(
        function () {
          if (payload.kind !== "turns") return null;
          var turns = Array.isArray(payload.turns) ? payload.turns : [];
          if (turns.length === 0) return null; // 空会话不占位
          var activeIndex =
            typeof payload.activeIndex === "number" && payload.activeIndex >= 0
              ? payload.activeIndex
              : turns.length - 1;
          return { current: activeIndex + 1, total: turns.length };
        },
        [payload]
      );

      if (!stats) return null;

      // TODO(usage 数据面)：turns 源接通 token 用量后切换为真实口径，形如：
      //   currencyPrefix + " 输入 " + inputTokens + " tok · 输出 " + outputTokens + " tok"
      var label = currencyPrefix + " 第 " + stats.current + "/" + stats.total + " 轮";

      return h(
        "span",
        {
          className: cn(
            "font-mono text-[9px] leading-none text-muted-foreground whitespace-nowrap select-none"
          ),
          title: "回合花销：当前为轮次口径（token 用量待 usage 数据面接入）",
        },
        label
      );
    };
  },
});
