/**
 * v0.9.8 需求22（评审修复轮 R2 / 契约 C4）：「不询问」开关按会话读写。
 *
 * 用户裁决：「需要修复，不询问只影响当前会话」。开关记在任务实例上（后端
 * `task_get_no_ask` / `task_set_no_ask`，都带会话 id），对该任务的主会话与
 * 节点会话生效；此前是全局配置里的一个布尔值——任何地方打开，所有会话同时
 * 生效，普通会话里看不到也关不掉。
 *
 * 前端这面：
 *  - 读：跟着**选中的会话**读；会话变了、该会话所属的任务上下文变了都重读；
 *  - 写：按会话写，先乐观更新，回执到达时**仍是这个会话被选中**才校正或回滚
 *    ——切走之后晚到的回执不写进另一个会话的显示。
 *  - 读与写共用一个请求序号，谁后发起谁作数（二轮评审 R3 P2-2）：刚切到一个会话、读
 *    还没回来就点了开关，写回执（新值）先到、旧读回执（写之前的值）后到——旧读作废，
 *    界面不会闪回旧值。
 *  - 读、写都带上项目根（二轮评审 R3 P2-5）：后端拿到项目根就直接查任务库，省掉
 *    「按会话号扫会话目录定位项目」那条慢路径。
 *  - 还没有会话的时候（新任务页、还没发第一条消息，二轮评审 R3 P1-1）：开关此刻
 *    无处可记——任务实例还不存在。先记在本地（`pendingNoAsk`），随首条消息的任务
 *    意图带给后端，由它在建实例时置上；一旦有了会话，开关以会话的值为准。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";

export interface UseTaskNoAsk {
  /** 开关的显示值：选中了会话 = 该会话的值；还没有会话 = 发消息之前点下的意图。 */
  taskNoAsk: boolean;
  handleTaskNoAskChange: (enabled: boolean) => void;
  /** 发消息之前（还没有会话）点下的「不询问」——随任务模式首条消息的任务意图
   * 带给后端。有了会话即作废（恒为 false）。 */
  pendingNoAsk: boolean;
}

/** 任务意图里的「不询问」（二轮评审 R3 / P1-1）：发第一条之前、还没有会话时点下的
 * 那一下，随任务模式首条消息带给后端，由它在建实例时置上。只对新任务有意义——
 * 已有任务的开关在实例上、由这里按会话读写，意图里不带（页面此刻没有待办意图，
 * 带过去就是 false，会把用户开的开关冲掉）。 */
export function taskLaunchNoAsk(
  taskId: string | null,
  pendingNoAsk: boolean,
): boolean | undefined {
  return taskId ? undefined : pendingNoAsk;
}

export function useTaskNoAsk(
  /** 选中的会话；新对话 / 未选中为 null。 */
  sessionId: string | null,
  /** 该会话所属任务上下文的标识（任务实例 id）——变化即重读。 */
  taskInstanceId: string | null,
  /** 会话所在项目的路径（知道就带，后端省一次会话目录扫描）。 */
  projectRoot: string | null = null,
): UseTaskNoAsk {
  const [taskNoAsk, setTaskNoAsk] = useState(false);
  const [pendingNoAsk, setPendingNoAsk] = useState(false);
  // 回执到达时「此刻选中的会话」——不是发起时的那个。
  const selectedRef = useRef(sessionId);
  selectedRef.current = sessionId;
  // 最近一次请求（读或写）的序号：回执到达时它已不是最新，说明之后又发起过请求，这次的不作数
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setTaskNoAsk(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    // 回执只在这个会话仍被选中、且之后没有别的请求时才写状态
    const current = () => seq === requestSeqRef.current && selectedRef.current === sessionId;
    invokeCommand<boolean>("task_get_no_ask", { sessionId, ...(projectRoot ? { projectRoot } : {}) })
      .then((value) => {
        if (current()) setTaskNoAsk(Boolean(value));
      })
      .catch(() => {
        if (current()) setTaskNoAsk(false);
      });
    // taskInstanceId / projectRoot 是重读的触发条件，不在 effect 体内使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, taskInstanceId, projectRoot]);

  // 有了会话：发消息之前点下的意图随之作废——开关以会话的值为准。
  useEffect(() => {
    if (sessionId) setPendingNoAsk(false);
  }, [sessionId]);

  const handleTaskNoAskChange = useCallback(
    (enabled: boolean) => {
      const target = selectedRef.current;
      if (!target) {
        // 还没有会话：此刻无处可记，先记在本地，随首条消息带过去。
        setPendingNoAsk(enabled);
        return;
      }
      // 写一发出就作废之前所有的读回执
      const seq = ++requestSeqRef.current;
      const current = () => seq === requestSeqRef.current && selectedRef.current === target;
      setTaskNoAsk(enabled); // 乐观更新
      invokeCommand<boolean>("task_set_no_ask", {
        sessionId: target,
        enabled,
        ...(projectRoot ? { projectRoot } : {}),
      })
        .then((value) => {
          if (current()) setTaskNoAsk(Boolean(value));
        })
        .catch(() => {
          if (current()) setTaskNoAsk(!enabled);
        });
    },
    [projectRoot],
  );

  return {
    taskNoAsk: sessionId ? taskNoAsk : pendingNoAsk,
    handleTaskNoAskChange,
    pendingNoAsk: sessionId ? false : pendingNoAsk,
  };
}
