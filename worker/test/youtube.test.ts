import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPES, SafeError, TOOLS, refreshGoogle, identifyChannel, runTool } from '../src/youtube.ts';
const A = `UC${'a'.repeat(22)}`;
const B = `UC${'b'.repeat(22)}`;
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret-client' };
const props = { channelId: A, googleRefreshToken: 'secret-refresh' };
const dates = { start_date: '2025-01-01', end_date: '2025-01-28' };
const videoId = 'abcdefghijk';
const token = { access_token: 'secret-access', token_type: 'Bearer', scope: GOOGLE_SCOPES.join(' ') };
const channel = (id = A) => ({ items: [{ id, snippet: { title: 'Untrusted title' }, statistics: { viewCount: '123', hiddenSubscriberCount: true } }] });
const report = { columnHeaders: [{ name: 'views', columnType: 'METRIC', dataType: 'INTEGER' }], rows: [[42]], secret: 'must-not-copy' };
function mock(responses: unknown[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    calls.push({ url, init: init! });
    assert.ok(responses.length, 'Unexpected request');
    const next = responses.shift();
    return next instanceof Response ? next : Response.json(next);
  }) as typeof fetch;
  return { calls, fetcher };
}
test('seven read-only tools expose strict schemas', () => {
  assert.equal(TOOLS.length, 7);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});
test('refresh validates exact scopes and never sends a bearer to token endpoint', async () => {
  const m = mock([{ ...token, refresh_token: 'rotated' }]);
  assert.deepEqual(await refreshGoogle(env, props.googleRefreshToken, m.fetcher), { access_token: 'secret-access', refresh_token: 'rotated' });
  assert.equal(m.calls[0].url.href, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(String(m.calls[0].init.body));
  assert.equal(body.get('refresh_token'), props.googleRefreshToken);
  assert.equal(m.calls[0].init.method, 'POST');
});
test('rejects expanded, reduced, omitted and malformed scopes', async () => {
  for (const scope of [GOOGLE_SCOPES.join(' ') + ' https://www.googleapis.com/auth/youtube', GOOGLE_SCOPES[0], undefined, [], '']) {
    const m = mock([{ ...token, scope }]);
    await assert.rejects(refreshGoogle(env, props.googleRefreshToken, m.fetcher), SafeError);
    assert.equal(m.calls.length, 1);
  }
});
test('fresh channel lookup prevents cross-user grants on every invocation', async () => {
  const m = mock([token, channel(A), token, channel(B)]);
  const first = await runTool('connected_channel', {}, props, env, m.fetcher);
  assert.equal((first as { id: string }).id, A);
  await assert.rejects(runTool('connected_channel', {}, props, env, m.fetcher), /channel changed/);
  assert.equal(m.calls.length, 4);
  assert.equal(m.calls[1].url.searchParams.get('mine'), 'true');
  assert.equal(m.calls[3].url.searchParams.get('mine'), 'true');
});
test('rejects multiple channels and paginated owner ambiguity', async () => {
  for (const data of [{ items: [...channel(A).items, ...channel(B).items] }, { ...channel(A), nextPageToken: 'more' }, { items: [] }]) {
    await assert.rejects(identifyChannel('token', mock([data]).fetcher), SafeError);
  }
});
test('owner checks occur before reports and videos', async () => {
  const m = mock([token, channel(B)]);
  await assert.rejects(runTool('video_performance', { ...dates, video_id: videoId }, props, env, m.fetcher), /channel changed/);
  assert.equal(m.calls.length, 2);
});
test('cross-owner videos are refused without calling analytics', async () => {
  const m = mock([token, channel(A), { items: [{ id: videoId, snippet: { channelId: B } }] }]);
  await assert.rejects(runTool('video_performance', { ...dates, video_id: videoId }, props, env, m.fetcher), /does not belong/);
  assert.equal(m.calls.length, 3);
});
test('daily video request uses supported basic metrics and verified video filter', async () => {
  const m = mock([token, channel(A), { items: [{ id: videoId, snippet: { channelId: A } }] }, report]);
  const result = await runTool('video_performance', { ...dates, video_id: videoId }, props, env, m.fetcher);
  const query = m.calls[3].url.searchParams;
  assert.equal(query.get('metrics'), 'views,estimatedMinutesWatched,averageViewDuration');
  assert.equal(query.get('filters'), `video==${videoId}`);
  assert.equal(query.get('ids'), 'channel==MINE');
  assert.equal(query.get('dimensions'), 'day');
  assert.deepEqual((result as { rows: unknown }).rows, [[42]]);
  assert.ok(!JSON.stringify(result).includes('must-not-copy'));
  assert.ok(!JSON.stringify(result).includes('secret-access'));
});
test('strict inputs reject before any upstream call', async () => {
  const bad: [string, unknown][] = [
    ['unknown', {}], ['connected_channel', { start_date: '2025-01-01' }], ['channel_overview', { filters: 'video==other' }],
    ['channel_overview', null], ['channel_overview', []], ['channel_overview', { ...dates, start_date: '2025-02-30' }],
    ['channel_overview', { ...dates, start_date: '20250101' }], ['channel_overview', { ...dates, start_date: false }],
    ['channel_overview', { start_date: '2004-12-31', end_date: '2005-01-01' }],
    ['channel_overview', { start_date: '2025-01-01', end_date: '2026-01-03' }],
    ['channel_overview', { start_date: '2025-02-01', end_date: '2025-01-01' }],
    ['channel_overview', { start_date: '2999-01-01', end_date: '2999-01-02' }],
    ...[0, 51, 1.5, true, '10', null].map(limit => ['top_videos', { ...dates, limit }] as [string, unknown]),
    ['video_performance', { ...dates, video_id: 'https://youtube.com/watch?v=abcdefghijk' }],
    ['audience_retention', { ...dates }],
  ];
  for (const [name, args] of bad) {
    const m = mock([]);
    await assert.rejects(runTool(name, args, props, env, m.fetcher), SafeError);
    assert.equal(m.calls.length, 0);
  }
});
test('367 inclusive days permitted; defaults and top video limit remain bounded', async () => {
  const m = mock([token, channel(), report]);
  await runTool('top_videos', { start_date: '2024-01-01', end_date: '2025-01-01', limit: 50 }, props, env, m.fetcher);
  assert.equal(m.calls[2].url.searchParams.get('maxResults'), '50');
  const n = mock([token, channel(), report]);
  const result = await runTool('channel_overview', {}, props, env, n.fetcher) as { requested_range: { start: string; end: string } };
  assert.equal(Date.parse(result.requested_range.end) - Date.parse(result.requested_range.start), 27 * 86400000);
});
test('HTTP, redirects, parser and network errors disclose no upstream bodies or tokens', async () => {
  for (const response of [new Response('secret-access secret-refresh', { status: 401 }), new Response('secret-body', { status: 403 }), new Response('secret-body', { status: 429 }), new Response('secret-body', { status: 302 }), new Response('secret-body', { status: 500 }), new Response('secret-body')]) {
    const m = mock([response]);
    await assert.rejects(refreshGoogle(env, props.googleRefreshToken, m.fetcher), error => error instanceof SafeError && !/secret/.test(error.message));
    assert.equal(m.calls.length, 1);
  }
  await assert.rejects(refreshGoogle(env, props.googleRefreshToken, (async () => { throw new Error('secret-access'); }) as typeof fetch), error => error instanceof SafeError && !/secret/.test(error.message));
});
test('response body limit enforced for declared and streamed size', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': '1048577' } }), new Response('x'.repeat(1048577))]) {
    await assert.rejects(refreshGoogle(env, props.googleRefreshToken, mock([response]).fetcher), /exceeds the allowed size/);
  }
});
test('structured and overly long output cells are rejected; omitted rows remain empty', async () => {
  for (const rows of [[[{}]], [['x'.repeat(1025)]], [[1, 2]]]) {
    const m = mock([token, channel(), { ...report, rows }]);
    await assert.rejects(runTool('channel_overview', dates, props, env, m.fetcher), /invalid report rows/);
  }
  const m = mock([token, channel(), { columnHeaders: report.columnHeaders }]);
  const result = await runTool('channel_overview', dates, props, env, m.fetcher) as { rows: unknown };
  assert.deepEqual(result.rows, []);
});
test('expired authorization fails safely without retries or analytics reads', async () => {
  const revoked = mock([Response.json({ error: 'invalid_grant', error_description: 'secret-refresh' }, { status: 400 })]);
  await assert.rejects(runTool('channel_overview', dates, props, env, revoked.fetcher), error => error instanceof SafeError && !/secret/.test(error.message));
  assert.equal(revoked.calls.length, 1);
  const expired = mock([token, new Response('secret-access', { status: 401 })]);
  await assert.rejects(runTool('channel_overview', dates, props, env, expired.fetcher), /authorization failed/);
  assert.equal(expired.calls.length, 2);
});
