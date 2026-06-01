use crate::agent::NormalizedEvent;
use tokio::sync::broadcast;

pub struct EventBus {
    sender: broadcast::Sender<NormalizedEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn emit(&self, event: NormalizedEvent) {
        // Ignore send errors (no receivers is fine)
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NormalizedEvent> {
        self.sender.subscribe()
    }
}
