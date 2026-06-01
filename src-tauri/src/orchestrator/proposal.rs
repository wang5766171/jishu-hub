use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionProposal {
    pub proposal_id: String,
    pub created_at: i64,
    pub source_task_id: String,
    pub target: String,
    pub kind: ProposalKind,
    pub diff: Option<String>,
    pub rationale: String,
    pub risk: RiskLevel,
    pub status: ProposalStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    CodeEdit,
    Config,
    Doc,
    NewAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Draft,
    Reviewed,
    Applied,
    Rejected,
}
