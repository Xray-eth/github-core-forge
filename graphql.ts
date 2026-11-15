import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo } from './store.ts';
import { restCall } from './rest.ts';
import { authorized, readJson, send } from './mcp.ts';

type Value = any;
type Selection = { name: string; alias?: string; args: Record<string,Value>; children: Selection[]; directives: {name:string;args:Record<string,Value>}[]; spread?: boolean; condition?: string };
// A small recursive descent parser. Values retain variable references until execution.
class Parser {
  tokens: string[]; index=0;
  fragments: Record<string,Selection>={};
  operations: {name?:string;kind:string;defaults:Record<string,Value>;children:Selection[]}[]=[];
  constructor(source:string){
    this.tokens=[]; const lexer=/\s+|#[^\n\r]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{}|]/gy;
    let offset=0;while(offset<source.length){lexer.lastIndex=offset;const m=lexer.exec(source);if(!m)throw new Error('Invalid GraphQL token');offset=lexer.lastIndex;if(!/^(?:\s|#|,)/.test(m[0]))this.tokens.push(m[0]);}
  }
  peek(){return this.tokens[this.index];}
  take(expected?:string):string{const token=this.tokens[this.index++];if(token===undefined||(expected!==undefined&&token!==expected))throw new Error(`Expected ${expected??'token'}`);return token;}
  value():Value{const t=this.take();if(t==='$')return {variable:this.take()};if(t==='['){const a=[];while(this.peek()!==']')a.push(this.value());this.take(']');return a;}if(t==='{'){const o:Record<string,Value>={};while(this.peek()!=='}'){const k=this.take();this.take(':');o[k]=this.value();}this.take('}');return o;}if(t.startsWith('"'))return JSON.parse(t);if(t==='true'||t==='false'||t==='null')return JSON.parse(t);if(/^-?\d/.test(t))return Number(t);return t;}
  args():Record<string,Value>{const out:Record<string,Value>={};if(this.peek()!=='(')return out;this.take();while(this.peek()!==')'){const key=this.take();this.take(':');out[key]=this.value();}this.take(')');return out;}
  directives(){const out=[];while(this.peek()==='@'){this.take();out.push({name:this.take(),args:this.args()});}return out;}
  selection():Selection[]{this.take('{');const out:Selection[]=[];while(this.peek()!=='}'){
    let name=this.take(),alias:string|undefined,condition:string|undefined,spread=false;
    if(name==='...'){spread=true;name=this.take();if(name==='on'){condition=this.take();name='';}else if(name==='@'||name==='{'){this.index--;name='';}}
    else if(this.peek()===':'){this.take();alias=name;name=this.take();}
    const args=this.args(),directives=this.directives();const children=this.peek()==='{'?this.selection():[];
    out.push({name,alias,args,directives,children,spread,condition});
  }this.take('}');return out;}
  parse(){while(this.peek()){
    if(this.peek()==='fragment'){this.take();const name=this.take();this.take('on');const condition=this.take();const directives=this.directives();this.fragments[name]={name:'',condition,args:{},directives,children:this.selection()};continue;}
    let kind='query',name:string|undefined;const defaults:Record<string,Value>={};
    if(this.peek()!=='{'){kind=this.take();if(!['query','mutation'].includes(kind))throw new Error('Unsupported operation');if(this.peek()!=='('&&this.peek()!=='{')name=this.take();if(this.peek()==='('){this.take();while(this.peek()!==')'){this.take('$');const v=this.take();this.take(':');while(this.peek()&&!['=','$',')'].includes(this.peek()))this.take();if(this.peek()==='='){this.take();defaults[v]=this.value();}}this.take(')');}this.directives();}
    this.operations.push({kind,name,defaults,children:this.selection()});
  }return this;}
}
const fieldLists:Record<string,string[]>={
  Issue:['id','number','title','state','body'],
  PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'],
  Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],
};
const tagged=(type:string,value:Value,repo?:Repo)=>({__type:type,value,repo});
function globalNode(id:string,login:string):Value {
  for(const r of store.listRepos(login)){
    if(id===`R_${r.id}`)return tagged('Repository',r,r);
    for(const i of store.listIssues(r))if(id===`I_${r.id}_${i.number}`)return tagged('Issue',i,r);
    for(const p of store.listPulls(r))if(id===`P_${r.id}_${p.number}`)return tagged('PullRequest',p,r);
  }return null;
}
function connection(items:Value[],a:Value):Value{
  const decoded=typeof a.after==='string'?Buffer.from(a.after,'base64').toString():'';
  const start=/^cursor:\d+$/.test(decoded)?Number(decoded.slice(7))+1:0;
  const end=Math.min(items.length,start+Math.max(0,Number(a.first??100)));
  const nodes=items.slice(start,end),cursor=(i:number)=>Buffer.from(`cursor:${i}`).toString('base64');
  return {nodes,edges:nodes.map((node,i)=>({node,cursor:cursor(start+i)})),pageInfo:{hasNextPage:end<items.length,hasPreviousPage:start>0,endCursor:nodes.length?cursor(end-1):null,startCursor:nodes.length?cursor(start):null}};
}
async function execute(document:Value):Promise<Value>{
  try{
    if(typeof document?.query!=='string')throw new Error('query must be a string');
    const parser=new Parser(document.query).parse();
    const op=document.operationName?parser.operations.find(o=>o.name===document.operationName):parser.operations.length===1?parser.operations[0]:undefined;
    if(!op)throw new Error('Select a valid operationName');
    const vars={...op.defaults,...document.variables};
    const evaluate=(v:Value):Value=>Array.isArray(v)?v.map(evaluate):v&&typeof v==='object'?('variable'in v?vars[v.variable]:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,evaluate(x)]))):v;
    const token=process.env.MAKEFUN_SHOP_TOKEN??'';const login=token.match(/^(?:login|user|github):([A-Za-z0-9][A-Za-z0-9-]*)$/i)?.[1]??'adaiversen';
    const errors:{message:string}[]=[];
    async function resolve(parent:Value,name:string,a:Value):Promise<Value>{
      if(name==='__typename')return parent.__type??'Object';
      const v=parent.value,r:Repo=parent.repo;
      if(parent.__type==='Query'||parent.__type==='Mutation'){
        if(name==='viewer')return {login};
        if(name==='repository'){const repo=String(a.owner).toLowerCase()===login.toLowerCase()?store.getRepo(a.owner,a.name):undefined;return repo?tagged('Repository',repo,repo):null;}
        if(name==='node')return globalNode(a.id,login);
        if(name==='__type')return {name:a.name,fields:fieldLists[a.name]?.map(name=>({name}))??null,enumValues:a.name==='SearchType'?['ISSUE','REPOSITORY','USER'].map(name=>({name})):null};
        if(name==='__schema')return {types:[{name:'SearchType',kind:'ENUM',enumValues:['ISSUE','REPOSITORY','USER'].map(name=>({name}))}],queryType:{name:'Query'},mutationType:{name:'Mutation'}};
        const input=a.input??{};
        if(['createIssue','createPullRequest'].includes(name)){
          const n=globalNode(input.repositoryId,login);if(n?.__type!=='Repository')throw new Error('Repository not found');
          const repo:Repo=n.value,path=`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
          const issue=name==='createIssue';const created=await restCall('POST',`${path}/${issue?'issues':'pulls'}`,{...input,head:input.headRefName,base:input.baseRefName});
          return issue?{issue:tagged('Issue',store.getIssue(repo,created.number),repo)}:{pullRequest:tagged('PullRequest',store.getPull(repo,created.number),repo)};
        }
        if(['closeIssue','mergePullRequest','addComment'].includes(name)){
          const n=globalNode(input.issueId??input.pullRequestId??input.subjectId,login);if(!n)throw new Error('Node not found');
          const repo:Repo=n.repo,path=`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
          if(name==='closeIssue'){await restCall('PATCH',`${path}/issues/${n.value.number}`,{state:'closed'});return {issue:n};}
          if(name==='mergePullRequest'){await restCall('PUT',`${path}/pulls/${n.value.number}/merge`,{merge_method:'squash'});return {pullRequest:n};}
          const comment=await restCall('POST',`${path}/issues/${n.value.number}/comments`,{body:input.body});return {commentEdge:{node:{id:`C_${comment.id}`,body:comment.body}}};
        }
      }else if(parent.__type==='Repository'){
        if(name==='id')return `R_${v.id}`;
        if(name==='databaseId')return v.id;
        if(name==='name')return v.name;
        if(name==='nameWithOwner')return `${v.owner}/${v.name}`;
        if(name==='owner')return {login:v.owner};
        if(name==='defaultBranchRef')return {name:v.defaultBranch};
        if(name==='viewerPermission')return 'ADMIN';
        if(name==='hasIssuesEnabled')return true;
        if(name==='issue'||name==='pullRequest'){const item=name==='issue'?store.getIssue(r,a.number):store.getPull(r,a.number);return item?tagged(name==='issue'?'Issue':'PullRequest',item,r):null;}
        if(name==='issues'){let items=store.listIssues(r);if(a.states)items=items.filter(i=>a.states.includes(i.state.toUpperCase()));items.sort((x,y)=>(a.orderBy?.direction==='DESC'?-1:1)*(x.createdSeq-y.createdSeq||x.number-y.number));return connection(items.map(i=>tagged('Issue',i,r)),a);}
        if(name==='pullRequests')return connection(store.listPulls(r).map(p=>tagged('PullRequest',p,r)),a);
      }else if(parent.__type==='Issue'||parent.__type==='PullRequest'){
        if(name==='id')return `${parent.__type==='Issue'?'I':'P'}_${r.id}_${v.number}`;
        if(name==='state')return v.state.toUpperCase();
        if(['number','title','body','merged'].includes(name))return v[name];
        if(name==='headRefName')return v.head.ref;
        if(name==='baseRefName')return v.base.ref;
        if(name==='mergeable')return 'MERGEABLE';
        if(name==='files')return connection(v.files.map((path:string)=>({path})),a);
      }else if(Object.hasOwn(parent,name))return parent[name];
      throw new Error(`Cannot query field "${name}" on type "${parent.__type??'Object'}".`);
    }
    async function project(parent:Value,selections:Selection[],depth=0):Promise<Value>{
      if(depth>64)throw new Error('Selection depth exceeded');
      if(parent===null||parent===undefined)return null;
      if(Array.isArray(parent))return Promise.all(parent.map(x=>project(x,selections,depth+1)));
      const out:Record<string,Value>={};
      for(const s of selections){
        if(s.directives.some(d=>d.name==='skip'?evaluate(d.args.if)===true:d.name==='include'?evaluate(d.args.if)===false:false))continue;
        if(s.spread){const f=s.name?parser.fragments[s.name]:s;if(!f)throw new Error(`Unknown fragment ${s.name}`);if(!f.condition||f.condition===parent.__type)Object.assign(out,await project(parent,f.children,depth+1));continue;}
        try{const value=await resolve(parent,s.name,evaluate(s.args));out[s.alias??s.name]=s.children.length?await project(value,s.children,depth+1):value;}
        catch(error){errors.push({message:(error as Error).message});out[s.alias??s.name]=null;}
      }return out;
    }
    const data=await project(tagged(op.kind==='mutation'?'Mutation':'Query',null),op.children);return errors.length?{data,errors}:{data};
  }catch(error){return {errors:[{message:(error as Error).message}]};}
}
export function graphqlRouter(req:IncomingMessage,res:ServerResponse,path:string):boolean{
  if(path!=='/api/graphql'||req.method!=='POST')return false;
  void (async()=>{if(!authorized(req)){send(res,401,{message:'Bad credentials'});return;}let body:Value;try{body=await readJson(req);}catch{send(res,400,{message:'Malformed JSON'});return;}send(res,200,Array.isArray(body)?await Promise.all(body.map(execute)):await execute(body));})();return true;
}
