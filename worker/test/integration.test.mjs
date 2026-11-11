import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Response as MFResponse } from 'miniflare';
import { createHash } from 'node:crypto';
const BASE='https://youtube.example.test';
const CALLBACK='https://client.example.test/callback';
const CHANNEL_A='UC'+'a'.repeat(22),CHANNEL_B='UC'+'b'.repeat(22);
const scopes='https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const json=(data,status=200)=>new MFResponse(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function instance(enabled=true){const mf=new Miniflare({modules:true,scriptPath:'dist/worker.js',compatibilityDate:'2026-07-30',compatibilityFlags:['global_fetch_strictly_public'],durableObjects:{AUTH_STORE:{className:'AuthStore',useSQLite:true}},bindings:{BASE_URL:BASE,PUBLIC_LAUNCH_READY:String(enabled),POLICY_APPROVED:String(enabled),OPERATOR_NAME:'Synthetic operator',SUPPORT_EMAIL:'test@example.test',GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-secret'},outboundService:async req=>{
 const u=new URL(req.url);
 if(u.href==='https://client.example.test/oauth-client.json')return json({client_id:u.href,client_name:'Synthetic CIMD client',redirect_uris:[CALLBACK],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});
 if(u.href==='https://oauth2.googleapis.com/token'){
  const form=new URLSearchParams(await req.text());
  const id=form.get('grant_type')==='authorization_code'?form.get('code'):form.get('refresh_token');
  const account=id?.includes('user-b')?'b':'a';
  return json({access_token:'google-access-'+account,refresh_token:'google-refresh-user-'+account,scope:scopes,token_type:'Bearer',expires_in:3600});
 }
 if(u.href==='https://oauth2.googleapis.com/revoke')return json({});
 if(u.hostname==='www.googleapis.com' && u.pathname==='/youtube/v3/channels'){
  const b=req.headers.get('Authorization')==='Bearer google-access-b';
  return json({items:[{id:b?CHANNEL_B:CHANNEL_A,snippet:{title:b?'Creator B':'Creator A'},statistics:{viewCount:'123',videoCount:'1'}}]});
 }
 if(u.hostname==='youtubeanalytics.googleapis.com')return json({columnHeaders:[{name:'views',columnType:'METRIC',dataType:'INTEGER'}],rows:[[42]]});
 throw new Error('Unexpected outbound endpoint: '+u.origin+u.pathname);
}});const dispatch=mf.dispatchFetch.bind(mf);mf.dispatchFetch=(url,init={})=>dispatch(url,{...init,redirect:'manual'});return mf;}
function cookies(response){return response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');}
async function register(mf,name='Synthetic client'){
 const r=await mf.dispatchFetch(BASE+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:name,redirect_uris:[CALLBACK],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
 assert.equal(r.status,201,await r.clone().text());return r.json();
}
function authorizeUrl(client,extra={}){const url=new URL(BASE+'/authorize');url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:CALLBACK,response_type:'code',scope:'youtube:read offline_access',state:'client-state',resource:BASE+'/mcp',code_challenge:challenge,code_challenge_method:'S256',...extra});return url.href;}
async function start(mf,client){const r=await mf.dispatchFetch(authorizeUrl(client));assert.equal(r.status,200,await r.clone().text());const text=await r.text();return {cookie:cookies(r),handle:text.match(/name="handle" value="([^"]+)"/)[1],html:text};}
async function approve(mf,started){return mf.dispatchFetch(BASE+'/authorize',{method:'POST',headers:{Origin:BASE,Cookie:started.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:started.handle,decision:'approve',policy:'accept'}).toString()});}
async function authorize(mf,client,code='user-a'){
 const begun=await start(mf,client),approved=await approve(mf,begun);assert.equal(approved.status,302,await approved.clone().text());
 const location=new URL(approved.headers.get('Location'));assert.equal(location.origin,'https://accounts.google.com');assert.equal(location.searchParams.get('scope'),scopes);
 const callback=await mf.dispatchFetch(BASE+'/google/callback?'+new URLSearchParams({state:location.searchParams.get('state'),code}),{headers:{Cookie:cookies(approved)}});
 assert.equal(callback.status,302,await callback.clone().text());const target=new URL(callback.headers.get('Location'));assert.equal(target.origin,new URL(CALLBACK).origin);assert.equal(target.searchParams.get('iss'),BASE);assert.equal(target.searchParams.get('state'),'client-state');
 return target.searchParams.get('code');
}
async function token(mf,client,code,extra={}){return mf.dispatchFetch(BASE+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:CALLBACK,code,code_verifier:verifier,resource:BASE+'/mcp',...extra}).toString()});}
async function rpc(mf,access,method,params={}){return mf.dispatchFetch(BASE+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+access,'MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}

test('Disabled service fails closed and publishes only preparation/policy drafts',async()=>{const mf=instance(false);try{assert.equal((await mf.dispatchFetch(BASE+'/mcp')).status,503);assert.equal((await mf.dispatchFetch(BASE+'/oauth/register',{method:'POST'})).status,503);assert.match(await(await mf.dispatchFetch(BASE+'/privacy')).text(),/Draft for operator review/);assert.equal((await(await mf.dispatchFetch(BASE+'/health')).json()).accepting_connections,false);}finally{await mf.dispose();}});

test('Real Workers runtime: OAuth discovery, complete synthetic two-user flows, MCP and disconnect',async()=>{const mf=instance();try{
 const unauthorized=await mf.dispatchFetch(BASE+'/mcp');assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('WWW-Authenticate'),/oauth-protected-resource/);
 const meta=await(await mf.dispatchFetch(BASE+'/.well-known/oauth-authorization-server')).json();assert.equal(meta.issuer,BASE);assert.equal(meta.authorization_response_iss_parameter_supported,true);assert.deepEqual(meta.code_challenge_methods_supported,['S256']);assert.equal(meta.client_id_metadata_document_supported,true);
 const client=await register(mf,'<script>alert(1)</script>');
 const begun=await start(mf,client);assert.match(begun.html,/&#60;script&#62;/);assert.doesNotMatch(begun.html,/<script>/);
 const forged=await mf.dispatchFetch(BASE+'/authorize',{method:'POST',headers:{Origin:BASE,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:begun.handle,decision:'approve',policy:'accept'}).toString()});assert.equal(forged.status,400);
 const codeA=await authorize(mf,client,'user-a');
 const wrongAudience=await token(mf,client,codeA,{resource:'https://attacker.example/mcp'});assert.equal(wrongAudience.status,400);
 const tokenAResponse=await token(mf,client,codeA);assert.equal(tokenAResponse.status,200,await tokenAResponse.clone().text());const tokenA=await tokenAResponse.json();
 const codeB=await authorize(mf,client,'user-b');const tokenB=await(await token(mf,client,codeB)).json();
 const init=await(await rpc(mf,tokenA.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Test',version:'1'}})).json();assert.equal(init.result.serverInfo.name,'youtube-analytics-mcp');
 const listing=await(await rpc(mf,tokenA.access_token,'tools/list')).json();assert.equal(listing.result.tools.length,8);assert.equal(listing.result.tools[0]._meta.securitySchemes[0].type,'oauth2');
 for(const [t,expected]of [[tokenA,CHANNEL_A],[tokenB,CHANNEL_B]]){const result=await(await rpc(mf,t.access_token,'tools/call',{name:'connected_channel',arguments:{}})).json();assert.equal(JSON.parse(result.result.content[0].text).id,expected);assert.doesNotMatch(JSON.stringify(result),/google-refresh|google-access|synthetic-secret/);}
 const disallowed=await(await rpc(mf,tokenA.access_token,'tools/call',{name:'channel_overview',arguments:{channel_id:CHANNEL_B}})).json();assert.equal(disallowed.result.isError,true);
 const disconnect=await(await rpc(mf,tokenA.access_token,'tools/call',{name:'disconnect_account',arguments:{confirm:true}})).json();assert.equal(JSON.parse(disconnect.result.content[0].text).deleted,true);
 assert.equal((await rpc(mf,tokenA.access_token,'tools/list')).status,401);assert.equal((await rpc(mf,tokenB.access_token,'tools/list')).status,200);
}finally{await mf.dispose();}});

test('Concurrent code consumption is serialized; refresh rotates; replay fails',async()=>{const mf=instance();try{
 const client=await register(mf),code=await authorize(mf,client);
 const attempts=await Promise.all([token(mf,client,code),token(mf,client,code)]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,400]);
 // Replay revokes the replayed grant. Establish a separate fresh grant for rotation.
 const freshCode=await authorize(mf,client),fresh=await(await token(mf,client,freshCode)).json();
 const refresh=()=>mf.dispatchFetch(BASE+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:fresh.refresh_token,resource:BASE+'/mcp'}).toString()});
 const rotated=await refresh();assert.equal(rotated.status,200);const rotation=await rotated.json();assert.notEqual(rotation.refresh_token,fresh.refresh_token);
 assert.equal((await refresh()).status,400);assert.equal((await refresh()).status,400);assert.equal((await rpc(mf,rotation.access_token,'tools/list')).status,401);
}finally{await mf.dispose();}});

test('Host/origin/body/redirect/PKCE guards and denial issuer',async()=>{const mf=instance();try{
 assert.equal((await mf.dispatchFetch('https://evil.example/mcp')).status,403);
 assert.equal((await mf.dispatchFetch(BASE+'/mcp',{headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await mf.dispatchFetch(BASE+'/oauth/register',{method:'POST',body:'x'.repeat(16385)})).status,413);
 const preflight=await mf.dispatchFetch(BASE+'/oauth/token',{method:'OPTIONS',headers:{Origin:BASE,'Access-Control-Request-Method':'POST'}});assert.equal(preflight.status,204);
 const client=await register(mf);
 const badRedirect=await mf.dispatchFetch(authorizeUrl(client,{redirect_uri:'https://evil.example/cb'}));assert.equal(badRedirect.status,400);assert.equal(badRedirect.headers.get('Location'),null);
 const noPkce=await mf.dispatchFetch(authorizeUrl(client,{code_challenge:'',code_challenge_method:''}));assert.ok([302,400].includes(noPkce.status));
 const started=await start(mf,client);const denied=await mf.dispatchFetch(BASE+'/authorize',{method:'POST',headers:{Origin:BASE,Cookie:started.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:started.handle,decision:'deny'}).toString()});assert.equal(denied.status,302);const loc=new URL(denied.headers.get('Location'));assert.equal(loc.searchParams.get('error'),'access_denied');assert.equal(loc.searchParams.get('iss'),BASE);
}finally{await mf.dispose();}});


test('CIMD client signs in through the same consent-bound flow',async()=>{const mf=instance();try{
 const client={client_id:'https://client.example.test/oauth-client.json'};
 const code=await authorize(mf,client),tokens=await(await token(mf,client,code)).json();
 assert.equal((await rpc(mf,tokens.access_token,'tools/list')).status,200);
}finally{await mf.dispose();}});

test('Discovery and unknown paths do not exhaust login; disconnect survives report throttling',async()=>{const mf=instance();try{
 for(let i=0;i<305;i++)assert.equal((await mf.dispatchFetch(BASE+'/oauth/unknown')).status,404);
 for(let i=0;i<305;i++)assert.equal((await mf.dispatchFetch(BASE+'/.well-known/oauth-authorization-server')).status,200);
 const client=await register(mf),code=await authorize(mf,client),tokens=await(await token(mf,client,code)).json();
 for(let i=0;i<60;i++)assert.equal((await rpc(mf,tokens.access_token,'tools/list')).status,200);
 assert.equal((await rpc(mf,tokens.access_token,'tools/list')).status,503);
 const dis=await(await rpc(mf,tokens.access_token,'tools/call',{name:'disconnect_account',arguments:{confirm:true}})).json();
 assert.equal(JSON.parse(dis.result.content[0].text).deleted,true);
}finally{await mf.dispose();}});
