//! v0.9.8 需求5（合并版）：工作区场景分析——L0/L1 层的零推理场景信号。
//!
//! 产品语义（用户裁决 2026-11-22）：推荐要**按项目定位**——在代码目录
//! 就推编程件，在办公/文档目录就推办公件。工作区目录本身就是最强的
//! 场景信号，且本地扫一眼文件即可判定（零 token 零联网，天然属于
//! L0/L1 轻量层；此前只有「历史会话画像」（冷启动空）与「草稿关键词」
//! 两个信号，都拿不到项目上下文）。
//!
//! 判定口径：**顶层目录单次 read_dir**（廉价，<10ms），按文件名/目录名
//! 标记计分，分高者胜；无标记（如默认空间）返回 None——回落画像/草稿/
//! 官方入门。依据清单随结果返回（透明可解释）。

use std::path::Path;

/// 场景判定结果：scene（plugin-scenes id）+ 命中依据（用户可读）。
pub struct WorkspaceScene {
    pub scene: String,
    pub basis: Vec<String>,
}

/// 计分语义：工程清单（package.json 等）单见即定论 +2；散文件（代码/
/// 办公/视频/数据扩展名、.git/src 目录）各 +1——单个弱文件不定论，
/// 两个即成立（一个 pptx 可能只是顺手存的）。阈值 ≥2。
const CODE_MARKERS: &[&str] = &[
    "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod",
    "pom.xml", "build.gradle", "Makefile", "CMakeLists.txt", "composer.json",
    "gemfile", "deno.json", "bun.lockb", "tsconfig.json",
];
const CODE_EXTS: &[&str] = &["rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "cpp", "c", "rb", "php", "kt", "swift"];
const OFFICE_EXTS: &[&str] = &["docx", "xlsx", "pptx", "doc", "xls", "ppt"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "prproj", "fcpxml", "aep"];
const DATA_EXTS: &[&str] = &["csv", "ipynb", "sql", "parquet", "db", "sqlite"];
const CONTENT_EXTS: &[&str] = &["md", "txt", "doc"];

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 分析工作区场景（顶层扫描；无定论返回 None）。
pub fn detect_workspace_scene(dir: &Path) -> Option<WorkspaceScene> {
    let entries = std::fs::read_dir(dir).ok()?;
    // 下标常量（声明顺序即平分优先序：代码 > 视频 > 数据 > 办公 > 内容）。
    const SCENE: [&str; 5] = ["programming", "office", "video", "data", "content"];
    let mut scores: Vec<(u32, &str, Vec<String>)> = SCENE.map(|n| (0u32, n, Vec::new())).to_vec();
    let mut code_files = 0u32;
    let mut content_files = 0u32;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        // 编程：工程清单单见即定论（package.json 在，就是 JS 项目）；
        // 代码文件逐个累积（2 个即成立）；.git/src/target 组合计分。
        if CODE_MARKERS.contains(&lower.as_str()) {
            scores[0].0 += 2;
            scores[0].2.push(name.clone());
        }
        if !is_dir {
            let e = ext_of(&name);
            if CODE_EXTS.contains(&e.as_str()) {
                code_files += 1;
                scores[0].0 += 1;
                if code_files == 2 {
                    scores[0].2.push("代码文件 ×2+".into());
                }
            }
            if OFFICE_EXTS.contains(&e.as_str()) {
                scores[1].0 += 1;
                if scores[1].0 == 2 {
                    scores[1].2.push("办公文档 ×2+".into());
                }
            }
            if VIDEO_EXTS.contains(&e.as_str()) {
                scores[2].0 += 1;
                if scores[2].0 == 2 {
                    scores[2].2.push("视频文件 ×2+".into());
                }
            }
            if DATA_EXTS.contains(&e.as_str()) {
                scores[3].0 += 1;
                if scores[3].0 == 2 {
                    scores[3].2.push("数据文件 ×2+".into());
                }
            }
            if CONTENT_EXTS.contains(&e.as_str()) {
                content_files += 1;
                if content_files == 5 {
                    scores[4].0 += 2;
                    scores[4].2.push("文档/笔记 ×5+".into());
                }
            }
        } else {
            match lower.as_str() {
                ".git" | "src" | "target" => {
                    scores[0].0 += 1;
                    scores[0].2.push(format!("{name}/"));
                }
                "分镜" | "素材" => {
                    scores[2].0 += 2;
                    scores[2].2.push(format!("{name}/"));
                }
                "data" | "dataset" | "datasets" => {
                    scores[3].0 += 2;
                    scores[3].2.push(format!("{name}/"));
                }
                _ => {}
            }
        }
    }

    // 分高者胜（≥2 才成立）；平分按 programming > video > data > office > content
    // （声明顺序即优先序——代码目录里夹个 xlsx 很常见，反向则不然）。
    scores.sort_by(|a, b| b.0.cmp(&a.0));
    let (score, scene, basis) = scores.into_iter().next()?;
    if score < 2 {
        return None;
    }
    Some(WorkspaceScene {
        scene: scene.to_string(),
        basis: basis.into_iter().take(4).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(files: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        for f in files {
            let p = tmp.path().join(f);
            if f.ends_with('/') {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, "x").unwrap();
            }
        }
        let path = tmp.path().to_path_buf();
        (tmp, path)
    }

    #[test]
    fn code_repo_detected() {
        let (_t, p) = dir_with(&[".git/", "package.json", "src/", "readme.md", "计划.xlsx"]);
        let r = detect_workspace_scene(&p).unwrap();
        assert_eq!(r.scene, "programming");
        assert!(r.basis.iter().any(|b| b == "package.json"), "依据可解释：{:?}", r.basis);
    }

    #[test]
    fn video_and_data_detected() {
        let (_t, p) = dir_with(&["分镜/", "v1.mp4", "v2.mov"]);
        assert_eq!(detect_workspace_scene(&p).unwrap().scene, "video");
        let (_t, p) = dir_with(&["a.csv", "b.ipynb", "分析.sql"]);
        assert_eq!(detect_workspace_scene(&p).unwrap().scene, "data");
    }

    #[test]
    fn weak_signal_none() {
        // 单个弱文件不定论；空目录/不存在 → None（默认空间回落画像/草稿/入门）。
        let (_t, p) = dir_with(&["随手一记.pptx", "笔记.md"]);
        assert!(detect_workspace_scene(&p).is_none());
        assert!(detect_workspace_scene(Path::new("Z:/不存在")).is_none());
    }

    #[test]
    fn code_ext_accumulation() {
        let (_t, p) = dir_with(&["main.py", "util.py", "app.py"]);
        assert_eq!(detect_workspace_scene(&p).unwrap().scene, "programming");
    }
}
