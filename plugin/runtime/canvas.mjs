import { createRequire as __mhCreateRequire } from 'node:module'; const require = __mhCreateRequire(import.meta.url);
import{b as $}from"./shared-D22L75RU.mjs";import{a as A,b as I,f as U,g as L,h as q,i as G}from"./shared-EUBGAXKJ.mjs";import{createServer as Je}from"node:http";import{randomBytes as le,timingSafeEqual as Ye}from"node:crypto";var x=e=>e!==null&&typeof e=="object"&&!Array.isArray(e),g=(e,t=4096)=>typeof e=="string"&&e.length<=t?e:null,N="node:",ue=3e5,fe=Object.freeze({limit:L.maxCount});function W(e={}){let t=e.fetch??globalThis.fetch,o=e.client??G({...e.clientOptions,fetch:t});async function n(s,{method:r="GET",body:i,headers:a={},operation:c="request",timeoutMs:p}={}){let u=await o.getAccessToken(),d=Math.min(Math.max(p??o.config.timeoutMs,1),ue);return q({url:`${o.config.gatewayBase}${s}`,fetch:t,timeoutMs:d,maxResponseBytes:o.config.maxResponseBytes,method:r,body:i,operation:c,headers:{...a,Authorization:`Bearer ${u}`}})}return Object.freeze({client:o,json:n})}function J(e={}){let t=Number(e.limit);return{search:typeof e.search=="string"?e.search.trim().slice(0,256):"",memoryTypes:[...new Set((Array.isArray(e.memoryTypes)?e.memoryTypes:[]).filter(o=>U.includes(o)))],includeSuperseded:e.includeSuperseded===!0,limit:Number.isInteger(t)&&t>=1&&t<=L.maxCount?t:fe.limit}}function he(e){return!x(e)||!g(e.principal,512)?null:{principal:e.principal,tenant:g(e.tenant_id,512)}}function ge(e){return!x(e)||!Array.isArray(e.nodes)?null:e.nodes.flatMap(t=>!x(t)||!g(t.id,256)?.startsWith(N)||!g(t.name,1024)?[]:[{id:t.id,name:t.name,path:g(t.path,8192)??t.name,parentId:g(t.parent_id,256),description:g(t.description,4096)}])}async function Y(e,t={}){let o=J(t),[n,s,r]=await Promise.allSettled([e.client.getMemories({recent_k:o.limit,memory_types:o.memoryTypes,include_superseded:o.includeSuperseded}),e.json("/whoami",{operation:"identity"}),e.json("/v1/me/reach",{operation:"hierarchy"})]);if(n.status==="rejected")throw n.reason;let i=[],a=s.status==="fulfilled"?he(s.value.data):null;a||i.push("Your signed-in identity could not be loaded.");let c=r.status==="fulfilled"?ge(r.value.data):null;return c||i.push("The hierarchy could not be loaded, so shared memories are shown by node ID."),Se({who:a,nodes:c??[],listing:n.value,filters:o,warnings:i})}function R(e){return String(e||"").split("/").filter(Boolean).join(" / ")}function ye(e){for(let t of["content","text","summary","title","name"])if(typeof e[t]=="string"&&e[t].trim())return e[t];return""}function be(e,t,o){let n=typeof e.scope_key=="string"?e.scope_key:"",s=t.get(n),r=n.startsWith("user:")&&(!o||n===o),i=r?"personal":s?"node":n.startsWith(N)?"unlisted":"other",a=x(e.source)?g(e.source.source,256)??g(e.source.application,256):null;return{id:e.id,scope_key:n,scope_kind:i,scope_label:r?"Personal":s?s.name:i==="unlisted"?"Unlisted node":n||"Unknown scope",scope_path:s?R(s.path):"",type:g(e.memory_type,64)??g(e.type,64),content:ye(e),tags:Array.isArray(e.tags)?e.tags.filter(c=>typeof c=="string").slice(0,20):[],created_at:g(e.created_at,64),updated_at:g(e.updated_at,64),salience:typeof e.salience=="number"?e.salience:null,confidence:typeof e.confidence=="number"?e.confidence:null,source:a,superseded:typeof e.superseded_by=="string"&&e.superseded_by.length>0,promotion:ve(we(e),t)}}function we(e){let t=x(e.metadata)?e.metadata:null;if(t&&typeof t.promoted_from_scope=="string"){let o=x(t.topology_assessment)?t.topology_assessment:{};return{from_scope:t.promoted_from_scope,origin:t.promotion_origin_principal,rationale:t.assessment_rationale??o.rationale,promoted_at:t.promoted_at}}return x(e.promotion)?e.promotion:null}function ve(e,t){if(!x(e))return null;let o=g(e.from_scope,256),n=o?t.get(o):null,s={from_scope:o,from_label:n?R(n.path):o,origin:g(e.origin,256),rationale:g(e.rationale,2e3),promoted_at:g(e.promoted_at,64)};return Object.values(s).some(Boolean)?s:null}function xe(e,t){return[e.content,e.id,e.scope_label,e.scope_path,...e.tags].some(o=>String(o||"").toLowerCase().includes(t))}var ke=(e,t)=>e.name.localeCompare(t.name,void 0,{sensitivity:"base"})||e.id.localeCompare(t.id),_e=(e,t)=>String(t.created_at||"").localeCompare(String(e.created_at||""));function Se({who:e=null,nodes:t=[],listing:o,filters:n={},warnings:s=[]}){let r=J(n),i=new Map(t.map(l=>[l.id,l])),a=e?.principal??null,c=r.search.toLowerCase(),p={},u=new Set,d=0;for(let l of Array.isArray(o?.items)?o.items:[]){if(!x(l)||typeof l.id!="string"||u.has(l.id))continue;u.add(l.id);let b=be(l,i,a);c&&!xe(b,c)||((p[b.scope_key]||=[]).push(b),d+=1)}for(let l of Object.values(p))l.sort(_e);let m=l=>(p[l]||[]).length,f=[],_=new Set(a?[a]:[]);for(let l of Object.keys(p))l.startsWith("user:")&&_.add(l);for(let l of _)f.push({scope:l,kind:"personal",name:"Personal",path:"",depth:0,count:m(l)});let h=new Map;for(let l of t){let b=l.parentId&&i.has(l.parentId)?l.parentId:null;h.has(b)||h.set(b,[]),h.get(b).push(l)}let M=new Set,B=(l,b)=>{for(let S of(h.get(l)||[]).sort(ke))M.has(S.id)||(M.add(S.id),f.push({scope:S.id,kind:l===null?"root":"node",name:S.name,path:R(S.path),description:S.description,depth:b,count:m(S.id)}),B(S.id,b+1))};B(null,0);for(let l of Object.keys(p).sort()){if(_.has(l)||M.has(l))continue;let b=l.startsWith(N);f.push({scope:l,kind:b?"unlisted":"other",name:b?"Unlisted node":l,path:l,depth:0,count:m(l)})}return{principal:a,tenant:e?.tenant??null,rows:f,groups:p,total:d,truncated:o?.has_more===!0,limit:r.limit,warnings:s,updatedAt:new Date().toISOString()}}function Te(e,{maxItems:t=100,maxChars:o=1e3}={}){let n=[];for(let s of e.rows)for(let r of e.groups[s.scope]||[]){if(n.length>=t)break;n.push({scope:s.kind==="personal"?"Personal":s.path||s.name,type:r.type,content:r.content.length>o?`${r.content.slice(0,o)}...`:r.content,created_at:r.created_at})}return{principal:e.principal,total:e.total,truncated:e.truncated||n.length<e.total,scopes:e.rows.map(({scope:s,kind:r,name:i,path:a,count:c})=>({scope:s,kind:r,name:i,path:a,count:c})),memories:n,warnings:e.warnings,referenceOnly:!0}}import{createReadStream as Me}from"node:fs";import{readdir as z,readFile as Ce,stat as Ie}from"node:fs/promises";import{createInterface as Ee}from"node:readline";import{createHash as Ae}from"node:crypto";import{homedir as Oe}from"node:os";import{basename as $e,join as k,posix as Le,relative as Ne,sep as Re}from"node:path";var v=Object.freeze({sessions:100,selected:200,batchItems:50,factBatchItems:10,batchBytes:240*1024,factBytes:16*1024,previewBytes:2048,timeoutMs:12e4}),H=Object.freeze({copilot:Object.freeze({label:"GitHub Copilot",session:"github-copilot",memory:"copilot-cli-memory"}),claude:Object.freeze({label:"Claude Code",session:"claude-code",memory:"claude-code-memory"})}),P=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,je=/"type"\s*:\s*"(?:session\.start|user\.message|assistant\.message)"/,w=e=>e!==null&&typeof e=="object"&&!Array.isArray(e);function C(e){if(typeof e!="string"||!Object.hasOwn(H,e))throw new A("INVALID_PAYLOAD","Import source must be copilot or claude.");return e}function V(e=process.env){let t=e.HOME||e.USERPROFILE||Oe();return{copilot:k(e.COPILOT_HOME||k(t,".copilot"),"session-state"),claude:k(e.CLAUDE_CONFIG_DIR||k(t,".claude"),"projects")}}function j(e,t=130){let o=$(e,{maxBytes:v.previewBytes}).replace(/```[\s\S]*?```/g," ").replace(/`([^`]*)`/g,"$1").replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/\*\*([^*]*)\*\*/g,"$1").replace(/[*_>]/g," ").replace(/\s+/g," ").trim();return o.length>t?`${o.slice(0,t-3)}...`:o}async function*D(e,t){let o=Me(e,{encoding:"utf8"}),n=Ee({input:o,crlfDelay:1/0});try{for await(let s of n){if(t&&!t(s))continue;let r=s.trim();if(r)try{let i=JSON.parse(r);w(i)&&(yield i)}catch{}}}finally{n.close(),o.destroy()}}async function K(e){try{let t=await Ie(e);return t.isFile()?t:null}catch{return null}}async function F(e){try{return(await z(e,{withFileTypes:!0})).filter(t=>t.isDirectory()).map(t=>t.name)}catch{return[]}}var E=new Map;async function Z(e,t,o,n){let s=`${e}\0${t}`,r=E.get(s);if(r&&r.mtimeMs===o.mtimeMs&&r.size===o.size)return r.value;let i=await n();return E.delete(s),E.set(s,{mtimeMs:o.mtimeMs,size:o.size,value:i}),E.size>2e3&&E.delete(E.keys().next().value),i}async function ze(e,t){let o="",n="",s=new Map,r=new Map;for await(let a of D(e,c=>je.test(c))){let c=a.data;if(w(c)){if(a.type==="session.start")o=String(c.startTime||a.timestamp||""),w(c.context)&&(n=String(c.context.cwd||""));else if(a.type==="user.message")typeof c.interactionId=="string"&&typeof c.content=="string"&&c.content.trim()&&s.set(c.interactionId,{role:"user",content:c.content});else if(a.type==="assistant.message"){let p=c.interactionId;if(typeof p!="string"||!s.has(p)||typeof c.content!="string"||!c.content.trim())continue;let u=c.phase==="final_answer";if(r.get(p)?.final&&!u)continue;r.set(p,{role:"agent",content:c.content,final:u})}}}let i=[];for(let[a,c]of s){let p=r.get(a);p&&i.push({question:c,response:{role:p.role,content:p.content}})}return{session_id:t,start_time:o,cwd:n,turns:i}}async function X(e){let t=[];for(let o of await F(e)){if(!P.test(o))continue;let n=k(e,o,"events.jsonl"),s=await K(n);s&&t.push({id:o,file:n,info:s})}return t}async function He(e,t){let o=[];for await(let n of D(e,s=>s.includes("storeMemory"))){let s=n.data;if(n.type!=="tool.execution_complete"||!w(s)||!s.success)continue;let r=s.toolTelemetry;if(!w(r)||!w(r.properties)||r.properties.operation!=="storeMemory")continue;let i=r.restrictedProperties;!w(i)||typeof i.memoryFact!="string"||o.push({memory_id:String(n.id||""),session_id:t,fact:i.memoryFact})}return o}function Pe(e){return typeof e=="string"?e.trim():Array.isArray(e)?e.filter(t=>w(t)&&t.type==="text").map(t=>String(t.text||"").trim()).filter(Boolean).join(`
`).trim():""}async function De(e,t){let o="",n="",s=null,r=null,i=[];for await(let a of D(e)){if(a.isSidechain||a.isMeta)continue;let c=a.message;if(a.type!=="user"&&a.type!=="assistant"||!w(c))continue;n=String(a.cwd||n);let p=String(a.timestamp||"");p&&(!o||p<o)&&(o=p);let u=Pe(c.content);if(u)if(a.type==="user"){if(typeof c.content!="string")continue;s&&r&&i.push({question:s,response:r}),s={role:"user",content:u},r=null}else s&&(r={role:"agent",content:u})}return s&&r&&i.push({question:s,response:r}),{session_id:t,start_time:o,cwd:n,turns:i}}async function Fe(e){let t=[];for(let o of await F(e)){let n=[];try{n=await z(k(e,o),{withFileTypes:!0})}catch{continue}for(let s of n){if(!s.isFile()||!s.name.endsWith(".jsonl"))continue;let r=s.name.slice(0,-6);if(!P.test(r))continue;let i=k(e,o,s.name),a=await K(i);a&&t.push({id:r,file:i,info:a})}}return t}var Be=/^---\r?\n[\s\S]*?\r?\n---\r?\n?/;async function Q(e,t=[]){let o=[];try{o=await z(e,{withFileTypes:!0})}catch{return t}for(let n of o){let s=k(e,n.name);n.isDirectory()?await Q(s,t):n.isFile()&&n.name.endsWith(".md")&&t.push(s)}return t}async function Ue(e){let t=[];for(let o of await F(e)){let n=k(e,o,"memory");for(let s of(await Q(n)).sort()){if($e(s)==="MEMORY.md")continue;let r=(await Ce(s,"utf8")).replace(Be,"").trim();if(!r)continue;let i=Ne(n,s).split(Re).join(Le.sep);t.push({memory_id:`${o}:${i}`,session_id:o,fact:r})}}return t}async function ee(e,t){return e==="claude"?Fe(t.claude):X(t.copilot)}async function te(e,t){let o=e==="claude"?De:ze;return Z(`${e}-session`,t.file,t.info,()=>o(t.file,t.id))}function qe(e){let t=e.turns[0];return j(t?t.question.content:"",72)||e.cwd.split(/[\\/]/).filter(Boolean).pop()||e.session_id}async function oe(e,t,{limit:o=v.sessions}={}){C(e);let n=(await ee(e,t)).sort((r,i)=>i.info.mtimeMs-r.info.mtimeMs),s=[];for(let r of n){if(s.length>=o)break;let i=await te(e,r);if(!i.turns.length)continue;let a=i.turns[i.turns.length-1];s.push({session_id:i.session_id,label:qe(i),cwd:i.cwd,start_time:i.start_time,turn_count:i.turns.length,last_user_turn:j(a.question.content),last_agent_turn:j(a.response.content)})}return s}function Ge(e){if(!Array.isArray(e)||!e.length||e.length>v.selected||e.some(t=>typeof t!="string"||!P.test(t)))throw new A("INVALID_PAYLOAD",`Select 1 to ${v.selected} listed sessions to import.`);return[...new Set(e)]}function*ne(e,t,o){let n=[];for(let s of e)n.length&&(n.length>=t||Buffer.byteLength(JSON.stringify(o([...n,s])))>v.batchBytes)&&(yield o(n),n=[]),n.push(s);n.length&&(yield o(n))}async function se(e,t){let o=`mh-import-${Ae("sha256").update(JSON.stringify(t)).digest("hex")}`,{data:n}=await e.json("/memory",{method:"POST",body:t,headers:{"Idempotency-Key":o},operation:"import",timeoutMs:v.timeoutMs});return n}function re(e,t,o,n){e.batches+=1;let s=w(n)?n.result:null;w(s)&&Number.isSafeInteger(s.succeeded)?(e[t]+=s.succeeded,e.failed+=Number.isSafeInteger(s.failed)?s.failed:0,e.unknown+=Number.isSafeInteger(s.unknown)?s.unknown:0):e[t]+=o}async function ie({gateway:e,source:t,ids:o,roots:n}){C(t);let s=Ge(o),r={source:t,sessions:0,messages:0,skipped:0,failed:0,unknown:0,batches:0};try{let i=new Map((await ee(t,n)).map(a=>[a.id,a]));for(let a of s){let c=i.get(a);if(!c)continue;let p=await te(t,c);if(!p.turns.length)continue;let u=[];for(let m of p.turns)for(let f of[m.question,m.response]){let _=$(f.content);_?u.push({role:f.role,content:_,source:H[t].session}):r.skipped+=1}if(!u.length)continue;r.sessions+=1;let d=`mh:import:${t}:${a}`;for(let m of ne(u,v.batchItems,f=>({extract:!0,thread_id:d,items:f})))re(r,"messages",m.items.length,await se(e,m))}}catch(i){return{...r,error:I(i)}}return r}async function We(e,t){if(e==="claude")return Ue(t.claude);let o=[];for(let n of await X(t.copilot))o.push(...await Z("copilot-memories",n.file,n.info,()=>He(n.file,n.id)));return o}async function ae({gateway:e,source:t,roots:o}){C(t);let n={source:t,memories:0,skipped:0,failed:0,unknown:0,batches:0,reconcile:null};try{let s=[],r=new Set;for(let i of await We(t,o)){let a=$(i.fact,{maxBytes:v.factBytes});if(!a||r.has(a)){n.skipped+=1;continue}r.add(a),s.push({content:a,source:H[t].memory})}for(let i of ne(s,v.factBatchItems,a=>({extract:!1,items:a})))re(n,"memories",i.items.length,await se(e,i));if(n.memories>0){let{data:i}=await e.json("/reconcile",{method:"POST",body:{},operation:"reconcile",timeoutMs:v.timeoutMs});n.reconcile=w(i)&&typeof i.status=="string"?i.status:"requested"}}catch(s){return{...n,error:I(s)}}return n}function ce({token:e,nonce:t}){return`<!doctype html>
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
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <span id="who" class="who">Loading...</span>
  <span class="spacer"></span>
  <button id="import" class="primary" type="button">Import memory</button>
  <button id="refresh" type="button">Refresh</button>
</header>
<main>
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

  function card(memory) {
    const kind = memory.scope_kind;
    const where = kind === 'personal' ? 'Personal' : memory.scope_path || memory.scope_label;
    const pills = [
      '<span class="pill ' + esc(kind) + '">' + esc(where) + '</span>',
      memory.type ? '<span class="pill">' + esc(memory.type) + '</span>' : '',
      memory.source ? '<span class="pill">via ' + esc(memory.source) + '</span>' : '',
      memory.superseded ? '<span class="pill">superseded</span>' : '',
      ...memory.tags.slice(0, 4).map(tag => '<span class="pill">' + esc(tag) + '</span>'),
    ].join('');
    const promo = memory.promotion;
    const details = {
      id: memory.id, scope_key: memory.scope_key, scope_path: memory.scope_path || undefined, type: memory.type,
      created_at: memory.created_at, updated_at: memory.updated_at, salience: memory.salience, confidence: memory.confidence, source: memory.source,
      promoted_from: promo?.from_label || undefined, origin_user: promo?.origin || undefined,
      promotion_rationale: promo?.rationale || undefined, promoted_at: promo?.promoted_at || undefined,
    };
    const promoLines = promo ? '<div class="promo">' +
      (promo.from_label ? '<div><b>From:</b> ' + esc(promo.from_label) + '</div>' : '') +
      (promo.origin ? '<div><b>Origin:</b> ' + esc(promo.origin) + '</div>' : '') +
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

  $('refresh').addEventListener('click', load);
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

  let timer = null;
  function setAutoRefresh(seconds) {
    const value = Math.min(Math.max(Number(seconds) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
    if (timer) clearInterval(timer);
    timer = value ? setInterval(() => { if (!document.hidden) load(); }, value * 1000) : null;
  }
  $('autoRefresh').addEventListener('input', event => {
    const value = Math.min(Math.max(Number(event.target.value) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  $('autoRefresh').addEventListener('change', event => setAutoRefresh(event.target.value));

  load();
  setAutoRefresh($('autoRefresh').value);
</script>
</body>
</html>`}var pe=new Set(["NOT_SIGNED_IN","AZURE_CLI_AUTH_REQUIRED","AZURE_CLI_NOT_FOUND","AZURE_CLI_TOKEN_INVALID","INVALID_AUTH_STATE","PUBLISHER_CONFIG_MISSING"]),Ve=new Set(["INVALID_PAYLOAD"]),Ke=64*1024,Ze="x-mh-canvas-token";function bt(e){let t=I(e);return{code:pe.has(t.code)?"not_signed_in":t.code.toLowerCase(),message:t.message}}var y=class extends Error{constructor(t,o,n){super(n),this.status=t,this.code=o}};function me(e,t,o,n={}){e.writeHead(t,{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...n}),e.end(o)}function T(e,t,o){me(e,t,JSON.stringify(o),{"Content-Type":"application/json; charset=utf-8","Cross-Origin-Resource-Policy":"same-origin"})}function O(e,t){let o=e.headers[t];return Array.isArray(o)?o[0]:o}function Xe(e,t){if(typeof e!="string")return!1;let o=Buffer.from(e),n=Buffer.from(t);return o.length===n.length&&Ye(o,n)}async function de(e){if(!/^application\/json(?:\s*;|$)/i.test(O(e,"content-type")??""))throw new y(415,"unsupported_media_type","Send a JSON request body.");let t=[],o=0;for await(let n of e){if(o+=n.length,o>Ke)throw new y(413,"payload_too_large","The request body is too large.");t.push(n)}try{let n=JSON.parse(Buffer.concat(t).toString("utf8")||"{}");if(n===null||typeof n!="object"||Array.isArray(n))throw new Error("shape");return n}catch{throw new y(400,"invalid_json","The request body must be a JSON object.")}}function Qe(e,t){if(t instanceof y)return T(e,t.status,{error:t.code,message:t.message});if(t instanceof A){let o=I(t);return pe.has(o.code)?T(e,401,{error:"not_signed_in",code:o.code,message:o.message}):T(e,Ve.has(o.code)?400:502,{error:o.code,message:o.message})}return T(e,500,{error:"internal_error",message:"The Memory House canvas hit an unexpected error."})}async function wt({gateway:e={},roots:t=V()}={}){let o=le(32).toString("base64url"),n,s=()=>n??=W(e),r=0,i=!1,a=d=>d===`127.0.0.1:${r}`||d===`localhost:${r}`,c=d=>{if(!a(O(d,"host")))throw new y(403,"forbidden","Forbidden.");let m=O(d,"sec-fetch-site");if(m!==void 0&&m!=="same-origin"&&m!=="none")throw new y(403,"forbidden","Forbidden.");if(!Xe(O(d,Ze),o))throw new y(403,"forbidden","Forbidden.")},p=async d=>{if(i)throw new y(409,"import_in_progress","Another import is still running. Wait for it to finish.");i=!0;try{return await d()}finally{i=!1}},u=Je(async(d,m)=>{try{let f=new URL(d.url??"/","http://127.0.0.1"),_=`${d.method} ${f.pathname}`;if(f.pathname==="/"){if(d.method!=="GET"&&d.method!=="HEAD")throw new y(405,"method_not_allowed","Method not allowed.");if(!a(O(d,"host")))throw new y(403,"forbidden","Forbidden.");let h=le(18).toString("base64");return me(m,200,d.method==="HEAD"?void 0:ce({token:o,nonce:h}),{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":`script-src 'nonce-${h}'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'`})}if(!f.pathname.startsWith("/api/"))throw new y(404,"not_found","Not found.");switch(c(d),_){case"GET /api/memory":{let h=await Y(s(),{search:f.searchParams.get("search")??"",memoryTypes:f.searchParams.getAll("memory_types"),includeSuperseded:f.searchParams.get("include_superseded")==="true",limit:f.searchParams.get("limit")});return T(m,200,h)}case"GET /api/import/sessions":{let h=C(f.searchParams.get("source"));return T(m,200,{source:h,limit:v.sessions,sessions:await oe(h,t)})}case"POST /api/import/sessions":{let h=await de(d),M=C(h.source);return T(m,200,await p(()=>ie({gateway:s(),source:M,ids:h.ids,roots:t})))}case"POST /api/import/memories":{let h=await de(d),M=C(h.source);return T(m,200,await p(()=>ae({gateway:s(),source:M,roots:t})))}default:throw new y(404,"not_found","Not found.")}}catch(f){m.headersSent?m.destroy():Qe(m,f)}});return await new Promise((d,m)=>{u.once("error",m),u.listen(0,"127.0.0.1",()=>{u.off("error",m),d()})}),r=u.address().port,{url:`http://127.0.0.1:${r}/`,token:o,close:()=>new Promise(d=>{u.close(()=>d()),u.closeAllConnections?.()})}}export{bt as canvasActionError,W as createGateway,Y as loadCanvasData,wt as startCanvasServer,Te as summarizeCanvasData};
