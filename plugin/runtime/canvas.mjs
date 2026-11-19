import { createRequire as __mhCreateRequire } from 'node:module'; const require = __mhCreateRequire(import.meta.url);
import{b as z}from"./shared-SQNNV4AH.mjs";import{A as V,B as Y,C as we,F as ge,G as be,H as ye,I as xe,J as ke,K as G,L as _e,M as W,N as Se,O as Ee,a as y,b as D,l as ae,m as j,n as B,o as le,p as ce,q as F,r as q,s as de,t as ue,u as pe,v as me,w as fe,x as ve,y as he,z as U}from"./shared-XGAUCKSY.mjs";import{createServer as Dt}from"node:http";import{randomBytes as We,timingSafeEqual as Pt}from"node:crypto";var $=e=>e!==null&&typeof e=="object"&&!Array.isArray(e),k=(e,t=4096)=>typeof e=="string"&&e.length<=t?e:null,K="node:",et=50,tt=3e5,nt=Object.freeze({limit:W.maxCount});function Te(e={}){let t=e.fetch??globalThis.fetch,n=e.client??Ee({...e.clientOptions,fetch:t});async function i(r,{method:a="GET",body:o,headers:l={},operation:d="request",timeoutMs:m}={}){let v=await n.getAccessToken(),S=Math.min(Math.max(m??n.config.timeoutMs,1),tt);return Se({url:`${n.config.gatewayBase}${r}`,fetch:t,timeoutMs:S,maxResponseBytes:n.config.maxResponseBytes,method:a,body:o,operation:d,headers:{...l,Authorization:`Bearer ${v}`}})}return Object.freeze({client:n,json:i})}function Ie(e={}){let t=Number(e.limit);return{search:typeof e.search=="string"?e.search.trim().slice(0,256):"",memoryTypes:[...new Set((Array.isArray(e.memoryTypes)?e.memoryTypes:[]).filter(n=>_e.includes(n)))],includeSuperseded:e.includeSuperseded===!0,limit:Number.isInteger(t)&&t>=1&&t<=W.maxCount?t:nt.limit}}function it(e){if(!$(e)||!k(e.principal,512))return null;let t=Array.isArray(e.read_spaces)?e.read_spaces.filter(n=>k(n,256)):[];return{principal:e.principal,tenant:k(e.tenant_id,512),readSpaces:[...new Set(t)]}}function rt(e,t){return!$(e)||e.id!==t||!k(e.name,1024)?null:{id:t,name:e.name,path:k(e.path,8192)??e.name,parentId:k(e.parent_id,256),description:k($(e.metadata)?e.metadata.description:null,4096)}}async function st(e,t){let n=t.readSpaces.filter(a=>a.startsWith(K)).slice(0,et),r=(await Promise.allSettled(n.map(a=>e.json(`/v1/spaces/${encodeURIComponent(a)}`,{operation:"space"})))).flatMap((a,o)=>{let l=a.status==="fulfilled"?rt(a.value.data,n[o]):null;return l?[l]:[]});return{spaces:r,missing:n.length-r.length}}async function Ae(e,t={}){let n=Ie(t),i=e.json("/whoami",{operation:"identity"}).then(v=>it(v.data)),[r,a,o]=await Promise.allSettled([e.client.getMemories({recent_k:n.limit,memory_types:n.memoryTypes,include_superseded:n.includeSuperseded}),i,i.then(v=>v?st(e,v):null)]);if(r.status==="rejected")throw r.reason;let l=[],d=a.status==="fulfilled"?a.value:null;d||l.push("Your signed-in identity could not be loaded, so shared memories are shown by Space ID.");let m=o.status==="fulfilled"&&o.value?o.value:{spaces:[],missing:0};return m.missing&&l.push("Some Learning Spaces could not be loaded, so their memories are shown by Space ID."),mt({who:d,nodes:m.spaces,listing:r.value,filters:n,warnings:l})}function J(e){return String(e||"").split("/").filter(Boolean).join(" / ")}function ot(e){for(let t of["content","text","summary","title","name"])if(typeof e[t]=="string"&&e[t].trim())return e[t];return""}function at(e,t,n){let i=typeof e.space_key=="string"?e.space_key:typeof e.scope_key=="string"?e.scope_key:"",r=t.get(i),a=i.startsWith("user:")&&(!n||i===n),o=a?"personal":r?"node":i.startsWith(K)?"unlisted":"other",l=$(e.source)?k(e.source.source,256)??k(e.source.application,256):null;return{id:e.id,scope_key:i,scope_kind:o,scope_label:a?"Personal":r?r.name:o==="unlisted"?"Unlisted node":i||"Unknown scope",scope_path:r?J(r.path):"",type:k(e.memory_type,64)??k(e.type,64),content:ot(e),tags:Array.isArray(e.tags)?e.tags.filter(d=>typeof d=="string").slice(0,20):[],created_at:k(e.created_at,64),updated_at:k(e.updated_at,64),salience:typeof e.salience=="number"?e.salience:null,confidence:typeof e.confidence=="number"?e.confidence:null,source:l,superseded:typeof e.superseded_by=="string"&&e.superseded_by.length>0,promotion:ct(lt(e),t)}}function lt(e){let t=$(e.metadata)?e.metadata:null;if(t&&typeof t.promoted_from_scope=="string"){let n=$(t.topology_assessment)?t.topology_assessment:{};return{from_scope:t.promoted_from_scope,origin:t.promotion_origin_principal,rationale:t.assessment_rationale??n.rationale,promoted_at:t.promoted_at}}return $(e.promotion)?e.promotion:null}function ct(e,t){if(!$(e))return null;let n=k(e.from_scope,256),i=n?t.get(n):null,r={from_scope:n,from_label:i?J(i.path):n,origin:k(e.origin,256),rationale:k(e.rationale,2e3),promoted_at:k(e.promoted_at,64)};return Object.values(r).some(Boolean)?r:null}function dt(e,t){return[e.content,e.id,e.scope_label,e.scope_path,...e.tags].some(n=>String(n||"").toLowerCase().includes(t))}var ut=(e,t)=>e.name.localeCompare(t.name,void 0,{sensitivity:"base"})||e.id.localeCompare(t.id),pt=(e,t)=>String(t.created_at||"").localeCompare(String(e.created_at||""));function mt({who:e=null,nodes:t=[],listing:n,filters:i={},warnings:r=[]}){let a=Ie(i),o=new Map(t.map(p=>[p.id,p])),l=e?.principal??null,d=a.search.toLowerCase(),m={},v=new Set,S=0;for(let p of Array.isArray(n?.items)?n.items:[]){if(!$(p)||typeof p.id!="string"||v.has(p.id))continue;v.add(p.id);let E=at(p,o,l);d&&!dt(E,d)||((m[E.scope_key]||=[]).push(E),S+=1)}for(let p of Object.values(m))p.sort(pt);let b=p=>(m[p]||[]).length,u=[],f=new Set(l?[l]:[]);for(let p of Object.keys(m))p.startsWith("user:")&&f.add(p);for(let p of f)u.push({scope:p,kind:"personal",name:"Personal",path:"",depth:0,count:b(p)});let w=new Map;for(let p of t){let E=p.parentId&&o.has(p.parentId)?p.parentId:null;w.has(E)||w.set(E,[]),w.get(E).push(p)}let O=new Set,x=(p,E)=>{for(let C of(w.get(p)||[]).sort(ut))O.has(C.id)||(O.add(C.id),u.push({scope:C.id,kind:p===null?"root":"node",name:C.name,path:J(C.path),description:C.description,depth:E,count:b(C.id)}),x(C.id,E+1))};x(null,0);for(let p of Object.keys(m).sort()){if(f.has(p)||O.has(p))continue;let E=p.startsWith(K);u.push({scope:p,kind:E?"unlisted":"other",name:E?"Unlisted node":p,path:p,depth:0,count:b(p)})}return{principal:l,tenant:e?.tenant??null,rows:u,groups:m,total:S,truncated:n?.has_more===!0,limit:a.limit,warnings:r,updatedAt:new Date().toISOString()}}function ft(e,{maxItems:t=100,maxChars:n=1e3}={}){let i=[];for(let r of e.rows)for(let a of e.groups[r.scope]||[]){if(i.length>=t)break;i.push({scope:r.kind==="personal"?"Personal":r.path||r.name,type:a.type,content:a.content.length>n?`${a.content.slice(0,n)}...`:a.content,created_at:a.created_at})}return{principal:e.principal,total:e.total,truncated:e.truncated||i.length<e.total,scopes:e.rows.map(({scope:r,kind:a,name:o,path:l,count:d})=>({scope:r,kind:a,name:o,path:l,count:d})),memories:i,warnings:e.warnings,referenceOnly:!0}}import{createReadStream as vt}from"node:fs";import{readdir as X,readFile as ht,stat as wt}from"node:fs/promises";import{createInterface as gt}from"node:readline";import{createHash as bt}from"node:crypto";import{homedir as yt}from"node:os";import{basename as xt,join as M,posix as kt,relative as _t,sep as St}from"node:path";var R=Object.freeze({sessions:100,selected:200,batchItems:50,factBatchItems:10,batchBytes:240*1024,factBytes:16*1024,previewBytes:2048,timeoutMs:12e4}),Z=Object.freeze({copilot:Object.freeze({label:"GitHub Copilot",session:"github-copilot",memory:"copilot-cli-memory"}),claude:Object.freeze({label:"Claude Code",session:"claude-code",memory:"claude-code-memory"})}),ee=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,Et=/"type"\s*:\s*"(?:session\.start|user\.message|assistant\.message)"/,A=e=>e!==null&&typeof e=="object"&&!Array.isArray(e);function N(e){if(typeof e!="string"||!Object.hasOwn(Z,e))throw new y("INVALID_PAYLOAD","Import source must be copilot or claude.");return e}function Re(e=process.env){let t=e.HOME||e.USERPROFILE||yt();return{copilot:M(e.COPILOT_HOME||M(t,".copilot"),"session-state"),claude:M(e.CLAUDE_CONFIG_DIR||M(t,".claude"),"projects")}}function Q(e,t=130){let n=z(e,{maxBytes:R.previewBytes}).replace(/```[\s\S]*?```/g," ").replace(/`([^`]*)`/g,"$1").replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/\*\*([^*]*)\*\*/g,"$1").replace(/[*_>]/g," ").replace(/\s+/g," ").trim();return n.length>t?`${n.slice(0,t-3)}...`:n}async function*te(e,t){let n=vt(e,{encoding:"utf8"}),i=gt({input:n,crlfDelay:1/0});try{for await(let r of i){if(t&&!t(r))continue;let a=r.trim();if(a)try{let o=JSON.parse(a);A(o)&&(yield o)}catch{}}}finally{i.close(),n.destroy()}}async function Ce(e){try{let t=await wt(e);return t.isFile()?t:null}catch{return null}}async function ne(e){try{return(await X(e,{withFileTypes:!0})).filter(t=>t.isDirectory()).map(t=>t.name)}catch{return[]}}var P=new Map;async function $e(e,t,n,i){let r=`${e}\0${t}`,a=P.get(r);if(a&&a.mtimeMs===n.mtimeMs&&a.size===n.size)return a.value;let o=await i();return P.delete(r),P.set(r,{mtimeMs:n.mtimeMs,size:n.size,value:o}),P.size>2e3&&P.delete(P.keys().next().value),o}async function Tt(e,t){let n="",i="",r=new Map,a=new Map;for await(let l of te(e,d=>Et.test(d))){let d=l.data;if(A(d)){if(l.type==="session.start")n=String(d.startTime||l.timestamp||""),A(d.context)&&(i=String(d.context.cwd||""));else if(l.type==="user.message")typeof d.interactionId=="string"&&typeof d.content=="string"&&d.content.trim()&&r.set(d.interactionId,{role:"user",content:d.content});else if(l.type==="assistant.message"){let m=d.interactionId;if(typeof m!="string"||!r.has(m)||typeof d.content!="string"||!d.content.trim())continue;let v=d.phase==="final_answer";if(a.get(m)?.final&&!v)continue;a.set(m,{role:"agent",content:d.content,final:v})}}}let o=[];for(let[l,d]of r){let m=a.get(l);m&&o.push({question:d,response:{role:m.role,content:m.content}})}return{session_id:t,start_time:n,cwd:i,turns:o}}async function Me(e){let t=[];for(let n of await ne(e)){if(!ee.test(n))continue;let i=M(e,n,"events.jsonl"),r=await Ce(i);r&&t.push({id:n,file:i,info:r})}return t}async function It(e,t){let n=[];for await(let i of te(e,r=>r.includes("storeMemory"))){let r=i.data;if(i.type!=="tool.execution_complete"||!A(r)||!r.success)continue;let a=r.toolTelemetry;if(!A(a)||!A(a.properties)||a.properties.operation!=="storeMemory")continue;let o=a.restrictedProperties;!A(o)||typeof o.memoryFact!="string"||n.push({memory_id:String(i.id||""),session_id:t,fact:o.memoryFact})}return n}function At(e){return typeof e=="string"?e.trim():Array.isArray(e)?e.filter(t=>A(t)&&t.type==="text").map(t=>String(t.text||"").trim()).filter(Boolean).join(`
`).trim():""}async function Rt(e,t){let n="",i="",r=null,a=null,o=[];for await(let l of te(e)){if(l.isSidechain||l.isMeta)continue;let d=l.message;if(l.type!=="user"&&l.type!=="assistant"||!A(d))continue;i=String(l.cwd||i);let m=String(l.timestamp||"");m&&(!n||m<n)&&(n=m);let v=At(d.content);if(v)if(l.type==="user"){if(typeof d.content!="string")continue;r&&a&&o.push({question:r,response:a}),r={role:"user",content:v},a=null}else r&&(a={role:"agent",content:v})}return r&&a&&o.push({question:r,response:a}),{session_id:t,start_time:n,cwd:i,turns:o}}async function Ct(e){let t=[];for(let n of await ne(e)){let i=[];try{i=await X(M(e,n),{withFileTypes:!0})}catch{continue}for(let r of i){if(!r.isFile()||!r.name.endsWith(".jsonl"))continue;let a=r.name.slice(0,-6);if(!ee.test(a))continue;let o=M(e,n,r.name),l=await Ce(o);l&&t.push({id:a,file:o,info:l})}}return t}var $t=/^---\r?\n[\s\S]*?\r?\n---\r?\n?/;async function Le(e,t=[]){let n=[];try{n=await X(e,{withFileTypes:!0})}catch{return t}for(let i of n){let r=M(e,i.name);i.isDirectory()?await Le(r,t):i.isFile()&&i.name.endsWith(".md")&&t.push(r)}return t}async function Mt(e){let t=[];for(let n of await ne(e)){let i=M(e,n,"memory");for(let r of(await Le(i)).sort()){if(xt(r)==="MEMORY.md")continue;let a=(await ht(r,"utf8")).replace($t,"").trim();if(!a)continue;let o=_t(i,r).split(St).join(kt.sep);t.push({memory_id:`${n}:${o}`,session_id:n,fact:a})}}return t}async function Oe(e,t){return e==="claude"?Ct(t.claude):Me(t.copilot)}async function Ne(e,t){let n=e==="claude"?Rt:Tt;return $e(`${e}-session`,t.file,t.info,()=>n(t.file,t.id))}function Lt(e){let t=e.turns[0];return Q(t?t.question.content:"",72)||e.cwd.split(/[\\/]/).filter(Boolean).pop()||e.session_id}async function De(e,t,{limit:n=R.sessions}={}){N(e);let i=(await Oe(e,t)).sort((a,o)=>o.info.mtimeMs-a.info.mtimeMs),r=[];for(let a of i){if(r.length>=n)break;let o=await Ne(e,a);if(!o.turns.length)continue;let l=o.turns[o.turns.length-1];r.push({session_id:o.session_id,label:Lt(o),cwd:o.cwd,start_time:o.start_time,turn_count:o.turns.length,last_user_turn:Q(l.question.content),last_agent_turn:Q(l.response.content)})}return r}function Ot(e){if(!Array.isArray(e)||!e.length||e.length>R.selected||e.some(t=>typeof t!="string"||!ee.test(t)))throw new y("INVALID_PAYLOAD",`Select 1 to ${R.selected} listed sessions to import.`);return[...new Set(e)]}function*Pe(e,t,n){let i=[];for(let r of e)i.length&&(i.length>=t||Buffer.byteLength(JSON.stringify(n([...i,r])))>R.batchBytes)&&(yield n(i),i=[]),i.push(r);i.length&&(yield n(i))}async function He(e,t){let n=`mh-import-${bt("sha256").update(JSON.stringify(t)).digest("hex")}`,{data:i}=await e.json("/memory",{method:"POST",body:t,headers:{"Idempotency-Key":n},operation:"import",timeoutMs:R.timeoutMs});return i}function ze(e,t,n,i){e.batches+=1;let r=A(i)?i.result:null;A(r)&&Number.isSafeInteger(r.succeeded)?(e[t]+=r.succeeded,e.failed+=Number.isSafeInteger(r.failed)?r.failed:0,e.unknown+=Number.isSafeInteger(r.unknown)?r.unknown:0):e[t]+=n}async function je({gateway:e,source:t,ids:n,roots:i}){N(t);let r=Ot(n),a={source:t,sessions:0,messages:0,skipped:0,failed:0,unknown:0,batches:0};try{let o=new Map((await Oe(t,i)).map(l=>[l.id,l]));for(let l of r){let d=o.get(l);if(!d)continue;let m=await Ne(t,d);if(!m.turns.length)continue;let v=[];for(let b of m.turns)for(let u of[b.question,b.response]){let f=z(u.content);f?v.push({role:u.role,content:f,source:Z[t].session}):a.skipped+=1}if(!v.length)continue;a.sessions+=1;let S=`mh:import:${t}:${l}`;for(let b of Pe(v,R.batchItems,u=>({extract:!0,thread_id:S,items:u})))ze(a,"messages",b.items.length,await He(e,b))}}catch(o){return{...a,error:D(o)}}return a}async function Nt(e,t){if(e==="claude")return Mt(t.claude);let n=[];for(let i of await Me(t.copilot))n.push(...await $e("copilot-memories",i.file,i.info,()=>It(i.file,i.id)));return n}async function Be({gateway:e,source:t,roots:n}){N(t);let i={source:t,memories:0,skipped:0,failed:0,unknown:0,batches:0,reconcile:null};try{let r=[],a=new Set;for(let o of await Nt(t,n)){let l=z(o.fact,{maxBytes:R.factBytes});if(!l||a.has(l)){i.skipped+=1;continue}a.add(l),r.push({content:l,source:Z[t].memory})}for(let o of Pe(r,R.factBatchItems,l=>({extract:!1,items:l})))ze(i,"memories",o.items.length,await He(e,o));if(i.memories>0){let{data:o}=await e.json("/reconcile",{method:"POST",body:{},operation:"reconcile",timeoutMs:R.timeoutMs});i.reconcile=A(o)&&typeof o.status=="string"?o.status:"requested"}}catch(r){return{...i,error:D(r)}}return i}var Fe=`
<section id="reviewView" hidden aria-label="Recent recalls and privacy">
  <h2>Recent recalls and privacy</h2>
  <p>Internal dogfooding telemetry is on by default unless you opted out. New metadata
  and explicit feedback are retained for 60 days. Your prompts, answers and memory text
  are not copied into feedback telemetry.</p>
  <details><summary>Collection and retention notice</summary><p id="reviewNotice"></p></details>
  <p id="reviewStatus" role="status" aria-live="polite">Loading participation...</p>
  <button id="reviewPreference" type="button" disabled>Loading participation...</button>
  <button id="reviewRefresh" type="button">Refresh recalls</button>
  <label class="checkline"><input id="invitationPreference" type="checkbox" checked />
    Occasionally invite me to rate a recall on this installation</label>
  <p class="hint">Only while this canvas is open. At most once per 24 hours; dismissing pauses invitations for 7 days.
    This preference does not opt you out of telemetry.</p>
  <p id="reviewError" class="err" role="alert"></p>
  <div class="review-grid">
    <div><h3>Your recorded recalls</h3><div id="recallList"></div>
      <button id="recallMore" type="button" hidden>Load more</button></div>
    <div id="recallDetail" aria-live="polite">Select a recall to review it.</div>
  </div>
</section>`,qe=`
  const review = { session: null, enrollment: null, cursor: null, items: [], detail: null,
    busy: false, pending: null, edits: new Map(), needsRefresh: false };
  const feedbackValues = ${JSON.stringify(be)};
  const feedbackQuestions = {
    benefit: { title: 'Did this recall help with your task?', values: {
      helped: 'Helped', no_difference: 'No noticeable difference', harmed: 'Made things worse', unsure: 'Not sure' } },
    correctness: { title: 'Is this information still accurate?', values: {
      correct: 'Correct', outdated: 'Outdated', incorrect: 'Incorrect', unsure: 'Not sure' } },
    applicability: { title: 'Does it apply to this task or context?', values: {
      applies: 'Applies', partly_applies: 'Partly applies', does_not_apply: 'Does not apply', unsure: 'Not sure' } },
    relevance: { title: 'Was it relevant to what you were doing?', values: {
      relevant: 'Relevant', partly_relevant: 'Partly relevant', irrelevant: 'Irrelevant', unsure: 'Not sure' } },
  };
  const labelText = value => String(value ?? '').replaceAll('_', ' ');
  const reviewTime = value => new Date(value).toLocaleString();

  function reviewError(error) {
    $('reviewError').textContent = error?.message || String(error || '');
  }

  async function reviewGet(path) {
    const response = await fetch(path, { headers: HEADERS, cache: 'no-store' });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  }

  async function reviewPost(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.message || 'The review request failed.');
      error.status = response.status; error.code = data.error; throw error;
    }
    return data;
  }

  function participation() {
    const value = review.enrollment;
    $('reviewPreference').disabled = review.busy || !value || (!value.available && !value.enrolled);
    $('reviewPreference').textContent = value?.enrolled ? 'Opt out of new collection' : 'Re-enable collection';
    $('reviewStatus').textContent = !value ? 'Participation could not be loaded.'
      : value.local_collection_paused && value.enrolled
        ? 'Local collection is paused. Server opt-out is unconfirmed; retry Opt out.'
        : !value.available ? 'Collection is unavailable for this account.'
        : value.enrolled ? 'Collection is on. You can opt out below without disabling memories.'
        : 'Collection is off. Previously recorded metadata keeps its original expiry.';
  }

  async function reviewStatus() {
    const data = await reviewGet('/api/telemetry/status');
    if (review.session && (review.session !== data.session
      || review.enrollment?.epoch !== data.enrollment.epoch
      || !data.enrollment.enrolled || !data.enrollment.available || data.enrollment.local_collection_paused)) {
      clearInvitation();
      review.items = []; review.detail = null; review.pending = null; review.cursor = null;
      review.edits.clear();
      $('recallList').textContent = '';
      $('recallDetail').textContent = 'Sign-in or participation changed. Select a recall again.';
    }
    review.session = data.session;
    review.enrollment = data.enrollment;
    invitationSettings(data.invitations);
    $('reviewNotice').textContent = data.notice + '\\n\\n' + data.opt_out;
    participation();
  }

  function recallList() {
    $('recallList').innerHTML = review.items.length ? review.items.map(item =>
      '<button type="button" data-recall="' + esc(item.retrieval_id) + '">' +
      esc(reviewTime(item.recorded_at)) + '<br>' + esc(item.client?.trigger || 'Unknown source') +
      ' - ' + esc(item.count) + ' result(s)' + (item.feedback ? ' - rated' : '') + '</button>').join('')
      : '<p>No recorded recalls are available. Earlier unrecorded searches cannot be reconstructed.</p>';
    $('recallMore').hidden = !review.cursor;
  }

  async function loadRecallPage(more = false) {
    const data = await reviewPost('/api/telemetry/recalls', { session: review.session,
      ...(more && review.cursor ? { cursor: review.cursor } : {}) });
    const items = more ? [...review.items, ...data.items] : data.items;
    review.items = [...new Map(items.map(item => [item.retrieval_id, item])).values()];
    review.cursor = data.cursor;
    recallList();
  }

  function memoryText(memory) {
    for (const key of ['content', 'text', 'summary']) if (typeof memory?.[key] === 'string') {
      const conflicts = memory.conflicts_with;
      return memory[key] + (Array.isArray(conflicts) && conflicts.length
        ? '\\n\\nConflict notes:\\n' + JSON.stringify(conflicts, null, 2) : '');
    }
    return memory ? JSON.stringify(memory, null, 2) : '';
  }

  const answerKey = (target, dimension) => target + ':' + dimension;
  const questionId = (target, dimension) => 'question-' + target + '-' + dimension;
  function savedAnswer(target, dimension) {
    return review.detail?.feedback?.labels.find(label => label.target === target && label.dimension === dimension);
  }
  function selectedAnswer(target, dimension) {
    const edit = review.edits.get(answerKey(target, dimension));
    return edit ? edit.action === 'set' ? edit : null : savedAnswer(target, dimension);
  }
  function stageAnswer(label) {
    const saved = savedAnswer(label.target, label.dimension);
    const same = label.action === 'withdraw' ? !saved : saved?.value === label.value
      && JSON.stringify([...(saved.reasons || [])].sort()) === JSON.stringify([...(label.reasons || [])].sort());
    if (same) review.edits.delete(answerKey(label.target, label.dimension));
    else review.edits.set(answerKey(label.target, label.dimension), label);
  }
  function feedbackAllowed() {
    return review.detail?.feedback_allowed && review.enrollment?.enrolled && review.enrollment?.available
      && !review.enrollment.local_collection_paused && review.detail.epoch === review.enrollment.epoch;
  }
  function answerTools(target, dimension) {
    const saved = savedAnswer(target, dimension);
    const edit = review.edits.get(answerKey(target, dimension));
    const attrs = ' data-target="' + target + '" data-dimension="' + dimension + '"';
    return '<div class="answer-status">' +
      (edit ? '<span>' + (edit.action === 'withdraw' ? 'Will be withdrawn when you submit.' : 'Not submitted yet.') + '</span> ' +
        (saved ? '<button type="button" data-undo-answer="true"' + attrs + '>Undo change</button>' : '') :
        saved ? '<span>Saved answer</span> ' : '<span>Optional - leave unanswered to skip</span>') +
      (selectedAnswer(target, dimension) ? '<button type="button" data-clear-answer="true"' + attrs + '>' +
        (saved ? 'Withdraw saved rating' : 'Clear answer') + '</button>' : '') + '</div>';
  }
  function questionContents(target, dimension) {
    const answer = selectedAnswer(target, dimension);
    const id = questionId(target, dimension);
    const attrs = ' data-target="' + target + '" data-dimension="' + dimension + '"';
    return '<legend>' + feedbackQuestions[dimension].title + '</legend><div class="answer-choices">' +
      Object.entries(feedbackQuestions[dimension].values).map(([value, title]) =>
        '<label class="answer-choice"><input type="radio" data-answer="true"' + attrs +
        ' name="' + id + '" id="' + id + '-' + value + '" value="' + value + '"' +
        (answer?.value === value ? ' checked' : '') + ' /><span>' + title + '</span></label>').join('') + '</div>' +
      (answer && feedbackValues[dimension][answer.value].length
        ? '<div class="answer-reasons" role="group" aria-label="Optional reasons"><p>Why? Optional - choose up to 3.</p>' +
          feedbackValues[dimension][answer.value].map(reason => {
            const checked = answer.reasons?.includes(reason);
            const capped = !checked && answer.reasons?.length >= 3;
            return '<label><input type="checkbox" data-reason="true"' + attrs + ' id="' + id + '-' + reason +
              '" value="' + reason + '"' + (checked ? ' checked' : '') +
              (capped ? ' disabled data-limit-disabled="true"' : '') + ' />' + esc(labelText(reason)) + '</label>';
          }).join('') + '</div>' : '') + answerTools(target, dimension);
  }
  function question(target, dimension) {
    return '<fieldset class="feedback-question" id="' + questionId(target, dimension) + '">' +
      questionContents(target, dimension) + '</fieldset>';
  }
  function updateQuestion(target, dimension) {
    const focused = document.activeElement?.id;
    const node = $(questionId(target, dimension));
    if (node) node.innerHTML = questionContents(target, dimension);
    else {
      const tools = $('saved-tools-' + target + '-' + dimension);
      if (tools) tools.innerHTML = answerTools(target, dimension);
    }
    if (focused) $(focused)?.focus();
    feedbackBusy();
  }

  function renderRecall() {
    const detail = review.detail;
    if (!detail) return;
    const allowed = feedbackAllowed();
    const labels = detail.feedback?.labels || [];
    const states = {
      unchanged: 'Unchanged since this recall', changed: 'Changed since this recall',
      superseded: 'Superseded since this recall', unavailable: 'Unavailable',
    };
    $('recallDetail').innerHTML = '<h3>Recall from ' + esc(reviewTime(detail.recorded_at)) + '</h3>' +
      (allowed ? '<form id="feedbackForm"><div class="feedback-intro"><h3>A quick check, if you have a moment</h3>' +
        '<p>Answer as much or as little as you like. One answer is useful; every question is optional.</p></div>' +
        question('retrieval', 'benefit') +
        '<p id="feedbackHarmHint" class="hint" hidden>If you can, rate a memory below to help us understand what went wrong. This is optional.</p>' +
        '<div class="feedback-submit-bar"><p id="feedbackDraftStatus" role="status" aria-live="polite"></p>' +
        '<p id="feedbackMessage" role="status" aria-live="polite"></p>' +
        '<button id="feedbackSubmit" class="primary" type="submit" disabled>Submit feedback</button>' +
        '<button id="feedbackDiscard" type="button" hidden>Discard changes</button>' +
        '<button id="feedbackRetry" type="button" hidden>Retry the same submission</button></div>' :
        '<p>This recall is read-only: collection is off/unavailable, it belongs to an earlier epoch, it failed, or its revision limit was reached.</p>') +
      '<details><summary>Recall details and privacy</summary><p>Source (client-reported): ' + esc(detail.client?.name || 'Unknown') + ' / ' +
      esc(detail.client?.trigger || 'Unknown') + '. Outcome: ' + esc(detail.final_outcome || detail.status) +
      '. Expires: ' + esc(reviewTime(detail.expires_at)) + '.</p>' +
      '<p>Supplied means added to the conversation, not proof the agent used it. Review text is read with your current access; no historical copy is kept.</p></details>' +
      '<h3 class="feedback-memory-heading">' + (detail.items.length ? 'Your recalled memories' : 'No memories were returned') + '</h3>' +
      (allowed && detail.items.length ? '<p class="hint">Want to tell us more? Expand any memory to rate its accuracy, applicability and relevance.</p>' : '') +
      detail.items.map(item => '<article class="card"><h3>Memory ' + item.rank + ' - ' + esc(states[item.memory_state]) +
        '</h3><p>Position: ' + esc(item.position) + '. Delivery: ' +
        esc(item.supplied === null ? 'unknown (no delivery report)' : item.supplied) +
        (item.omit_reason ? ' (' + esc(labelText(item.omit_reason)) + ')' : '') + '.</p>' +
        (item.memory ? '<p><b>' + (item.memory_state === 'unchanged' ? 'Unchanged text' : 'Current text, NOT the recalled version') +
          '</b></p><pre>' + esc(memoryText(item.memory)) + '</pre>' : '') +
        (['changed', 'superseded'].includes(item.memory_state) && !item.memory
          ? '<button type="button" data-current="true">Show current text (not the recalled version)</button>' : '') +
        (item.successor_id ? '<p>A readable successor exists: ' + esc(item.successor_id) + '</p>' : '') +
        (item.memory_state !== 'unchanged' ? '<p>New result ratings are unavailable because the original text cannot be verified.</p>' : '') +
        (allowed && item.memory_state === 'unchanged' ? '<details class="memory-questions"' +
          (['correctness', 'applicability', 'relevance'].some(dimension => review.edits.has(answerKey(item.rank, dimension))) ? ' open' : '') +
          '><summary>Rate this memory <span class="hint">- accuracy, applicability &amp; relevance' +
          (labels.some(label => label.target === item.rank) ? ' (saved answers inside)' : '') + '</span></summary>' +
          ['correctness', 'applicability', 'relevance'].map(dimension => question(item.rank, dimension)).join('') + '</details>' : '') +
        '</article>').join('') +
      (labels.some(label => !allowed || (label.target !== 'retrieval'
        && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged')) ? '<h3>Previously saved ratings</h3>' : '') +
      labels.filter(label => !allowed || (label.target !== 'retrieval'
        && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged')).map(label => '<div><p>' +
        esc(label.target === 'retrieval' ? 'Whole recall' : 'Memory ' + label.target) +
        ': ' + esc(label.dimension) + ' - ' + esc(labelText(label.value)) +
        (label.reasons?.length ? ' (' + esc(label.reasons.map(labelText).join(', ')) + ')' : '') +
        '</p>' + (allowed ? '<div id="saved-tools-' + label.target + '-' + label.dimension + '">' +
          answerTools(label.target, label.dimension) + '</div>' : '') + '</div>').join('') +
      '<details><summary>How your feedback is handled</summary>' +
      '<p>Only answers you choose are submitted, as UI-attested feedback. Nothing changes your memories or their ranking. ' +
      'Leaving a question untouched keeps any saved rating; use Withdraw to remove one. Up to 20 revisions are retained.</p>' +
      (detail.feedback ? '<p>' + esc(detail.feedback.revisions_left) + ' revisions left. Feedback expires ' +
        esc(reviewTime(detail.feedback.expires_at)) + '. Withdrawal removes the active rating; previously exported versions remain until that expiry.</p>' :
        '<p>Feedback expires 60 days after your first submission. Changes do not restart expiry.</p>') + '</details>' +
      (allowed ? '</form>' : '') +
      (allowed ? '' : '<p id="feedbackMessage" role="status" aria-live="polite"></p>' +
        '<button id="feedbackRetry" type="button" hidden>Retry the same submission</button>');
    if (allowed) {
      $('feedbackForm').onsubmit = event => {
        event.preventDefault();
        submitFeedback();
      };
      $('feedbackDiscard').onclick = () => {
        if (review.busy || review.pending) return;
        review.edits.clear();
        renderRecall();
      };
    }
    $('feedbackRetry').onclick = () => sendFeedback();
    feedbackBusy();
  }

  function feedbackBusy() {
    for (const element of $('recallDetail').querySelectorAll('button, input, select')) {
      element.disabled = review.busy || Boolean(review.pending) || review.needsRefresh || element.dataset.limitDisabled === 'true';
    }
    if ($('feedbackRetry')) {
      $('feedbackRetry').hidden = !review.pending;
      $('feedbackRetry').disabled = review.busy;
    }
    const blocked = review.busy || Boolean(review.pending) || review.edits.size > 0;
    $('reviewRefresh').disabled = blocked;
    $('recallMore').disabled = blocked;
    for (const button of $('recallList').querySelectorAll('button')) button.disabled = blocked;
    if ($('feedbackSubmit')) $('feedbackSubmit').disabled = review.busy || Boolean(review.pending) || review.needsRefresh || !review.edits.size;
    if ($('feedbackDiscard')) $('feedbackDiscard').hidden = !review.edits.size || Boolean(review.pending);
    if ($('feedbackDraftStatus')) $('feedbackDraftStatus').textContent = review.pending ? 'Waiting for confirmation. Your selected answers are kept for retry.'
      : review.edits.size ? review.edits.size + (review.edits.size === 1 ? ' change ready to save.' : ' changes ready to save.')
        : 'Choose any answer. Nothing is sent until you submit.';
    if ($('feedbackHarmHint')) $('feedbackHarmHint').hidden = selectedAnswer('retrieval', 'benefit')?.value !== 'harmed';
  }

  async function openRecall(id, includeCurrent = false) {
    if (review.busy || review.pending) return;
    if (review.edits.size && id !== review.detail?.retrieval_id) {
      reviewError(new Error('Submit or discard your changes before opening another recall.'));
      return false;
    }
    const previous = review.detail;
    const previousSession = review.session;
    review.busy = true; feedbackBusy(); reviewError('');
    try {
      await reviewStatus();
      const detail = await reviewPost('/api/telemetry/recall', {
        session: review.session, retrieval_id: id, include_current: includeCurrent,
      });
      if (previous?.retrieval_id !== id || previousSession !== review.session || previous.epoch !== detail.epoch) review.edits.clear();
      else if (previous.feedback?.revision !== detail.feedback?.revision) {
        if (review.edits.size) reviewError(new Error('Saved ratings changed elsewhere. Your draft was cleared; review the updated answers.'));
        review.edits.clear();
      }
      review.detail = detail;
      if (!feedbackAllowed()) review.edits.clear();
      for (const [key, label] of review.edits) {
        if (label.action === 'set' && label.target !== 'retrieval'
          && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged') {
          review.edits.delete(key);
          reviewError(new Error('A memory changed or is unavailable. Its unsaved rating was cleared to avoid rating the wrong version.'));
        }
      }
      review.needsRefresh = false;
      renderRecall();
      return true;
    } catch (error) {
      review.detail = null;
      review.edits.clear();
      $('recallDetail').textContent = 'Recall could not be loaded.';
      reviewError(error);
      return false;
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  function submitFeedback() {
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed() || !review.edits.size) return;
    review.pending = { session: review.session, retrieval_id: review.detail.retrieval_id,
      event: { event_id: crypto.randomUUID(), epoch: review.detail.epoch, surface: 'review_canvas',
        attestation: 'client_ui', occurred_at: new Date().toISOString(), labels: [...review.edits.values()] } };
    return sendFeedback();
  }

  async function sendFeedback() {
    if (review.busy || !review.pending) return;
    review.busy = true; participation(); feedbackBusy(); reviewError('');
    $('feedbackMessage').textContent = 'Submitting...';
    const pending = review.pending;
    let saved = false;
    try {
      const ack = await reviewPost('/api/telemetry/feedback', pending);
      if (!['recorded', 'duplicate'].includes(ack.status) || ack.event_id !== pending.event.event_id) {
        throw new Error('The submission was not acknowledged. Retry the same submission.');
      }
      saved = true; review.pending = null; review.edits.clear(); review.needsRefresh = true;
      review.detail = await reviewPost('/api/telemetry/recall', {
        session: review.session, retrieval_id: pending.retrieval_id, include_current: false,
      });
      review.needsRefresh = false;
      renderRecall();
      $('feedbackMessage').textContent = 'Thank you! Your feedback is saved. Only your latest answers count.';
    } catch (error) {
      if (!saved && ([400, 401, 403, 404, 413, 422].includes(error.status)
        || (error.status === 409 && error.code !== 'retrieval_not_ready')
        || error.code === 'TELEMETRY_STATE_CHANGED')) {
        review.pending = null; review.edits.clear(); review.needsRefresh = true;
      }
      $('feedbackMessage').textContent = saved ? 'Saved, but the updated recall could not be loaded. Refresh to see it.'
        : review.pending ? 'Submission not confirmed. Retry uses the same event ID; no automatic retry is sent.'
          : 'Feedback was not accepted. Refresh before trying again.';
      reviewError(error);
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  async function refreshReview() {
    if (review.busy || review.pending || review.edits.size) return;
    review.busy = true; participation(); reviewError('');
    try {
      await reviewStatus();
      review.detail = null;
      review.needsRefresh = false;
      $('recallDetail').textContent = 'Select a recall to review it.';
      await loadRecallPage();
    }
    catch (error) {
      review.enrollment = null; review.session = null; review.pending = null;
      review.edits.clear();
      review.detail = null; review.items = []; review.cursor = null;
      $('recallList').textContent = '';
      $('recallDetail').textContent = 'Refresh participation before reviewing recalls.';
      reviewError(error);
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  $('recallList').addEventListener('click', event => {
    const button = event.target.closest('[data-recall]');
    if (button) openRecall(button.getAttribute('data-recall'));
  });
  $('recallDetail').addEventListener('click', event => {
    const current = event.target.closest('[data-current]');
    if (current && review.detail) { openRecall(review.detail.retrieval_id, true); return; }
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed()) return;
    const control = event.target.closest('[data-clear-answer], [data-undo-answer]');
    if (control) {
      const target = control.dataset.target === 'retrieval' ? 'retrieval' : Number(control.dataset.target);
      const dimension = control.dataset.dimension;
      if (control.hasAttribute('data-undo-answer')) review.edits.delete(answerKey(target, dimension));
      else stageAnswer({ target, dimension, action: 'withdraw' });
      updateQuestion(target, dimension);
    }
  });
  $('recallDetail').addEventListener('change', event => {
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed()) return;
    const control = event.target.closest('[data-answer], [data-reason]');
    if (!control) return;
    const target = control.dataset.target === 'retrieval' ? 'retrieval' : Number(control.dataset.target);
    const dimension = control.dataset.dimension;
    const current = selectedAnswer(target, dimension);
    if (control.hasAttribute('data-answer')) {
      stageAnswer({ target, dimension, action: 'set', value: control.value,
        reasons: current?.value === control.value ? [...(current.reasons || [])] : [] });
    } else {
      if (!current) return;
      const reasons = new Set(current.reasons || []);
      if (control.checked) reasons.add(control.value); else reasons.delete(control.value);
      if (reasons.size > 3) {
        control.checked = false;
        reviewError(new Error('Choose at most three reasons.'));
        return;
      }
      stageAnswer({ target, dimension, action: 'set', value: current.value, reasons: [...reasons] });
    }
    updateQuestion(target, dimension);
  });
  $('recallMore').addEventListener('click', async () => {
    if (review.busy || review.pending || review.edits.size || !review.cursor) return;
    review.busy = true; feedbackBusy(); reviewError('');
    try { await loadRecallPage(true); } catch (error) { reviewError(error); }
    finally { review.busy = false; participation(); feedbackBusy(); }
  });
  $('reviewRefresh').addEventListener('click', refreshReview);
  $('recalls').addEventListener('click', () => {
    $('memoryView').hidden = true;
    $('reviewView').hidden = false;
    refreshReview();
  });
  $('memories').addEventListener('click', () => {
    $('reviewView').hidden = true;
    $('memoryView').hidden = false;
  });
  $('reviewPreference').addEventListener('click', async () => {
    if (review.busy || !review.enrollment || !review.session) return;
    review.busy = true; participation(); reviewError('');
    try {
      const data = await reviewPost('/api/telemetry/preference', {
        session: review.session, action: review.enrollment.enrolled ? 'disable' : 'enable',
      });
      review.enrollment = data.enrollment;
      clearInvitation();
      review.pending = null;
      review.edits.clear();
      review.detail = null;
      $('recallDetail').textContent = 'Participation changed. Select a recall again.';
    } catch (error) {
      reviewError(error);
      review.pending = null;
      review.edits.clear();
      review.detail = null;
      $('recallDetail').textContent = 'Refresh participation before submitting feedback.';
    } finally { review.busy = false; participation(); feedbackBusy(); }
  });
`;var Ue=`
<section id="invitationBanner" class="notice" hidden aria-label="Optional recall feedback">
  <h2>Was this recall helpful?</h2>
  <p id="invitationSummary"></p>
  <p>Review this specific recall and choose whether to rate it. No rating is submitted automatically.</p>
  <p>As part of internal dogfooding, whether this invitation is shown, opened or dismissed is collected as metadata
    for 60 days. See Recent recalls &amp; privacy for the full notice and telemetry opt-out.</p>
  <button id="invitationReview" type="button" disabled>Review</button>
  <button id="invitationDismiss" type="button" disabled>Dismiss for 7 days</button>
  <button id="invitationStop" type="button">Stop asking on this installation</button>
</section>
<p id="invitationError" class="err" role="status" aria-live="polite"></p>`,Ve=`
  const invitation = { current: null, busy: false, lastCheck: 0, observer: null, timer: null, shown: false };

  function clearInvitation() {
    invitation.observer?.disconnect();
    clearTimeout(invitation.timer);
    invitation.current = null;
    invitation.shown = false;
    $('invitationBanner').hidden = true;
  }

  function invitationError(error) {
    $('invitationError').textContent = error?.message || String(error || '');
  }

  function invitationSettings(data) {
    $('invitationPreference').checked = data.enabled;
  }

  async function invitationEvent(action, current) {
    return reviewPost('/api/telemetry/invitation-event', {
      session: current.session, invitation_id: current.invitation_id, action,
    });
  }

  async function showInvitationWhenVisible(entries) {
    const current = invitation.current;
    if (!current || invitation.shown || invitation.busy || document.hidden
      || !entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return;
    invitation.busy = true;
    try {
      await invitationEvent('shown', current);
      if (invitation.current !== current) return;
      invitation.shown = true;
      invitation.observer.disconnect();
      $('invitationReview').disabled = false;
      $('invitationDismiss').disabled = false;
    } catch (error) {
      clearInvitation();
      invitationError(error);
    } finally { invitation.busy = false; }
  }

  async function checkInvitation() {
    if (document.hidden || invitation.busy || invitation.current || review.busy || review.pending || review.edits?.size
      || Date.now() - invitation.lastCheck < 60000) return;
    invitation.lastCheck = Date.now();
    invitation.busy = true;
    try {
      // Separate from reviewStatus: background invitations must never change an
      // in-progress review selection or pending rating.
      const status = await reviewGet('/api/telemetry/status');
      invitationSettings(status.invitations);
      const data = await reviewPost('/api/telemetry/invitation', { session: status.session });
      if (!data.invitation || document.hidden || review.busy || review.pending || review.edits?.size) return;
      const current = { ...data.invitation, session: status.session };
      invitation.current = current;
      invitation.shown = false;
      $('invitationSummary').textContent = reviewTime(current.recorded_at) + ' - ' + current.count + ' result(s).';
      $('invitationReview').disabled = true;
      $('invitationDismiss').disabled = true;
      $('invitationBanner').hidden = false;
      invitation.observer = new IntersectionObserver(showInvitationWhenVisible, { threshold: 0.5 });
      invitation.observer.observe($('invitationBanner'));
      invitation.timer = setTimeout(clearInvitation, Math.max(0, Date.parse(current.expires_at) - Date.now()));
    } catch (error) {
      clearInvitation();
      invitationError(error);
    } finally { invitation.busy = false; }
  }

  $('invitationReview').addEventListener('click', async () => {
    const current = invitation.current;
    if (!current || !invitation.shown || invitation.busy || review.busy || review.pending || review.edits?.size) return;
    invitation.busy = true;
    invitationError('');
    try {
      $('memoryView').hidden = true;
      $('reviewView').hidden = false;
      if (await openRecall(current.retrieval_id)) await invitationEvent('opened', current);
    } catch (error) { invitationError(error); }
    finally { clearInvitation(); invitation.busy = false; }
  });
  $('invitationDismiss').addEventListener('click', async () => {
    const current = invitation.current;
    if (!current || !invitation.shown || invitation.busy) return;
    invitation.busy = true;
    try { await invitationEvent('dismissed', current); }
    catch (error) { invitationError(error); }
    finally { clearInvitation(); invitation.busy = false; }
  });
  async function changeInvitationPreference(enabled) {
    if (invitation.busy) return;
    invitation.busy = true;
    $('invitationPreference').disabled = true;
    invitationError('');
    try {
      const status = await reviewGet('/api/telemetry/status');
      const data = await reviewPost('/api/telemetry/invitation-preference', { session: status.session, enabled });
      invitationSettings(data);
      if (data.warning) invitationError(data.warning);
      clearInvitation();
    } catch (error) {
      $('invitationPreference').checked = !enabled;
      invitationError(error);
    } finally { invitation.busy = false; $('invitationPreference').disabled = false; }
  }
  $('invitationStop').addEventListener('click', () => changeInvitationPreference(false));
  $('invitationPreference').addEventListener('change', () => changeInvitationPreference($('invitationPreference').checked));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInvitation();
    else checkInvitation();
  });
  $('refresh').addEventListener('click', checkInvitation);
  checkInvitation();
`;function Ye({token:e,nonce:t}){return`<!doctype html>
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
  [hidden] { display: none !important; }
  .review-grid { display: grid; grid-template-columns: minmax(210px, 30%) 1fr; gap: 18px; margin-top: 18px; }
  #reviewView { overflow: visible; }
  #reviewView button { margin: 4px 0; }
  #reviewView > button { width: auto; margin-right: 8px; }
  #invitationBanner { margin: 12px 16px; }
  #invitationBanner button { width: auto; margin: 4px; }
  #invitationError { margin: 0 16px; }
  #recallList button { text-align: left; }
  #recallDetail select { margin-bottom: 8px; }
  .feedback-intro { margin: 14px 0; }
  .feedback-intro p, .answer-reasons p { margin: 6px 0; }
  .feedback-question { min-width: 0; margin: 16px 0; padding: 12px; border: 1px solid var(--mh-border); border-radius: 10px; }
  .feedback-question legend { padding: 0 4px; font-weight: var(--font-weight-semibold, 600); }
  .answer-choices { display: flex; flex-wrap: wrap; gap: 8px; }
  .answer-choice { display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 8px 10px;
    border: 1px solid var(--mh-border); border-radius: 8px; cursor: pointer; color: var(--mh-fg); font-size: inherit; }
  .answer-choice:has(input:checked) { border-color: var(--mh-accent); background: color-mix(in srgb, var(--mh-accent) 14%, var(--mh-bg)); }
  .answer-choice:has(input:focus-visible) { outline: 2px solid var(--mh-accent); outline-offset: 2px; }
  .answer-choice input, .answer-reasons input { width: auto; margin: 0; accent-color: var(--mh-accent); }
  .answer-reasons { margin-top: 12px; }
  .answer-reasons label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 12px 4px 0; cursor: pointer; }
  .answer-status { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; font-size: 12px; color: var(--mh-muted); }
  .answer-status button { width: auto; padding: 4px 8px; background: transparent; }
  .feedback-memory-heading { margin-top: 20px; }
  .memory-questions > summary { padding: 8px 0; font-size: 14px; color: var(--mh-fg); }
  .feedback-submit-bar { position: sticky; top: 0; z-index: 1; padding: 10px 0; background: var(--mh-bg); border-bottom: 1px solid var(--mh-border); }
  .feedback-submit-bar button { width: auto; margin-right: 8px !important; }
  #feedbackDraftStatus { margin: 4px 0; font-size: 12px; color: var(--mh-muted); }
  @media (max-width: 600px) { .review-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Memory House</h1>
  <span id="who" class="who">Loading...</span>
  <span class="spacer"></span>
  <button id="memories" type="button">Memories</button>
  <button id="recalls" type="button">Recent recalls &amp; privacy</button>
  <button id="import" class="primary" type="button">Import memory</button>
  <button id="refresh" type="button">Refresh</button>
</header>
${Ue}
<main id="memoryView">
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
${Fe}

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
      : '<div class="hint">You are not a member of any Learning Space yet.</div>');
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
    timer = value ? setInterval(() => { if (!document.hidden && !$('memoryView').hidden) load(); }, value * 1000) : null;
  }
  $('autoRefresh').addEventListener('input', event => {
    const value = Math.min(Math.max(Number(event.target.value) || 0, 0), 300);
    $('autoRefreshValue').textContent = value ? value + 's' : 'off';
  });
  $('autoRefresh').addEventListener('change', event => setAutoRefresh(event.target.value));

  ${qe}
  ${Ve}

  load();
  setAutoRefresh($('autoRefresh').value);
</script>
</body>
</html>`}import{randomUUID as ie}from"node:crypto";function Ge(e,{clock:t=Date.now}={}){let n,i,r,a,o,l=!1,d,m=s=>process.stderr.write(`memory-house:${s}
`),v=new Map,S=(s,c)=>s&&typeof s=="object"&&!Array.isArray(s)&&Object.keys(s).every(h=>c.includes(h)),b=()=>{throw new y("INVALID_PAYLOAD","Invalid recall review request.")};async function u(){let s=await e.captureIdentity();if(!s?.accountBound)throw new y("NOT_SIGNED_IN","Sign in to Memory House before reviewing recalls.");return s}async function f(){let s=await u(),c=await Y(e,"status",void 0,{expectedBinding:s.binding}),h=await u();if(s.binding!==h.binding||s.generation!==h.generation)throw new y("TELEMETRY_STATE_CHANGED","Sign-in changed. Refresh the review before continuing.");return(n!==h.binding||i!==h.generation)&&(r=ie(),v.clear(),o=null),n=h.binding,i=h.generation,a=c,(!c.enrolled||!c.available||c.local_collection_paused||!F(c.invitation_policy)||o?.snapshot.epoch!==c.epoch)&&(o=null),{enrollment:a,session:r,invitations:await B(e.config),notice:ve,opt_out:he,notice_version:fe}}async function w(s){let c=await u();if(!r||s!==r||n!==c.binding||i!==c.generation)throw new y("TELEMETRY_STATE_CHANGED","Sign-in changed or the review expired. Refresh before continuing.");return c}async function O(s){if(!s||Object.keys(s).some(g=>!["action","session"].includes(g))||!["enable","disable"].includes(s.action))throw new y("INVALID_PAYLOAD","Choose enable or disable.");let c=await w(s.session),h=await Y(e,s.action,void 0,{expectedBinding:c.binding});return await w(s.session),v.clear(),o=null,{enrollment:h}}async function x(s,c,h){let g=await w(s);try{let I=await e.telemetryReview(c,{...h,binding:g.binding});return await w(s),I}catch(I){throw Object.hasOwn(G,I.problem??"")?new y("FEEDBACK_REJECTED",G[I.problem],{status:I.status,problem:I.problem}):I}}async function p(s){return(!S(s,["session","cursor"])||s.cursor!==void 0&&(typeof s.cursor!="string"||!s.cursor.length||s.cursor.length>16384))&&b(),xe(await x(s.session,"list",{...s.cursor===void 0?{}:{cursor:s.cursor}}))}async function E(s){(!S(s,["session","retrieval_id","include_current"])||s.include_current!==void 0&&typeof s.include_current!="boolean")&&b();let c=s.include_current===!0,h=ke(await x(s.session,"detail",{retrievalId:s.retrieval_id,includeCurrent:c}),s.retrieval_id,c);return v.delete(h.retrieval_id),v.set(h.retrieval_id,{epoch:h.epoch,count:h.count,allowed:h.feedback_allowed,states:new Map(h.items.map(g=>[g.rank,g.memory_state]))}),v.size>50&&v.delete(v.keys().next().value),h}async function C(s){(!S(s,["session","retrieval_id","event"])||!ye(s.event))&&b(),await w(s.session);let c=v.get(s.retrieval_id);if(!c||!c.allowed||c.epoch!==s.event.epoch)throw new y("TELEMETRY_STATE_CHANGED","Refresh and select an eligible recall before submitting feedback.");if(s.event.labels.some(g=>g.target!=="retrieval"&&(g.target>c.count||g.action==="set"&&c.states.get(g.target)!=="unchanged")))throw new y("INVALID_PAYLOAD","Only unchanged, currently readable results can receive new result ratings.");let h=await U(e);if(h?.binding!==n||h.epoch!==s.event.epoch)throw new y("TELEMETRY_STATE_CHANGED","Local collection is paused or participation changed. Refresh before submitting.");return x(s.session,"feedback",{retrievalId:s.retrieval_id,body:s.event,revision:h.revision})}async function Qe(s){if(S(s,["session"])||b(),await w(s.session),l)return{invitation:null};l=!0;try{if(await f(),await w(s.session),!a.available||!a.enrolled||a.local_collection_paused||!F(a.invitation_policy)||!(await B(e.config)).enabled)return{invitation:null};let c=await U(e),g=(await p(s)).items.find(oe=>q(oe,c.epoch,t())&&ce(oe.retrieval_id));if(!g)return{invitation:null};let I=await de(e.config,t());if(!I)return{invitation:null};if(await w(s.session),!await V(e.config,c.binding,c.epoch,c.revision))return{invitation:null};let se=Math.min(t()+j.leaseMs,Date.parse(g.expires_at),Date.parse(g.recorded_at)+j.recentMs);return o={id:ie(),session:s.session,snapshot:c,reservation:I,expiresAt:se,retrievalId:g.retrieval_id,events:new Map},{invitation:{invitation_id:o.id,retrieval_id:g.retrieval_id,recorded_at:g.recorded_at,count:g.count,expires_at:new Date(se).toISOString()}}}finally{l=!1}}async function re(s,c,h){if(await w(s.session),s.expiresAt<=t()||!await V(e.config,s.snapshot.binding,s.snapshot.epoch,s.snapshot.revision))throw new y("TELEMETRY_STATE_CHANGED","The invitation expired or participation changed.");let g=s.events.get(c);if(g||(g={queued:!1,body:{event_id:ie(),epoch:s.snapshot.epoch,policy:ae,action:c,surface:"review_canvas_banner",occurred_at:new Date(t()).toISOString(),...c==="dismissed"?{dismissal:h}:{}}},s.events.set(c,g)),!g.queued&&(g.queued=await we(e,s.snapshot,[{kind:"invitation",retrievalId:s.retrievalId,body:g.body}],s.snapshot.epoch,{clock:t,log:m}),!g.queued))throw new y("TELEMETRY_STATE_CHANGED","Participation changed; the invitation event was not queued.");return d??=ge({client:e,clock:t,log:m}).finally(()=>{d=null}),{status:"queued"}}async function Xe(s){(!S(s,["session","invitation_id","action"])||!["shown","opened","dismissed"].includes(s.action))&&b(),await w(s.session);let c=o;if(!c||s.invitation_id!==c.id||c.session!==s.session||!await ue(e.config,c.reservation))throw new y("TELEMETRY_STATE_CHANGED","This invitation is no longer active.");if(s.action==="shown"){if(await f(),c!==o)throw new y("TELEMETRY_STATE_CHANGED","Invitations or collection are now disabled.");if(!(await p({session:s.session})).items.some(I=>I.retrieval_id===c.retrievalId&&q(I,c.snapshot.epoch,t())))throw new y("TELEMETRY_STATE_CHANGED","This recall is no longer eligible for an invitation.");if(!c.events.has("shown")&&!await pe(e.config,c.reservation,t()))throw new y("TELEMETRY_STATE_CHANGED","Invitations are now disabled or this reservation expired.")}else(!c.events.get("shown")?.queued||s.action==="opened"&&!v.has(c.retrievalId))&&b();s.action==="dismissed"&&await me(e.config,c.reservation,t());let h=await re(c,s.action,"dismiss");return s.action!=="shown"&&(o=null),h}async function Ze(s){(!S(s,["session","enabled"])||typeof s.enabled!="boolean")&&b(),await w(s.session);let c=o,h=await le(e.config,s.enabled,t());if(o=null,!s.enabled&&c?.events.get("shown")?.queued)try{await re(c,"dismissed","stop_asking")}catch{h.warning="Invitations are off on this installation, but the dismissal event could not be queued.",m("invitation:dismissal:not-queued")}return h}return{status:f,check:w,preference:O,list:p,detail:E,feedback:C,candidate:Qe,invitationEvent:Xe,invitationSettings:Ze,close:async()=>{await d}}}var Ke=new Set(["NOT_SIGNED_IN","ENTRA_AUTH_REQUIRED","ENTRA_TOKEN_INVALID","SECURE_CACHE_UNAVAILABLE","INVALID_AUTH_STATE","PUBLISHER_CONFIG_MISSING","TENANT_CHANGED"]),Ht=new Set(["INVALID_PAYLOAD"]),zt=64*1024,jt="x-mh-canvas-token";function yn(e){let t=D(e);return{code:Ke.has(t.code)?"not_signed_in":t.code.toLowerCase(),message:t.message}}var T=class extends Error{constructor(t,n,i){super(i),this.status=t,this.code=n}};function Je(e,t,n,i={}){e.writeHead(t,{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...i}),e.end(n)}function _(e,t,n){Je(e,t,JSON.stringify(n),{"Content-Type":"application/json; charset=utf-8","Cross-Origin-Resource-Policy":"same-origin"})}function H(e,t){let n=e.headers[t];return Array.isArray(n)?n[0]:n}function Bt(e,t){if(typeof e!="string")return!1;let n=Buffer.from(e),i=Buffer.from(t);return n.length===i.length&&Pt(n,i)}async function L(e){if(!/^application\/json(?:\s*;|$)/i.test(H(e,"content-type")??""))throw new T(415,"unsupported_media_type","Send a JSON request body.");let t=[],n=0;for await(let i of e){if(n+=i.length,n>zt)throw new T(413,"payload_too_large","The request body is too large.");t.push(i)}try{let i=JSON.parse(Buffer.concat(t).toString("utf8")||"{}");if(i===null||typeof i!="object"||Array.isArray(i))throw new Error("shape");return i}catch{throw new T(400,"invalid_json","The request body must be a JSON object.")}}function Ft(e,t){if(t instanceof T)return _(e,t.status,{error:t.code,message:t.message});if(t instanceof y){let n=D(t);return Ke.has(n.code)?_(e,401,{error:"not_signed_in",code:n.code,message:n.message}):n.code==="FEEDBACK_REJECTED"?_(e,t.status,{error:t.problem,message:n.message}):_(e,Ht.has(n.code)?400:502,{error:n.code,message:n.message})}return _(e,500,{error:"internal_error",message:"The Memory House canvas hit an unexpected error."})}async function xn({gateway:e={},roots:t=Re()}={}){let n=We(32).toString("base64url"),i,r=()=>i??=Te(e),a,o=()=>a??=Ge(r().client),l=0,d=!1,m=u=>u===`127.0.0.1:${l}`||u===`localhost:${l}`,v=u=>{if(!m(H(u,"host")))throw new T(403,"forbidden","Forbidden.");let f=H(u,"sec-fetch-site");if(f!==void 0&&f!=="same-origin"&&f!=="none")throw new T(403,"forbidden","Forbidden.");if(!Bt(H(u,jt),n))throw new T(403,"forbidden","Forbidden.")},S=async u=>{if(d)throw new T(409,"import_in_progress","Another import is still running. Wait for it to finish.");d=!0;try{return await u()}finally{d=!1}},b=Dt(async(u,f)=>{try{let w=new URL(u.url??"/","http://127.0.0.1"),O=`${u.method} ${w.pathname}`;if(w.pathname==="/"){if(u.method!=="GET"&&u.method!=="HEAD")throw new T(405,"method_not_allowed","Method not allowed.");if(!m(H(u,"host")))throw new T(403,"forbidden","Forbidden.");let x=We(18).toString("base64");return Je(f,200,u.method==="HEAD"?void 0:Ye({token:n,nonce:x}),{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":`script-src 'nonce-${x}'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'`})}if(!w.pathname.startsWith("/api/"))throw new T(404,"not_found","Not found.");switch(v(u),O){case"GET /api/telemetry/status":return _(f,200,await o().status());case"POST /api/telemetry/preference":return _(f,200,await o().preference(await L(u)));case"POST /api/telemetry/recalls":return _(f,200,await o().list(await L(u)));case"POST /api/telemetry/recall":return _(f,200,await o().detail(await L(u)));case"POST /api/telemetry/feedback":return _(f,200,await o().feedback(await L(u)));case"POST /api/telemetry/invitation":return _(f,200,await o().candidate(await L(u)));case"POST /api/telemetry/invitation-event":return _(f,200,await o().invitationEvent(await L(u)));case"POST /api/telemetry/invitation-preference":return _(f,200,await o().invitationSettings(await L(u)));case"GET /api/memory":{let x=await Ae(r(),{search:w.searchParams.get("search")??"",memoryTypes:w.searchParams.getAll("memory_types"),includeSuperseded:w.searchParams.get("include_superseded")==="true",limit:w.searchParams.get("limit")});return _(f,200,x)}case"GET /api/import/sessions":{let x=N(w.searchParams.get("source"));return _(f,200,{source:x,limit:R.sessions,sessions:await De(x,t)})}case"POST /api/import/sessions":{let x=await L(u),p=N(x.source);return _(f,200,await S(()=>je({gateway:r(),source:p,ids:x.ids,roots:t})))}case"POST /api/import/memories":{let x=await L(u),p=N(x.source);return _(f,200,await S(()=>Be({gateway:r(),source:p,roots:t})))}default:throw new T(404,"not_found","Not found.")}}catch(w){f.headersSent?f.destroy():Ft(f,w)}});return await new Promise((u,f)=>{b.once("error",f),b.listen(0,"127.0.0.1",()=>{b.off("error",f),u()})}),l=b.address().port,{url:`http://127.0.0.1:${l}/`,token:n,close:async()=>{await new Promise(u=>{b.close(u),b.closeAllConnections?.()}),await a?.close()}}}export{yn as canvasActionError,Te as createGateway,Ae as loadCanvasData,xn as startCanvasServer,ft as summarizeCanvasData};
