//! OpenRouter: hundreds of models from many labs behind one API key, billed per token.
//!
//! Two ways in, matching the two kinds of role:
//!
//! * **Roles that work on code** (`provider = "openrouter"`) run the `claude` CLI pointed
//!   at OpenRouter's Anthropic-compatible endpoint, so any model it serves gets Claude
//!   Code's tool loop, permission prompts, worktrees and resumable sessions unchanged.
//!   This is the route OpenRouter documents for Claude Code.
//! * **Text-only roles** (`provider = "openai_compat"` with OpenRouter's `base_url`) are
//!   a plain chat completion, with the key attached.
//!
//! Unlike every other backend this one is not covered by a subscription: each call is
//! billed to the OpenRouter account. That is why it is opt-in per role, and why its key
//! is never handed to any other agent.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::RwLock;
use std::time::Duration;

use crate::event::HarnessEvent;

/// The Anthropic-compatible root Claude Code is pointed at.
pub const ANTHROPIC_ROOT: &str = "https://openrouter.ai/api";
/// The OpenAI-compatible root for chat completions and the model catalog.
pub const API_BASE: &str = "https://openrouter.ai/api/v1";
/// The environment variable read when no key was saved in the app.
pub const KEY_VARIABLE: &str = "OPENROUTER_API_KEY";

const TIMEOUT: Duration = Duration::from_secs(15);

struct Config {
    key: Option<String>,
    models: Vec<String>,
}

static CONFIG: RwLock<Config> = RwLock::new(Config {
    key: None,
    models: Vec::new(),
});

/// The key saved in the app. `None` falls back to [`KEY_VARIABLE`].
pub fn set_api_key(key: Option<String>) {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    CONFIG.write().expect("not poisoned").key = key;
}

/// The models offered when a role is reassigned, as OpenRouter slugs.
pub fn set_models(models: Vec<String>) {
    CONFIG.write().expect("not poisoned").models = models;
}

pub fn models() -> Vec<String> {
    CONFIG.read().expect("not poisoned").models.clone()
}

/// Where the key in use came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Saved,
    Environment,
}

/// The key to use and where it came from: the app's saved key wins over the environment.
pub fn key_with_source() -> Option<(String, KeySource)> {
    if let Some(key) = CONFIG.read().expect("not poisoned").key.clone() {
        return Some((key, KeySource::Saved));
    }
    std::env::var(KEY_VARIABLE)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .map(|k| (k, KeySource::Environment))
}

pub fn api_key() -> Option<String> {
    key_with_source().map(|(key, _)| key)
}

/// The key, or the error a run should fail with when there is none.
pub fn require_key() -> Result<String> {
    api_key().context(
        "no OpenRouter key — add one in Settings → OpenRouter, or set OPENROUTER_API_KEY",
    )
}

/// The last few characters, enough to tell two keys apart without showing either.
pub fn key_hint(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

/// Whether a `base_url` is OpenRouter's, so the key goes to it and nowhere else.
pub fn is_openrouter_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    host.eq_ignore_ascii_case("openrouter.ai")
}

/// What the `claude` CLI needs in its environment to run on OpenRouter: `Some` sets a
/// variable, `None` removes it.
///
/// `ANTHROPIC_API_KEY` is set to an empty string rather than left unset: OpenRouter's
/// guide is explicit that, unset, the CLI can fall back to the Anthropic sign-in. Anything
/// that would send the run somewhere else — a sign-in token from `claude setup-token`,
/// Bedrock or Vertex — is removed. The tier defaults all name the role's model, so the
/// CLI's background calls and any subagent it starts run on the model the person chose
/// (and pays for), not on a Claude model billed through OpenRouter behind their back.
pub fn claude_env(key: &str, model: &str) -> Vec<(&'static str, Option<String>)> {
    let mut env = vec![
        ("ANTHROPIC_BASE_URL", Some(ANTHROPIC_ROOT.to_string())),
        ("ANTHROPIC_AUTH_TOKEN", Some(key.to_string())),
        ("ANTHROPIC_API_KEY", Some(String::new())),
        ("CLAUDE_CODE_OAUTH_TOKEN", None),
        ("CLAUDE_CODE_USE_BEDROCK", None),
        ("CLAUDE_CODE_USE_VERTEX", None),
    ];
    for tier in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        env.push((tier, Some(model.to_string())));
    }
    env
}

/// A `claude` event from a run on OpenRouter, as the rest of the harness should see it.
///
/// The stream looks like a subscription run but isn't one, so the signals that would
/// otherwise be read as being about the Claude subscription are reworded or dropped:
/// a rate limit here is OpenRouter's, a refused key is OpenRouter's, and the CLI's
/// dollar figure is priced as if the model were Claude.
pub fn adapt_event(event: HarnessEvent) -> Option<HarnessEvent> {
    match event {
        // Anthropic's quota windows; meaningless here.
        HarnessEvent::QuotaReport { .. } => None,
        // Would mark the Claude subscription as rate-limited.
        HarnessEvent::ApiRetry { run_id, error, .. } if error == "rate_limit" => {
            Some(HarnessEvent::Error {
                run_id,
                message: "OpenRouter is rate-limiting this model; the CLI is retrying".into(),
            })
        }
        // Would open the Claude sign-in panel, which can't fix an OpenRouter key.
        HarnessEvent::SignInProblem { run_id, .. } => Some(HarnessEvent::Error {
            run_id,
            message: "OpenRouter refused the key — check it in Settings → OpenRouter".into(),
        }),
        HarnessEvent::RunFinished {
            run_id,
            text,
            usage,
            is_error,
            ..
        } => Some(HarnessEvent::RunFinished {
            run_id,
            text,
            usage,
            cost_usd: None,
            is_error,
        }),
        other => Some(other),
    }
}

/// One model in OpenRouter's catalog.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub context_length: Option<u64>,
    /// Dollars per million tokens.
    pub prompt_per_million: Option<f64>,
    pub completion_per_million: Option<f64>,
    /// Whether it accepts tool calls, which a role that works on code needs.
    pub tools: bool,
}

/// The public catalog. Needs no key.
pub async fn catalog() -> Result<Vec<CatalogModel>> {
    catalog_at(API_BASE).await
}

pub async fn catalog_at(base: &str) -> Result<Vec<CatalogModel>> {
    let endpoint = format!("{}/models", base.trim_end_matches('/'));
    let value: Value = client()?
        .get(&endpoint)
        .send()
        .await
        .with_context(|| format!("reaching {endpoint}"))?
        .error_for_status()?
        .json()
        .await
        .context("reading OpenRouter's model list")?;
    Ok(parse_catalog(&value))
}

fn parse_catalog(value: &Value) -> Vec<CatalogModel> {
    let per_million = |model: &Value, field: &str| {
        model
            .pointer(&format!("/pricing/{field}"))
            .and_then(|p| match p {
                Value::String(s) => s.parse::<f64>().ok(),
                other => other.as_f64(),
            })
            .filter(|p| *p >= 0.0)
            .map(|p| p * 1_000_000.0)
    };
    let mut models: Vec<CatalogModel> = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            Some(CatalogModel {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                context_length: model.get("context_length").and_then(Value::as_u64),
                prompt_per_million: per_million(model, "prompt"),
                completion_per_million: per_million(model, "completion"),
                tools: model
                    .get("supported_parameters")
                    .and_then(Value::as_array)
                    .is_some_and(|params| params.iter().any(|p| p.as_str() == Some("tools"))),
                id,
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

/// What OpenRouter says about a key: that it works, and how much it has spent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyInfo {
    pub label: Option<String>,
    /// Dollars spent on this key so far.
    pub usage: Option<f64>,
    /// The key's spending limit in dollars; `None` is no limit.
    pub limit: Option<f64>,
    pub free_tier: bool,
}

pub async fn check_key(key: &str) -> Result<KeyInfo> {
    check_key_at(API_BASE, key).await
}

pub async fn check_key_at(base: &str, key: &str) -> Result<KeyInfo> {
    let endpoint = format!("{}/key", base.trim_end_matches('/'));
    let response = client()?
        .get(&endpoint)
        .bearer_auth(key)
        .send()
        .await
        .with_context(|| format!("reaching {endpoint}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        bail!("OpenRouter doesn't recognise this key");
    }
    if !status.is_success() {
        bail!("OpenRouter answered {status}");
    }
    let value: Value = response.json().await.context("reading the key's details")?;
    let data = value.get("data").unwrap_or(&value);
    Ok(KeyInfo {
        label: data.get("label").and_then(Value::as_str).map(str::to_string),
        usage: data.get("usage").and_then(Value::as_f64),
        limit: data.get("limit").and_then(Value::as_f64),
        free_tier: data
            .get("is_free_tier")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(TIMEOUT).build()?)
}

/// Whether `slug` could be an OpenRouter model id, e.g. `moonshotai/kimi-k2:free`.
///
/// It is passed as the value of `--model` and into the environment, so it must never
/// start with `-` or carry anything a shell or the CLI would read specially.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 120
        && !slug.starts_with('-')
        && slug.contains('/')
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_openrouters_own_host_gets_the_key() {
        assert!(is_openrouter_url("https://openrouter.ai/api/v1"));
        assert!(is_openrouter_url("https://OpenRouter.ai/api/v1/"));
        for url in [
            "http://openrouter.ai/api/v1",
            "https://openrouter.ai.evil.example/api/v1",
            "https://evil.example/openrouter.ai/api/v1",
            "https://notopenrouter.ai/api/v1",
            "http://localhost:11434/v1",
        ] {
            assert!(!is_openrouter_url(url), "{url}");
        }
    }

    #[test]
    fn the_cli_is_pointed_at_openrouter_with_an_empty_anthropic_key() {
        let env = claude_env("sk-or-test", "qwen/qwen3-coder");
        let get = |name: &str| {
            env.iter()
                .find(|(k, _)| *k == name)
                .and_then(|(_, v)| v.as_deref())
        };
        let removed = |name: &str| env.iter().any(|(k, v)| *k == name && v.is_none());
        assert_eq!(get("ANTHROPIC_BASE_URL"), Some("https://openrouter.ai/api"));
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN"), Some("sk-or-test"));
        // Empty, not absent: absent lets the CLI fall back to the Anthropic sign-in.
        assert_eq!(get("ANTHROPIC_API_KEY"), Some(""));
        assert_eq!(get("ANTHROPIC_DEFAULT_HAIKU_MODEL"), Some("qwen/qwen3-coder"));
        assert_eq!(get("CLAUDE_CODE_SUBAGENT_MODEL"), Some("qwen/qwen3-coder"));
        // A sign-in token in the environment must not ride along to OpenRouter.
        assert!(removed("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(removed("CLAUDE_CODE_USE_BEDROCK"));
    }

    #[test]
    fn subscription_signals_are_not_read_as_claudes() {
        let quota = HarnessEvent::QuotaReport {
            run_id: "r".into(),
            provider: "claude".into(),
            status: "rejected".into(),
            windows: Vec::new(),
        };
        assert!(adapt_event(quota).is_none());

        let sign_in = HarnessEvent::SignInProblem {
            run_id: "r".into(),
            message: "OAuth token has expired".into(),
        };
        assert!(matches!(
            adapt_event(sign_in),
            Some(HarnessEvent::Error { message, .. }) if message.contains("OpenRouter")
        ));

        let finished = HarnessEvent::RunFinished {
            run_id: "r".into(),
            text: "done".into(),
            usage: Default::default(),
            cost_usd: Some(0.42),
            is_error: false,
        };
        assert!(matches!(
            adapt_event(finished),
            Some(HarnessEvent::RunFinished { cost_usd: None, .. })
        ));

        let text = HarnessEvent::AssistantText {
            run_id: "r".into(),
            text: "hi".into(),
            partial: false,
        };
        assert!(matches!(
            adapt_event(text),
            Some(HarnessEvent::AssistantText { .. })
        ));
    }

    #[test]
    fn the_catalog_is_read_with_prices_per_million_and_tool_support() {
        let value = serde_json::json!({
            "data": [
                {
                    "id": "z-ai/glm-4.6",
                    "name": "GLM 4.6",
                    "context_length": 200000,
                    "pricing": { "prompt": "0.0000006", "completion": "0.0000022" },
                    "supported_parameters": ["tools", "temperature"]
                },
                {
                    "id": "acme/no-tools",
                    "pricing": { "prompt": "-1", "completion": "0" },
                    "supported_parameters": ["temperature"]
                },
                { "name": "no id, skipped" }
            ]
        });
        let models = parse_catalog(&value);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "acme/no-tools");
        assert_eq!(models[0].name, "acme/no-tools");
        assert!(!models[0].tools);
        // OpenRouter's -1 means "varies"; it isn't a price.
        assert_eq!(models[0].prompt_per_million, None);
        assert_eq!(models[0].completion_per_million, Some(0.0));

        let glm = &models[1];
        assert!(glm.tools);
        assert_eq!(glm.context_length, Some(200_000));
        assert!((glm.prompt_per_million.unwrap() - 0.6).abs() < 1e-9);
        assert!((glm.completion_per_million.unwrap() - 2.2).abs() < 1e-9);
    }

    #[test]
    fn slugs_that_could_be_read_as_flags_are_refused() {
        assert!(valid_slug("moonshotai/kimi-k2:free"));
        assert!(valid_slug("openai/gpt-5.1-codex"));
        for bad in ["", "-model/x", "no-slash", "a/b c", "a/b;rm", "a/$(x)"] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }

    #[test]
    fn the_hint_shows_only_the_tail() {
        assert_eq!(key_hint("sk-or-v1-abcdef123456"), "…3456");
        assert_eq!(key_hint("ab"), "…ab");
    }

    async fn fake_openrouter() -> String {
        use axum::{http::HeaderMap, http::StatusCode, routing::get, Json, Router};
        let app = Router::new()
            .route(
                "/api/v1/models",
                get(|| async {
                    Json(serde_json::json!({ "data": [{ "id": "qwen/qwen3-coder",
                        "supported_parameters": ["tools"] }] }))
                }),
            )
            .route(
                "/api/v1/key",
                get(|headers: HeaderMap| async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    if auth != "Bearer sk-or-good" {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    Ok(Json(serde_json::json!({ "data": {
                        "label": "sk-or-v1-goo...",
                        "usage": 1.25,
                        "limit": null,
                        "is_free_tier": false
                    }})))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/api/v1")
    }

    #[tokio::test]
    async fn a_key_is_checked_and_a_wrong_one_is_named_as_such() {
        let base = fake_openrouter().await;

        let info = check_key_at(&base, "sk-or-good").await.unwrap();
        assert_eq!(info.usage, Some(1.25));
        assert_eq!(info.limit, None);
        assert!(!info.free_tier);

        let err = check_key_at(&base, "sk-or-bad").await.unwrap_err();
        assert!(err.to_string().contains("doesn't recognise"), "{err}");

        let catalog = catalog_at(&base).await.unwrap();
        assert_eq!(catalog[0].id, "qwen/qwen3-coder");
        assert!(catalog[0].tools);
    }
}
