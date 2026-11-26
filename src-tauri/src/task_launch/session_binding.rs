//! 任务会话登记的生命周期（v0.9.8 评审修复轮 R3 / P1-1）。
//!
//! 「本会话是任务会话」的事实来源是「用户以任务模式发了这条消息」这个意图。
//! 意图发生在发送入口，所以任务实例必须在首条 prompt 写给引擎**之前**就存
//! 在并挂在本会话上——引擎跑 before_agent_start 向 hub 查「是不是任务会话、
//! 开没开不询问」时才查得到。此前实例由前端在 session_resolved 分片到达后
//! 才建，与首条 prompt 之间是竞态：首轮经常答「不是任务会话」，任务隔离锚
//! 点、任务纪律、能力提示、不询问全部落空；实例还不存在，发第一条之前
//! 「不询问」开关也无处可记。
//!
//! 三个动作，对应一次发送的三个时刻：
//! 1. [`bind_task_session`]——拉起进程之前：按发送用的会话键（新会话是临时
//!    键）建实例，或把已有任务改绑到这个键上；新任务按意图置「不询问」开关。
//! 2. [`rebind_task_session`]——会话解析回调里（早于首条 prompt 写出）：把会
//!    话键换成引擎给的真实会话号。
//! 3. [`unbind_task_session`]——拉起失败、或新会话的进程没解析出会话号就退出了：
//!    撤销这一次登记（新建的删掉、改绑的还原），不留没有会话的任务。
//!
//! 一次发送里「什么时候改绑、什么时候撤销」由 [`TaskBindingSlot`] 管（有用例），
//! 发送入口只在「会话解析回调」「进程收尾回调」「这次发送没发出去」三处叫它。

use super::*;

/// 一次任务模式发送带上的意图（随 `send_message` 的 `taskLaunch` 传入）。
#[derive(Debug, Clone, Deserialize)]
pub struct TaskLaunchIntent {
    /// 接着哪个任务；空 = 新建任务。hub 里没有这个任务时也按新建处理（见
    /// [`bind_task_session`]）。
    pub task_id: Option<String>,
    pub skill_id: String,
    /// 不带命令前缀的纯目标——建实例时作为标题（规则同 [`mark_task_session`]：
    /// 用户改过名的不回写）。
    pub title: Option<String>,
    /// 发消息那一刻「不询问」开关的状态；只对这次新建的任务生效，None = 不动开关。
    pub no_ask: Option<bool>,
}

/// 一次登记的事实。撤销时要知道「是不是这次新建的、改绑前挂在哪个会话」。
#[derive(Debug, Clone)]
pub struct TaskSessionBinding {
    pub task_id: String,
    project_root: String,
    /// 这次登记新建了任务实例——撤销 = 删除。
    created: bool,
    /// 已有任务改绑前的会话键——撤销 = 还原；`None` = 它原来没有会话。
    previous_session_id: Option<String>,
}

fn plain_intent_error(detail: impl std::fmt::Display) -> String {
    format!("任务意图不完整（{detail}）")
}

/// 拉起进程之前：让 `session_key` 这个会话成为任务会话。返回（登记事实，
/// 此刻的实例）。此刻实例挂的是发送用的会话键；新会话的真实会话号要等引
/// 擎握手之后才有，由 [`rebind_task_session`] 换上。
pub fn bind_task_session(
    project_root: &str,
    intent: &TaskLaunchIntent,
    session_key: &str,
) -> Result<(TaskSessionBinding, TaskLaunchInstance), String> {
    let session_key = session_key.trim();
    if session_key.is_empty() {
        return Err(plain_intent_error("没有会话键"));
    }
    let project_root = normalize_project_root(project_root);
    let task_id = intent
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // hub 里有的任务：只把会话键改过来，别的字段不动。带了任务号但 hub 里没有
    // ——上一次拉起失败、登记已被撤销，页面手里还是旧号——按新任务登记，真实
    // 任务号随返回值交回页面。登记以 hub 为准：页面手里的号只是「接着哪个任务」
    // 的提示；这里若报错，页面拿着旧号重发就永远发不出去。
    let existing = match task_id.as_deref() {
        Some(task_id) => open_store_existing(&project_root)?
            .map(|store| store.get(task_id))
            .transpose()?
            .flatten(),
        None => None,
    };

    let (binding, instance) = match existing {
        Some(mut existing) => {
            let previous_session_id = existing.task_session_id.clone();
            if previous_session_id.as_deref() != Some(session_key) {
                open_store(&project_root)?
                    .set_session_id(existing.task_id.as_str(), Some(session_key))?;
                existing.task_session_id = Some(session_key.to_string());
            }
            let binding = TaskSessionBinding {
                task_id: existing.task_id.clone(),
                project_root: project_root.clone(),
                created: false,
                previous_session_id,
            };
            (binding, existing)
        }
        // 新任务：以发送用的会话键建实例。技能标识只有建实例时用得上。
        None => {
            let skill_id = intent.skill_id.trim();
            if skill_id.is_empty() {
                return Err(plain_intent_error("缺少技能标识"));
            }
            let instance = mark_task_session(
                &project_root,
                None,
                session_key,
                skill_id,
                intent.title.as_deref(),
            )?;
            (
                TaskSessionBinding {
                    task_id: instance.task_id.clone(),
                    project_root: project_root.clone(),
                    created: true,
                    previous_session_id: None,
                },
                instance,
            )
        }
    };

    // 开关：只动这次新建的任务，带了意图才动（新任务的开关就是发第一条之前
    // 用户点的那一下）。已有任务的开关在实例上、由页面按会话读写；意图里的
    // noAsk 对它没有意义——不动，免得把用户开的开关冲掉。
    let instance = match intent.no_ask {
        Some(enabled) if binding.created => {
            let store = open_store(&project_root)?;
            store.set_no_ask(&binding.task_id, enabled)?;
            store
                .get(&binding.task_id)?
                .ok_or_else(|| format!("任务不存在：{}", binding.task_id))?
        }
        _ => instance,
    };
    Ok((binding, instance))
}

/// 会话解析回调里（早于首条 prompt 写出）：把任务挂的会话键换成真实会话号。
/// 返回改绑后的实例。
pub fn rebind_task_session(
    binding: &TaskSessionBinding,
    real_session_id: &str,
) -> Result<TaskLaunchInstance, String> {
    let real_session_id = real_session_id.trim();
    if real_session_id.is_empty() {
        return Err("引擎没有给出会话号，任务无法关联到会话".to_string());
    }
    let store = open_store(&binding.project_root)?;
    store.set_session_id(&binding.task_id, Some(real_session_id))?;
    store
        .get(&binding.task_id)?
        .ok_or_else(|| format!("任务不存在：{}", binding.task_id))
}

/// 拉起失败、或新会话的进程没解析出会话号就退出了：撤销这一次登记。没有会
/// 话诞生，就不该留下任务。
pub fn unbind_task_session(binding: &TaskSessionBinding) -> Result<(), String> {
    if binding.created {
        delete_task(&binding.project_root, &binding.task_id)
    } else {
        open_store(&binding.project_root)?
            .set_session_id(&binding.task_id, binding.previous_session_id.as_deref())
    }
}

/// 一次发送期间，这次登记的去向。两处会来叫它，谁先到谁处理：
/// - 会话解析回调 [`Self::resolved`]：引擎给出了会话号——换了号就改绑，登记落定；
/// - 进程收尾回调 [`Self::finished`]：进程退出了登记还没落定——撤销。
///
/// `rollback_if_unresolved` 只对「发送键是临时键」的发送为真：那种会话还不存
/// 在，进程没解析出会话号就该把登记撤掉。发送键本来就是真实会话号（续接已有
/// 会话）时会话早已存在，没什么可撤的——进程退出时撤，会把任务删掉或把它
/// 的会话键改回去（进程被空闲回收是常事）。
#[derive(Debug, Default)]
pub struct TaskBindingSlot {
    binding: std::sync::Mutex<Option<TaskSessionBinding>>,
    rollback_if_unresolved: bool,
}

impl TaskBindingSlot {
    pub fn new(binding: Option<TaskSessionBinding>, rollback_if_unresolved: bool) -> Self {
        Self {
            binding: std::sync::Mutex::new(binding),
            rollback_if_unresolved,
        }
    }

    /// 会话解析回调。号没变——续接已有会话、或引擎没给出号时的占位回调——什么
    /// 都不做，登记留在原处；换了号就取走登记、改绑，返回改绑后的实例。
    pub fn resolved(
        &self,
        real_session_id: &str,
        bound_key: &str,
    ) -> Result<Option<TaskLaunchInstance>, String> {
        if real_session_id == bound_key {
            return Ok(None);
        }
        match self.take() {
            Some(binding) => rebind_task_session(&binding, real_session_id).map(Some),
            None => Ok(None),
        }
    }

    /// 进程收尾回调。返回「有没有动过登记」——调用方据此通知界面。
    pub fn finished(&self) -> Result<bool, String> {
        if !self.rollback_if_unresolved {
            return Ok(false);
        }
        self.abandon()
    }

    /// 这次发送没发出去、不往下走了：撤销登记。已有进程那条路发送失败、改走
    /// 重新拉起时会再登记一次——这里不撤，新任务就会建出两份。
    pub fn abandon(&self) -> Result<bool, String> {
        match self.take() {
            Some(binding) => unbind_task_session(&binding).map(|_| true),
            None => Ok(false),
        }
    }

    fn take(&self) -> Option<TaskSessionBinding> {
        self.binding
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jishu-task-binding-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn new_task_intent(no_ask: bool) -> TaskLaunchIntent {
        TaskLaunchIntent {
            task_id: None,
            skill_id: "jishu-task-runner".to_string(),
            title: Some("把登录页改成深色".to_string()),
            no_ask: Some(no_ask),
        }
    }

    fn existing_intent(task_id: &str, no_ask: Option<bool>) -> TaskLaunchIntent {
        TaskLaunchIntent {
            task_id: Some(task_id.to_string()),
            skill_id: "whatever".to_string(),
            title: Some("不该覆盖的标题".to_string()),
            no_ask,
        }
    }

    /// 评审修复轮 R3（P1-1）：登记先于首条 prompt——拉起之前，发送用的临时
    /// 会话键就已经是任务会话，引擎首轮来查就查得到；开关也已经在实例上。
    #[test]
    fn task_intent_binds_the_session_before_launch() {
        let project = temp_project("bind");
        let root = project.to_string_lossy().to_string();

        let (binding, instance) =
            bind_task_session(&root, &new_task_intent(true), "pending-first-message").unwrap();

        assert!(binding.created, "新任务：这次登记建的实例");
        assert_eq!(instance.task_id, binding.task_id);
        assert_eq!(instance.skill_id, "jishu-task-runner");
        assert_eq!(instance.title, "把登录页改成深色");
        assert!(instance.no_ask, "发第一条之前点的开关已经在实例上");
        // 首条 prompt 写出之前，按发送用的会话键查「是不是任务会话」就查得到。
        let found = query_task_instance(Some(&root), "pending-first-message")
            .unwrap()
            .expect("首条 prompt 写出之前登记就必须在");
        assert_eq!(found.task_id, binding.task_id);
        assert!(found.no_ask);
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 会话解析回调里把会话键换成真实会话号：任务号、开关、标题都不变。
    #[test]
    fn rebind_moves_the_task_to_the_real_session() {
        let project = temp_project("rebind");
        let root = project.to_string_lossy().to_string();
        let (binding, before) =
            bind_task_session(&root, &new_task_intent(true), "pending-first-message").unwrap();

        let after = rebind_task_session(&binding, "real-session-1").unwrap();

        assert_eq!(after.task_id, before.task_id, "改绑不换任务号");
        assert_eq!(after.title, before.title);
        assert!(after.no_ask, "改绑不动开关");
        assert_eq!(after.task_session_id.as_deref(), Some("real-session-1"));
        // 引擎拿着真实会话号来查——查得到；临时键查不到了。
        assert_eq!(
            query_task_instance(Some(&root), "real-session-1")
                .unwrap()
                .map(|it| it.task_id),
            Some(binding.task_id.clone())
        );
        assert!(
            query_task_instance(Some(&root), "pending-first-message")
                .unwrap()
                .is_none(),
            "临时键不再指向任何任务"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 已有任务换到新会话：不新建，只改会话键；不带开关意图就不动开关。
    #[test]
    fn existing_task_is_rebound_not_duplicated() {
        let project = temp_project("rebound");
        let root = project.to_string_lossy().to_string();
        let original = mark_task_session(
            &root,
            None,
            "old-session",
            "jishu-task-runner",
            Some("旧任务"),
        )
        .unwrap();
        open_store(&root)
            .unwrap()
            .set_no_ask(&original.task_id, true)
            .unwrap();

        let intent = existing_intent(&original.task_id, None);
        let (binding, instance) = bind_task_session(&root, &intent, "pending-next").unwrap();

        assert!(!binding.created, "已有任务：这次登记没有新建");
        assert_eq!(instance.task_id, original.task_id);
        assert_eq!(instance.title, "旧任务", "已有任务的标题、技能不被意图覆盖");
        assert_eq!(instance.skill_id, "jishu-task-runner");
        assert!(instance.no_ask, "没带开关意图就不动开关");
        assert_eq!(
            instance.task_session_id.as_deref(),
            Some("pending-next"),
            "交回的实例已经是新的会话键"
        );
        assert_eq!(
            get_task_instance(&root, &original.task_id)
                .unwrap()
                .unwrap()
                .task_session_id
                .as_deref(),
            Some("pending-next"),
            "库里的会话键也改到了新键上"
        );
        assert_eq!(
            list_task_instances(&root).unwrap().len(),
            1,
            "不多出一个任务"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 「不询问」意图只对新任务生效：已有任务上用户开的开关，不被随后带意图
    /// 的发送（页面此刻没有待办意图，带过来的是 false）冲掉。
    #[test]
    fn switch_intent_only_sets_a_new_task() {
        let project = temp_project("switch");
        let root = project.to_string_lossy().to_string();
        let original =
            mark_task_session(&root, None, "old-session", "jishu-task-runner", None).unwrap();
        open_store(&root)
            .unwrap()
            .set_no_ask(&original.task_id, true)
            .unwrap();

        let (_, instance) = bind_task_session(
            &root,
            &existing_intent(&original.task_id, Some(false)),
            "s-next",
        )
        .unwrap();
        assert!(instance.no_ask, "已有任务：意图里的开关不生效");

        let (_, fresh) = bind_task_session(&root, &new_task_intent(true), "pending-fresh").unwrap();
        assert!(fresh.no_ask, "新任务：发第一条之前点的开关生效");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 拉起失败 / 没解析出会话号：新建的任务删掉；已有任务的会话键还原；开关
    /// 不动（开关是用户的决定，不是这次拉起的产物）。
    #[test]
    fn failed_launch_rolls_back_the_binding() {
        let project = temp_project("rollback");
        let root = project.to_string_lossy().to_string();

        let (binding, _) =
            bind_task_session(&root, &new_task_intent(false), "pending-gone").unwrap();
        unbind_task_session(&binding).unwrap();
        assert!(
            list_task_instances(&root).unwrap().is_empty(),
            "会话没诞生，任务不该留下"
        );

        let original =
            mark_task_session(&root, None, "old-session", "jishu-task-runner", None).unwrap();
        open_store(&root)
            .unwrap()
            .set_no_ask(&original.task_id, true)
            .unwrap();
        let (binding, _) = bind_task_session(
            &root,
            &existing_intent(&original.task_id, None),
            "pending-gone",
        )
        .unwrap();
        unbind_task_session(&binding).unwrap();
        let restored = get_task_instance(&root, &original.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            restored.task_session_id.as_deref(),
            Some("old-session"),
            "改绑前的会话键还原"
        );
        assert!(restored.no_ask, "撤销不动开关");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 登记做不成就把错误交回去——调用方据此按发送失败处理，不带任务态硬发。
    /// 带了任务号但 hub 里没有这个任务（上一次拉起失败、登记已撤销）：按新任务
    /// 登记，真实任务号随实例交回——报错的话页面拿着旧号重发永远发不出去。
    #[test]
    fn binding_failure_is_reported() {
        let project = temp_project("bind-fail");
        let root = project.to_string_lossy().to_string();
        let ghost = TaskLaunchIntent {
            task_id: Some("task-nope".to_string()),
            skill_id: "jishu-task-runner".to_string(),
            title: Some("重发的目标".to_string()),
            no_ask: Some(false),
        };
        let (binding, instance) = bind_task_session(&root, &ghost, "pending-x").unwrap();
        assert!(binding.created, "hub 里没有的任务号：按新任务登记");
        assert_ne!(instance.task_id, "task-nope", "交回的是真实任务号");
        assert_eq!(instance.title, "重发的目标");
        assert_eq!(instance.task_session_id.as_deref(), Some("pending-x"));
        assert_eq!(list_task_instances(&root).unwrap().len(), 1);

        // 没有技能标识 / 没有会话键：同样报错。
        let no_skill = TaskLaunchIntent {
            task_id: None,
            skill_id: "  ".to_string(),
            title: None,
            no_ask: None,
        };
        assert!(bind_task_session(&root, &no_skill, "pending-x").is_err());
        assert!(bind_task_session(&root, &new_task_intent(false), "  ").is_err());
        assert_eq!(
            list_task_instances(&root).unwrap().len(),
            1,
            "失败的登记不留半截实例"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 发送键是临时键（新会话）：引擎给出真实会话号 → 改绑、登记落定；之后
    /// 进程退出不再撤销。失败路径的占位回调（号没变）不动登记。
    #[test]
    fn slot_settles_when_the_session_resolves() {
        let project = temp_project("slot-settle");
        let root = project.to_string_lossy().to_string();
        let (binding, _) = bind_task_session(&root, &new_task_intent(true), "pending-1").unwrap();
        let task_id = binding.task_id.clone();
        let slot = TaskBindingSlot::new(Some(binding), true);

        assert!(
            slot.resolved("pending-1", "pending-1").unwrap().is_none(),
            "号没变：登记留在原处，等收尾回调处置"
        );
        assert_eq!(
            get_task_instance(&root, &task_id)
                .unwrap()
                .unwrap()
                .task_session_id
                .as_deref(),
            Some("pending-1")
        );

        let after = slot
            .resolved("real-1", "pending-1")
            .unwrap()
            .expect("换了号：交回改绑后的实例");
        assert_eq!(after.task_id, task_id);
        assert_eq!(after.task_session_id.as_deref(), Some("real-1"));
        assert!(after.no_ask, "改绑不动开关");

        assert!(!slot.finished().unwrap(), "登记已落定：进程退出不撤销");
        assert_eq!(list_task_instances(&root).unwrap().len(), 1, "任务还在");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 发送键是临时键、进程始终没解析出会话号：收尾时撤销——新任务的删掉，
    /// 已有任务的会话键还原；再叫一次是空操作。
    #[test]
    fn slot_rolls_back_when_a_new_session_never_resolves() {
        let project = temp_project("slot-rollback");
        let root = project.to_string_lossy().to_string();

        let (binding, _) =
            bind_task_session(&root, &new_task_intent(false), "pending-gone").unwrap();
        let slot = TaskBindingSlot::new(Some(binding), true);
        assert!(slot
            .resolved("pending-gone", "pending-gone")
            .unwrap()
            .is_none());
        assert!(slot.finished().unwrap(), "动过登记");
        assert!(
            list_task_instances(&root).unwrap().is_empty(),
            "会话没诞生，任务不该留下"
        );
        assert!(!slot.finished().unwrap(), "只撤一次");

        let original =
            mark_task_session(&root, None, "old-session", "jishu-task-runner", None).unwrap();
        let (binding, _) = bind_task_session(
            &root,
            &existing_intent(&original.task_id, None),
            "pending-gone",
        )
        .unwrap();
        let slot = TaskBindingSlot::new(Some(binding), true);
        assert!(slot.finished().unwrap());
        assert_eq!(
            get_task_instance(&root, &original.task_id)
                .unwrap()
                .unwrap()
                .task_session_id
                .as_deref(),
            Some("old-session"),
            "改绑前的会话键还原"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 发送键是真实会话号（续接已有会话）：会话早就存在，进程退出时不撤销——
    /// 否则任务会在进程被空闲回收时被删掉。
    #[test]
    fn slot_never_rolls_back_an_existing_session() {
        let project = temp_project("slot-existing");
        let root = project.to_string_lossy().to_string();
        let (binding, _) =
            bind_task_session(&root, &new_task_intent(false), "real-session").unwrap();
        let task_id = binding.task_id.clone();
        let slot = TaskBindingSlot::new(Some(binding), false);

        assert!(
            slot.resolved("real-session", "real-session")
                .unwrap()
                .is_none(),
            "号没变：不动"
        );
        assert!(!slot.finished().unwrap(), "续接已有会话：进程退出不撤销");
        assert_eq!(
            get_task_instance(&root, &task_id)
                .unwrap()
                .expect("任务还在")
                .task_session_id
                .as_deref(),
            Some("real-session")
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 续接已有会话时引擎换了一个会话号（旧会话恢复不了）：任务跟着换到新的
    /// 号上。
    #[test]
    fn slot_follows_the_engine_when_it_switches_sessions() {
        let project = temp_project("slot-switch");
        let root = project.to_string_lossy().to_string();
        let (binding, _) = bind_task_session(&root, &new_task_intent(false), "real-old").unwrap();
        let task_id = binding.task_id.clone();
        let slot = TaskBindingSlot::new(Some(binding), false);

        let after = slot
            .resolved("real-new", "real-old")
            .unwrap()
            .expect("换了号：交回改绑后的实例");

        assert_eq!(after.task_id, task_id, "换号不换任务");
        assert_eq!(after.task_session_id.as_deref(), Some("real-new"));
        assert!(!slot.finished().unwrap());
        assert_eq!(list_task_instances(&root).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 已有进程那条路发送失败、改走重新拉起：先撤销上一次登记，重新拉起时再
    /// 登记一次——新任务不会建出两份。没有登记可撤时是空操作。
    #[test]
    fn abandoned_send_leaves_no_second_task() {
        let project = temp_project("slot-abandon");
        let root = project.to_string_lossy().to_string();
        let (first, _) = bind_task_session(&root, &new_task_intent(false), "real-session").unwrap();
        let first_id = first.task_id.clone();
        let slot = TaskBindingSlot::new(Some(first), false);

        assert!(slot.abandon().unwrap(), "这次发送没发出去：撤销登记");
        assert!(
            list_task_instances(&root).unwrap().is_empty(),
            "撤销后不留任务"
        );

        let (second, instance) =
            bind_task_session(&root, &new_task_intent(false), "real-session").unwrap();
        assert_ne!(
            second.task_id, first_id,
            "重新拉起时再登记一次（新的任务号）"
        );
        assert_eq!(
            list_task_instances(&root).unwrap().len(),
            1,
            "重新拉起后的登记只有一份"
        );
        assert_eq!(instance.task_session_id.as_deref(), Some("real-session"));
        assert!(!slot.abandon().unwrap(), "登记已经取走：空操作");
        let _ = std::fs::remove_dir_all(&project);
    }
}
