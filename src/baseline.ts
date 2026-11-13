import type {RunState} from './contracts.ts';

/** Preserve retrievable Git provenance without sending local staged/unstaged diff bodies to providers. */
export function baselineContext(state:RunState) {
  const original=typeof state.originalGit==='object'&&state.originalGit!==null?state.originalGit:{};
  const baseline='baselineCommit' in original&&typeof original.baselineCommit==='string'?original.baselineCommit:state.adoptions[0]?.oldHead??state.tasks.find(task=>task.baseCommit)?.baseCommit;
  if('kind' in original&&original.kind==='workspace'&&'components' in original&&Array.isArray(original.components)){
    return {
      workspaceRevision:baseline,
      repositories:original.components.map(component=>({prefix:component.prefix,baselineCommit:component.baselineCommit,originalHead:component.snapshot?.head})),
      instruction:'The workspace revision is an aggregate identity, NOT a Git commit. For read_history use the exact baselineCommit of the component owning the workspace-relative file path (longest prefix wins; empty prefix owns loose files). Repository baselines include original dirty input. Use read for current working-tree bytes.',
    };
  }
  const head='head' in original&&typeof original.head==='string'?original.head:undefined;
  const untracked='untracked' in original&&typeof original.untracked==='object'&&original.untracked!==null?Object.fromEntries(Object.entries(original.untracked).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&/^[a-f0-9]{64}$/.test(entry[1]))):{};
  return {baselineCommit:baseline,originalHead:head,untrackedHashes:untracked,instruction:'Compare original dirty input with read_history({path,commit:baselineCommit}); unlike the original HEAD, this baseline includes user working-tree changes. Use read({path}) for current working-tree bytes. Both file tools return SHA256 for byte identity.'};
}
