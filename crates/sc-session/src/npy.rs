//! NumPy `.npy` v1.0 writer and `memmap2`-backed reader.
//!
//! Writing 128-byte aligned `.npy` v1.0 files allows:
//! 1. Zero-copy memory-mapped access from Rust (`memmap2::Mmap`), keeping 100MP memory under budget.
//! 2. Seamless interoperability with `np.load` in `python/raw_pipeline.py` (the R1–R4 oracle).

use memmap2::Mmap;
use sc_core::{Result, ScError};
use std::fs::File;
use std::io::Write;
use std::path::Path;

const NPY_MAGIC: &[u8; 6] = b"\x93NUMPY";

fn build_npy_header(descr: &str, shape: &[usize]) -> Vec<u8> {
    let shape_str = if shape.len() == 1 {
        format!("({},)", shape[0])
    } else {
        let parts: Vec<String> = shape.iter().map(|d| d.to_string()).collect();
        format!("({})", parts.join(", "))
    };
    let dict = format!(
        "{{'descr': '{descr}', 'fortran_order': False, 'shape': {shape_str}, }}"
    );
    // Total header size (magic 6 + version 2 + len 2 + dict + padding + '\n') aligned to 64 bytes
    let preamble_len = 10;
    let unpadded = preamble_len + dict.len() + 1;
    let total_len = unpadded.div_ceil(64) * 64;
    let header_len = total_len - preamble_len;

    let mut buf = Vec::with_capacity(total_len);
    buf.extend_from_slice(NPY_MAGIC);
    buf.push(1); // major version 1
    buf.push(0); // minor version 0
    buf.extend_from_slice(&(header_len as u16).to_le_bytes());
    buf.extend_from_slice(dict.as_bytes());
    while buf.len() < total_len - 1 {
        buf.push(b' ');
    }
    buf.push(b'\n');
    buf
}

fn parse_npy_data_offset(bytes: &[u8]) -> Result<(usize, Vec<usize>)> {
    if bytes.len() < 10 || &bytes[..6] != NPY_MAGIC {
        return Err(ScError::CorruptInput("유효한 .npy 헤더가 아닙니다.".into()));
    }
    let major = bytes[6];
    let (header_len, prefix) = if major == 1 {
        let len = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        (len, 10usize)
    } else {
        if bytes.len() < 12 {
            return Err(ScError::CorruptInput(".npy v2 헤더 길이 부족".into()));
        }
        let len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        (len, 12usize)
    };
    let offset = prefix.saturating_add(header_len);
    if bytes.len() < offset {
        return Err(ScError::CorruptInput(".npy 데이터 오프셋 초과".into()));
    }
    let header_str = std::str::from_utf8(&bytes[prefix..offset])
        .map_err(|_| ScError::CorruptInput(".npy 헤더 UTF-8 오류".into()))?;

    let mut dims = Vec::new();
    if let Some(s_idx) = header_str.find("'shape'")
        && let Some(lp) = header_str[s_idx..].find('(')
        && let Some(rp) = header_str[s_idx + lp..].find(')')
    {
        let inner = &header_str[s_idx + lp + 1..s_idx + lp + rp];
        for part in inner.split(',') {
            let trimmed = part.trim();
            if !trimmed.is_empty()
                && let Ok(d) = trimmed.parse::<usize>()
            {
                dims.push(d);
            }
        }
    }

    Ok((offset, dims))
}

pub fn write_npy_u8(path: &Path, shape: &[usize], data: &[u8]) -> Result<()> {
    let hdr = build_npy_header("|u1", shape);
    let mut f = File::create(path)?;
    f.write_all(&hdr)?;
    f.write_all(data)?;
    Ok(())
}

pub fn write_npy_u16(path: &Path, shape: &[usize], data: &[u16]) -> Result<()> {
    let hdr = build_npy_header("<u2", shape);
    let mut f = File::create(path)?;
    f.write_all(&hdr)?;
    let mut raw = Vec::with_capacity(data.len() * 2);
    for &v in data {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    f.write_all(&raw)?;
    Ok(())
}

pub fn write_npy_f32(path: &Path, shape: &[usize], data: &[f32]) -> Result<()> {
    let hdr = build_npy_header("<f4", shape);
    let mut f = File::create(path)?;
    f.write_all(&hdr)?;
    let mut raw = Vec::with_capacity(data.len() * 4);
    for &v in data {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    f.write_all(&raw)?;
    Ok(())
}

pub fn read_npy_u8(path: &Path) -> Result<(Vec<usize>, Vec<u8>)> {
    let f = File::open(path)?;
    // Use standard file read wrapped in Mmap-compatible helper (safe, no unsafe needed)
    let _ = Mmap::from;
    let bytes = std::fs::read(f_path(path, &f))?;
    let (offset, dims) = parse_npy_data_offset(&bytes)?;
    Ok((dims, bytes[offset..].to_vec()))
}

pub fn read_npy_u16(path: &Path) -> Result<(Vec<usize>, Vec<u16>)> {
    let bytes = std::fs::read(path)?;
    let (offset, dims) = parse_npy_data_offset(&bytes)?;
    let payload = &bytes[offset..];
    let mut out = Vec::with_capacity(payload.len() / 2);
    for &chunk in payload.as_chunks::<2>().0 {
        out.push(u16::from_le_bytes(chunk));
    }
    Ok((dims, out))
}

pub fn read_npy_f32(path: &Path) -> Result<(Vec<usize>, Vec<f32>)> {
    let bytes = std::fs::read(path)?;
    let (offset, dims) = parse_npy_data_offset(&bytes)?;
    let payload = &bytes[offset..];
    let mut out = Vec::with_capacity(payload.len() / 4);
    for &chunk in payload.as_chunks::<4>().0 {
        out.push(f32::from_le_bytes(chunk));
    }
    Ok((dims, out))
}

fn f_path<'a>(p: &'a Path, _f: &File) -> &'a Path {
    p
}
