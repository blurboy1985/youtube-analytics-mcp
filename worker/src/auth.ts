import { DurableObject } from 'cloudflare:workers';
import { OAuthAuthorizationServer, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import type { ValidatedAccessToken } from '@cloudflare/workers-oauth-provider';
import { SQLiteOAuthStorage } from './storage.ts';
import { GOOGLE_SCOPES, identifyChannel, SafeError } from './youtube.ts';
import type { GrantProps } from './youtube.ts';
import { html, json, escapeHtml } from './web.ts';
import type { Env } from './index.ts';

const SCOPE='youtube:read';
export function launchReady(env: Env): boolean {
  return env.PUBLIC_LAUNCH_READY === 'true' && env.POLICY_APPROVED === 'true' &&
    Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OPERATOR_NAME && env.SUPPORT_EMAIL);
}
async function sha256(value:string) {
 return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
async function googleExchange(env:Env,code:string,verifier:string):Promise<{access_token:string;refresh_token:string}> {
 const response=await fetch('https://oauth2.googleapis.com/token',{
   method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
   body:new URLSearchParams({grant_type:'authorization_code',client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,code_verifier:verifier,redirect_uri:env.BASE_URL+'/google/callback'})
 });
 const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let total=0;
 if(!reader)throw new SafeError('Google authorization did not return a response.');
 while(true){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>16384){await reader.cancel();throw new SafeError('Google authorization response was invalid.');}chunks.push(value);}
 const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let data:Record<string,unknown>;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new SafeError('Google authorization response was invalid.');}
 if(!response.ok || typeof data.access_token!=='string' || typeof data.refresh_token!=='string')throw new SafeError('Google authorization was not completed. Reconnect and approve offline read-only access.');
 const scopes=typeof data.scope==='string'?new Set(data.scope.split(/\s+/)):new Set();
 if(scopes.size!==GOOGLE_SCOPES.length || !GOOGLE_SCOPES.every(s=>scopes.has(s)))throw new SafeError('Google permissions did not match the two required read-only scopes.');
 return {access_token:data.access_token,refresh_token:data.refresh_token};
}

/** One coherent security boundary. This intentionally serializes OAuth operations,
 * not analytics requests. SQLite + blockConcurrencyWhile removes KV's non-atomic
 * get/delete and refresh races. This MVP favors safety over high auth throughput.
 */
export class AuthStore extends DurableObject<Env> {
 private kv:SQLiteOAuthStorage;
 private authorization:OAuthAuthorizationServer<{OAUTH_KV:SQLiteOAuthStorage}>;
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);this.kv=new SQLiteOAuthStorage(ctx.storage.sql);
  this.authorization=new OAuthAuthorizationServer({
    issuer:env.BASE_URL,resources:[env.BASE_URL+'/mcp'],scopesSupported:[SCOPE,'offline_access'],
    clientRegistrationEndpoint:'/oauth/register',clientIdMetadataDocumentEnabled:true,
    accessTokenTTL:300,refreshTokenTTL:7*86400,clientRegistrationTTL:30*86400,
    allowTokenExchangeGrant:false,
    // Never print error detail: it can contain callback URLs or credentials.
    onError:()=>undefined,
  });
 }
 private oauth(){return this.authorization.getOAuthApi({OAUTH_KV:this.kv});}
 private async maintain(){this.kv.cleanup();if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+86400000);}
 async alarm(){this.kv.cleanup();await this.ctx.storage.setAlarm(Date.now()+86400000);}
 async fetch(request:Request):Promise<Response>{
  return this.ctx.blockConcurrencyWhile(async()=>{
   if(!launchReady(this.env))return json({error:'service_not_ready'},503);
   await this.maintain();
   const url=new URL(request.url),path=url.pathname;
   const discovery=path==='/.well-known/oauth-authorization-server';
   if(!discovery && !['/authorize','/google/callback','/oauth/token','/oauth/register'].includes(path))return json({error:'not_found'},404);
   if(!discovery){
    const ipKey=await sha256((request.headers.get('CF-Connecting-IP')??'unknown')+':'+new Date().toISOString().slice(0,10));
    const group=path==='/oauth/token'?'token':'login';
    // Refused source traffic must not consume the service-wide budget. Token
    // refresh/revocation has a separate allowance from new login/registration.
    if(!this.kv.allow(group+'-ip:'+ipKey,60,600))return json({error:'rate_limit'},429,{'Retry-After':'600'});
    if(path==='/oauth/register' && !this.kv.allow('register-ip:'+ipKey,5,3600))return json({error:'rate_limit'},429,{'Retry-After':'3600'});
    if(!this.kv.allow(group+'-global',group==='token'?1500:300,3600))return json({error:'rate_limit'},429,{'Retry-After':'3600'});
    if(path==='/oauth/register' && !this.kv.allow('register-global',50,86400))return json({error:'rate_limit'},429,{'Retry-After':'3600'});
   }
   try{
    if(path==='/authorize')return await this.authorize(request);
    if(path==='/google/callback')return await this.callback(request);
    // The authorization-server role does not host a resource handler. Adapt the
    // DO context explicitly; unsupported Worker-only features fail loudly.
    const state=this.ctx;
    const execution:ExecutionContext={
      waitUntil:promise=>state.waitUntil(promise), exports:state.exports,props:{},
      passThroughOnException(){throw new Error('No origin passthrough');},
      mapVirtualHost(){throw new Error('No virtual hosts');},
      get tracing():Tracing{throw new Error('No execution tracing context');},
      abort:reason=>state.abort(reason),
    };
    if(path==='/oauth/token')return await this.tokenEndpoint(request,execution);
    return await this.authorization.fetch(request,{OAUTH_KV:this.kv},execution);
   }catch(error){
    if(error instanceof AuthorizationError && error.redirectTo)return new Response(null,{status:302,headers:{Location:error.redirectTo,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    if(error instanceof AuthorizationError || error instanceof CimdFetchError || error instanceof SafeError)
      return html('Connection not completed','<p>The request expired, was already used, or could not be verified. Start again from your AI client.</p>',400);
    return html('Temporarily unavailable','<p>Authorization could not be completed. Try again later.</p>',503);
   }
  });
 }
 private async tokenEndpoint(request:Request,execution:ExecutionContext):Promise<Response>{
  // The provider allows its immediately previous refresh token for retry recovery.
  // This public service deliberately uses stricter rotation: a successful exchange
  // consumes that refresh token once. All reads/writes are in the same DO lock.
  if(request.method==='OPTIONS')return this.authorization.fetch(request,{OAUTH_KV:this.kv},execution);
  const type=request.headers.get('Content-Type')?.split(';')[0].trim();
  if(request.method!=='POST'||type!=='application/x-www-form-urlencoded')return json({error:'invalid_request'},400);
  const form=new URLSearchParams(await request.clone().text());
  const old=form.get('grant_type')==='refresh_token'?form.get('refresh_token'):null;
  let marker:string|undefined;
  if(old && old.length<=4096){
   const parts=old.split(':');
   if(parts.length===3){
    marker=`used-refresh:${parts[0]}:${parts[1]}:${await sha256(old)}`;
    const consumed=await this.kv.get<{userId:string;grantId:string}>(marker,{type:'json'});
    if(consumed && typeof consumed!=='string'){
     await this.oauth().revokeGrant(consumed.grantId,consumed.userId);
     return json({error:'invalid_grant',error_description:'Refresh token was already used. Reconnect.'},400);
    }
   }
  }
  const response=await this.authorization.fetch(request,{OAUTH_KV:this.kv},execution);
  if(marker && old && response.status===200){
   // A successful provider response proves this token's embedded owner/grant.
   const [userId,grantId]=old.split(':');
   await this.kv.put(marker,JSON.stringify({userId,grantId}),{expirationTtl:7*86400});
  }
  return response;
 }
 private async authorize(request:Request):Promise<Response>{
  const oauth=this.oauth();
  if(request.method==='GET'){
   const parsed=await oauth.parseAuthRequest(request);
   // Require PKCE for every client, not only clients registered as public.
   if(!parsed.codeChallenge || parsed.codeChallengeMethod!=='S256')throw new AuthorizationError('invalid_request',{description:'S256 PKCE required'});
   if(!parsed.scope.includes(SCOPE)||parsed.scope.some(scope=>![SCOPE,'offline_access'].includes(scope)))throw new AuthorizationError('invalid_scope',{description:'Request youtube:read, optionally offline_access'});
   const details=await oauth.describeConsent(parsed),consent=await oauth.beginConsent(parsed);
   const publisher=details.clientDomain?`Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`:'This client registered itself; its name has not been verified.';
   return html('Connect your YouTube channel',`<p><strong>${escapeHtml(details.clientName)}</strong> wants read-only access to your channel reports.</p><p>${publisher} Access will be delivered to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback?'<p><strong>This is an app on your computer. Continue only if you started this connection.</strong></p>':''}<p>This lets the client read your channel identity, public statistics and aggregate YouTube performance. Scope: youtube:read. It cannot change videos or read revenue. Your Google credentials stay server-side. If this client is ChatGPT, results are shared with OpenAI and may be retained in your chats.</p><p>You will choose your own Google/YouTube channel next. Each creator authorizes separately. Connection expires after seven days; you can disconnect earlier using disconnect_account in your client or Google Account permissions.</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><label><input type="checkbox" name="policy" value="accept" required> I agree to the <a href="/privacy" target="_blank" rel="noopener">privacy policy</a> and <a href="/terms" target="_blank" rel="noopener">terms</a>, and authorize this client to receive my channel data.</label><button name="decision" value="approve">Continue to Google</button><button name="decision" value="deny" formnovalidate>Cancel</button></form>`,200,consent.headers);
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'GET, POST'});
  if(request.headers.get('Origin')!==this.env.BASE_URL)return json({error:'invalid_origin'},403);
  const form=await request.formData(),handle=form.get('handle');
  if(typeof handle!=='string'||handle.length>200)throw new AuthorizationError('invalid_request',{description:'Invalid consent handle'});
  if(form.get('decision')!=='approve'){
   const denied=await oauth.denyConsent(request,handle);return new Response(null,{status:302,headers:denied.headers});
  }
  if(form.get('policy')!=='accept')return html('Agreement required','<p>Review and accept the privacy policy and terms before connecting.</p>',400);
  const approved=await oauth.approveConsent(request,handle);
  const verifier=crypto.randomUUID()+crypto.randomUUID();
  const upstream=await oauth.beginUpstream(approved.request,{data:{verifier},headers:approved.headers});
  const google=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search=new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,redirect_uri:this.env.BASE_URL+'/google/callback',response_type:'code',scope:GOOGLE_SCOPES.join(' '),state:upstream.state,code_challenge:await sha256(verifier),code_challenge_method:'S256',access_type:'offline',prompt:'consent',include_granted_scopes:'false'}).toString();
  upstream.headers.set('Location',google.toString());return new Response(null,{status:302,headers:upstream.headers});
 }
 private async callback(request:Request):Promise<Response>{
  if(request.method!=='GET')return json({error:'method_not_allowed'},405,{Allow:'GET'});
  const oauth=this.oauth(),upstream=await oauth.finishUpstream<{verifier:string}>(request),url=new URL(request.url);
  const code=url.searchParams.get('code');
  if(url.searchParams.has('error')||!code||code.length>4096){upstream.headers.set('Location',authorizationErrorRedirect(upstream.request,'access_denied'));return new Response(null,{status:302,headers:upstream.headers});}
  const tokens=await googleExchange(this.env,code,upstream.data.verifier);
  // Bound callback external waits: token exchange 8s + channel 8s + optional
  // CIMD refresh 10s stays below the DO 30s concurrency-block ceiling.
  const channel=await identifyChannel(tokens.access_token,(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(8000)}));
  const {redirectTo}=await oauth.completeAuthorization({request:upstream.request,userId:channel.id,metadata:{},scope:upstream.request.scope,props:{channelId:channel.id,googleRefreshToken:tokens.refresh_token} satisfies GrantProps});
  upstream.headers.set('Location',redirectTo);return new Response(null,{status:302,headers:upstream.headers});
 }
 async validateToken(resource:string,token:string,management=false):Promise<ValidatedAccessToken<GrantProps>|null>{
  return this.ctx.blockConcurrencyWhile(async()=>{
   if(!launchReady(this.env)||token.length>4096)return null;
   const verified=await this.authorization.validateToken<GrantProps>(resource,token,{OAUTH_KV:this.kv});
   if(!verified || !verified.scope.includes(SCOPE))return null;
   if(!management && (!this.kv.allow('api-user:'+verified.userId,60,60)||!this.kv.allow('api-global',2000,86400)))throw new Error('rate_limit');
   return verified;
  });
 }
 async disconnect(token:string):Promise<{deleted:boolean;google_revoked:boolean;next_step?:string}>{
  return this.ctx.blockConcurrencyWhile(async()=>{
   const verified=await this.authorization.validateToken<GrantProps>(this.env.BASE_URL+'/mcp',token,{OAUTH_KV:this.kv});
   if(!verified)throw new Error('invalid_token');
   let revoked=false;
   try{
    const response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),body:new URLSearchParams({token:verified.props.googleRefreshToken})});
    revoked=response.ok;await response.body?.cancel();
   }catch{/* Delete local access even when Google is unreachable. */}
   this.kv.deleteUser(verified.userId);
   return {deleted:true,google_revoked:revoked,...(revoked?{}:{next_step:'Google revocation could not be confirmed. Revoke the app at https://myaccount.google.com/permissions. Local grants have been deleted.'})};
  });
 }
}
