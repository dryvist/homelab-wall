import type { Page, Route } from '@playwright/test';

// mc5: fixture shape for the public GitHub API (site/mc5/mc5.js fetches api.github.com directly,
// no token) — routed below so CI never hits the real network. Event/repo/release fields are only
// the subset mc5.js reads.
export const GH_ORG = 'dryvist';
export const ghEvents = [
  { id: 'e1', type: 'PushEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/wall-repo` }, payload: { commits: [{}, {}] }, created_at: new Date(Date.now() - 30_000).toISOString() },
  { id: 'e2', type: 'PullRequestEvent', actor: { login: 'hubot' }, repo: { name: `${GH_ORG}/proxmox-repo` }, payload: { action: 'opened', pull_request: { merged: false } }, created_at: new Date(Date.now() - 90_000).toISOString() },
  { id: 'e3', type: 'PullRequestEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/ansible-repo` }, payload: { action: 'closed', pull_request: { merged: true } }, created_at: new Date(Date.now() - 200_000).toISOString() },
  { id: 'e4', type: 'ReleaseEvent', actor: { login: 'hubot' }, repo: { name: `${GH_ORG}/wall-repo` }, payload: {}, created_at: new Date(Date.now() - 400_000).toISOString() },
  { id: 'e5', type: 'DeploymentStatusEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/nix-repo` }, payload: {}, created_at: new Date(Date.now() - 500_000).toISOString() },
];
export const ghRepos = ['wall-repo', 'proxmox-repo', 'ansible-repo', 'nix-repo', 'cribl-repo', 'docs-repo'].map((name, i) => ({
  name, private: false, pushed_at: new Date(Date.now() - i * 86400_000).toISOString(),
}));

export async function mockGithub(page: Page) {
  await page.route('https://api.github.com/orgs/*/events', (r: Route) => r.fulfill({ json: ghEvents, headers: { etag: '"fixture-events"' } }));
  await page.route('https://api.github.com/orgs/*/repos**', (r: Route) => r.fulfill({ json: ghRepos, headers: { etag: '"fixture-repos"' } }));
  await page.route('https://api.github.com/repos/*/*/releases**', (r: Route) => r.fulfill({
    json: [{ tag_name: 'v1.0.0', published_at: new Date(Date.now() - 3600_000).toISOString() }],
  }));
}

// mc6: fixture rows for /api/words (site/mc6/mc6.js fetches it directly, ClickHouse FORMAT
// JSON: n is a UInt64 serialized as a STRING). Sources with no rows here —
// antigravity and opencode — must render explicit NO FEED tiles, never stand-in words. The
// 'minion' row is deliberately from a source mc6 has never heard of: unknown sources are
// handled generically, same tile treatment, label upper-cased.
export const words = [
  { source: 'user', word: 'deploy', n: '412' },
  { source: 'user', word: 'backup', n: '187' },
  { source: 'user', word: 'certificate', n: '55' },
  { source: 'claude', word: 'refactor', n: '301' },
  { source: 'claude', word: 'fixture', n: '96' },
  { source: 'claude', word: 'typescript', n: '41' },
  { source: 'codex', word: 'benchmark', n: '77' },
  { source: 'codex', word: 'cache', n: '12' },
  // 'deploy' is held by the operator and codex: a word shared between a prompt source and an agent.
  { source: 'codex', word: 'deploy', n: '33' },
  { source: 'zcode', word: 'prometheus', n: '64' },
  { source: 'zcode', word: 'playwright', n: '29' },
  { source: 'minion', word: 'banana', n: '9' },
];

// opts.failWords turns the words feed into a hard failure (HTTP 500) instead of answering it;
// opts.emptyWords makes it succeed with zero rows — genuinely "no words yet".
export async function mockWords(page: Page, opts: { failWords?: boolean; emptyWords?: boolean } = {}) {
  await page.route('**/api/words', (r: Route) => {
    if (opts.failWords) return r.fulfill({ status: 500, json: { error: 'forced failure' } });
    const data = opts.emptyWords ? [] : words;
    return r.fulfill({ json: { meta: [{ name: 'source', type: 'String' }, { name: 'word', type: 'String' }, { name: 'n', type: 'UInt64' }], data, rows: data.length } });
  });
}

