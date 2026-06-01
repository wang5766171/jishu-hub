use crate::agent::AgentRegistry;
use crate::cli::args::ConfigAction;
use crate::cli::error::CliError;
use crate::cli::output::ExecutionContext;

pub fn run(action: ConfigAction, ctx: &ExecutionContext) -> Result<(), CliError> {
    let registry = AgentRegistry::new();
    let agent = registry.active();

    match action {
        ConfigAction::Show => {
            let config = agent.load_config().map_err(CliError::Internal)?;
            if ctx.json {
                println!("{}", serde_json::to_string(&config)?);
            } else {
                println!("{}", serde_json::to_string_pretty(&config)?);
            }
            Ok(())
        }
        ConfigAction::Get { key } => {
            let config = agent.load_config().map_err(CliError::Internal)?;
            let value = serde_json::to_value(&config)?;
            match value.get(&key) {
                Some(v) => println!("{v}"),
                None => return Err(CliError::NotFound(format!("Config key not found: {key}"))),
            }
            Ok(())
        }
        ConfigAction::Set { key, value } => {
            let mut config = agent.load_config().map_err(CliError::Internal)?;
            let mut value_map = serde_json::to_value(&mut config)?;
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or(serde_json::Value::String(value.clone()));
            value_map[&key] = parsed_value;
            config = serde_json::from_value(value_map)?;
            agent.save_config(&config).map_err(CliError::Internal)?;
            if ctx.json {
                println!("{{\"ok\":true,\"key\":\"{key}\"}}");
            } else {
                println!("Set {key}");
            }
            Ok(())
        }
    }
}
