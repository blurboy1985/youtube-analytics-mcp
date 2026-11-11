/** Minimal KV interface used by pinned workers-oauth-provider 1.2.4.
 * Backed by strongly consistent SQLite, NOT Workers KV. All provider operations
 * run under AuthStore.blockConcurrencyWhile, making multi-step consumption and
 * refresh rotation serial. Do not expose this adapter outside that boundary.
 */
export class SQLiteOAuthStorage {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_records (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER, metadata TEXT
    ); CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_records(expires);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_expiry ON rate_limits(expires);`);
  }
  async get<T = string>(key: string, options?: {type?: string} | string): Promise<T | string | null> {
    const row = this.sql.exec<{value: string}>(
      'SELECT value FROM oauth_records WHERE key = ? AND (expires IS NULL OR expires > ?)', key, Math.floor(Date.now()/1000)
    ).toArray()[0];
    if (!row) return null;
    const type = typeof options === 'string' ? options : options?.type;
    if (type && type !== 'text' && type !== 'json') throw new Error('Unsupported storage read');
    return type === 'json' ? JSON.parse(row.value) as T : row.value;
  }
  async put(key: string, value: string, options?: {expiration?: number; expirationTtl?: number; metadata?: unknown}) {
    if (typeof value !== 'string') throw new Error('Unsupported storage write');
    const expires = options?.expiration ?? (options?.expirationTtl === undefined ? null : Math.floor(Date.now()/1000) + options.expirationTtl);
    this.sql.exec('INSERT INTO oauth_records(key,value,expires,metadata) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires,metadata=excluded.metadata',
      key, value, expires, options?.metadata === undefined ? null : JSON.stringify(options.metadata));
  }
  async delete(key: string) { this.sql.exec('DELETE FROM oauth_records WHERE key = ?', key); }
  async list(options: {prefix?: string; limit?: number; cursor?: string} = {}) {
    const prefix = options.prefix ?? '';
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    const after = options.cursor ? decodeURIComponent(options.cursor) : '';
    const rows = this.sql.exec<{key:string; expires:number|null; metadata:string|null}>(
      `SELECT key,expires,metadata FROM oauth_records WHERE key >= ? AND key < ? AND key > ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?`,
      prefix, prefix+'\uffff', after, Math.floor(Date.now()/1000), limit+1).toArray();
    const page = rows.slice(0,limit);
    return {keys: page.map(row => ({name:row.key, ...(row.expires===null?{}:{expiration:row.expires}), ...(row.metadata===null?{}:{metadata:JSON.parse(row.metadata)})})),
      list_complete:rows.length <= limit, cursor:rows.length > limit ? encodeURIComponent(page[page.length-1].key) : ''};
  }
  allow(key: string, limit: number, period: number): boolean {
    const now=Math.floor(Date.now()/1000), bucket=Math.floor(now/period);
    const row=this.sql.exec<{count:number}>(`INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`,key+':'+bucket,(bucket+1)*period).one();
    return row.count <= limit;
  }
  cleanup() {
    const now=Math.floor(Date.now()/1000);
    this.sql.exec('DELETE FROM oauth_records WHERE expires IS NOT NULL AND expires <= ?', now);
    this.sql.exec('DELETE FROM rate_limits WHERE expires <= ?', now);
  }
  deleteUser(userId: string) {
    // User identifiers are server-verified YouTube IDs, never request parameters.
    for (const prefix of [`grant:${userId}:`, `token:${userId}:`, `used-refresh:${userId}:`])
      this.sql.exec('DELETE FROM oauth_records WHERE key >= ? AND key < ?',prefix,prefix+'\uffff');
  }
}
