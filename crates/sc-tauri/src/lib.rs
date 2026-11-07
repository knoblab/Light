//! `sc-tauri`: Desktop (Win/macOS/Linux) and Android Mobile runtime for SensorClean.

#![forbid(unsafe_code)]

pub mod commands;
pub mod mobile;
pub mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol("sensorclean", protocol::handle_sensorclean_protocol)
        .invoke_handler(tauri::generate_handler![
            commands::cmd_get_system_info,
            commands::cmd_ingest_and_detect,
            commands::cmd_detect,
            commands::cmd_inpaint,
            commands::cmd_export_file,
            commands::cmd_cancel_job,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running sensorclean tauri application");
}
