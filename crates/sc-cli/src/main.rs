//! SensorClean CLI (`sensorclean`): supports both standalone CLI usage and 1:1 `raw_pipeline.py`
//! JSON stdout command compatibility (`ingest`, `detect`, `ingest_and_detect`, `inpaint`, `export`, `inpaint_and_export`, `multi_detect`).

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

use sc_core::{DetectionParams, InpaintParams, MultiFrameConfig};
use sc_session::{
    detect_sensor_dust_in_session, export_healed_image_native, ingest_and_detect_session,
    ingest_image_to_session, inpaint_16bit_linear_native, multi_detect_sessions,
};
use serde_json::json;
use std::path::{Path, PathBuf};

fn parse_inpaint_params(arg: Option<&String>) -> InpaintParams {
    let Some(s) = arg else {
        return InpaintParams::default();
    };
    if Path::new(s).is_file()
        && let Ok(contents) = std::fs::read_to_string(s)
    {
        return serde_json::from_str(&contents).unwrap_or_default();
    }
    serde_json::from_str(s).unwrap_or_default()
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1).map(|s| s.as_str()) else {
        return Err(
            "Usage: sensorclean <ingest|detect|ingest_and_detect|inpaint|export|inpaint_and_export|multi_detect> ..."
                .to_string(),
        );
    };

    match cmd {
        "ingest" => {
            let input_path = args.get(2).ok_or("Missing <input_path>")?;
            let session_dir = args.get(3).ok_or("Missing <session_dir>")?;
            let orig_name = args.get(4).map(|s| s.as_str());
            let meta =
                ingest_image_to_session(Path::new(input_path), Path::new(session_dir), orig_name)
                    .map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&meta).map_err(|e| e.to_string())?
            );
        }
        "detect" => {
            let session_dir = args.get(2).ok_or("Missing <session_dir>")?;
            let params: DetectionParams = match args.get(3) {
                Some(s) => serde_json::from_str(s).unwrap_or_default(),
                None => DetectionParams::default(),
            };
            let res = detect_sensor_dust_in_session(Path::new(session_dir), &params)
                .map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&res).map_err(|e| e.to_string())?
            );
        }
        "ingest_and_detect" => {
            let input_path = args.get(2).ok_or("Missing <input_path>")?;
            let session_dir = args.get(3).ok_or("Missing <session_dir>")?;
            let params: DetectionParams = match args.get(4) {
                Some(s) => serde_json::from_str(s).unwrap_or_default(),
                None => DetectionParams::default(),
            };
            let orig_name = args.get(5).map(|s| s.as_str());
            let (meta, detection) = ingest_and_detect_session(
                Path::new(input_path),
                Path::new(session_dir),
                &params,
                orig_name,
            )
            .map_err(|e| e.to_string())?;
            let out = json!({
                "meta": meta,
                "detection": detection,
            });
            println!(
                "{}",
                serde_json::to_string(&out).map_err(|e| e.to_string())?
            );
        }
        "inpaint" => {
            let session_dir = args.get(2).ok_or("Missing <session_dir>")?;
            let params = parse_inpaint_params(args.get(3));
            let res = inpaint_16bit_linear_native(Path::new(session_dir), &params)
                .map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&res).map_err(|e| e.to_string())?
            );
        }
        "export" => {
            let session_dir = args.get(2).ok_or("Missing <session_dir>")?;
            let fmt = args.get(3).map(|s| s.as_str()).unwrap_or("dng");
            let out_path = args
                .get(4)
                .map(PathBuf::from)
                .unwrap_or_else(|| Path::new(session_dir).join(format!("export.{fmt}")));
            let res = export_healed_image_native(Path::new(session_dir), fmt, &out_path)
                .map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&res).map_err(|e| e.to_string())?
            );
        }
        "inpaint_and_export" => {
            let session_dir = args.get(2).ok_or("Missing <session_dir>")?;
            let params = parse_inpaint_params(args.get(3));
            let fmt = args.get(4).map(|s| s.as_str()).unwrap_or("dng");
            let out_path = args
                .get(5)
                .map(PathBuf::from)
                .unwrap_or_else(|| Path::new(session_dir).join(format!("export.{fmt}")));
            let inpaint_res = inpaint_16bit_linear_native(Path::new(session_dir), &params)
                .map_err(|e| e.to_string())?;
            let export_info = export_healed_image_native(Path::new(session_dir), fmt, &out_path)
                .map_err(|e| e.to_string())?;
            let out = json!({
                "inpaintResult": inpaint_res,
                "exportInfo": export_info,
            });
            println!(
                "{}",
                serde_json::to_string(&out).map_err(|e| e.to_string())?
            );
        }
        "multi_detect" => {
            let cfg_arg = args.get(2).ok_or("Missing <config_json_or_path>")?;
            let cfg_str = if Path::new(cfg_arg).is_file() {
                std::fs::read_to_string(cfg_arg).map_err(|e| e.to_string())?
            } else {
                cfg_arg.clone()
            };
            let cfg: MultiFrameConfig =
                serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
            let report = multi_detect_sessions(&cfg).map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string(&report).map_err(|e| e.to_string())?
            );
        }
        other => {
            return Err(format!("Unknown command: {other}"));
        }
    }

    Ok(())
}

fn main() {
    if let Err(err) = run() {
        let out = json!({ "error": err });
        println!("{}", out);
        std::process::exit(1);
    }
}
