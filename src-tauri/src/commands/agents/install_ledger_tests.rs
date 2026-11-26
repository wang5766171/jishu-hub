//! `commands::agents` 的安装登记用例（v0.9.8 评审修复轮 R2）：冲突确认安装
//! 与直接安装走同一处登记、「已装来源」读不到要报错、来源台账 ref 的口径。
//!
//! 单独成文件是文件规模的原因（DEVELOP_READ §12：`agents.rs` 行数已在上沿，
//! 本轮新增用例放进来就越过 2500）。这里只有用例，不带生产代码；作为
//! `agents` 的子模块，可以直接用到父模块的私有函数。

use super::*;

/// v0.9.8 评审修复轮 R2：「已装来源」读不到不是「一个都没装」。读失败、
/// 文件不是合法 JSON → Err；文件在但没有 `packages` 键（或不是数组）→
/// 空清单。修前两种失败都返回空数组，前端拿到空会把「已装」判成「全
/// 未装」，照常推荐、照常安装。
#[test]
fn installed_sources_distinguish_unreadable_from_none_installed() {
    let unreadable = parse_registered_packages(Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "settings.json",
    )));
    let err = unreadable.expect_err("读不到配置文件必须报错，不能当成没装");
    assert!(err.contains("读取"), "{err}");

    let invalid = parse_registered_packages(Ok("{ not json".to_string()));
    let err = invalid.expect_err("配置文件不是合法 JSON 必须报错");
    assert!(err.contains("JSON"), "{err}");

    // 确实没装：文件在、没有 packages 键 / 不是数组 / 空数组。
    for content in ["{}", r#"{"packages": "x"}"#, r#"{"packages": []}"#] {
        assert_eq!(
            parse_registered_packages(Ok(content.to_string())).unwrap(),
            Vec::<String>::new(),
            "{content}"
        );
    }
    // 正常清单：非字符串项跳过。
    assert_eq!(
        parse_registered_packages(Ok(r#"{"packages": ["npm:a@1", 3, "git:x"]}"#.to_string()))
            .unwrap(),
        vec!["npm:a@1".to_string(), "git:x".to_string()]
    );
}

/// v0.9.8 评审修复轮 R2：冲突确认后的「停用并安装」装成了，与直接安装
/// 走同一处登记（来源台账 + 标签库）。修前确认流的成功出口不登记：用户
/// 在确认卡里选了「停用并安装」并且装成了的扩展，从来没进过标签库和来源
/// 台账。
#[test]
fn confirmed_install_records_to_the_same_ledger_as_direct_install() {
    let guard = crate::agent::manifest::env_test_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("JISHU_EQUIPMENT_DB", tmp.path().join("equipment.db"));
    agent::equipment_db::ensure_schema().unwrap();

    let meta = Some(agent::equipment_db::InstallMeta {
        via: "recommend-card".to_string(),
        title: Some("烟花".to_string()),
        tags: Some(vec!["演示".to_string()]),
    });
    // 直接安装的成功出口。
    record_pi_install("npm:pi-direct@1.0.0", &meta);
    // 冲突确认安装的成功出口（命令里的两条路径都汇到这一个函数）：
    // 无冲突直接成功 / 停用对手后成功（后者调用方没带 meta）。
    let no_conflict =
        confirmed_install_succeeded("npm:@scope/pi-confirmed@2.0.0", &meta, Vec::new());
    assert!(no_conflict.disabled.is_empty());
    let after_disable = confirmed_install_succeeded("npm:pi-confirmed-2@1.0.0", &None, Vec::new());
    assert!(after_disable.disabled.is_empty());

    let via_of = |r#ref: &str| -> Option<String> {
        agent::equipment_db::origins_list()
            .unwrap()
            .into_iter()
            .find(|row| row.r#ref == r#ref)
            .map(|row| row.via)
    };
    assert_eq!(
        via_of("pi:npm:pi-direct").as_deref(),
        Some("recommend-card")
    );
    assert_eq!(
        via_of("pi:npm:@scope/pi-confirmed").as_deref(),
        Some("recommend-card"),
        "确认安装要进来源台账，并带上安装链来源"
    );
    assert_eq!(
        via_of("pi:npm:pi-confirmed-2").as_deref(),
        Some("manual"),
        "调用方没带 meta 就按手动安装登记"
    );
    // 标签库：确认安装的件也在，带上了安装链的标题。
    let tags = agent::equipment_db::tags_list().unwrap();
    let direct = tags
        .iter()
        .find(|row| row.r#ref == "pi:npm:pi-direct")
        .expect("直接安装进标签库");
    assert_eq!(direct.title, "烟花");
    assert!(direct.installed_at.is_some());
    let confirmed = tags
        .iter()
        .find(|row| row.r#ref == "pi:npm:@scope/pi-confirmed")
        .expect("确认安装也要进标签库");
    assert_eq!(confirmed.title, "烟花");
    assert!(confirmed.installed_at.is_some());

    std::env::remove_var("JISHU_EQUIPMENT_DB");
    drop(guard);
}

/// 安装源 → 来源台账 ref：npm 源去版本（含 scoped），其它源原样。
#[test]
fn pi_install_ledger_ref_strips_version_and_keeps_scope() {
    assert_eq!(
        pi_install_ledger_ref("npm:pi-fireworks@0.1.2"),
        "pi:npm:pi-fireworks"
    );
    assert_eq!(
        pi_install_ledger_ref("npm:@juicesharp/rpiv-todo@2.11.0"),
        "pi:npm:@juicesharp/rpiv-todo"
    );
    // scoped 无版本：首 @ 是名字的一部分，不能当版本分隔。
    assert_eq!(
        pi_install_ledger_ref("npm:@juicesharp/rpiv-todo"),
        "pi:npm:@juicesharp/rpiv-todo"
    );
    assert_eq!(
        pi_install_ledger_ref("npm:pi-fireworks"),
        "pi:npm:pi-fireworks"
    );
    assert_eq!(
        pi_install_ledger_ref("git:github.com/owner/repo"),
        "pi:git:github.com/owner/repo"
    );
}
