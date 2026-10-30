//! Product feature gates, fixed at build time as the TypeScript build's
//! defines fix them (src/shared/features.ts): `JUNTO_<NAME>_ENABLED=1` in the
//! build's environment turns one on. Unset, a surface is off.

/// Whether a build-time variable reads `1` or `true`.
const fn on(value: Option<&str>) -> bool {
    matches!(value, Some(v) if matches!(v.as_bytes(), b"1" | b"true"))
}

pub const BROWSER: bool = on(option_env!("JUNTO_BROWSER_ENABLED"));
pub const ARTIFACTS: bool = on(option_env!("JUNTO_ARTIFACTS_ENABLED"));
pub const TASKS: bool = on(option_env!("JUNTO_TASKS_ENABLED"));
pub const AUTHORITY: bool = on(option_env!("JUNTO_AUTHORITY_ENABLED"));
pub const VAULT: bool = on(option_env!("JUNTO_VAULT_ENABLED"));
pub const LIVE_OVERSEER: bool = on(option_env!("JUNTO_LIVE_OVERSEER_ENABLED"));
/// The machine bundle's CLI, as `__JUNTO_MACHINE_BUILD__`: no browser there.
pub const MACHINE_BUILD: bool = on(option_env!("JUNTO_MACHINE_BUILD"));

/// main.ts disabledCliGroup: a root command whose feature is off in this build.
pub fn disabled_group(first: &str) -> Option<&str> {
    let off = match first {
        "task" | "rulings" => !TASKS,
        "artifact" => !ARTIFACTS,
        "browser" => !BROWSER,
        "authority" => !AUTHORITY,
        _ => false,
    };
    off.then_some(first)
}
