import { createRequire as __mhCreateRequire } from 'node:module'; const require = __mhCreateRequire(import.meta.url);
import{b as J}from"./shared-NQPEADBJ.mjs";import{a as k,b as F,f as ue,g as B,i as te,j as K,k as me}from"./shared-F6UALMI2.mjs";import"./shared-NCUF5LPZ.mjs";import{createServer as Ht}from"node:http";import{randomBytes as ze,timingSafeEqual as zt}from"node:crypto";var $=e=>e!==null&&typeof e=="object"&&!Array.isArray(e),M=(e,t=4096)=>typeof e=="string"&&e.length<=t?e:null,oe="node:",Ge=3e5,Qe=3,Ve=Object.freeze({limit:B.maxCount});function fe(e={}){let t=e.fetch??globalThis.fetch,o=e.client??me({...e.clientOptions,fetch:t});async function s(n,{method:r="GET",body:a,headers:i={},operation:c="request",timeoutMs:d}={}){let f=await o.getAccessToken(),l=Math.min(Math.max(d??o.config.timeoutMs,1),Ge);return K({url:`${o.config.gatewayBase}${n}`,fetch:t,timeoutMs:l,maxResponseBytes:o.config.maxResponseBytes,method:r,body:a,operation:c,headers:{...i,Authorization:`HookToken ${f}`}})}return Object.freeze({client:o,json:s})}function he(e={}){let t=Number(e.limit);return{search:typeof e.search=="string"?e.search.trim().slice(0,256):"",memoryTypes:[...new Set((Array.isArray(e.memoryTypes)?e.memoryTypes:[]).filter(o=>ue.includes(o)))],includeSuperseded:e.includeSuperseded===!0,limit:Number.isInteger(t)&&t>=1&&t<=B.maxCount?t:Ve.limit}}function ye(e){return!$(e)||!M(e.principal,512)?null:{principal:e.principal,tenant:M(e.tenant_id,512)}}function Ye(e){return!$(e)||!Array.isArray(e.nodes)?null:e.nodes.flatMap(t=>!$(t)||!M(t.id,256)?.startsWith(oe)||!M(t.name,1024)?[]:[{id:t.id,name:t.name,path:M(t.path,8192)??t.name,parentId:M(t.parent_id,256),description:M(t.description,4096)}])}async function be(e,t={}){let o=he(t),[s,n,r]=await Promise.allSettled([e.client.getMemories({recent_k:o.limit,memory_types:o.memoryTypes,include_superseded:o.includeSuperseded}),e.json("/whoami",{operation:"identity"}),e.json("/v1/me/reach",{operation:"hierarchy"})]);if(s.status==="rejected")throw s.reason;let a=[],i=n.status==="fulfilled"?ye(n.value.data):null;i||a.push("Your signed-in identity could not be loaded.");let c=r.status==="fulfilled"?Ye(r.value.data):null;return c||a.push("The hierarchy could not be loaded, so shared memories are shown by node ID."),tt({who:i,nodes:c??[],listing:s.value,filters:o,warnings:a})}async function Ke(e,t,o){let s=new Array(e.length),n=0,r=async()=>{for(;n<e.length;){let a=n;n+=1,s[a]=await o(e[a])}};return await Promise.all(Array.from({length:Math.min(t,e.length)},r)),s}async function se(e,t,{labels:o=new Map,principal:s=null}={}){let n=[...new Set(t)].filter(te),r=[];for(let l=0;l<n.length;l+=B.maxScopes)r.push(n.slice(l,l+B.maxScopes));let a=await Ke(r,Qe,l=>e.client.getMemories({recent_k:B.maxCount,scopes:l})),i=new Set(n),c={},d=new Set,f=0;for(let l of a.flatMap(u=>u.items)){if(!$(l)||typeof l.id!="string"||d.has(l.id)||!i.has(l.scope_key))continue;d.add(l.id);let u=we(l,o,s);(c[u.scope_key]||=[]).push(u),f+=1}for(let l of Object.values(c))l.sort(ke);return{groups:c,total:f,truncated:a.some(l=>l.has_more===!0)}}async function ge(e){let t=await W(e);if(!te(t.principal))throw new k("INVALID_RESPONSE","Memory House did not return your signed-in identity. Try again.");let{groups:o,total:s,truncated:n}=await se(e,[t.principal],{principal:t.principal});return{principal:t.principal,tenant:t.tenant,memories:o[t.principal]??[],total:s,truncated:n}}async function W(e){let t=ye((await e.json("/whoami",{operation:"identity"})).data);if(!t)throw new k("INVALID_RESPONSE","Memory House did not return your signed-in identity. Try again.");return t}function ne(e){return String(e||"").split("/").filter(Boolean).join(" / ")}function Je(e){for(let t of["content","text","summary","title","name"])if(typeof e[t]=="string"&&e[t].trim())return e[t];return""}function we(e,t,o){let s=typeof e.scope_key=="string"?e.scope_key:"",n=t.get(s),r=s.startsWith("user:")&&(!o||s===o),a=r?"personal":n?"node":s.startsWith(oe)?"unlisted":"other",i=$(e.source)?M(e.source.source,256)??M(e.source.application,256):null;return{id:e.id,scope_key:s,scope_kind:a,scope_label:r?"Personal":n?n.name:a==="unlisted"?"Unlisted node":s||"Unknown scope",scope_path:n?ne(n.path):"",type:M(e.memory_type,64)??M(e.type,64),content:Je(e),tags:Array.isArray(e.tags)?e.tags.filter(c=>typeof c=="string").slice(0,20):[],created_at:M(e.created_at,64),updated_at:M(e.updated_at,64),salience:typeof e.salience=="number"?e.salience:null,confidence:typeof e.confidence=="number"?e.confidence:null,source:i,superseded:typeof e.superseded_by=="string"&&e.superseded_by.length>0,promotion:Xe(We(e),t)}}function We(e){let t=$(e.metadata)?e.metadata:null;if(t&&typeof t.promoted_from_scope=="string"){let o=$(t.topology_assessment)?t.topology_assessment:{};return{from_scope:t.promoted_from_scope,origin:t.promotion_origin_principal,rationale:t.assessment_rationale??o.rationale,promoted_at:t.promoted_at}}return $(e.promotion)?e.promotion:null}function Xe(e,t){if(!$(e))return null;let o=M(e.from_scope,256),s=o?t.get(o):null,n={from_scope:o,from_label:s?ne(s.path):o,origin:M(e.origin,256),rationale:M(e.rationale,2e3),promoted_at:M(e.promoted_at,64)};return Object.values(n).some(Boolean)?n:null}function Ze(e,t){return[e.content,e.id,e.scope_label,e.scope_path,...e.tags].some(o=>String(o||"").toLowerCase().includes(t))}var et=(e,t)=>e.name.localeCompare(t.name,void 0,{sensitivity:"base"})||e.id.localeCompare(t.id),ke=(e,t)=>String(t.created_at||"").localeCompare(String(e.created_at||""));function tt({who:e=null,nodes:t=[],listing:o,filters:s={},warnings:n=[]}){let r=he(s),a=new Map(t.map(p=>[p.id,p])),i=e?.principal??null,c=r.search.toLowerCase(),d={},f=new Set,l=0;for(let p of Array.isArray(o?.items)?o.items:[]){if(!$(p)||typeof p.id!="string"||f.has(p.id))continue;f.add(p.id);let S=we(p,a,i);c&&!Ze(S,c)||((d[S.scope_key]||=[]).push(S),l+=1)}for(let p of Object.values(d))p.sort(ke);let u=p=>(d[p]||[]).length,m=[],h=new Set(i?[i]:[]);for(let p of Object.keys(d))p.startsWith("user:")&&h.add(p);for(let p of h)m.push({scope:p,kind:"personal",name:"Personal",path:"",depth:0,count:u(p)});let y=new Map;for(let p of t){let S=p.parentId&&a.has(p.parentId)?p.parentId:null;y.has(S)||y.set(S,[]),y.get(S).push(p)}let A=new Set,E=(p,S)=>{for(let T of(y.get(p)||[]).sort(et))A.has(T.id)||(A.add(T.id),m.push({scope:T.id,kind:p===null?"root":"node",name:T.name,path:ne(T.path),description:T.description,depth:S,count:u(T.id)}),E(T.id,S+1))};E(null,0);for(let p of Object.keys(d).sort()){if(h.has(p)||A.has(p))continue;let S=p.startsWith(oe);m.push({scope:p,kind:S?"unlisted":"other",name:S?"Unlisted node":p,path:p,depth:0,count:u(p)})}return{principal:i,tenant:e?.tenant??null,rows:m,groups:d,total:l,truncated:o?.has_more===!0,limit:r.limit,warnings:n,updatedAt:new Date().toISOString()}}function ot(e,{maxItems:t=100,maxChars:o=1e3}={}){let s=[];for(let n of e.rows)for(let r of e.groups[n.scope]||[]){if(s.length>=t)break;s.push({scope:n.kind==="personal"?"Personal":n.path||n.name,type:r.type,content:r.content.length>o?`${r.content.slice(0,o)}...`:r.content,created_at:r.created_at})}return{principal:e.principal,total:e.total,truncated:e.truncated||s.length<e.total,scopes:e.rows.map(({scope:n,kind:r,name:a,path:i,count:c})=>({scope:n,kind:r,name:a,path:i,count:c})),memories:s,warnings:e.warnings,referenceOnly:!0}}import{createReadStream as st}from"node:fs";import{readdir as ae,readFile as nt,stat as rt}from"node:fs/promises";import{createInterface as at}from"node:readline";import{createHash as it}from"node:crypto";import{homedir as ct}from"node:os";import{basename as lt,join as H,posix as dt,relative as pt,sep as ut}from"node:path";var P=Object.freeze({sessions:100,selected:200,batchItems:50,factBatchItems:10,batchBytes:240*1024,factBytes:16*1024,previewBytes:2048,timeoutMs:12e4}),ie=Object.freeze({copilot:Object.freeze({label:"GitHub Copilot",session:"github-copilot",memory:"copilot-cli-memory"}),claude:Object.freeze({label:"Claude Code",session:"claude-code",memory:"claude-code-memory"})}),ce=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,mt=/"type"\s*:\s*"(?:session\.start|user\.message|assistant\.message)"/,R=e=>e!==null&&typeof e=="object"&&!Array.isArray(e);function j(e){if(typeof e!="string"||!Object.hasOwn(ie,e))throw new k("INVALID_PAYLOAD","Import source must be copilot or claude.");return e}function ve(e=process.env){let t=e.HOME||e.USERPROFILE||ct();return{copilot:H(e.COPILOT_HOME||H(t,".copilot"),"session-state"),claude:H(e.CLAUDE_CONFIG_DIR||H(t,".claude"),"projects")}}function re(e,t=130){let o=J(e,{maxBytes:P.previewBytes}).replace(/```[\s\S]*?```/g," ").replace(/`([^`]*)`/g,"$1").replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/\*\*([^*]*)\*\*/g,"$1").replace(/[*_>]/g," ").replace(/\s+/g," ").trim();return o.length>t?`${o.slice(0,t-3)}...`:o}async function*le(e,t){let o=st(e,{encoding:"utf8"}),s=at({input:o,crlfDelay:1/0});try{for await(let n of s){if(t&&!t(n))continue;let r=n.trim();if(r)try{let a=JSON.parse(r);R(a)&&(yield a)}catch{}}}finally{s.close(),o.destroy()}}async function xe(e){try{let t=await rt(e);return t.isFile()?t:null}catch{return null}}async function de(e){try{return(await ae(e,{withFileTypes:!0})).filter(t=>t.isDirectory()).map(t=>t.name)}catch{return[]}}var U=new Map;async function Se(e,t,o,s){let n=`${e}\0${t}`,r=U.get(n);if(r&&r.mtimeMs===o.mtimeMs&&r.size===o.size)return r.value;let a=await s();return U.delete(n),U.set(n,{mtimeMs:o.mtimeMs,size:o.size,value:a}),U.size>2e3&&U.delete(U.keys().next().value),a}async function ft(e,t){let o="",s="",n=new Map,r=new Map;for await(let i of le(e,c=>mt.test(c))){let c=i.data;if(R(c)){if(i.type==="session.start")o=String(c.startTime||i.timestamp||""),R(c.context)&&(s=String(c.context.cwd||""));else if(i.type==="user.message")typeof c.interactionId=="string"&&typeof c.content=="string"&&c.content.trim()&&n.set(c.interactionId,{role:"user",content:c.content});else if(i.type==="assistant.message"){let d=c.interactionId;if(typeof d!="string"||!n.has(d)||typeof c.content!="string"||!c.content.trim())continue;let f=c.phase==="final_answer";if(r.get(d)?.final&&!f)continue;r.set(d,{role:"agent",content:c.content,final:f})}}}let a=[];for(let[i,c]of n){let d=r.get(i);d&&a.push({question:c,response:{role:d.role,content:d.content}})}return{session_id:t,start_time:o,cwd:s,turns:a}}async function Me(e){let t=[];for(let o of await de(e)){if(!ce.test(o))continue;let s=H(e,o,"events.jsonl"),n=await xe(s);n&&t.push({id:o,file:s,info:n})}return t}async function ht(e,t){let o=[];for await(let s of le(e,n=>n.includes("storeMemory"))){let n=s.data;if(s.type!=="tool.execution_complete"||!R(n)||!n.success)continue;let r=n.toolTelemetry;if(!R(r)||!R(r.properties)||r.properties.operation!=="storeMemory")continue;let a=r.restrictedProperties;!R(a)||typeof a.memoryFact!="string"||o.push({memory_id:String(s.id||""),session_id:t,fact:a.memoryFact})}return o}function yt(e){return typeof e=="string"?e.trim():Array.isArray(e)?e.filter(t=>R(t)&&t.type==="text").map(t=>String(t.text||"").trim()).filter(Boolean).join(`
`).trim():""}async function bt(e,t){let o="",s="",n=null,r=null,a=[];for await(let i of le(e)){if(i.isSidechain||i.isMeta)continue;let c=i.message;if(i.type!=="user"&&i.type!=="assistant"||!R(c))continue;s=String(i.cwd||s);let d=String(i.timestamp||"");d&&(!o||d<o)&&(o=d);let f=yt(c.content);if(f)if(i.type==="user"){if(typeof c.content!="string")continue;n&&r&&a.push({question:n,response:r}),n={role:"user",content:f},r=null}else n&&(r={role:"agent",content:f})}return n&&r&&a.push({question:n,response:r}),{session_id:t,start_time:o,cwd:s,turns:a}}async function gt(e){let t=[];for(let o of await de(e)){let s=[];try{s=await ae(H(e,o),{withFileTypes:!0})}catch{continue}for(let n of s){if(!n.isFile()||!n.name.endsWith(".jsonl"))continue;let r=n.name.slice(0,-6);if(!ce.test(r))continue;let a=H(e,o,n.name),i=await xe(a);i&&t.push({id:r,file:a,info:i})}}return t}var wt=/^---\r?\n[\s\S]*?\r?\n---\r?\n?/;async function _e(e,t=[]){let o=[];try{o=await ae(e,{withFileTypes:!0})}catch{return t}for(let s of o){let n=H(e,s.name);s.isDirectory()?await _e(n,t):s.isFile()&&s.name.endsWith(".md")&&t.push(n)}return t}async function kt(e){let t=[];for(let o of await de(e)){let s=H(e,o,"memory");for(let n of(await _e(s)).sort()){if(lt(n)==="MEMORY.md")continue;let r=(await nt(n,"utf8")).replace(wt,"").trim();if(!r)continue;let a=pt(s,n).split(ut).join(dt.sep);t.push({memory_id:`${o}:${a}`,session_id:o,fact:r})}}return t}async function Ee(e,t){return e==="claude"?gt(t.claude):Me(t.copilot)}async function Ie(e,t){let o=e==="claude"?bt:ft;return Se(`${e}-session`,t.file,t.info,()=>o(t.file,t.id))}function vt(e){let t=e.turns[0];return re(t?t.question.content:"",72)||e.cwd.split(/[\\/]/).filter(Boolean).pop()||e.session_id}async function Ae(e,t,{limit:o=P.sessions}={}){j(e);let s=(await Ee(e,t)).sort((r,a)=>a.info.mtimeMs-r.info.mtimeMs),n=[];for(let r of s){if(n.length>=o)break;let a=await Ie(e,r);if(!a.turns.length)continue;let i=a.turns[a.turns.length-1];n.push({session_id:a.session_id,label:vt(a),cwd:a.cwd,start_time:a.start_time,turn_count:a.turns.length,last_user_turn:re(i.question.content),last_agent_turn:re(i.response.content)})}return n}function xt(e){if(!Array.isArray(e)||!e.length||e.length>P.selected||e.some(t=>typeof t!="string"||!ce.test(t)))throw new k("INVALID_PAYLOAD",`Select 1 to ${P.selected} listed sessions to import.`);return[...new Set(e)]}function*Ce(e,t,o){let s=[];for(let n of e)s.length&&(s.length>=t||Buffer.byteLength(JSON.stringify(o([...s,n])))>P.batchBytes)&&(yield o(s),s=[]),s.push(n);s.length&&(yield o(s))}async function Te(e,t){let o=`mh-import-${it("sha256").update(JSON.stringify(t)).digest("hex")}`,{data:s}=await e.json("/memory",{method:"POST",body:t,headers:{"Idempotency-Key":o},operation:"import",timeoutMs:P.timeoutMs});return s}function Le(e,t,o,s){e.batches+=1;let n=R(s)?s.result:null;R(n)&&Number.isSafeInteger(n.succeeded)?(e[t]+=n.succeeded,e.failed+=Number.isSafeInteger(n.failed)?n.failed:0,e.unknown+=Number.isSafeInteger(n.unknown)?n.unknown:0):e[t]+=o}async function Re({gateway:e,source:t,ids:o,roots:s}){j(t);let n=xt(o),r={source:t,sessions:0,messages:0,skipped:0,failed:0,unknown:0,batches:0};try{let a=new Map((await Ee(t,s)).map(i=>[i.id,i]));for(let i of n){let c=a.get(i);if(!c)continue;let d=await Ie(t,c);if(!d.turns.length)continue;let f=[];for(let u of d.turns)for(let m of[u.question,u.response]){let h=J(m.content);h?f.push({role:m.role,content:h,source:ie[t].session}):r.skipped+=1}if(!f.length)continue;r.sessions+=1;let l=`mh:import:${t}:${i}`;for(let u of Ce(f,P.batchItems,m=>({extract:!0,thread_id:l,items:m})))Le(r,"messages",u.items.length,await Te(e,u))}}catch(a){return{...r,error:F(a)}}return r}async function St(e,t){if(e==="claude")return kt(t.claude);let o=[];for(let s of await Me(t.copilot))o.push(...await Se("copilot-memories",s.file,s.info,()=>ht(s.file,s.id)));return o}async function Pe({gateway:e,source:t,roots:o}){j(t);let s={source:t,memories:0,skipped:0,failed:0,unknown:0,batches:0,reconcile:null};try{let n=[],r=new Set;for(let a of await St(t,o)){let i=J(a.fact,{maxBytes:P.factBytes});if(!i||r.has(i)){s.skipped+=1;continue}r.add(i),n.push({content:i,source:ie[t].memory})}for(let a of Ce(n,P.factBatchItems,i=>({extract:!1,items:i})))Le(s,"memories",a.items.length,await Te(e,a));if(s.memories>0){let{data:a}=await e.json("/reconcile",{method:"POST",body:{},operation:"reconcile",timeoutMs:P.timeoutMs});s.reconcile=R(a)&&typeof a.status=="string"?a.status:"requested"}}catch(n){return{...s,error:F(n)}}return s}import{exec as Mt,execFile as _t}from"node:child_process";import{existsSync as Et}from"node:fs";import{isAbsolute as It}from"node:path";var ee=Object.freeze({baseUrl:"https://wabi-daily-us-east2-redirect.analysis.windows.net",scope:"https://analysis.windows.net/powerbi/api/.default",timeoutMs:3e4,maxSections:500,maxPages:20,concurrency:6}),At=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,Ne=new Set([401,403,404]),Ct=5*6e4,Tt="scope:miq:",Z=e=>e!==null&&typeof e=="object"&&!Array.isArray(e),X=(e,t)=>typeof e=="string"&&e.length<=t?e:"",z=e=>typeof e=="string"&&At.test(e);function Lt(e,t,o){let s=`${Tt}${e.toLowerCase()}`;if(o===t)return s;if(!o.startsWith(`${t}/`))throw new k("INVALID_PAYLOAD","The section is outside its playbook.");return`${s}:${o.slice(t.length+1)}`}function Oe(e){return`Run \`az login --tenant ${e}\` with your Microsoft account to read your Microsoft IQ playbooks, then select Refresh.`}function Rt(e){try{let t=JSON.parse(Buffer.from(e.split(".")[1],"base64url").toString("utf8"));return Z(t)?t:null}catch{return null}}function Pt(e,t){return e.MEMORY_HOUSE_AZ_PATH?[e.MEMORY_HOUSE_AZ_PATH]:t==="win32"?["az.cmd",...[e.ProgramFiles,e["ProgramFiles(x86)"]].filter(Boolean).map(s=>`${s}\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd`)]:["az","/opt/homebrew/bin/az","/usr/local/bin/az","/usr/bin/az"]}function Nt(e,t,{env:o,platform:s,timeoutMs:n}){return new Promise((r,a)=>{let i={env:o,timeout:n,windowsHide:!0,maxBuffer:65536},c=(d,f)=>d?a(d):r(String(f));if(s==="win32"){let d=e.includes(" ")?`"${e}"`:e;Mt([d,...t].join(" "),i,c)}else _t(e,t,i,c)})}function Ot({env:e=process.env,platform:t=process.platform,run:o=Nt,exists:s=Et,now:n=Date.now}={}){let r=null,a=null;async function i(c){let d=["account","get-access-token","--tenant",c,"--scope",ee.scope,"--query","accessToken","-o","tsv"];for(let f of Pt(e,t)){if((It(f)||/[\\/]/.test(f))&&!s(f))continue;let l;try{l=await o(f,d,{env:e,platform:t,timeoutMs:ee.timeoutMs})}catch(y){if(y?.code==="ENOENT"||y?.code===9009)continue;throw y?.killed?new k("MIQ_CLI_TIMEOUT","The Azure CLI took too long to return a Microsoft IQ token. Retry, or run `az login` again."):new k("MIQ_CLI_SIGN_IN",Oe(c))}let u=l.trim(),m=Rt(u);if(!m||m.idtyp==="app"||!z(m.oid)||String(m.tid).toLowerCase()!==c.toLowerCase())throw new k("MIQ_CLI_SIGN_IN",Oe(c));let h=[m.upn,m.preferred_username,m.unique_name].find(y=>typeof y=="string"&&y&&y.length<=256&&!/[\x00-\x1f\x7f]/.test(y))??null;return{token:u,oid:m.oid.toLowerCase(),username:h,expiresAt:Number(m.exp)*1e3||n()}}throw new k("MIQ_CLI_MISSING",`Microsoft IQ playbooks use your Azure CLI sign-in. Install the Azure CLI, run \`az login --tenant ${c}\`, then select Refresh.`)}return Object.freeze({async get(c){return r&&r.tenantId===c&&r.expiresAt-n()>Ct?r:(a??=i(c).then(d=>r={...d,tenantId:c}).finally(()=>{a=null}),a)},clear(){r=null}})}function $t(e){let t=0,o=[],s=()=>{if(t>=e||!o.length)return;t+=1;let{work:n,resolve:r,reject:a}=o.shift();n().then(r,a).finally(()=>{t-=1,s()})};return n=>new Promise((r,a)=>{o.push({work:n,resolve:r,reject:a}),s()})}var pe=e=>e.split("/").pop()||e;function $e({tenantId:e,fetch:t=globalThis.fetch,tokens:o=Ot(),baseUrl:s=ee.baseUrl,limits:n={}}={}){if(!z(e))throw new k("INVALID_CONFIG","Microsoft IQ playbooks need the Memory House Entra tenant ID.");let r={...ee,...n};function a(l){if(!Z(l)||typeof l.token!="string"||!l.token||!z(l.oid))throw new k("INVALID_PAYLOAD","Microsoft IQ is read only with a verified Azure CLI account.");return l}async function i(l,u,{token:m}){try{let{data:h}=await K({url:`${s}${l}`,fetch:t,timeoutMs:r.timeoutMs,method:"GET",headers:{Authorization:`Bearer ${m}`},operation:u});return Z(h)?h:{}}catch(h){let y=h instanceof k?h.code:"NETWORK_ERROR";throw y==="HTTP_ERROR"?(h.status===401&&o.clear(),new k("MIQ_HTTP_ERROR",`Microsoft IQ answered HTTP ${h.status} to the ${u} request.`,{status:h.status})):y==="REQUEST_TIMEOUT"?new k("MIQ_TIMEOUT",`Microsoft IQ did not answer the ${u} request in time. Try again.`):y==="NETWORK_ERROR"?new k("MIQ_UNREACHABLE","Microsoft IQ could not be reached. Check your network connection and try again."):new k("MIQ_INVALID_RESPONSE",`Microsoft IQ returned a ${u} response the canvas could not read.`)}}async function c(l){a(l);let u=[],m=null;for(let h=0;h<r.maxPages;h+=1){let y=new URLSearchParams({maxPageSize:"200"});m&&y.set("continuationToken",m);let A=await i(`/v1/miq/__private/playbooks?${y}`,"playbook list",l);for(let E of Array.isArray(A.playbooks)?A.playbooks:[]){let p=X(E?.playbookRoot,1024);z(E?.workspaceId)&&z(E?.playbookId)&&p&&u.push({workspaceId:E.workspaceId.toLowerCase(),playbookId:E.playbookId.toLowerCase(),name:p})}if(m=X(A.continuationToken,4096),!m)break}return u.sort((h,y)=>h.name.localeCompare(y.name,void 0,{sensitivity:"base"})||h.playbookId.localeCompare(y.playbookId)),{tenantId:e,playbooks:u}}async function d({workspaceId:l,playbookId:u,name:m},h){let{oid:y}=a(h),A=$t(r.concurrency),E=`/v1/workspaces/${l}/playbooks/${u}/__private/sections`,p=0,S=0,T=!1;async function G(v,b=null){if(p>=r.maxSections)return T=!0,{path:v,name:pe(v),skipped:!0,children:[]};p+=1;let g=encodeURIComponent(v),[x,C]=await Promise.all([A(()=>i(`${E}/${g}`,"section",h)),A(()=>i(`${E}/members/${g}`,"section membership",h))]);S+=1;let w=I=>(Array.isArray(C[I])?C[I]:[]).filter(Z),L=w("curators"),O=w("users"),Q=I=>String(I.principalId).toLowerCase()===y,q=L.some(Q)?"curator":O.some(Q)?"user":null,V=(Array.isArray(x.childSections?.value)?x.childSections.value:[]).map(I=>X(I?.path,4096)).filter(I=>I.startsWith(`${v}/`)),Be=q==="curator"?v:b,Ue=await Promise.all(V.map(I=>G(I,Be).catch(D=>{if(D instanceof k&&Ne.has(D.status))return{path:I,name:pe(I),refused:D.status,children:[]};throw D})));return{path:v,name:pe(v),scope:Lt(u,m,v),description:X(x.description,4096),curators:L.length,users:O.length,groups:[...L,...O].filter(I=>I.principalType!=="User").length,role:q,...q!=="curator"&&b?{curatorVia:b}:{},children:Ue.sort((I,D)=>I.name.localeCompare(D.name,void 0,{sensitivity:"base"}))}}try{let v=await G(m);return{workspaceId:l,playbookId:u,name:m,access:!0,sections:S,truncated:T,root:v}}catch(v){if(v instanceof k&&Ne.has(v.status))return{workspaceId:l,playbookId:u,name:m,access:!1,status:v.status,sections:0,truncated:!1,root:null};throw v}}async function f(l){let[u,m]=await Promise.allSettled([o.get(e),l]);if(u.status==="rejected")throw u.reason;if(m.status==="rejected")throw m.reason;let h=typeof m.value=="string"?m.value.toLowerCase():null;if(h===`user:${u.value.oid}`)return u.value;o.clear();let y=await o.get(e);if(h===`user:${y.oid}`)return y;o.clear();let A=y.username?`as ${y.username}`:"with another account";throw new k("MIQ_ACCOUNT_MISMATCH",`Azure CLI is signed in ${A}, but Memory House is signed in as someone else. Run \`az login --tenant ${e}\` with your Memory House account, then select Refresh.`)}return Object.freeze({tenantId:e,listPlaybooks:c,loadPlaybookTree:d,verifyAccount:f})}function He({token:e,nonce:t}){return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory House</title>
<style>
  :root {
    color-scheme: light dark;
    --mh-bg: var(--background-color-default, Canvas);
    --mh-fg: var(--text-color-default, CanvasText);
    --mh-muted: var(--text-color-muted, color-mix(in srgb, CanvasText 64%, transparent));
    --mh-border: var(--border-color-default, color-mix(in srgb, CanvasText 18%, transparent));
    --mh-accent: var(--color-focus-outline, Highlight);
    --mh-soft: color-mix(in srgb, var(--mh-fg) 5%, transparent);
    --mh-chip: color-mix(in srgb, var(--mh-fg) 9%, transparent);
    --mh-danger: var(--true-color-red, #d1242f);
  }
  body { margin: 0; background: var(--mh-bg); color: var(--mh-fg);
    font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px); line-height: var(--leading-body-medium, 20px); }
  header { padding: 12px 16px; border-bottom: 1px solid var(--mh-border); display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; font-weight: var(--font-weight-semibold, 600); }
  .who { font-size: 12px; color: var(--mh-muted); overflow-wrap: anywhere; }
  .spacer { flex: 1; }
  main { display: grid; grid-template-columns: minmax(280px, 34%) 1fr; min-height: calc(100vh - 58px); }
  aside { border-right: 1px solid var(--mh-border); padding: 12px 14px; overflow: auto; }
  section { padding: 12px 16px; overflow: auto; }
  h2 { font-size: 15px; margin: 0 0 10px; font-weight: var(--font-weight-semibold, 600); }
  h3 { font-size: 13px; margin: 0; font-weight: var(--font-weight-semibold, 600); }
  label { display: block; font-size: 12px; color: var(--mh-muted); margin: 12px 0 4px; }
  input, select, button { box-sizing: border-box; width: 100%; padding: 7px 8px; border-radius: 8px;
    border: 1px solid var(--mh-border); background: var(--mh-bg); color: var(--mh-fg); font: inherit; }
  button { cursor: pointer; font-weight: var(--font-weight-semibold, 600); background: var(--mh-soft); }
  button:hover { border-color: var(--mh-accent); }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--mh-accent); outline-offset: 1px; }
  button:disabled { cursor: wait; opacity: .65; }
  header button { width: auto; min-width: 92px; }
  .primary { background: color-mix(in srgb, var(--mh-accent) 22%, var(--mh-bg)); }
  .identity { box-sizing: border-box; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--mh-border);
    background: var(--mh-soft); overflow-wrap: anywhere; font-size: 12px; }
  .toolbar { display: flex; justify-content: flex-end; margin-top: 10px; }
  .filter-toggle { width: auto; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; }
  .filter-toggle svg { width: 15px; height: 15px; fill: currentColor; }
  .filter-panel { margin-top: 8px; padding: 2px 10px 12px; border: 1px solid var(--mh-border); border-radius: 10px; background: var(--mh-soft); }
  .filter-panel[hidden] { display: none; }
  .badge { min-width: 16px; padding: 0 5px; border-radius: 999px; background: var(--mh-accent); color: var(--color-white, #fff); font-size: 10px; text-align: center; }
  .filter-panel button { margin-top: 12px; }
  .checkline { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; }
  .checkline input { width: auto; }
  .range-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
  .range-row input { padding: 0; }
  .range-value { min-width: 40px; text-align: right; font-size: 12px; font-weight: 700; }
  .hint { font-size: 11px; color: var(--mh-muted); margin-top: 3px; }
  .scopes-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 18px; }
  .link-button { width: auto; padding: 2px 9px; border-radius: 999px; border-color: transparent; background: transparent; font-size: 12px; }
  .link-button[aria-pressed="true"] { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 18%, var(--mh-bg)); }
  .tree { margin-top: 6px; padding-bottom: 16px; }
  .tree-section { margin: 14px 6px 4px; font-size: 11px; font-weight: 700; color: var(--mh-muted); text-transform: uppercase; letter-spacing: .05em; }
  .tree-node { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 7px; align-items: center; text-align: left;
    padding: 6px 8px 6px calc(8px + var(--indent, 0px)); margin: 1px 0; border-color: transparent; background: transparent; font-weight: 400; }
  .tree-node.active { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 16%, var(--mh-bg)); font-weight: 600; }
  .tree-icon { color: var(--mh-muted); text-align: center; font-size: 11px; }
  .tree-label { min-width: 0; }
  .tree-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-sub { display: block; margin-top: 1px; font-size: 10px; color: var(--mh-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .count { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: var(--mh-chip); }
  .notice { margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--mh-border); background: var(--mh-soft); font-size: 12px; }
  .notice[hidden] { display: none; }
  .err { color: var(--mh-danger); white-space: pre-wrap; }
  .card { border: 1px solid var(--mh-border); border-radius: 12px; padding: 12px; margin-bottom: 10px; }
  .card p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .pill { font-size: 11px; border-radius: 999px; padding: 2px 8px; background: var(--mh-chip); }
  .pill.personal { background: var(--true-color-blue-muted, color-mix(in srgb, #0969da 18%, transparent)); }
  .pill.node, .pill.root { background: var(--true-color-green-muted, color-mix(in srgb, #1a7f37 20%, transparent)); }
  .pill.unlisted, .pill.other { background: var(--true-color-orange-muted, color-mix(in srgb, #bc4c00 20%, transparent)); }
  details { margin-top: 8px; border-top: 1px solid var(--mh-border); padding-top: 6px; }
  summary { cursor: pointer; width: fit-content; font-size: 12px; font-weight: 600; color: var(--mh-muted); }
  pre { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
  .empty { color: var(--mh-muted); padding: 22px; text-align: center; }
  code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
  .overlay { position: fixed; inset: 0; background: color-mix(in srgb, #000 45%, transparent); display: none; align-items: center; justify-content: center; z-index: 10; }
  .overlay.show { display: flex; }
  .modal { background: var(--mh-bg); color: var(--mh-fg); border: 1px solid var(--mh-border); border-radius: 12px; padding: 18px;
    max-width: 680px; width: 90%; max-height: 82vh; overflow: auto; box-shadow: 0 10px 40px color-mix(in srgb, #000 30%, transparent); }
  .modal button { width: auto; min-width: 100px; }
  .modal .choice { display: flex; gap: 10px; margin-top: 10px; }
  .modal .choice button { flex: 1; text-align: left; padding: 14px; font-weight: 400; }
  .modal .choice .t { font-weight: 600; display: block; margin-bottom: 4px; }
  .modal .choice .d { display: block; color: var(--mh-muted); font-size: 12px; }
  .modal .bar { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .modal .msg { font-size: 12px; color: var(--mh-muted); }
  .modal .ghost { background: transparent; }
  .modal .rows { margin: 8px 0; max-height: 46vh; overflow: auto; border: 1px solid var(--mh-border); border-radius: 8px; }
  .modal .row { display: flex; gap: 8px; padding: 8px; margin: 0; align-items: flex-start; cursor: pointer; color: var(--mh-fg); font-size: 13px; }
  .modal .row:hover { background: var(--mh-soft); }
  .modal .row input { width: auto; margin-top: 3px; }
  .modal .row .body { flex: 1; min-width: 0; }
  .modal .row .lbl { font-weight: 600; }
  .modal .row .sub { color: var(--mh-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .modal .row .q { color: var(--mh-muted); font-size: 12px; margin-top: 3px; display: flex; gap: 6px; }
  .modal .row .q b { flex: 0 0 40px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
  .modal .selall { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 8px; }
  .modal .selall input { width: auto; }
  .modal .selall label { margin: 0; }
  main[hidden] { display: none; }
  .tabs { display: flex; gap: 4px; }
  .tab { width: auto; padding: 4px 12px; border-radius: 999px; border-color: transparent; background: transparent; }
  .tab[aria-selected="true"] { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 18%, var(--mh-bg)); }
  .playbook-view { display: block; }
  .pb-list { margin-top: 12px; max-width: 960px; }
  .pb { border: 1px solid var(--mh-border); border-radius: 12px; margin-bottom: 8px; }
  .pb-head { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; align-items: center; text-align: left;
    padding: 9px 12px; border: 0; border-radius: 12px; background: transparent; }
  .pb-head:hover { background: var(--mh-soft); }
  .pb-sub { display: block; font-size: 11px; color: var(--mh-muted); font-weight: 400; }
  .pb-body { padding: 2px 12px 12px 36px; }
  .sections { list-style: none; margin: 0; padding: 0 0 0 16px; border-left: 1px solid var(--mh-border); }
  .sections.top { padding-left: 0; border-left: 0; }
  .sections li { margin: 8px 0 0; }
  .sec-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .sec-name { font-weight: 600; overflow-wrap: anywhere; }
  .sec-desc { font-size: 12px; color: var(--mh-muted); margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pill.you { background: color-mix(in srgb, var(--mh-accent) 28%, transparent); }
  .pill.refused { background: var(--true-color-orange-muted, color-mix(in srgb, #bc4c00 20%, transparent)); }
  .pb.learnings { border-color: color-mix(in srgb, var(--mh-accent) 45%, var(--mh-border)); }
  .pill.mem-toggle { width: auto; border-color: transparent; cursor: pointer;
    background: var(--true-color-green-muted, color-mix(in srgb, #1a7f37 20%, transparent)); }
  .pill.mem-toggle[aria-expanded="true"] { border-color: var(--mh-accent); }
  .sec-mem { margin: 8px 0 4px; }
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <nav class="tabs" role="tablist" aria-label="Views">
    <button id="tabMemories" class="tab" role="tab" type="button" aria-selected="true" aria-controls="memoryView">Memories</button>
    <button id="tabPlaybooks" class="tab" role="tab" type="button" aria-selected="false" aria-controls="playbookView">Playbooks</button>
  </nav>
  <span id="who" class="who">Loading...</span>
  <span class="spacer"></span>
  <button id="import" class="primary" type="button">Import memory</button>
  <button id="refresh" type="button">Refresh</button>
</header>
<main id="memoryView" role="tabpanel" aria-labelledby="tabMemories">
  <aside>
    <label>Signed-in principal</label><div id="principal" class="identity">Loading...</div>
    <label>Tenant</label><div id="tenant" class="identity">Loading...</div>

    <div class="toolbar">
      <button id="filterToggle" class="filter-toggle" type="button" aria-expanded="false" aria-controls="filterPanel" title="Filters">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.25A.75.75 0 0 1 2.25 1.5h11.5a.75.75 0 0 1 .58 1.225L9.5 8.628v4.122a.75.75 0 0 1-.416.671l-2 1A.75.75 0 0 1 6 13.75V8.628L1.67 2.725a.75.75 0 0 1-.17-.475Z"/></svg>
        <span>Filters</span><span id="filterCount" class="badge" hidden>0</span>
      </button>
    </div>
    <div id="filterPanel" class="filter-panel" hidden>
      <label for="search">Search</label><input id="search" placeholder="Content, node, id or tag" />
      <label for="memoryType">Memory type</label>
      <select id="memoryType">
        <option value="">All</option><option value="fact">Fact</option><option value="episodic">Episodic</option><option value="procedural">Procedural</option>
      </select>
      <label for="limit">Newest memories to load (1-200)</label><input id="limit" type="number" min="1" max="200" value="200" />
      <div class="checkline"><input id="includeSuperseded" type="checkbox" /><label for="includeSuperseded" style="margin:0">Include superseded</label></div>
      <button id="apply" type="button">Apply filters</button>
    </div>

    <label for="autoRefresh">Auto-refresh</label>
    <div class="range-row">
      <input id="autoRefresh" type="range" min="0" max="300" step="5" value="15" />
      <span id="autoRefreshValue" class="range-value">15s</span>
    </div>
    <div class="hint">0 turns auto-refresh off. Promotion and extraction run in the background, so new memories can appear without any action here.</div>

    <div class="scopes-head">
      <h3>Where your memories live</h3>
      <button id="showAll" class="link-button" type="button" aria-pressed="true">All</button>
    </div>
    <div class="hint">Your personal memories, then every hierarchy node you can read.</div>
    <div id="tree" class="tree" role="tree" aria-label="Memory scopes"></div>
  </aside>
  <section>
    <h2 id="heading">Memories</h2>
    <div id="error" class="notice err" role="alert" hidden></div>
    <div id="notices" class="notice" hidden></div>
    <div id="cards"></div>
  </section>
</main>
<main id="playbookView" class="playbook-view" role="tabpanel" aria-labelledby="tabPlaybooks" hidden>
  <section>
    <h2>Playbooks</h2>
    <div class="hint">My Learnings lists your personal memories. Below it are the playbooks and sections Microsoft IQ shows you, read with your Azure CLI sign-in, which must be the account you use for Memory House, and the memories promoted into each section. Select a playbook to load its sections. Memories refresh on the Memories tab's auto-refresh interval, and playbooks and open sections every 10 minutes while this tab is showing, unless auto-refresh is off. Nothing is changed in Microsoft IQ or Memory House.</div>
    <div id="playbooks" class="pb-list"></div>
  </section>
</main>

<div id="overlay" class="overlay" role="dialog" aria-modal="true" aria-label="Import memory">
  <div class="modal" id="modal"></div>
</div>

<script nonce="${t}">
  const TOKEN = ${JSON.stringify(e)};
  const HEADERS = { 'x-mh-canvas-token': TOKEN };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONS = { personal: '&#9679;', root: '&#9670;', node: '&#9632;', unlisted: '&#9675;', other: '&#9675;' };
  const state = { data: null, selected: null, filters: { search: '', memoryTypes: [], limit: 200, includeSuperseded: false }, loading: false };

  function rowFor(scope) {
    return (state.data?.rows || []).find(row => row.scope === scope) || null;
  }

  function rowLabel(row) {
    if (!row) return 'All memories';
    if (row.kind === 'personal') return 'Personal';
    return row.path || row.name;
  }

  function treeHtml() {
    const data = state.data || { rows: [] };
    const button = row => {
      const active = row.scope === state.selected;
      const indent = row.depth * 18;
      const sub = row.kind === 'personal' ? (data.principal || row.scope)
        : row.kind === 'unlisted' ? 'Not in your hierarchy view: ' + row.scope
        : row.kind === 'other' ? 'Unrecognized scope' : (row.description || row.path);
      return '<button type="button" class="tree-node' + (active ? ' active' : '') + '" role="treeitem" aria-level="' + (row.depth + 1) +
        '" aria-selected="' + active + '" data-scope="' + esc(row.scope) + '" style="--indent:' + indent + 'px" title="' + esc(row.path || row.scope) + '">' +
        '<span class="tree-icon" aria-hidden="true">' + ICONS[row.kind] + '</span><span class="tree-label"><span class="tree-name">' + esc(row.name) +
        '</span><span class="tree-sub">' + esc(sub) + '</span></span><span class="count">' + row.count + '</span></button>';
    };
    const personal = data.rows.filter(row => row.kind === 'personal');
    const shared = data.rows.filter(row => row.kind === 'root' || row.kind === 'node');
    const other = data.rows.filter(row => row.kind === 'unlisted' || row.kind === 'other');
    let html = '<div class="tree-section">Personal</div>' + (personal.length ? personal.map(button).join('') : '<div class="hint">No personal scope yet.</div>');
    html += '<div class="tree-section">Shared hierarchy</div>' + (shared.length ? shared.map(button).join('')
      : '<div class="hint">You are not a member or curator of any hierarchy node yet.</div>');
    if (other.length) html += '<div class="tree-section">Other scopes</div>' + other.map(button).join('');
    return html;
  }

  // In the Playbooks view the section names the scope, and the caller's own principal reads as "You".
  function card(memory, options = {}) {
    const kind = memory.scope_kind;
    const where = kind === 'personal' ? 'Personal' : memory.scope_path || memory.scope_label;
    const pills = [
      options.hideScope ? '' : '<span class="pill ' + esc(kind) + '">' + esc(where) + '</span>',
      memory.type ? '<span class="pill">' + esc(memory.type) + '</span>' : '',
      memory.source ? '<span class="pill">via ' + esc(memory.source) + '</span>' : '',
      memory.superseded ? '<span class="pill">superseded</span>' : '',
      ...memory.tags.slice(0, 4).map(tag => '<span class="pill">' + esc(tag) + '</span>'),
    ].join('');
    const promo = memory.promotion;
    const mine = value => Boolean(options.principal) && value === options.principal;
    const fromLabel = promo && mine(promo.from_scope) ? 'Your personal memories' : promo?.from_label;
    const origin = promo && mine(promo.origin) ? 'You' : promo?.origin;
    const details = {
      id: memory.id, scope_key: memory.scope_key, scope_path: memory.scope_path || undefined, type: memory.type,
      created_at: memory.created_at, updated_at: memory.updated_at, salience: memory.salience, confidence: memory.confidence, source: memory.source,
      promoted_from: promo?.from_label || undefined, origin_user: promo?.origin || undefined,
      promotion_rationale: promo?.rationale || undefined, promoted_at: promo?.promoted_at || undefined,
    };
    const promoLines = promo ? '<div class="promo">' +
      (fromLabel ? '<div><b>From:</b> ' + esc(fromLabel) + '</div>' : '') +
      (origin ? '<div><b>Origin:</b> ' + esc(origin) + '</div>' : '') +
      (promo.rationale ? '<div><b>Why:</b> ' + esc(promo.rationale) + '</div>' : '') + '</div>' : '';
    return '<article class="card"><p>' + esc(memory.content || '(no text)') + '</p>' + promoLines + '<div class="meta">' + pills +
      '</div><details><summary>Details</summary><pre>' + esc(JSON.stringify(details, null, 2)) + '</pre></details></article>';
  }

  function visible() {
    const groups = state.data?.groups || {};
    if (state.selected) return groups[state.selected] || [];
    return (state.data?.rows || []).flatMap(row => groups[row.scope] || []);
  }

  function render() {
    const data = state.data || {};
    $('who').textContent = data.principal || '';
    $('principal').textContent = data.principal || 'Unknown';
    $('tenant').textContent = data.tenant || 'Unknown';
    $('tree').innerHTML = treeHtml();
    $('showAll').setAttribute('aria-pressed', String(!state.selected));
    const list = visible();
    $('heading').textContent = rowLabel(rowFor(state.selected)) + ' (' + list.length + ')';
    $('cards').innerHTML = list.length ? list.map(card).join('')
      : '<div class="empty">' + (state.selected ? 'No memories in this scope yet.' : 'No memories to show yet.') + '</div>';
    const notes = [...(data.warnings || [])];
    if (data.truncated) notes.push('Showing the newest ' + data.limit + ' memories you can read. Use filters to narrow the list.');
    $('notices').innerHTML = notes.map(esc).join('<br>');
    $('notices').hidden = notes.length === 0;
    const active = [state.filters.search, state.filters.memoryTypes.length, state.filters.includeSuperseded, state.filters.limit !== 200].filter(Boolean).length;
    $('filterCount').textContent = String(active);
    $('filterCount').hidden = active === 0;
  }

  function showError(html) {
    $('error').innerHTML = html;
    $('error').hidden = !html;
  }

  async function errorText(response) {
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') return body.message;
    } catch {}
    return 'Memory House request failed (HTTP ' + response.status + ').';
  }

  function query() {
    const params = new URLSearchParams({ limit: String(state.filters.limit) });
    if (state.filters.search) params.set('search', state.filters.search);
    for (const type of state.filters.memoryTypes) params.append('memory_types', type);
    if (state.filters.includeSuperseded) params.set('include_superseded', 'true');
    return params;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $('refresh').disabled = true;
    try {
      const response = await fetch('/api/memory?' + query(), { headers: HEADERS, cache: 'no-store' });
      if (response.status === 401) {
        showError('Not signed in to Memory House. Run <code>/mh-login</code> in a chat, then select Refresh.');
        return;
      }
      if (!response.ok) { showError(esc(await errorText(response))); return; }
      state.data = await response.json();
      if (state.selected && !rowFor(state.selected)) state.selected = null;
      showError('');
      render();
    } catch {
      showError('Could not reach the Memory House canvas. Close and reopen it if this continues.');
    } finally {
      state.loading = false;
      $('refresh').disabled = false;
    }
  }

  $('refresh').addEventListener('click', () => refreshView());
  $('filterToggle').addEventListener('click', () => {
    const panel = $('filterPanel');
    panel.hidden = !panel.hidden;
    $('filterToggle').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('apply').addEventListener('click', () => {
    const type = $('memoryType').value;
    const limit = Number($('limit').value);
    state.filters = {
      search: $('search').value.trim(),
      memoryTypes: type ? [type] : [],
      limit: Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 200,
      includeSuperseded: $('includeSuperseded').checked,
    };
    $('limit').value = String(state.filters.limit);
    load();
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') $('apply').click(); });
  $('tree').addEventListener('click', event => {
    const node = event.target.closest('.tree-node');
    if (!node) return;
    state.selected = node.getAttribute('data-scope');
    render();
  });
  $('showAll').addEventListener('click', () => { state.selected = null; render(); });

  // Import: choose the source agent, then what to import from it.
  const SOURCES = {
    copilot: { label: 'GitHub Copilot', memory: 'Copilot memories', memoryText: 'Facts Copilot saved with its memory tool on this device.', sessionText: 'Pick recent Copilot sessions; their turns go through Memory House extraction.' },
    claude: { label: 'Claude Code', memory: 'Claude memories', memoryText: 'Memory files Claude Code saved for your projects.', sessionText: 'Pick recent Claude Code sessions; their turns go through Memory House extraction.' },
  };
  const overlay = $('overlay');
  const modal = $('modal');
  let importing = false;
  let source = 'copilot';
  const close = () => { if (importing) return; overlay.classList.remove('show'); modal.innerHTML = ''; };
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 401) throw new Error('Not signed in to Memory House. Run /mh-login in a chat, then try again.');
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  }

  function outcome(result, noun) {
    const sent = noun === 'memories' ? result.memories : result.messages;
    let text = noun === 'memories'
      ? 'Sent ' + sent + ' memories' + (result.reconcile ? ' and requested reconciliation.' : '.')
      : 'Sent ' + sent + ' messages from ' + result.sessions + ' session(s) for extraction.';
    if (result.skipped) text += ' Skipped ' + result.skipped + ' empty or filtered item(s).';
    if (result.failed || result.unknown) text += ' ' + (result.failed + result.unknown) + ' item(s) were not confirmed.';
    if (noun === 'messages' && sent) text += ' New memories appear after background processing.';
    if (result.error) text += ' Stopped early: ' + result.error.message;
    return text;
  }

  function openChoice() {
    modal.innerHTML = '<h2>Import memory</h2><div class="msg">Which agent on this device should Memory House import from?</div>' +
      '<div class="choice"><button type="button" data-source="copilot"><span class="t">GitHub Copilot</span><span class="d">Sessions and saved memories from Copilot.</span></button>' +
      '<button type="button" data-source="claude"><span class="t">Claude Code</span><span class="d">Sessions and memory files from Claude Code.</span></button></div>' +
      '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="m-cancel">Cancel</button></div>';
    overlay.classList.add('show');
    $('m-cancel').onclick = close;
    for (const button of modal.querySelectorAll('[data-source]')) button.onclick = () => openKind(button.getAttribute('data-source'));
  }

  function openKind(selected) {
    source = selected;
    const info = SOURCES[source];
    modal.innerHTML = '<h2>Import from ' + esc(info.label) + '</h2>' +
      '<div class="choice"><button type="button" id="k-memory"><span class="t">' + esc(info.memory) + '</span><span class="d">' + esc(info.memoryText) + '</span></button>' +
      '<button type="button" id="k-sessions"><span class="t">Recent sessions</span><span class="d">' + esc(info.sessionText) + '</span></button></div>' +
      '<div class="msg" style="margin-top:10px">Imports go to your personal memories. Text is filtered for credentials first; original timestamps are not kept.</div>' +
      '<div class="bar"><span id="k-msg" class="msg"></span><span class="spacer"></span><button type="button" class="ghost" id="k-back">Back</button><button type="button" class="ghost" id="k-cancel">Cancel</button></div>';
    $('k-back').onclick = openChoice;
    $('k-cancel').onclick = close;
    $('k-memory').onclick = importMemories;
    $('k-sessions').onclick = openSessions;
  }

  async function importMemories() {
    const message = $('k-msg');
    for (const button of modal.querySelectorAll('button')) button.disabled = true;
    importing = true;
    message.textContent = 'Importing ' + SOURCES[source].label + ' memories...';
    try {
      const result = await post('/api/import/memories', { source });
      message.textContent = outcome(result, 'memories');
      if (result.error) message.classList.add('err');
      load();
    } catch (error) {
      message.innerHTML = '<span class="err">' + esc(error.message) + '</span>';
    } finally {
      importing = false;
      for (const button of modal.querySelectorAll('button')) button.disabled = false;
    }
  }

  async function openSessions() {
    modal.innerHTML = '<h2>Import recent sessions</h2><div class="msg">Reading local ' + esc(SOURCES[source].label) + ' sessions...</div>';
    let listing;
    try {
      const response = await fetch('/api/import/sessions?source=' + encodeURIComponent(source), { headers: HEADERS });
      if (!response.ok) throw new Error(await errorText(response));
      listing = await response.json();
    } catch (error) {
      modal.innerHTML = '<h2>Import recent sessions</h2><div class="err">' + esc(error.message) + '</div>' +
        '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button></div>';
      $('s-back').onclick = () => openKind(source);
      return;
    }
    const sessions = listing.sessions || [];
    if (!sessions.length) {
      modal.innerHTML = '<h2>Import recent sessions</h2><div class="msg">No local ' + esc(SOURCES[source].label) + ' sessions with complete turns were found.</div>' +
        '<div class="bar"><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button></div>';
      $('s-back').onclick = () => openKind(source);
      return;
    }
    const folder = cwd => String(cwd || '').split(/[\\\\/]/).filter(Boolean).pop() || '';
    const when = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };
    modal.innerHTML = '<h2>Import recent sessions <span class="msg">(' + sessions.length + ', newest first)</span></h2>' +
      '<div class="selall"><input type="checkbox" id="s-all"><label for="s-all">Select all</label></div>' +
      '<div class="rows">' + sessions.map(session =>
        '<label class="row"><input type="checkbox" class="s-pick" value="' + esc(session.session_id) + '"><span class="body">' +
        '<div class="lbl">' + esc(session.label) + '</div>' +
        '<div class="sub">' + esc([folder(session.cwd), when(session.start_time), session.turn_count + ' turn(s)'].filter(Boolean).join(' - ')) + '</div>' +
        (session.last_user_turn ? '<div class="q"><b>You</b><span>' + esc(session.last_user_turn) + '</span></div>' : '') +
        (session.last_agent_turn ? '<div class="q"><b>Agent</b><span>' + esc(session.last_agent_turn) + '</span></div>' : '') +
        '</span></label>').join('') + '</div>' +
      '<div class="bar"><span id="s-msg" class="msg"></span><span class="spacer"></span><button type="button" class="ghost" id="s-back">Back</button>' +
      '<button type="button" class="primary" id="s-import">Import</button></div>';
    const picks = [...modal.querySelectorAll('.s-pick')];
    $('s-all').onchange = event => picks.forEach(pick => { pick.checked = event.target.checked; });
    $('s-back').onclick = () => openKind(source);
    $('s-import').onclick = async () => {
      const ids = picks.filter(pick => pick.checked).map(pick => pick.value);
      const message = $('s-msg');
      if (!ids.length) { message.innerHTML = '<span class="err">Select at least one session.</span>'; return; }
      for (const button of modal.querySelectorAll('button, input')) button.disabled = true;
      importing = true;
      message.textContent = 'Importing ' + ids.length + ' session(s). Large sessions can take a few minutes...';
      try {
        const result = await post('/api/import/sessions', { source, ids });
        message.textContent = outcome(result, 'messages');
        if (result.error) message.classList.add('err');
        load();
      } catch (error) {
        message.innerHTML = '<span class="err">' + esc(error.message) + '</span>';
      } finally {
        importing = false;
        for (const button of modal.querySelectorAll('button, input')) button.disabled = false;
      }
    };
  }

  $('import').addEventListener('click', openChoice);

  // Microsoft IQ playbooks, read through the canvas server with the user's own Azure CLI sign-in.
  // Each playbook's sections load when it is first expanded. The memories promoted into those
  // sections and the My Learnings entry come from Memory House, and refresh on the auto-refresh
  // interval without reading Microsoft IQ. Playbooks and sections change rarely and read slowly,
  // so the list and the open playbooks refresh quietly every 10 minutes instead.
  const LEARNINGS = 'learnings';
  const PLAYBOOK_REFRESH_MS = 10 * 60 * 1000;
  const pb = {
    view: 'memories', list: null, listError: '', listLoading: false, listTicket: 0, listCheckedAt: 0,
    trees: new Map(), treeLoadedAt: new Map(), treeErrors: new Map(), treeRefreshing: new Set(), memories: new Map(),
    learnings: null, open: new Set(), openSections: new Set(), tickets: new Map(), inflight: new Set(), generation: 0,
  };
  const pbKey = playbook => playbook.workspaceId + '/' + playbook.playbookId;
  const treePath = playbook => '/api/miq/tree?' + new URLSearchParams({ workspace_id: playbook.workspaceId, playbook_id: playbook.playbookId });
  const plural = (count, noun, nouns) => Number(count) + ' ' + (Number(count) === 1 ? noun : nouns || noun + 's');
  const ready = value => Boolean(value) && value !== 'loading' && !(value instanceof Error);
  const me = () => (ready(pb.learnings) ? pb.learnings.principal : null);

  function refreshView() {
    if (pb.view === 'playbooks') loadPlaybooks();
    else load();
  }

  function setView(view) {
    pb.view = view;
    const playbooks = view === 'playbooks';
    $('memoryView').hidden = playbooks;
    $('playbookView').hidden = !playbooks;
    $('tabMemories').setAttribute('aria-selected', String(!playbooks));
    $('tabPlaybooks').setAttribute('aria-selected', String(playbooks));
    if (!playbooks) return;
    if (!pb.list && !pb.listLoading) loadPlaybooks();
    else refreshPlaybooksIfStale();
  }

  async function getJson(path) {
    const response = await fetch(path, { headers: HEADERS, cache: 'no-store' });
    if (response.status === 401) throw new Error('Not signed in to Memory House. Run /mh-login in a chat, then select Refresh.');
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch {}
      const error = new Error(body && typeof body.message === 'string' ? body.message : 'Memory House request failed (HTTP ' + response.status + ').');
      error.code = body && typeof body.error === 'string' ? body.error : '';
      throw error;
    }
    return response.json();
  }

  // Playbooks read with an Azure CLI account that is not the Memory House user would pair someone else's
  // playbooks with these memories, so none stay shown. Open playbooks reopen once the account matches.
  const isAccountMismatch = value => value instanceof Error && value.code === 'MIQ_ACCOUNT_MISMATCH';
  function dropPlaybooks(message) {
    pb.list = null;
    pb.listError = message;
    pb.generation += 1;
    pb.trees.clear();
    pb.treeLoadedAt.clear();
    pb.treeErrors.clear();
    pb.memories.clear();
    renderPlaybooks();
  }

  // Memory House is now signed in as someone else, so the playbooks shown were read for the previous person.
  function reloadForNewAccount() {
    dropPlaybooks('You are now signed in to Memory House as someone else. Loading your playbooks...');
    loadPlaybooks();
  }

  // Returns true when an answer was about the account rather than the data, after acting on it.
  function handledAccountChange(value) {
    if (isAccountMismatch(value)) { dropPlaybooks(value.message); return true; }
    if (value instanceof Error && value.code === 'MIQ_ACCOUNT_CHANGED') { reloadForNewAccount(); return true; }
    return false;
  }

  // A background refresh skips a key whose last request is still running, keeps what is shown until
  // new data arrives, and redraws only on a change. An explicit load supersedes a running request.
  // An answer that is no longer current is dropped, and an account change is acted on even in the background.
  async function fetchMemories(key, path, read, write, quiet, isCurrent = () => true) {
    if (quiet && pb.inflight.has(key)) return;
    const ticket = (pb.tickets.get(key) || 0) + 1;
    pb.tickets.set(key, ticket);
    pb.inflight.add(key);
    const previous = read();
    if (!quiet || !ready(previous)) { write('loading'); renderPlaybooks(); }
    let next;
    try {
      next = await getJson(path);
    } catch (error) {
      next = error instanceof Error ? error : new Error('Could not load memories.');
    }
    if (pb.tickets.get(key) !== ticket) return;
    pb.inflight.delete(key);
    if (!isCurrent() || handledAccountChange(next)) return;
    if (quiet && ready(previous) && (next instanceof Error || JSON.stringify(next) === JSON.stringify(previous))) return;
    write(next);
    renderPlaybooks();
  }

  function loadLearnings(quiet = false) {
    return fetchMemories(LEARNINGS, '/api/learnings', () => pb.learnings, value => {
      const before = ready(pb.learnings) ? pb.learnings.principal : null;
      pb.learnings = value;
      // Memory House is now signed in as someone else: reload the playbooks for that person.
      if (before && ready(value) && value.principal !== before) setTimeout(reloadForNewAccount, 0);
    }, quiet);
  }

  function loadSectionMemories(key, quiet = false) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook) return;
    // Memories requested before the playbooks were reloaded or hidden belong to trees no longer shown.
    const generation = pb.generation;
    const query = new URLSearchParams({ workspace_id: playbook.workspaceId, playbook_id: playbook.playbookId });
    return fetchMemories(key, '/api/miq/memories?' + query, () => pb.memories.get(key),
      value => pb.memories.set(key, value), quiet, () => generation === pb.generation);
  }

  function memoryCards(records) {
    const principal = me();
    return records.map(record => card(record, { hideScope: true, principal })).join('');
  }

  function sectionHtml(key, node, memories) {
    const records = ready(memories) && node.scope ? memories.groups[node.scope] || [] : [];
    const sectionKey = key + ' ' + node.scope;
    const showing = records.length > 0 && pb.openSections.has(sectionKey);
    const pills = [];
    if (node.refused) pills.push('<span class="pill refused">no access (HTTP ' + esc(node.refused) + ')</span>');
    else if (node.skipped) pills.push('<span class="pill refused">not loaded</span>');
    else {
      if (records.length) {
        pills.push('<button type="button" class="pill mem-toggle" aria-expanded="' + showing + '" data-section="' + esc(sectionKey) +
          '" title="' + (showing ? 'Hide' : 'Show') + ' the memories in this section"><span aria-hidden="true">' + (showing ? '&#9662; ' : '&#9656; ') +
          '</span>' + esc(plural(records.length, 'memory', 'memories')) + '</button>');
      }
      if (node.role === 'curator') pills.push('<span class="pill you">you: curator</span>');
      else if (node.curatorVia) {
        pills.push('<span class="pill you" title="' + esc('You curate ' + node.curatorVia.split('/').join(' / ') + ', which covers the sections below it.') +
          '">you: curator (inherited)</span>');
      } else if (node.role) pills.push('<span class="pill you">you: ' + esc(node.role) + '</span>');
      pills.push('<span class="pill">' + esc(plural(node.curators, 'direct curator')) + '</span>');
      pills.push('<span class="pill">' + esc(plural(node.users, 'direct user')) + '</span>');
      if (node.groups) pills.push('<span class="pill">' + esc(plural(node.groups, 'group or app', 'groups or apps')) + '</span>');
    }
    const children = (node.children || []).length
      ? '<ul class="sections">' + node.children.map(child => '<li>' + sectionHtml(key, child, memories) + '</li>').join('') + '</ul>' : '';
    return '<div class="sec-row"><span class="sec-name">' + esc(node.name) + '</span>' + pills.join('') + '</div>' +
      (node.description ? '<div class="sec-desc">' + esc(node.description) + '</div>' : '') +
      (showing ? '<div class="sec-mem">' + memoryCards(records) + '</div>' : '') + children;
  }

  function memoryNote(memories) {
    if (memories === 'loading') return '<div class="hint">Loading the memories in these sections...</div>';
    if (memories instanceof Error) return '<div class="notice err">Memories could not be loaded: ' + esc(memories.message) + '</div>';
    if (!ready(memories)) return '';
    if (!memories.total) return '<div class="hint">No memories have been promoted into these sections yet.</div>';
    return memories.truncated ? '<div class="hint">Showing the newest memories: Memory House returns up to 200 for every 20 sections.</div>' : '';
  }

  function pbHtml(key, name, sub, body, extraClass) {
    const open = pb.open.has(key);
    return '<div class="pb' + (extraClass ? ' ' + extraClass : '') + '"><button type="button" class="pb-head" aria-expanded="' + open + '" data-key="' + esc(key) + '">' +
      '<span class="tree-icon" aria-hidden="true">' + (open ? '&#9662;' : '&#9656;') + '</span>' +
      '<span><span class="tree-name">' + esc(name) + '</span><span class="pb-sub">' + esc(sub) + '</span></span></button>' +
      (open && body ? '<div class="pb-body">' + body + '</div>' : '') + '</div>';
  }

  function learningsHtml() {
    const data = pb.learnings;
    if (data instanceof Error) return pbHtml(LEARNINGS, 'My Learnings', data.message, '', 'learnings');
    if (!ready(data)) return pbHtml(LEARNINGS, 'My Learnings', 'Loading your personal memories...', '', 'learnings');
    const sub = data.truncated ? 'Your newest ' + plural(data.total, 'personal memory', 'personal memories')
      : plural(data.total, 'personal memory', 'personal memories');
    const body = data.memories.length ? memoryCards(data.memories)
      : '<div class="empty">No personal memories yet. Memory House saves them from your conversations.</div>';
    return pbHtml(LEARNINGS, 'My Learnings', sub, body, 'learnings');
  }

  function playbookHtml(playbook) {
    const key = pbKey(playbook);
    const tree = pb.trees.get(key);
    const memories = pb.memories.get(key);
    let sub = 'Select to load its sections';
    let body = '';
    if (tree === 'loading') sub = 'Loading sections...';
    else if (tree instanceof Error) { sub = 'Could not load its sections'; body = '<div class="err">' + esc(tree.message) + '</div>'; }
    else if (tree && !tree.access) sub = 'No access: Microsoft IQ answered HTTP ' + tree.status;
    else if (tree) {
      const parts = [plural(tree.sections, 'section')];
      if (ready(memories)) parts.push(plural(memories.total, 'memory', 'memories'));
      if (tree.root && tree.root.role) parts.push('you: ' + tree.root.role);
      sub = parts.join(' - ');
      const refreshError = pb.treeErrors.get(key);
      body = (refreshError ? '<div class="notice err">These sections could not be refreshed and may be out of date: ' + esc(refreshError) + '</div>' : '') +
        memoryNote(memories) + '<ul class="sections top"><li>' + sectionHtml(key, tree.root, memories) + '</li></ul>' +
        (tree.truncated ? '<div class="hint">Showing the first ' + esc(tree.sections) + ' sections.</div>' : '');
    }
    return pbHtml(key, playbook.name, sub, body, '');
  }

  // innerHTML replaces every button, so focus moves to the replacement of the focused one.
  function renderPlaybooks() {
    const container = $('playbooks');
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const focus = active && ['data-section', 'data-key'].find(name => active.hasAttribute(name));
    const focusValue = focus ? active.getAttribute(focus) : null;
    let html = learningsHtml();
    if (pb.listError) html += '<div class="notice err" role="alert">' + esc(pb.listError) + '</div>';
    if (pb.list === null) html += pb.listLoading ? '<div class="empty">Loading your Microsoft IQ playbooks...</div>' : '';
    else if (!pb.list.length) html += '<div class="empty">Microsoft IQ lists no playbooks for you.</div>';
    else html += pb.list.map(playbookHtml).join('');
    container.innerHTML = html;
    if (!focus) return;
    for (const element of container.querySelectorAll('[' + focus + ']')) {
      if (element.getAttribute(focus) === focusValue) { element.focus(); return; }
    }
  }

  async function openPlaybook(key) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook) return;
    pb.open.add(key);
    const cached = pb.trees.get(key);
    if (cached && !(cached instanceof Error)) {
      renderPlaybooks();
      // Sections cached while the playbook was closed show at once and refresh quietly when old.
      if (ready(cached) && Date.now() - (pb.treeLoadedAt.get(key) || 0) >= PLAYBOOK_REFRESH_MS) refreshTree(key);
      return;
    }
    const generation = pb.generation;
    pb.trees.set(key, 'loading');
    pb.treeErrors.delete(key);
    renderPlaybooks();
    let tree;
    try {
      tree = await getJson(treePath(playbook));
    } catch (error) {
      tree = error instanceof Error ? error : new Error('Could not load this playbook.');
    }
    if (generation !== pb.generation || handledAccountChange(tree)) return;
    pb.trees.set(key, tree);
    if (ready(tree)) pb.treeLoadedAt.set(key, Date.now());
    renderPlaybooks();
    if (ready(tree) && tree.access) loadSectionMemories(key);
  }

  // Re-reads an open playbook's sections without clearing what is shown. A failure keeps the sections
  // and says so above them; a change redraws them, keeping expanded sections, and refreshes their memories.
  async function refreshTree(key) {
    const playbook = (pb.list || []).find(item => pbKey(item) === key);
    if (!playbook || pb.treeRefreshing.has(key)) return;
    pb.treeRefreshing.add(key);
    const generation = pb.generation;
    let tree;
    try {
      tree = await getJson(treePath(playbook));
    } catch (error) {
      tree = error instanceof Error ? error : new Error('Could not refresh this playbook.');
    } finally {
      pb.treeRefreshing.delete(key);
    }
    if (generation !== pb.generation || !ready(pb.trees.get(key)) || handledAccountChange(tree)) return;
    if (tree instanceof Error) {
      if (pb.treeErrors.get(key) !== tree.message) { pb.treeErrors.set(key, tree.message); renderPlaybooks(); }
      return;
    }
    pb.treeLoadedAt.set(key, Date.now());
    const recovered = pb.treeErrors.delete(key);
    if (recovered || JSON.stringify(tree) !== JSON.stringify(pb.trees.get(key))) {
      pb.trees.set(key, tree);
      if (!tree.access) pb.memories.delete(key);
      renderPlaybooks();
    }
    if (tree.access) loadSectionMemories(key, true);
  }

  // Refresh reloads the list and every open playbook. The background refresh re-reads the list and
  // the open playbooks quietly and redraws only what changed. Either way, sections and memories are
  // replaced only once a new list arrives, so a failed refresh keeps what is shown and reports the
  // failure above the list. A newer load supersedes an older one.
  async function loadPlaybooks(quiet = false) {
    if (quiet && pb.listLoading) return;
    const ticket = ++pb.listTicket;
    pb.listLoading = true;
    pb.listCheckedAt = Date.now();
    if (!quiet) loadLearnings();
    let data;
    try {
      data = await getJson('/api/miq/playbooks');
    } catch (error) {
      data = error instanceof Error ? error : new Error('Could not load your Microsoft IQ playbooks.');
    }
    if (ticket !== pb.listTicket) return;
    pb.listLoading = false;
    if (handledAccountChange(data)) return;
    const error = data instanceof Error ? data.message : '';
    let changed = !quiet || error !== pb.listError;
    pb.listError = error;
    if (!error) {
      const list = Array.isArray(data.playbooks) ? data.playbooks : [];
      if (quiet) changed = mergeList(list) || changed;
      else replaceList(list);
    }
    if (changed) renderPlaybooks();
  }

  function replaceList(list) {
    pb.list = list;
    pb.generation += 1;
    pb.trees.clear();
    pb.treeLoadedAt.clear();
    pb.treeErrors.clear();
    pb.memories.clear();
    for (const key of [...pb.open]) {
      if (key === LEARNINGS) continue;
      if (list.some(item => pbKey(item) === key)) openPlaybook(key);
      else pb.open.delete(key);
    }
  }

  // Applies a background list: drops playbooks that are gone, re-reads the open ones and retries an open
  // playbook whose sections failed to load. Closed playbooks refresh when next opened. Returns whether
  // the list changed.
  function mergeList(list) {
    const changed = JSON.stringify(list) !== JSON.stringify(pb.list);
    pb.list = list;
    const listed = new Set(list.map(pbKey));
    for (const key of [...pb.trees.keys()]) {
      if (listed.has(key)) continue;
      pb.trees.delete(key);
      pb.treeLoadedAt.delete(key);
      pb.treeErrors.delete(key);
      pb.memories.delete(key);
    }
    for (const key of [...pb.open]) {
      if (key === LEARNINGS) continue;
      if (!listed.has(key)) { pb.open.delete(key); continue; }
      const tree = pb.trees.get(key);
      if (ready(tree)) refreshTree(key);
      else if (tree !== 'loading') openPlaybook(key);
    }
    return changed;
  }

  // Memories refresh on the Memories tab's auto-refresh interval, without reading Microsoft IQ.
  function refreshPlaybookMemories() {
    loadLearnings(true);
    for (const [key, tree] of pb.trees) if (ready(tree) && tree.access) loadSectionMemories(key, true);
  }

  // Checked every minute and when the Playbooks tab is selected. Like the memory refresh, it stops
  // while auto-refresh is off or the panel is hidden.
  function refreshPlaybooksIfStale() {
    if (document.hidden || !autoRefreshSeconds || pb.view !== 'playbooks' || pb.listLoading) return;
    if (Date.now() - pb.listCheckedAt >= PLAYBOOK_REFRESH_MS) loadPlaybooks(true);
  }

  $('tabMemories').addEventListener('click', () => setView('memories'));
  $('tabPlaybooks').addEventListener('click', () => setView('playbooks'));
  $('playbooks').addEventListener('click', event => {
    const toggle = event.target.closest('.mem-toggle');
    if (toggle) {
      const section = toggle.getAttribute('data-section');
      if (pb.openSections.has(section)) pb.openSections.delete(section);
      else pb.openSections.add(section);
      renderPlaybooks();
      return;
    }
    const head = event.target.closest('.pb-head');
    if (!head) return;
    const key = head.getAttribute('data-key');
    if (pb.open.has(key)) { pb.open.delete(key); renderPlaybooks(); }
    else if (key === LEARNINGS) { pb.open.add(key); renderPlaybooks(); }
    else openPlaybook(key);
  });

  let timer = null;
  let autoRefreshSeconds = 0;
  function setAutoRefresh(seconds) {
    const value = Math.min(Math.max(Number(seconds) || 0, 0), 300);
    autoRefreshSeconds = value;
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
    if (timer) clearInterval(timer);
    timer = value ? setInterval(() => {
      if (document.hidden) return;
      if (pb.view === 'memories') load();
      else refreshPlaybookMemories();
    }, value * 1000) : null;
  }
  $('autoRefresh').addEventListener('input', event => {
    const value = Math.min(Math.max(Number(event.target.value) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  $('autoRefresh').addEventListener('change', event => setAutoRefresh(event.target.value));

  load();
  setAutoRefresh($('autoRefresh').value);
  setInterval(refreshPlaybooksIfStale, 60 * 1000);
</script>
</body>
</html>`}var De=new Set(["NOT_SIGNED_IN","REFRESH_EXPIRED","REFRESH_REJECTED","GATEWAY_MISMATCH","INVALID_CACHE","PUBLISHER_CONFIG_MISSING"]),jt=new Set(["INVALID_PAYLOAD"]),qt=64*1024,Dt="x-mh-canvas-token";function go(e){let t=F(e);return{code:De.has(t.code)?"not_signed_in":t.code.toLowerCase(),message:t.message}}var _=class extends Error{constructor(t,o,s){super(s),this.status=t,this.code=o}};function Fe(e,t,o,s={}){e.writeHead(t,{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...s}),e.end(o)}function N(e,t,o){Fe(e,t,JSON.stringify(o),{"Content-Type":"application/json; charset=utf-8","Cross-Origin-Resource-Policy":"same-origin"})}function Y(e,t){let o=e.headers[t];return Array.isArray(o)?o[0]:o}function Ft(e,t){if(typeof e!="string")return!1;let o=Buffer.from(e),s=Buffer.from(t);return o.length===s.length&&zt(o,s)}async function je(e){if(!/^application\/json(?:\s*;|$)/i.test(Y(e,"content-type")??""))throw new _(415,"unsupported_media_type","Send a JSON request body.");let t=[],o=0;for await(let s of e){if(o+=s.length,o>qt)throw new _(413,"payload_too_large","The request body is too large.");t.push(s)}try{let s=JSON.parse(Buffer.concat(t).toString("utf8")||"{}");if(s===null||typeof s!="object"||Array.isArray(s))throw new Error("shape");return s}catch{throw new _(400,"invalid_json","The request body must be a JSON object.")}}function Bt(e,t){if(t instanceof _)return N(e,t.status,{error:t.code,message:t.message});if(t instanceof k){let o=F(t);return De.has(o.code)?N(e,401,{error:"not_signed_in",code:o.code,message:o.message}):N(e,jt.has(o.code)?400:502,{error:o.code,message:o.message})}return N(e,500,{error:"internal_error",message:"The Memory House canvas hit an unexpected error."})}function qe(e){let t=(e.searchParams.get("workspace_id")??"").toLowerCase(),o=(e.searchParams.get("playbook_id")??"").toLowerCase();if(!z(t)||!z(o))throw new _(400,"invalid_playbook","Choose a playbook from the list.");return`${t}/${o}`}function Ut(e){let t=new Map,o=s=>{s.scope&&t.set(s.scope,{name:s.name,path:s.path});for(let n of s.children??[])o(n)};return o(e),t}async function wo({gateway:e={},roots:t=ve(),miq:o={}}={}){let s=ze(32).toString("base64url"),n,r=()=>n??=fe(e),a,i=()=>a??=$e({...o,tenantId:o.tenantId??r().client.config.tenantId}),c=new Map,d=new Map,f=null,l=0,u=()=>{c=new Map,d.clear(),f=null,l+=1},m=()=>new k("MIQ_ACCOUNT_CHANGED","You are now signed in to Memory House as someone else. Select Refresh to load your playbooks."),h=b=>{if(b!==l)throw m()},y=async(b,g)=>{let x=await i().listPlaybooks(b);h(g),c=new Map(x.playbooks.map(C=>[`${C.workspaceId}/${C.playbookId}`,C]));for(let C of d.keys())c.has(C)||d.delete(C);return x},A=async()=>{let b=i(),g=(async()=>(await W(r())).principal)(),x;try{x=await b.verifyAccount(g)}catch(w){throw w?.code==="MIQ_ACCOUNT_MISMATCH"&&u(),w}let C=(await g).toLowerCase();return C!==f&&(u(),f=C),{reader:b,account:x,generation:l}},E=0,p=!1,S=b=>b===`127.0.0.1:${E}`||b===`localhost:${E}`,T=b=>{if(!S(Y(b,"host")))throw new _(403,"forbidden","Forbidden.");let g=Y(b,"sec-fetch-site");if(g!==void 0&&g!=="same-origin"&&g!=="none")throw new _(403,"forbidden","Forbidden.");if(!Ft(Y(b,Dt),s))throw new _(403,"forbidden","Forbidden.")},G=async b=>{if(p)throw new _(409,"import_in_progress","Another import is still running. Wait for it to finish.");p=!0;try{return await b()}finally{p=!1}},v=Ht(async(b,g)=>{try{let x=new URL(b.url??"/","http://127.0.0.1"),C=`${b.method} ${x.pathname}`;if(x.pathname==="/"){if(b.method!=="GET"&&b.method!=="HEAD")throw new _(405,"method_not_allowed","Method not allowed.");if(!S(Y(b,"host")))throw new _(403,"forbidden","Forbidden.");let w=ze(18).toString("base64");return Fe(g,200,b.method==="HEAD"?void 0:He({token:s,nonce:w}),{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":`script-src 'nonce-${w}'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'`})}if(!x.pathname.startsWith("/api/"))throw new _(404,"not_found","Not found.");switch(T(b),C){case"GET /api/memory":{let w=await be(r(),{search:x.searchParams.get("search")??"",memoryTypes:x.searchParams.getAll("memory_types"),includeSuperseded:x.searchParams.get("include_superseded")==="true",limit:x.searchParams.get("limit")});return N(g,200,w)}case"GET /api/import/sessions":{let w=j(x.searchParams.get("source"));return N(g,200,{source:w,limit:P.sessions,sessions:await Ae(w,t)})}case"POST /api/import/sessions":{let w=await je(b),L=j(w.source);return N(g,200,await G(()=>Re({gateway:r(),source:L,ids:w.ids,roots:t})))}case"POST /api/import/memories":{let w=await je(b),L=j(w.source);return N(g,200,await G(()=>Pe({gateway:r(),source:L,roots:t})))}case"GET /api/miq/playbooks":{let{account:w,generation:L}=await A();return N(g,200,await y(w,L))}case"GET /api/miq/tree":{let w=qe(x),{reader:L,account:O,generation:Q}=await A();c.has(w)||await y(O,Q);let q=c.get(w);if(!q)throw new _(404,"playbook_not_listed","Microsoft IQ does not list this playbook for you. Refresh the list.");let V=await L.loadPlaybookTree(q,O);return h(Q),V.access?d.set(w,Ut(V.root)):d.delete(w),N(g,200,V)}case"GET /api/miq/memories":{let w=qe(x),L=(await W(r())).principal.toLowerCase();if(f!==null&&L!==f)throw u(),m();let O=d.get(w);if(!O)throw new _(404,"playbook_not_loaded","Open the playbook to load its sections first.");return N(g,200,await se(r(),[...O.keys()],{labels:O}))}case"GET /api/learnings":return N(g,200,await ge(r()));default:throw new _(404,"not_found","Not found.")}}catch(x){g.headersSent?g.destroy():Bt(g,x)}});return await new Promise((b,g)=>{v.once("error",g),v.listen(0,"127.0.0.1",()=>{v.off("error",g),b()})}),E=v.address().port,{url:`http://127.0.0.1:${E}/`,token:s,close:()=>new Promise(b=>{v.close(()=>b()),v.closeAllConnections?.()})}}export{go as canvasActionError,fe as createGateway,be as loadCanvasData,wo as startCanvasServer,ot as summarizeCanvasData};
