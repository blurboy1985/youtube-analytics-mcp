export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const SAFE_HEADERS = {
  'Cache-Control':'no-store',
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security':'max-age=31536000',
};
export function html(title: string, body: string, status=200, extra?: Headers): Response {
  const headers=new Headers(extra);
  for (const [key,value] of Object.entries(SAFE_HEADERS)) headers.set(key,value);
  headers.set('Content-Type','text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{max-width:760px;margin:64px auto;padding:0 24px;background:#f7f9fc;color:#172131;font:18px/1.6 system-ui}h1{line-height:1.15}a{color:#165ac2}button{font:inherit;padding:10px 24px;margin:12px 8px 0 0}small{color:#4a5360}label{display:block;margin:16px 0}</style><main><p><strong>YouTube Analytics MCP</strong></p><h1>${escapeHtml(title)}</h1>${body}</main></html>`,{status,headers});
}
export function json(data: unknown, status=200, extra:Record<string,string>={}) {
  return Response.json(data,{status,headers:{...SAFE_HEADERS,...extra}});
}
export async function boundedBody(request: Request, max=16384): Promise<Request> {
  if (!request.body) return request;
  if (Number(request.headers.get('Content-Length')) > max) throw new Error('body_too_large');
  const reader=request.body.getReader();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const read=async()=>{
    const parts:Uint8Array[]=[];let length=0;
    while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new Error('body_too_large');}parts.push(value);}
    const body=new Uint8Array(length);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.length;}
    return new Request(request,{body});
  };
  try{return await Promise.race([read(),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new Error('body_timeout'));},5000);
  })]);}finally{if(timer)clearTimeout(timer);}

}
export function policyPages(path:string, operator:string, contact:string, approved:boolean):Response|null{
 const label=approved?'':'<p><strong>Draft for operator review. Service is not accepting connections.</strong></p>';
 if(path==='/privacy')return html('Privacy and data use',`${label}<p>Operated by ${escapeHtml(operator||'Operator details pending')}. Contact: ${escapeHtml(contact||'Support contact pending')}.</p><p>This service reads the YouTube channel you authorize: channel identity, current public statistics and aggregate performance reports. It requests only youtube.readonly and yt-analytics.readonly. It cannot upload or edit videos and does not request revenue or viewer identities.</p><p>Google authorization credentials are stored encrypted on Cloudflare. Short-lived server authorization records and channel identifiers are stored there to link your chosen AI client to your channel. Analytics reports are requested on demand and are not saved by this server. Network identifiers are hashed for short-lived abuse limits. Application logs do not contain report contents, credentials, codes or callback query strings.</p><p>Results are sent to the client you explicitly approve, including ChatGPT/OpenAI if you connect with ChatGPT. That client may retain results according to its own settings and privacy policy. This service does not use YouTube data to train AI models, sell data, target advertising or combine creator data.</p><p>Authorization expires after at most seven days, requiring reconnection. To disconnect and delete this service's authorization, use the disconnect_account tool in your connected client. It immediately attempts Google revocation and deletes stored service grants. If Google cannot be reached, access here is still removed and you must revoke at <a href="https://myaccount.google.com/permissions">Google Account permissions</a>. Deleting this service's data does not delete your YouTube data or results retained in your AI client's chats. You may also contact the operator for deletion; requests will be handled within seven days. Expired local authorization records are purged daily, and revocations in Google are detected when access is attempted or by expiry. Infrastructure recovery copies may remain until Cloudflare's retention period expires.</p><p>Read <a href="https://policies.google.com/privacy">Google's Privacy Policy</a> and your client's privacy policy. Use of information received from Google APIs follows the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including Limited Use requirements.</p><p><a href="/">Home</a> · <a href="/terms">Terms</a></p>`);
 if(path==='/terms')return html('Terms of use',`${label}<p>This independent read-only service is not affiliated with or endorsed by Google, YouTube or OpenAI. By using it you agree to these terms and the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.</p><p>Authorize only channels you are entitled to access. Only you and the AI clients you explicitly approve may receive the authorized data. Do not use this service to bypass YouTube controls or create prohibited derived metrics. Results may be delayed, incomplete or suppressed. Availability is limited by free hosting and Google API quotas. No uptime or analytics completeness is guaranteed.</p><p>You control connection and revocation. Review the <a href="/privacy">privacy policy</a> before approving a client. Contact ${escapeHtml(contact||'pending operator contact')} for support or deletion. This service's software is MIT-licensed; Google's services and data remain subject to their own terms.</p><p><a href="/">Home</a></p>`);
 return null;
}
