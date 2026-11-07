//! Cooperative cancellation and progress callback sink.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Thread-safe cooperative cancellation token.
#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn check(&self) -> crate::error::Result<()> {
        if self.is_cancelled() {
            Err(crate::error::ScError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Progress reporting sink for long-running pipeline steps.
pub trait ProgressSink: Send + Sync {
    fn on_progress(&self, percent: u8, stage: &str, detail: Option<&str>);
}

/// No-op progress sink that discards all progress updates.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopProgressSink;

impl ProgressSink for NoopProgressSink {
    fn on_progress(&self, _percent: u8, _stage: &str, _detail: Option<&str>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_state_transition() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        assert!(token.check().is_ok());

        token.cancel();
        assert!(token.is_cancelled());
        assert!(matches!(token.check(), Err(crate::error::ScError::Cancelled)));

        token.reset();
        assert!(!token.is_cancelled());
        assert!(token.check().is_ok());
    }
}
