//! SensorClean HTTP server binary entry point (`sc-server`).

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

use sc_server::{AppState, build_app};
use sc_session::SessionStore;
use std::path::PathBuf;
use std::time::Duration;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    let project_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let store = SessionStore::default();
    store.prune_sessions(None, 36, &[]);

    // Periodic background pruning every 15 minutes
    let prune_store = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15 * 60));
        loop {
            interval.tick().await;
            prune_store.prune_sessions(None, 36, &[]);
        }
    });

    let state = AppState::new(store.clone(), project_root);
    let app = build_app(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("==========================================================");
    tracing::info!("  SensorClean Rust Server running on http://localhost:{port}");
    tracing::info!("  Sessions Root: {}", store.sessions_root.display());
    tracing::info!("==========================================================");

    let Ok(listener) = tokio::net::TcpListener::bind(&addr).await else {
        tracing::error!("포트 {port} 바인딩 실패");
        std::process::exit(1);
    };

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("서버 실행 오류: {e}");
        std::process::exit(1);
    }
}
