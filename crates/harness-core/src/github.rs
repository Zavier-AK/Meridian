//! The project's repositories, their branches and pull requests, for the GitHub view.
//!
//! A project is one folder, but it can span several repositories: the folder itself,
//! its submodules, and repositories nested inside it (a workspace of separate repos).
//! Everything here is read with `git`, and pull requests with the GitHub CLI when it is
//! signed in. Nothing runs through a shell, and every branch name is checked before it
//! reaches `git`.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::publish::{self, GhState, GithubRepo, PrStatus, Remote};

/// How deep under the project to look for nested repositories.
const MAX_DEPTH: usize = 2;
/// A folder of hundreds of checkouts is not a project; stop listing well before that.
const MAX_REPOS: usize = 24;
/// Folders that are never a repository worth showing, and are expensive to walk.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "Pods",
    "venv",
    "__pycache__",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoKind {
    /// The project folder itself.
    Project,
    /// Listed in the project's `.gitmodules`.
    Submodule,
    /// A separate repository inside the project folder.
    Nested,
}

/// One repository and the state of its checkout.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RepoSummary {
    /// Relative to the project root; empty for the project itself.
    pub path: String,
    /// `owner/repo` on GitHub, else the folder's name.
    pub name: String,
    pub kind: RepoKind,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Files changed in the checkout, staged or not, untracked included.
    pub changed: u32,
    pub has_commits: bool,
    pub remote: Option<Remote>,
}

impl RepoSummary {
    pub fn github(&self) -> Option<&GithubRepo> {
        self.remote.as_ref().and_then(|r| r.github.as_ref())
    }
}

/// The repositories in a project: the folder itself first, then the rest by path.
pub async fn discover(project_root: &Path) -> Vec<RepoSummary> {
    let root = project_root.to_path_buf();
    let found = tokio::task::spawn_blocking(move || find_repos(&root))
        .await
        .unwrap_or_default();
    let submodules = submodule_paths(project_root).await;

    let mut repos = Vec::new();
    for relative in found {
        let kind = if relative.as_os_str().is_empty() {
            RepoKind::Project
        } else if submodules.iter().any(|s| s == &relative) {
            RepoKind::Submodule
        } else {
            RepoKind::Nested
        };
        if let Ok(summary) = summarize(project_root, &relative, kind).await {
            repos.push(summary);
        }
    }
    repos
}

/// Repositories under `root`, as paths relative to it, root first.
fn find_repos(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if root.join(".git").exists() {
        found.push(PathBuf::new());
    }
    let mut frontier = vec![(PathBuf::new(), 0usize)];
    while let Some((relative, depth)) = frontier.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root.join(&relative)) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                (!name.starts_with('.') && !SKIP.contains(&name.as_str()))
                    .then(|| relative.join(name))
            })
            .collect();
        children.sort();
        for child in children {
            if root.join(&child).join(".git").exists() {
                found.push(child.clone());
                if found.len() >= MAX_REPOS {
                    return sorted(found);
                }
            }
            frontier.push((child, depth + 1));
        }
    }
    sorted(found)
}

fn sorted(mut found: Vec<PathBuf>) -> Vec<PathBuf> {
    found.sort();
    found
}

async fn submodule_paths(project_root: &Path) -> Vec<PathBuf> {
    if !project_root.join(".gitmodules").exists() {
        return Vec::new();
    }
    publish::run(
        project_root,
        "git",
        &[
            "config",
            "--file",
            ".gitmodules",
            "--get-regexp",
            r"^submodule\..*\.path$",
        ],
        None,
    )
    .await
    .map(|out| {
        out.lines()
            .filter_map(|line| line.split_once(' ').map(|(_, path)| PathBuf::from(path)))
            .collect()
    })
    .unwrap_or_default()
}

async fn summarize(project_root: &Path, relative: &Path, kind: RepoKind) -> Result<RepoSummary> {
    let dir = project_root.join(relative);
    let status = publish::run(
        &dir,
        "git",
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ],
        None,
    )
    .await?;
    let parsed = parse_status(&status);
    let remote = publish::remote(&dir).await.ok().flatten();
    let folder = if relative.as_os_str().is_empty() {
        project_root
    } else {
        relative
    }
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_default();
    let name = remote
        .as_ref()
        .and_then(|r| r.github.as_ref())
        .map(|g| format!("{}/{}", g.owner, g.repo))
        .unwrap_or(folder);
    Ok(RepoSummary {
        path: relative.to_string_lossy().to_string(),
        name,
        kind,
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        changed: parsed.changed,
        has_commits: parsed.has_commits,
        remote,
    })
}

#[derive(Debug, Default, PartialEq)]
struct CheckoutStatus {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changed: u32,
    has_commits: bool,
}

/// `git status --porcelain=v2 --branch`: the branch headers, then one line per change.
fn parse_status(out: &str) -> CheckoutStatus {
    let mut status = CheckoutStatus {
        has_commits: true,
        ..Default::default()
    };
    for line in out.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => status.has_commits = value != "(initial)",
                "branch.head" if value != "(detached)" => status.branch = Some(value.into()),
                "branch.upstream" => status.upstream = Some(value.into()),
                "branch.ab" => {
                    for part in value.split_whitespace() {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
        } else if !line.trim().is_empty() {
            status.changed += 1;
        }
    }
    status
}

/// A local branch.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream was deleted on the remote (after its pull request merged, usually).
    pub gone: bool,
    /// Unix seconds of the tip commit.
    pub updated: i64,
    pub subject: String,
    /// Already contained in the checked-out branch, so deleting it loses nothing.
    pub merged: bool,
    /// The worker that made it, for `harness/<worker>` branches.
    pub worker: Option<String>,
}

const FIELD: char = '\u{1f}';

pub async fn branches(repo: &Path) -> Result<Vec<BranchInfo>> {
    let format = [
        "%(refname:short)",
        "%(HEAD)",
        "%(upstream:short)",
        "%(upstream:track,nobracket)",
        "%(committerdate:unix)",
        "%(contents:subject)",
    ]
    .join("%1f");
    let listed = publish::run(
        repo,
        "git",
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={format}"),
            "refs/heads",
        ],
        None,
    )
    .await?;
    // A repository with no commits has nothing merged into anything.
    let merged = publish::run(
        repo,
        "git",
        &["branch", "--merged", "HEAD", "--format=%(refname:short)"],
        None,
    )
    .await
    .unwrap_or_default();
    let merged: Vec<&str> = merged.lines().map(str::trim).collect();
    Ok(parse_branches(&listed, &merged))
}

fn parse_branches(listed: &str, merged: &[&str]) -> Vec<BranchInfo> {
    listed
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD).collect();
            let [name, head, upstream, track, updated, subject] = fields[..] else {
                return None;
            };
            let mut info = BranchInfo {
                name: name.to_string(),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead: 0,
                behind: 0,
                gone: track == "gone",
                updated: updated.parse().unwrap_or(0),
                subject: subject.to_string(),
                merged: head != "*" && merged.contains(&name),
                worker: name
                    .strip_prefix(crate::isolation::BRANCH_PREFIX)
                    .and_then(|rest| rest.strip_prefix('/'))
                    .map(str::to_string),
            };
            for part in track.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    info.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    info.behind = n.parse().unwrap_or(0);
                }
            }
            Some(info)
        })
        .collect()
}

/// An open pull request on the repository's GitHub remote.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head: String,
    pub base: String,
    pub author: String,
    pub draft: bool,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `None` when not required.
    pub review: Option<String>,
    pub checks: PrStatus,
    pub updated_at: String,
}

/// Pull requests, or why there are none to show.
#[derive(Debug, Clone, Serialize)]
pub struct PullRequestList {
    pub gh: GhState,
    pub items: Vec<PullRequestSummary>,
}

pub async fn pull_requests(repo: &Path) -> Result<PullRequestList> {
    let gh = publish::gh_state(repo).await;
    if gh != GhState::Ready {
        return Ok(PullRequestList {
            gh,
            items: Vec::new(),
        });
    }
    let out = publish::run(
        repo,
        "gh",
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "40",
            "--json",
            "number,title,url,headRefName,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,updatedAt,state",
        ],
        None,
    )
    .await?;
    Ok(PullRequestList {
        gh,
        items: parse_pull_requests(&serde_json::from_str(&out).context("reading gh's list")?),
    })
}

fn parse_pull_requests(value: &serde_json::Value) -> Vec<PullRequestSummary> {
    let text = |item: &serde_json::Value, key: &str| item[key].as_str().unwrap_or("").to_string();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(PullRequestSummary {
                number: item["number"].as_u64()?,
                title: text(item, "title"),
                url: text(item, "url"),
                head: text(item, "headRefName"),
                base: text(item, "baseRefName"),
                author: item["author"]["login"].as_str().unwrap_or("").to_string(),
                draft: item["isDraft"].as_bool().unwrap_or(false),
                review: item["reviewDecision"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                checks: publish::parse_status(item),
                updated_at: text(item, "updatedAt"),
            })
        })
        .collect()
}

/// A branch name `git` would accept, that can't be read as an option.
pub async fn check_branch_name(repo: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.len() > 200 {
        bail!("`{name}` isn't a usable branch name");
    }
    publish::run(repo, "git", &["check-ref-format", "--branch", name], None)
        .await
        .map(|_| ())
        .map_err(|_| anyhow::anyhow!("`{name}` isn't a valid branch name"))
}

async fn existing_branch(repo: &Path, name: &str) -> Result<BranchInfo> {
    check_branch_name(repo, name).await?;
    branches(repo)
        .await?
        .into_iter()
        .find(|b| b.name == name)
        .with_context(|| format!("there's no branch `{name}`"))
}

/// Check out another local branch. Refused with uncommitted changes, which would either
/// block the switch or follow it onto the other branch without the person noticing.
pub async fn switch_branch(repo: &Path, name: &str) -> Result<()> {
    let branch = existing_branch(repo, name).await?;
    if branch.current {
        return Ok(());
    }
    let status = parse_status(
        &publish::run(repo, "git", &["status", "--porcelain=v2", "--branch"], None).await?,
    );
    if status.changed > 0 {
        bail!(
            "{} uncommitted change(s) here — commit or stash them before switching branches",
            status.changed
        );
    }
    publish::run(repo, "git", &["switch", "--no-guess", &branch.name], None).await?;
    Ok(())
}

/// Start a branch from the current commit and switch to it. Uncommitted changes come
/// along, which is the usual reason to make one.
pub async fn create_branch(repo: &Path, name: &str) -> Result<()> {
    check_branch_name(repo, name).await?;
    if branches(repo).await?.iter().any(|b| b.name == name) {
        bail!("a branch called `{name}` already exists");
    }
    publish::run(repo, "git", &["switch", "--create", name], None).await?;
    Ok(())
}

/// Delete a branch that is already merged into the current one. `git branch -d` would
/// refuse anything else as well; checking first gives a clearer reason.
pub async fn delete_branch(repo: &Path, name: &str) -> Result<()> {
    let branch = existing_branch(repo, name).await?;
    if branch.current {
        bail!("`{name}` is checked out — switch to another branch first");
    }
    if !branch.merged {
        bail!("`{name}` has commits that aren't on the current branch, so it was kept");
    }
    publish::run(
        repo,
        "git",
        &["branch", "--delete", "--", &branch.name],
        None,
    )
    .await?;
    Ok(())
}

/// Push a branch to the repository's remote, setting it as the upstream.
pub async fn push_branch(repo: &Path, name: &str) -> Result<String> {
    let branch = existing_branch(repo, name).await?;
    let remote = publish::remote(repo)
        .await?
        .context("this repository has no remote to push to")?;
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch.name);
    publish::run(
        repo,
        "git",
        &["push", "--set-upstream", &remote.name, &refspec],
        None,
    )
    .await?;
    Ok(remote.name)
}

/// Check out a pull request's branch with `gh`. The same rule as switching applies.
pub async fn checkout_pull_request(repo: &Path, number: u64) -> Result<()> {
    let status = parse_status(
        &publish::run(repo, "git", &["status", "--porcelain=v2", "--branch"], None).await?,
    );
    if status.changed > 0 {
        bail!(
            "{} uncommitted change(s) here — commit or stash them before checking out a pull request",
            status.changed
        );
    }
    publish::run(repo, "gh", &["pr", "checkout", &number.to_string()], None).await?;
    Ok(())
}

/// The repository at `relative` under the project, refusing anything outside it.
pub fn resolve(project_root: &Path, relative: &str) -> Result<PathBuf> {
    let root = project_root
        .canonicalize()
        .context("the project folder is gone")?;
    let candidate = root
        .join(relative)
        .canonicalize()
        .with_context(|| format!("no folder `{relative}` in the project"))?;
    if !candidate.starts_with(&root) {
        bail!("`{relative}` is outside the project");
    }
    if !candidate.join(".git").exists() {
        bail!("`{relative}` isn't a git repository");
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_status_gives_branch_tracking_and_changes() {
        let out = "# branch.oid 1a2b\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.rs\n? notes.txt\n";
        assert_eq!(
            parse_status(out),
            CheckoutStatus {
                branch: Some("main".into()),
                upstream: Some("origin/main".into()),
                ahead: 2,
                behind: 1,
                changed: 2,
                has_commits: true,
            }
        );

        let fresh = parse_status("# branch.oid (initial)\n# branch.head main\n");
        assert!(!fresh.has_commits);
        assert_eq!(fresh.upstream, None);

        let detached = parse_status("# branch.oid 1a2b\n# branch.head (detached)\n");
        assert_eq!(detached.branch, None);
    }

    #[test]
    fn branch_listing_marks_current_merged_tracking_and_workers() {
        let f = FIELD;
        let listed = format!(
            "main{f}*{f}origin/main{f}ahead 1{f}1760000000{f}Initial\n\
             harness/w-3{f} {f}{f}{f}1750000000{f}Add retries\n\
             old{f} {f}origin/old{f}gone{f}1700000000{f}Fix\n\
             feature{f} {f}origin/feature{f}ahead 2, behind 3{f}1755000000{f}WIP\n"
        );
        let branches = parse_branches(&listed, &["main", "harness/w-3", "old"]);
        assert_eq!(branches.len(), 4);

        let main = &branches[0];
        assert!(main.current);
        assert!(
            !main.merged,
            "the current branch is never offered for deletion"
        );
        assert_eq!(main.ahead, 1);

        let worker = &branches[1];
        assert_eq!(worker.worker.as_deref(), Some("w-3"));
        assert!(worker.merged);
        assert_eq!(worker.upstream, None);

        assert!(branches[2].gone);
        assert_eq!((branches[3].ahead, branches[3].behind), (2, 3));
        assert!(!branches[3].merged);
    }

    #[test]
    fn pull_requests_are_read_with_their_checks() {
        let value = serde_json::json!([{
            "number": 12,
            "title": "Add retries",
            "url": "https://github.com/z/proj/pull/12",
            "headRefName": "meridian/builder-add-retries",
            "baseRefName": "main",
            "author": { "login": "zavier" },
            "isDraft": true,
            "reviewDecision": "",
            "updatedAt": "2026-10-20T10:00:00Z",
            "state": "OPEN",
            "statusCheckRollup": [
                { "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE" },
                { "context": "deploy", "state": "PENDING" }
            ]
        }, { "title": "no number, skipped" }]);
        let prs = parse_pull_requests(&value);
        assert_eq!(prs.len(), 1);
        let pr = &prs[0];
        assert_eq!(pr.number, 12);
        assert_eq!(pr.author, "zavier");
        assert!(pr.draft);
        assert_eq!(pr.review, None);
        assert_eq!(
            (pr.checks.passed, pr.checks.failed, pr.checks.pending),
            (1, 1, 1)
        );
        assert_eq!(pr.checks.failing, ["lint"]);
    }

    async fn git(dir: &Path, args: &[&str]) {
        let out = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    async fn repo_at(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]).await;
        git(dir, &["commit", "-q", "--allow-empty", "-m", "Initial"]).await;
    }

    #[tokio::test]
    async fn a_project_lists_itself_and_the_repositories_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo_at(root).await;
        git(
            root,
            &["remote", "add", "origin", "git@github.com:z/proj.git"],
        )
        .await;
        repo_at(&root.join("services/api")).await;
        repo_at(&root.join("web")).await;
        // Not worth walking, and never a repository to show.
        repo_at(&root.join("node_modules/dep")).await;
        repo_at(&root.join(".harness/worktrees/w-1")).await;
        // Too deep.
        repo_at(&root.join("a/b/c")).await;
        std::fs::write(root.join("web/new.txt"), "x").unwrap();

        let repos = discover(root).await;
        let paths: Vec<&str> = repos.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["", "services/api", "web"]);

        let project = &repos[0];
        assert_eq!(project.kind, RepoKind::Project);
        assert_eq!(project.name, "z/proj");
        assert_eq!(project.branch.as_deref(), Some("main"));
        assert_eq!(project.github().unwrap().repo, "proj");

        assert_eq!(repos[1].kind, RepoKind::Nested);
        assert_eq!(repos[1].name, "api");
        assert_eq!(repos[2].changed, 1);
    }

    #[tokio::test]
    async fn branches_are_made_switched_and_cleaned_up_safely() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        repo_at(repo).await;

        create_branch(repo, "feature/retries").await.unwrap();
        assert!(create_branch(repo, "feature/retries").await.is_err());
        for bad in ["-rf", "has space", "a..b", ""] {
            assert!(create_branch(repo, bad).await.is_err(), "{bad}");
        }
        let current = branches(repo).await.unwrap();
        assert!(current
            .iter()
            .any(|b| b.name == "feature/retries" && b.current));

        // Uncommitted work blocks a switch rather than travelling with it.
        std::fs::write(repo.join("wip.txt"), "x").unwrap();
        let err = switch_branch(repo, "main").await.unwrap_err().to_string();
        assert!(err.contains("uncommitted"), "{err}");
        std::fs::remove_file(repo.join("wip.txt")).unwrap();
        switch_branch(repo, "main").await.unwrap();
        assert!(switch_branch(repo, "nope").await.is_err());

        // Merged (no commits of its own): deletable. With its own commit: kept.
        delete_branch(repo, "feature/retries").await.unwrap();
        create_branch(repo, "spike").await.unwrap();
        git(repo, &["commit", "-q", "--allow-empty", "-m", "Spike"]).await;
        switch_branch(repo, "main").await.unwrap();
        let err = delete_branch(repo, "spike").await.unwrap_err().to_string();
        assert!(err.contains("kept"), "{err}");
        let err = delete_branch(repo, "main").await.unwrap_err().to_string();
        assert!(err.contains("checked out"), "{err}");
    }

    #[test]
    fn only_repositories_inside_the_project_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("inner/.git")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("outside/.git")).unwrap();
        std::fs::create_dir_all(root.join("plain")).unwrap();

        assert!(resolve(&root, "").is_ok());
        assert!(resolve(&root, "inner").is_ok());
        assert!(resolve(&root, "../outside").is_err());
        assert!(resolve(&root, "plain").is_err());
        assert!(resolve(&root, "missing").is_err());
    }
}
