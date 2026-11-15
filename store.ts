import { createHash } from 'node:crypto';

export type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer };
export type Repo = { id: number; name: string; owner: string; description: string; private: boolean; defaultBranch: string; createdSeq: number; refs: Map<string, string>; objects: Map<string, GitObject>; files: Map<string, Map<string, string>>; commits: Map<string, { parent: string | null; message: string; tree: Map<string, string> }> };
export type Label = { name: string; color: string; description: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed'; labels: Label[]; comments: { id: number; body: string; createdSeq: number }[]; createdSeq: number; updatedSeq: number };
export type Pull = { number: number; title: string; body: string; state: 'open' | 'closed' | 'merged'; head: { ref: string; sha: string }; base: { ref: string; sha: string }; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; createdSeq: number; files: string[] };

export class ForgeStore {
  private sequence = 0;
  private repoId = 0;
  private readonly repos = new Map<string, Repo>();
  private readonly issues = new Map<Repo, Map<number, Issue>>();
  private readonly issueCounters = new Map<Repo, number>();
  private readonly labels = new Map<Repo, Map<string, Label>>();
  private readonly pulls = new Map<Repo, Map<number, Pull>>();
  private readonly pullCounters = new Map<Repo, number>();
  nextSeq(): number { return ++this.sequence; }
  key(owner: string, name: string): string { return `${owner.toLowerCase()}/${name.toLowerCase()}`; }
  createRepo(owner: string, name: string, description = '', isPrivate = true, defaultBranch = 'main'): Repo {
    const key = this.key(owner, name);
    const existing = this.repos.get(key);
    if (existing) throw new Error('already exists');
    const repo: Repo = { id: ++this.repoId, name, owner, description, private: isPrivate, defaultBranch, createdSeq: this.nextSeq(), refs: new Map(), objects: new Map(), files: new Map(), commits: new Map() };
    repo.files.set(defaultBranch, new Map());
    this.repos.set(key, repo); this.issues.set(repo, new Map()); this.issueCounters.set(repo, 0); this.labels.set(repo, new Map()); this.pulls.set(repo, new Map()); this.pullCounters.set(repo, 0);
    return repo;
  }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  deleteRepo(repo: Repo): void { this.repos.delete(this.key(repo.owner, repo.name)); }
  listRepos(owner: string): Repo[] { return [...this.repos.values()].filter((r) => r.owner.toLowerCase() === owner.toLowerCase()).sort((a,b) => a.createdSeq-b.createdSeq); }
  deleteFile(repo: Repo, branch: string, path: string): boolean { const files = repo.files.get(branch); if (!files?.has(path)) return false; files.delete(path); return true; }
  branchFiles(repo: Repo, branch: string): Map<string,string> { let files=repo.files.get(branch); if (!files) { files=new Map(); repo.files.set(branch, files); } return files; }
  addObject(repo: Repo, type: GitObject['type'], data: Buffer): string { const raw=Buffer.concat([Buffer.from(`${type} ${data.length}\0`),data]); const sha=createHash('sha1').update(raw).digest('hex'); if (!repo.objects.has(sha)) repo.objects.set(sha,{type,data}); return sha; }
  commit(repo: Repo, branch: string, message: string, files: Map<string,string>, parent: string | null): string {
    const root = new Map<string, unknown>();
    for (const [path, blob] of files) {
      const parts=path.split('/'); let node=root;
      for (const part of parts.slice(0,-1)) { let child=node.get(part); if (!(child instanceof Map)) { child=new Map(); node.set(part,child); } node=child as Map<string,unknown>; }
      node.set(parts.at(-1)!,blob);
    }
    const buildTree=(node: Map<string,unknown>): string => {
      const entries: Buffer[]=[];
      for (const [name,value] of [...node].sort(([a,av],[b,bv])=>Buffer.compare(Buffer.from(a+(av instanceof Map?'/':'')),Buffer.from(b+(bv instanceof Map?'/':''))))) {
        const directory=value instanceof Map; const sha=directory ? buildTree(value as Map<string,unknown>) : String(value);
        entries.push(Buffer.from(`${directory?'40000':'100644'} ${name}\0`),Buffer.from(sha,'hex'));
      }
      return this.addObject(repo,'tree',Buffer.concat(entries));
    };
    const tree=buildTree(root);
    const data=Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Forge <forge@localhost> 0 +0000\ncommitter Forge <forge@localhost> 0 +0000\n\n${message}\n`);
    const sha=this.addObject(repo,'commit',data);
    repo.commits.set(sha,{parent,message,tree:new Map(files)}); repo.files.set(branch,new Map(files)); repo.refs.set(`refs/heads/${branch}`,sha); return sha;
  }
  addIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue { const number=(this.issueCounters.get(repo) ?? 0)+1; this.issueCounters.set(repo,number); const seq=this.nextSeq(); const issue: Issue={number,title,body,state:'open',labels,comments:[],createdSeq:seq,updatedSeq:seq}; this.issues.get(repo)!.set(number,issue); return issue; }
  getIssue(repo: Repo,n: number): Issue | undefined { return this.issues.get(repo)?.get(n); }
  listIssues(repo: Repo): Issue[] { return [...(this.issues.get(repo)?.values() ?? [])]; }
  addLabel(repo: Repo,label: Label): void { this.labels.get(repo)!.set(label.name.toLowerCase(),label); }
  getLabel(repo: Repo,name: string): Label | undefined { return this.labels.get(repo)?.get(name.toLowerCase()); }
  addPull(repo: Repo, pull: Omit<Pull,'number'|'createdSeq'>): Pull { const number=(this.pullCounters.get(repo) ?? 0)+1; this.pullCounters.set(repo,number); const result={...pull,number,createdSeq:this.nextSeq()}; this.pulls.get(repo)!.set(number,result); return result; }
  getPull(repo: Repo,n: number): Pull | undefined { return this.pulls.get(repo)?.get(n); }
  listPulls(repo: Repo): Pull[] { return [...(this.pulls.get(repo)?.values() ?? [])]; }
}

export const store = new ForgeStore();
