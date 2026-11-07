//! Content-Hashed Incremental ROI Cache for Interactive Dust Spot Inpainting.
//!
//! Stores previously healed ROI patches indexed by geometric bounds, inpaint params,
//! and raw CFA pixel content hash. Unaffected ROIs are instantly retrieved on re-renders.

#![forbid(unsafe_code)]

use std::collections::HashMap;

/// Cache key uniquely identifying a healed ROI patch.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RoiCacheKey {
    pub rx0: usize,
    pub ry0: usize,
    pub rw: usize,
    pub rh: usize,
    pub params_hash: u64,
    pub content_hash: u64,
}

impl RoiCacheKey {
    pub fn new(
        rx0: usize,
        ry0: usize,
        rw: usize,
        rh: usize,
        params_hash: u64,
        content: &[u16],
    ) -> Self {
        // Fast 64-bit content hash (FNV-1a)
        let mut h: u64 = 0xcbf29ce484222325;
        for &val in content {
            h ^= val as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        Self {
            rx0,
            ry0,
            rw,
            rh,
            params_hash,
            content_hash: h,
        }
    }
}

/// Cache holding healed ROI results across inpainting requests.
#[derive(Default)]
pub struct RoiCache {
    entries: HashMap<RoiCacheKey, Vec<u16>>,
}

impl RoiCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &RoiCacheKey) -> Option<&Vec<u16>> {
        self.entries.get(key)
    }

    pub fn insert(&mut self, key: RoiCacheKey, healed: Vec<u16>) {
        self.entries.insert(key, healed);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_stores_and_retrieves_matching_keys() {
        let mut cache = RoiCache::new();
        let content = vec![100u16, 200, 300, 400];
        let key = RoiCacheKey::new(10, 10, 2, 2, 42, &content);

        assert!(cache.get(&key).is_none());
        cache.insert(key.clone(), vec![999u16, 999, 999, 999]);
        assert_eq!(cache.get(&key).unwrap(), &[999u16, 999, 999, 999]);

        // Key with different content hash should miss
        let different_content = vec![100u16, 200, 300, 401];
        let diff_key = RoiCacheKey::new(10, 10, 2, 2, 42, &different_content);
        assert!(cache.get(&diff_key).is_none());
    }
}
