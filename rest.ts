import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, touchRepo, type Repo, type Pull, type Issue } from './store.ts';

type Obj = Record<string, any>;
const logins = new Map<string, string>();
const authTokens = new Map<string, string | undefined>();
// In-process API adapter: all public surfaces use the same validation and mutations.
export async function restCall(method: string, path: string, input: Obj = {}): Promise<any> {
  const request = Readable.from([JSON.stringify(input)]) as IncomingMessage;
  request.method = method; request.url = `/api/v3${path}`;
  request.headers = { authorization: `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`, 'content-type': 'application/json' };
  let status = 200, result: any;
  const response = { writeHead(code: number) { status = code; }, end(text: string) { result = text ? JSON.parse(text) : null; } } as unknown as ServerResponse;
  await handle(request, response, request.url.split('?')[0]!);
  if (status >= 400) throw new Error(result?.message ?? 'Request failed');
  return result;
}
const json = (res: ServerResponse, status: number, value?: unknown, extra: Record<string,string> = {}) => {
  const body = Buffer.from(value === undefined ? '' : `${JSON.stringify(value)}\n`);
  res.writeHead(status, { 'x-github-request-id': 'MF0000000001', ...(body.length ? { 'content-type':'application/json; charset=utf-8', 'content-length':String(body.length) } : {}), ...extra }); res.end(body);
};
const error = (res: ServerResponse, status: number, message: string) => json(res,status,{message});
async function body(req: IncomingMessage): Promise<Obj> { let data=''; for await (const part of req) data += part; if (!data) return {}; try { const parsed=JSON.parse(data); return parsed && typeof parsed==='object' ? parsed : {}; } catch { throw new Error('bad-json'); } }
function repoView(r: Repo): Obj { return { id:r.id,node_id:`R_${r.id}`,name:r.name,full_name:`${r.owner}/${r.name}`,owner:{login:r.owner},private:r.private,description:r.description,default_branch:r.defaultBranch }; }
function issueView(r: Repo,i: Issue): Obj { return { id:i.createdSeq,node_id:`I_${r.id}_${i.number}`,number:i.number,title:i.title,body:i.body,state:i.state,labels:i.labels.map(x=>({...x})),comments:i.comments.length,created_at:`seq-${i.createdSeq}`,updated_at:`seq-${i.updatedSeq}`,html_url:`/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}` }; }
function pullView(r: Repo,p: Pull): Obj { return { id:p.createdSeq,node_id:`P_${r.id}_${p.number}`,number:p.number,title:p.title,body:p.body,state:p.merged?'closed':p.state,head:{ref:p.head.ref,sha:p.head.sha},base:{ref:p.base.ref,sha:p.base.sha},merged:p.merged,merged_at:p.mergedAt,merge_commit_sha:p.mergeCommitSha }; }
function contentCommit(r: Repo, branch: string, path: string, value?: Buffer, message='update file'): string {
  const files=new Map(store.branchFiles(r,branch));
  if (value === undefined) files.delete(path); else { const blob=store.addObject(r,'blob',value); files.set(path,blob); }
  const parent=r.refs.get(`refs/heads/${branch}`) ?? null; return store.commit(r,branch,message,files,parent);
}
function branchName(ref: string): string { return ref.replace(/^refs\/heads\//,''); }
function directorySha(repo: Repo, branch: string, path: string): string | undefined {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  let tree = tip && repo.objects.get(tip)?.data.toString().match(/^tree ([0-9a-f]{40})/m)?.[1];
  for (const name of path.split('/').filter(Boolean)) {
    const data = tree && repo.objects.get(tree)?.data;
    if (!data) return undefined;
    let found: string | undefined;
    for (let offset = 0; offset < data.length;) {
      const space = data.indexOf(32, offset), nul = data.indexOf(0, space);
      if (space < 0 || nul < 0) return undefined;
      if (data.subarray(space + 1, nul).toString() === name) found = data.subarray(nul + 1, nul + 21).toString('hex');
      offset = nul + 21;
    }
    tree = found;
  }
  return tree || undefined;
}
function ancestors(repo: Repo, sha: string): string[] { const out:string[]=[]; let current:string|undefined=sha; while(current){out.push(current);current=repo.commits.get(current)?.parent??undefined;} return out; }
function mergeBase(repo: Repo, left: string, right: string): string | undefined { const leftSet=new Set(ancestors(repo,left)); return ancestors(repo,right).find(sha=>leftSet.has(sha)); }
function lineChanges(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
  const left=(before?.toString('utf8')??'').split('\n'); const right=(after?.toString('utf8')??'').split('\n');
  if (before === undefined) return {additions:right.length,deletions:0};
  if (after === undefined) return {additions:0,deletions:left.length};
  const rows=Array.from({length:left.length+1},()=>new Uint32Array(right.length+1));
  for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)rows[i]![j]=left[i]===right[j]?rows[i+1]![j+1]!+1:Math.max(rows[i+1]![j]!,rows[i]![j+1]!);
  const common=rows[0]![0]!; return {additions:right.length-common,deletions:left.length-common};
}
export function restRouter(req: IncomingMessage, res: ServerResponse, pathname: string, url?: URL): boolean {
  if (pathname !== '/api/v3' && pathname !== '/api/v3/' && !pathname.startsWith('/api/v3/')) return false;
  void handle(req,res,pathname,url); return true;
}
async function handle(req: IncomingMessage,res: ServerResponse,pathname: string, parsedUrl?: URL): Promise<void> {
  const header=req.headers.authorization;
  if (header !== undefined && !authTokens.has(header)) authTokens.set(header, header.match(/^Bearer\s+(.+)$/i)?.[1]);
  const auth=header === undefined ? undefined : authTokens.get(header); const token=process.env.MAKEFUN_SHOP_TOKEN;
  if (!auth || !token || auth !== token) { error(res,401,'Bad credentials'); return; }
  let login=logins.get(token);
  if (login === undefined) { login=token.match(/^(?:login|user|github):([A-Za-z0-9][A-Za-z0-9-]*)$/i)?.[1] ?? 'adaiversen'; logins.set(token,login); }
  const url=parsedUrl ?? new URL(req.url ?? pathname,'http://forge.local'); const method=req.method ?? 'GET';
  let input: Obj={}; if (['POST','PUT','PATCH','DELETE'].includes(method) && req.headers['content-type']?.includes('application/json')) { try { input=await body(req); } catch { error(res,400,'Malformed JSON'); return; } }
  if (pathname==='/api/v3/' || pathname==='/api/v3') { json(res,200,{current_user_url:'/api/v3/user'},{'x-oauth-scopes':'repo, read:org'}); return; }
  if (pathname==='/api/v3/meta' && method==='GET') { json(res,200,{installed_version:'3.0.0'}); return; }
  if (pathname==='/api/v3/user/repos') {
    if(method==='POST') { const name=String(input.name ?? ''); if(!name) {error(res,422,'Validation Failed');return;} try { const r=store.createRepo(login,name,String(input.description??''),input.private!==false,String(input.default_branch??'main')); json(res,201,repoView(r)); } catch {error(res,422,'Repository already exists');} return; }
    if(method==='GET') { const all=store.listRepos(login); const page=Math.max(1,Number(url.searchParams.get('page')??1)); const per=Math.max(1,Math.min(100,Number(url.searchParams.get('per_page')??30))); const items=all.slice((page-1)*per,page*per); const headers:Record<string,string>={}; if(page*per<all.length) {const next=new URL(url);next.searchParams.set('page',String(page+1));headers.link=`<http://${req.headers.host}${next.pathname}${next.search}>; rel="next"`; } json(res,200,items.map(repoView),headers); return; }
  }
  const parts=pathname.slice('/api/v3/repos/'.length).split('/').map(decodeURIComponent); if(parts.length<2){error(res,404,'Not Found');return;}
  const [owner,name,...tail]=parts; if(owner.toLowerCase()!==login.toLowerCase()){error(res,404,'Not Found');return;} const repo=store.getRepo(owner,name);
  if (repo && ['POST','PUT','PATCH','DELETE'].includes(method)) touchRepo(repo);
  if(tail.length===0) { if(!repo){error(res,404,'Not Found');return;} if(method==='GET'){json(res,200,repoView(repo));return;} if(method==='PATCH'){repo.description=String(input.description??repo.description);json(res,200,repoView(repo));return;} if(method==='DELETE'){store.deleteRepo(repo);json(res,204);return;} }
  if(!repo){error(res,404,'Not Found');return;}
  if(tail[0]==='labels' && method==='POST') { const label={name:String(input.name??''),color:String(input.color??'ededed'),description:String(input.description??'')}; if(!label.name){error(res,422,'Validation Failed');return;} store.addLabel(repo,label);json(res,201,label);return; }
  if(tail[0]==='issues') {
    if(tail.length===1 && method==='POST'){const names=Array.isArray(input.labels)?input.labels.map((x:any)=>typeof x==='string'?x:x.name):[];const labels=names.map((n:string)=>store.getLabel(repo,n));if(labels.some(x=>!x)){error(res,422,'Validation Failed');return;}json(res,201,issueView(repo,store.addIssue(repo,String(input.title??''),String(input.body??''),labels as any[])));return;}
    if(tail.length===1 && method==='GET'){let list=store.listIssues(repo);const state=url.searchParams.get('state')??'open';if(state!=='all')list=list.filter(i=>i.state===state);list.sort((a,b)=>(url.searchParams.get('direction')==='asc'?1:-1)*(a.createdSeq-b.createdSeq));json(res,200,list.map(i=>issueView(repo,i)));return;}
    const n=Number(tail[1]);const issue=store.getIssue(repo,n);if(!issue){error(res,404,'Not Found');return;}
    if(tail[2]==='comments'){if(method==='POST'){const comment={id:store.nextSeq(),body:String(input.body??''),createdSeq:store.nextSeq()};issue.comments.push(comment);json(res,201,{id:comment.id,body:comment.body});return;}if(method==='GET'){json(res,200,issue.comments.map(c=>({id:c.id,body:c.body})));return;}}
    if(tail.length===2&&method==='GET'){json(res,200,issueView(repo,issue));return;}if(tail.length===2&&method==='PATCH'){if(input.state==='closed'||input.state==='open')issue.state=input.state;issue.updatedSeq=store.nextSeq();json(res,200,issueView(repo,issue));return;}
  }
  if(tail[0]==='git'&&tail[1]==='refs'&&method==='POST'){const ref=String(input.ref??'');const sha=String(input.sha??input.object?.sha??'');if(!ref.startsWith('refs/heads/')||!sha){error(res,422,'Invalid ref');return;}repo.refs.set(ref,sha);const branch=branchName(ref);repo.files.set(branch,new Map(repo.files.get(branch)??repo.files.get(repo.defaultBranch)??[]));json(res,201,{ref,object:{sha}});return;}
  if(tail[0]==='branches'&&method==='GET'){json(res,200,[...repo.refs].filter(([ref])=>ref.startsWith('refs/heads/')).map(([ref,sha])=>({name:branchName(ref),commit:{sha}})));return;}
  if(tail[0]==='commits'&&method==='GET'){const branch=branchName(url.searchParams.get('sha')??repo.defaultBranch);let sha=repo.refs.get(`refs/heads/${branch}`);const out=[];while(sha){const c=repo.commits.get(sha);if(!c)break;out.push({sha,commit:{message:c.message}});sha=c.parent??undefined;}json(res,200,out);return;}
  if(tail[0]==='contents'){
    const path=tail.slice(1).join('/'); const branch=branchName(input.branch??url.searchParams.get('branch')??url.searchParams.get('ref')??repo.defaultBranch); const files=store.branchFiles(repo,branch); const existing=files.get(path);
    if(method==='GET'){if(existing){const object=repo.objects.get(existing)!;json(res,200,{name:path.split('/').pop(),path,sha:existing,size:object.data.length,type:'file',encoding:'base64',content:object.data.toString('base64')});return;}const prefix=path?`${path}/`:'';const children=new Set<string>();for(const file of files.keys())if(file.startsWith(prefix)){const rest=file.slice(prefix.length);children.add(rest.split('/')[0]!);}if(children.size){json(res,200,[...children].sort().map(x=>({name:x,path:prefix+x,type:files.has(prefix+x)?'file':'dir',sha:files.get(prefix+x)??directorySha(repo,branch,prefix+x)})));return;}error(res,404,'Not Found');return;}
    if(method==='PUT'){if(existing&&input.sha!==existing){error(res,409,'sha does not match');return;}const commit=contentCommit(repo,branch,path,Buffer.from(String(input.content??''),'base64'),String(input.message??'update file'));const blob=store.branchFiles(repo,branch).get(path)!;json(res,existing?200:201,{content:{name:path.split('/').pop(),path,sha:blob,encoding:'base64'},commit:{sha:commit,message:String(input.message??'update file')}});return;}
    if(method==='DELETE'){if(!existing){error(res,404,'Not Found');return;}if(input.sha!==existing){error(res,409,'sha does not match');return;}const commit=contentCommit(repo,branch,path,undefined,String(input.message??'delete file'));json(res,200,{commit:{sha:commit}});return;}
  }
  if(tail[0]==='pulls'){
    if(tail.length===1&&method==='POST'){const head=String(input.head??'').split(':').pop()!;const base=String(input.base??repo.defaultBranch);const hs=repo.refs.get(`refs/heads/${head}`);const bs=repo.refs.get(`refs/heads/${base}`);if(!hs||!bs){error(res,422,'Head or base branch not found');return;}const hf=store.branchFiles(repo,head),bf=store.branchFiles(repo,base);const changed=[...new Set([...hf.keys(),...bf.keys()])].filter(p=>hf.get(p)!==bf.get(p));const p=store.addPull(repo,{title:String(input.title??''),body:String(input.body??''),state:'open',head:{ref:head,sha:hs},base:{ref:base,sha:bs},merged:false,mergedAt:null,mergeCommitSha:null,files:changed});json(res,201,pullView(repo,p));return;}
    if(tail.length===1&&method==='GET'){const state=url.searchParams.get('state')??'open';json(res,200,store.listPulls(repo).filter(p=>state==='all'||p.state===state).map(p=>pullView(repo,p)));return;}
    const n=Number(tail[1]),pull=store.getPull(repo,n);if(!pull){error(res,404,'Not Found');return;}
    if(tail[2]==='files'&&method==='GET'){const baseTree=repo.commits.get(pull.base.sha)?.tree??new Map<string,string>();const headTree=repo.commits.get(pull.head.sha)?.tree??new Map<string,string>();json(res,200,pull.files.map(filename=>{const before=baseTree.get(filename),after=headTree.get(filename);const delta=lineChanges(before?repo.objects.get(before)?.data:undefined,after?repo.objects.get(after)?.data:undefined);return{filename,status:before===undefined?'added':after===undefined?'removed':'modified',...delta,changes:delta.additions+delta.deletions};}));return;}
    if(tail[2]==='merge'&&method==='PUT'){const baseBranch=repo.defaultBranch;const baseSha=repo.refs.get(`refs/heads/${baseBranch}`)??pull.base.sha;const headSha=repo.refs.get(`refs/heads/${pull.head.ref}`)??pull.head.sha;const ancestor=mergeBase(repo,baseSha,headSha);if(!ancestor){error(res,405,'Pull request is not mergeable');return;}const baseline=repo.commits.get(ancestor)?.tree??new Map<string,string>();const base=repo.commits.get(baseSha)?.tree??store.branchFiles(repo,baseBranch);const head=repo.commits.get(headSha)?.tree??store.branchFiles(repo,pull.head.ref);const merged=new Map(base);const paths=new Set([...baseline.keys(),...base.keys(),...head.keys()]);for(const path of paths){const baseChanged=base.get(path)!==baseline.get(path);const headChanged=head.get(path)!==baseline.get(path);if(baseChanged&&headChanged&&base.get(path)!==head.get(path)){error(res,405,'Pull request is not mergeable');return;}if(headChanged){const sha=head.get(path);if(sha===undefined)merged.delete(path);else merged.set(path,sha);}}const sha=store.commit(repo,baseBranch,String(input.commit_title??pull.title),merged,baseSha);pull.state='merged';pull.merged=true;pull.mergedAt=`seq-${store.nextSeq()}`;pull.mergeCommitSha=sha;json(res,200,{sha,merged:true,message:'Pull request successfully merged'});return;}
    if(tail.length===2&&method==='GET'){json(res,200,pullView(repo,pull));return;}
  }
  error(res,404,'Not Found');
}
