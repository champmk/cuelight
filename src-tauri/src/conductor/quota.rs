//! Quota governor: subscription plans are shared, opaque, rate-limited pools.
//! The governor never knows the real limits — it learns them from
//! `RateLimited` events and spends what's available in priority order.

use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct QuotaGovernor {
    /// Per-harness backoff deadline after a rate-limit event.
    cooldowns: HashMap<String, DateTime<Utc>>,
    /// Sessions started today per harness (resets at local midnight; M1: UTC).
    started_today: HashMap<String, u32>,
    day: Option<chrono::NaiveDate>,
}

impl QuotaGovernor {
    /// May a new session start on this harness right now?
    pub fn permits(&mut self, harness: &str, max_per_day: Option<u32>) -> bool {
        self.roll_day();
        if let Some(until) = self.cooldowns.get(harness) {
            if *until > Utc::now() {
                return false;
            }
        }
        if let Some(cap) = max_per_day {
            if self.started_today.get(harness).copied().unwrap_or(0) >= cap {
                return false;
            }
        }
        true
    }

    pub fn record_start(&mut self, harness: &str) {
        self.roll_day();
        *self.started_today.entry(harness.to_string()).or_insert(0) += 1;
    }

    /// React to a RateLimited event. Exponential-ish: honor the CLI's own
    /// retry-after when given, otherwise back off 5 minutes.
    pub fn record_rate_limit(&mut self, harness: &str, retry_after_secs: Option<u64>) {
        let secs = retry_after_secs.unwrap_or(300).min(3600) as i64;
        self.cooldowns
            .insert(harness.to_string(), Utc::now() + Duration::seconds(secs));
    }

    /// Cooldown remaining, for the canvas's quota strip.
    pub fn cooldown_secs(&self, harness: &str) -> i64 {
        self.cooldowns
            .get(harness)
            .map(|u| (*u - Utc::now()).num_seconds().max(0))
            .unwrap_or(0)
    }

    fn roll_day(&mut self) {
        let today = Utc::now().date_naive();
        if self.day != Some(today) {
            self.day = Some(today);
            self.started_today.clear();
        }
    }
}
