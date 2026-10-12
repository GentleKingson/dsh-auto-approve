// Online provenance for the community casebook. Ordinary tests stay offline;
// this module is only used by `evaluate-community-cases.mjs --verify-sources`.
// Hash scope matches the public corpus: the UTF-8 text of one issue,
// discussion or comment body, never the API envelope.
import { createHash } from 'node:crypto'

const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

export function parseSourceUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|discussions)\/(\d+)$/.exec(url)
  if (match === null) throw new Error(`unsupported source URL: ${url}`)
  return { owner: match[1], repo: match[2], kind: match[3] === 'issues' ? 'issue' : 'discussion', number: Number(match[4]) }
}

async function request(url, init, token) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-auto-approve-source-check', ...init?.headers }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function issueTexts({ owner, repo, number }, token) {
  const issue = await request(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {}, token)
  const comments = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await request(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`, {}, token)
    comments.push(...batch)
    if (batch.length < 100) break
  }
  return {
    title: issue.title, createdAt: issue.created_at, updatedAt: issue.updated_at, state: issue.state,
    body: issue.body ?? '',
    comments: comments.map(comment => ({ id: comment.id, url: comment.html_url, body: comment.body ?? '' })),
  }
}

async function discussionTexts({ owner, repo, number }, token) {
  if (!token) throw new Error('discussions need GITHUB_TOKEN (GraphQL)')
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){
    title createdAt updatedAt body closed
    comments(first:100){nodes{id url body replies(first:100){nodes{id url body}}}}}}}`
  const data = await request('https://api.github.com/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, repo, number } }),
  }, token)
  const discussion = data?.data?.repository?.discussion
  if (!discussion) throw new Error(`${owner}/${repo}#${number}: discussion not found ${JSON.stringify(data?.errors ?? null)}`)
  const comments = discussion.comments.nodes.flatMap(node => [node, ...node.replies.nodes])
  return {
    title: discussion.title, createdAt: discussion.createdAt, updatedAt: discussion.updatedAt, state: discussion.closed ? 'closed' : 'open',
    body: discussion.body ?? '',
    comments: comments.map(comment => ({ id: comment.id, url: comment.url, body: comment.body ?? '' })),
  }
}

/** Fetch one source and return its hashed texts (body first, then comments). */
export async function fetchSource(source, token) {
  const ref = parseSourceUrl(source.url)
  const texts = ref.kind === 'issue' ? await issueTexts(ref, token) : await discussionTexts(ref, token)
  return {
    ...texts,
    bodySha256: sha256(texts.body),
    parts: [{ location: 'body', url: source.url, text: texts.body, sha256: sha256(texts.body) },
      ...texts.comments.map(comment => ({ location: `comment:${comment.id}`, url: comment.url, text: comment.body, sha256: sha256(comment.body) }))],
  }
}

/** 1-based line of the first occurrence of excerpt in text, or 0. */
export function excerptLine(text, excerpt) {
  const offset = text.indexOf(excerpt)
  return offset < 0 ? 0 : text.slice(0, offset).split('\n').length
}
