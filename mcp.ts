import type { IncomingMessage, ServerResponse } from 'node:http';
import { restCall } from './rest.ts';

const definitions = [
  ['create_repo', 'Create a repository', ['name'], ['name','description','private']],
  ['get_repo', 'Read a repository', ['owner','repo'], ['owner','repo','full_name']],
  ['create_issue', 'Create an issue', ['owner','repo','title'], ['owner','repo','title','body','full_name']],
  ['list_issues', 'List repository issues', ['owner','repo'], ['owner','repo','state','full_name']],
  ['create_pull_request', 'Create a pull request', ['owner','repo','title','head','base'], ['owner','repo','title','head','base','body','full_name']],
  ['merge_pull_request', 'Squash merge a pull request', ['owner','repo','pull_number'], ['owner','repo','pull_number','full_name']],
] as const;
const toolList = definitions.map(([name,description,required,properties]) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(properties.map(p => [p, {type: p === 'private' ? 'boolean' : p === 'pull_number' ? 'integer' : 'string'}])), required } }));
export function authorized(req: IncomingMessage): boolean { const token=process.env.MAKEFUN_SHOP_TOKEN; return !!token && req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] === token; }
export function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
export async function readJson(req: IncomingMessage): Promise<any> { let raw=''; for await(const part of req) raw+=part; return JSON.parse(raw); }
export function mcpRouter(req: IncomingMessage,res: ServerResponse,path: string): boolean {
  if(path!=='/mcp'||req.method!=='POST')return false;
  void handle(req,res); return true;
}
async function handle(req: IncomingMessage,res: ServerResponse): Promise<void> {
  if(!authorized(req)){send(res,401,{message:'Bad credentials'});return;}
  let doc:any; try{doc=await readJson(req);}catch{send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
  const id=doc?.id??null;
  const fail=(code:number,message:string)=>send(res,200,{jsonrpc:'2.0',id,error:{code,message}});
  if(!doc || doc.jsonrpc!=='2.0' || typeof doc.method!=='string'){fail(-32600,'Invalid Request');return;}
  let result:any;
  switch(doc.method){
    case 'server/discover': result={supportedVersions:['2026-07-28','2025-11-25'],serverInfo:{name:'makefun-forge',version:'1.0.0'},capabilities:{tools:{}}};break;
    case 'initialize': result={protocolVersion:'2025-11-25',serverInfo:{name:'makefun-forge',version:'1.0.0'},capabilities:{tools:{}}};break;
    case 'notifications/initialized': res.writeHead(202);res.end();return;
    case 'tools/list': result={tools:toolList};break;
    case 'tools/call': {
      const name=doc.params?.name, tool=toolList.find(t=>t.name===name);
      if(!tool){fail(-32602,'Unknown tool');return;}
      const a={...(doc.params?.arguments??{})};
      if(typeof a.full_name==='string'){const [owner,...repo]=a.full_name.split('/');a.owner??=owner;a.repo??=repo.join('/');}
      if(tool.inputSchema.required.some(k=>a[k]===undefined||a[k]===null||a[k]==='')){fail(-32602,'Missing required argument');return;}
      const path=`/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
      try {
        let value:any;
        if(name==='create_repo')value=await restCall('POST','/user/repos',a);
        else if(name==='get_repo')value=await restCall('GET',path);
        else if(name==='create_issue')value=await restCall('POST',`${path}/issues`,a);
        else if(name==='list_issues')value=await restCall('GET',`${path}/issues?state=${encodeURIComponent(a.state??'open')}`);
        else if(name==='create_pull_request')value=await restCall('POST',`${path}/pulls`,a);
        else value=await restCall('PUT',`${path}/pulls/${a.pull_number}/merge`,{merge_method:'squash'});
        result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};
      }catch(error){result={content:[{type:'text',text:(error as Error).message}],isError:true};}
      break;
    }
    default: fail(-32601,'Method not found');return;
  }
  send(res,200,{jsonrpc:'2.0',id,result});
}
