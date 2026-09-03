# v0.8.1 恢复 · 阶段七：adapter 角色方法搬迁（impl ConfigAdapter 胖方法 → 独立角色 impl 块）
# 按设计文档 §1.3 能力矩阵：
#   claude_code: Raw + Backup + TransportBridge
#   codex:       Raw + PermissionMode
#   opencode:    Raw + Backup
#   jishu_self:  Raw + Backup + ModelStore + Mcp
import io, re, sys

ROLE_METHODS = {
    'RawConfigStore': ['load_raw_config', 'save_raw_config', 'config_format'],
    'ConfigBackupStore': ['list_backups', 'restore_backup', 'export_config', 'import_config'],
    'ModelStore': ['load_model_store', 'save_model_store', 'get_active_model', 'set_active_model'],
    'McpIntegration': ['check_mcp', 'install_mcp', 'update_mcp', 'migrate_mcp_if_needed'],
    'TransportBridgeDependency': ['check_transport_bridge', 'install_transport_bridge'],
    'PermissionModeConfig': ['get_permission_mode', 'set_permission_mode'],
}
DROP_METHODS = ['supports_mcp', 'supports_transport_bridge']
ROLE_IMPORTS = {
    'RawConfigStore': 'crate::agent::config_roles::RawConfigStore',
    'ConfigBackupStore': 'crate::agent::config_roles::ConfigBackupStore',
    'ModelStore': 'crate::agent::config_roles::ModelStore',
    'McpIntegration': 'crate::agent::config_roles::McpIntegration',
    'TransportBridgeDependency': 'crate::agent::config_roles::TransportBridgeDependency',
    'PermissionModeConfig': 'crate::agent::config_roles::PermissionModeConfig',
}
# 文件 → (类型名, [角色...])
TARGETS = [
    ('src-tauri/src/agent/claude_code.rs', 'ClaudeCodeAgent',
     ['RawConfigStore', 'ConfigBackupStore', 'TransportBridgeDependency']),
    ('src-tauri/src/agent/adapters/codex.rs', 'CodexAdapter',
     ['RawConfigStore', 'PermissionModeConfig']),
    ('src-tauri/src/agent/adapters/opencode.rs', 'OpencodeAdapter',
     ['RawConfigStore', 'ConfigBackupStore']),
    ('src-tauri/src/agent/jishu_self/mod.rs', 'JishuSelfAgent',
     ['RawConfigStore', 'ConfigBackupStore', 'ModelStore', 'McpIntegration']),
]

def find_block_end(lines, start_idx):
    """从 impl 块起始行起，按花括号平衡找块结束行号（含闭合 }）。"""
    depth = 0
    for i in range(start_idx, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if depth == 0 and i > start_idx:
            return i
    return None

def split_methods(body_lines):
    """把 impl 块体（不含首尾大括号行）按顶层 `fn ` 切成 [(name, lines)]。"""
    methods = []
    cur_name, cur = None, []
    for ln in body_lines:
        m = re.match(r'    (?:pub )?fn (\w+)', ln)
        if m and (cur_name is None or ln.startswith('    fn') or ln.startswith('    pub fn')) and not ln.startswith('        '):
            if cur_name:
                methods.append((cur_name, cur))
            cur_name, cur = m.group(1), [ln]
        else:
            if cur_name is None:
                # 块内非方法行（注释/属性）挂在下一个方法前——追加进 pending
                methods.append(('_preamble', [ln]) if not methods else ('_tail', [ln]))
                # 简化：先当 preamble
                if methods and methods[0][0] == '_tail':
                    methods[0] = ('_preamble', methods[0][1] + [ln])
                    methods.pop()
                    continue
            else:
                cur.append(ln)
    if cur_name:
        methods.append((cur_name, cur))
    return methods

for path, type_name, roles in TARGETS:
    with io.open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    lines = src.split('\n')

    # 定位 impl ConfigAdapter for Type
    impl_start = None
    for i, ln in enumerate(lines):
        if ln.strip() == f'impl ConfigAdapter for {type_name} {{':
            impl_start = i
            break
    if impl_start is None:
        print(f'!! {path}: 未找到 impl ConfigAdapter for {type_name}')
        continue
    impl_end = find_block_end(lines, impl_start)

    body = lines[impl_start + 1 : impl_end]
    methods = split_methods(body)

    keep, moved = [], {}
    for name, mlines in methods:
        if name in DROP_METHODS:
            continue
        target_role = None
        for role, msets in ROLE_METHODS.items():
            if name in msets:
                target_role = role
                break
        if target_role and target_role in roles:
            moved.setdefault(target_role, []).extend(mlines)
        else:
            keep.extend(mlines)

    # 重建 impl ConfigAdapter（瘦）
    new_impl = [f'impl ConfigAdapter for {type_name} {{'] + keep + ['}']
    # 角色访问器覆写插到 ConfigAdapter 尾部前
    accessors = []
    for role in roles:
        short = {
            'RawConfigStore': 'raw_config', 'ConfigBackupStore': 'backup_store',
            'ModelStore': 'model_store', 'McpIntegration': 'mcp',
            'TransportBridgeDependency': 'transport_bridge',
            'PermissionModeConfig': 'permission_mode_config',
        }[role]
        accessors.append(f'    fn as_{short}(&self) -> Option<&dyn {ROLE_IMPORTS[role]}> {{')
        accessors.append('        Some(self)')
        accessors.append('    }')
        accessors.append('')

    head = new_impl[:-1] + accessors + ['}']

    role_impls = []
    for role in roles:
        mlines = moved.get(role, [])
        # 方法从 4 空格 impl ConfigAdapter 缩进直接复用（同为顶层 impl）
        role_impls.append('')
        role_impls.append(f'impl {ROLE_IMPORTS[role]} for {type_name} {{')
        role_impls.extend(mlines)
        role_impls.append('}')

    lines = lines[:impl_start] + head + role_impls + lines[impl_end + 1:]
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write('\n'.join(lines))
    moved_names = {r: [n for n in ROLE_METHODS[r] if any(n == m for m, _ in methods)] for r in roles}
    print(f'✓ {path}: {type_name} 搬迁 {sum(len(v) for v in moved.values())} 行 → {list(moved.keys())}')
    for r, names in moved_names.items():
        print(f'    {r}: {names}')
