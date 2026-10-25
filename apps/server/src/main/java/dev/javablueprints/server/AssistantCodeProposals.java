package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import java.util.*;

/** Exact bounded text edits produce ordinary detached proposals; never move project head. */
final class AssistantCodeProposals {
  final Workspace w;
  AssistantCodeProposals(Workspace w) { this.w=w; }

  static void requireEditor(Workspace w,String actor,String project) {
    var rows=w.db.queryForList("SELECT owner_id::text FROM projects WHERE id=?",uuid(project));
    if(rows.isEmpty()) throw missing();
    if(actor.equals(rows.getFirst().get("owner_id"))) return;
    if(w.db.queryForList("SELECT account_id FROM project_members WHERE project_id=? AND account_id=? AND role='editor'",uuid(project),uuid(actor)).isEmpty())
      throw new ApiError(403,"EDIT_REQUIRED","Project editor access required");
  }

  static Map<String,String> replacement(Workspace w,String project,Map<String,Object> args) {
    var revision=w.revision(project,str(args,"baseRevisionId"));
    var files=new LinkedHashMap<String,String>();
    for(Object v:(List<?>)revision.get("files")) {
      var f=(Map<?,?>)v; files.put(f.get("path").toString(),f.get("canonicalText").toString());
    }
    String path=str(args,"filePath"),source=files.get(path);
    int start=AssistantActions.offset(args,"startOffset"),end=AssistantActions.offset(args,"endOffset");
    if(source==null || end<start || end>source.length() || !source.substring(start,end).equals(args.get("expectedText"))) throw AssistantService.stale();
    if((start>0 && start<source.length() && Character.isLowSurrogate(source.charAt(start)) && Character.isHighSurrogate(source.charAt(start-1)))
        || (end>0 && end<source.length() && Character.isLowSurrogate(source.charAt(end)) && Character.isHighSurrogate(source.charAt(end-1)))) throw AssistantActions.invalid();
    String after=source.substring(0,start)+AssistantActions.source(args,"replacement")+source.substring(end);
    if(after.equals(source)) throw AssistantActions.invalid();
    files.put(path,after);
    return files;
  }

  Map<String,Object> prepare(String actor,String project,Map<String,Object> args) {
    requireEditor(w,actor,project);
    String base=str(args,"baseRevisionId");
    if(!base.equals(w.project(project).get("headRevisionId"))) throw AssistantService.stale();
    var original=w.revision(project,base);
    var files=replacement(w,project,args);
    var candidate=w.save(project,base,files,Map.of(),(Collection<String>)original.getOrDefault("directories",List.of()),"assistant_edit",str(args,"intent"),false);
    String id=id();
    var job=w.enqueue(project,"compile",map("revisionId",candidate.get("id"),"profileId","java21-v1"));
    var proposal=map("id",id,"proposalId",id,"projectId",project,"baseRevisionId",base,
        "candidateRevisionId",candidate.get("id"),"intent",args.get("intent"),"origin","assistant_edit",
        "status","queued","jobId",job.get("id"),"createdAt",java.time.Instant.now().toString(),
        "checks",map("parseStatus","not_checked","compileStatus","queued","verificationStatus","not_run"),
        "diff",List.of(map("filePath",args.get("filePath"),"before",args.get("expectedText"),"after",args.get("replacement"),"startOffset",args.get("startOffset"),"endOffset",args.get("endOffset"))));
    w.putResource(project,id,"proposal",proposal);
    return proposal;
  }

  Map<String,Object> refresh(String actor,String project,String id) {
    return w.tx.execute(tx->{
      requireEditor(w,actor,project);
      w.db.queryForList("SELECT id FROM resources WHERE project_id=? AND id=? AND kind='proposal' FOR UPDATE",uuid(project),uuid(id));
      var proposal=w.resource(project,id,"proposal");
      if(!"assistant_edit".equals(proposal.get("origin"))) throw AssistantActions.invalid();
      if(!Set.of("queued","running").contains(proposal.get("status"))) return proposal;
      var job=w.job(project,str(proposal,"jobId"));
      String status=str(job,"status");
      if(Set.of("queued","running").contains(status)) return proposal;
      boolean passed=false;
      Object result=job.get("result");
      if(status.equals("succeeded") && "compile".equals(job.get("type")) && job.get("cancelRequestedAt")==null
          && Objects.equals(proposal.get("candidateRevisionId"),job.get("revisionId"))
          && result instanceof Map<?,?> r && "compilation".equals(r.get("resultKind"))
          && Objects.equals(proposal.get("candidateRevisionId"),r.get("revisionId")) && "java21-v1".equals(r.get("executionProfileId"))
          && r.get("execution") instanceof Map<?,?> execution) {
        passed="compile".equals(execution.get("phase")) && "exited".equals(execution.get("outcome"))
            && execution.get("exitCode") instanceof Number n && n.intValue()==0
            && Boolean.FALSE.equals(execution.get("truncated")) && Boolean.FALSE.equals(execution.get("cleanupPending"))
            && Objects.equals(job.get("id"),execution.get("jobId")) && Objects.equals(job.get("attemptId"),execution.get("attemptId"));
        proposal.put("compileExecution",execution);
      }
      proposal.put("status",passed?"ready":"rejected");
      proposal.put("checks",map("parseStatus","not_checked","compileStatus",passed?"passed":"failed","verificationStatus","not_run"));
      w.updateResource(project,id,"proposal",proposal);
      return proposal;
    });
  }
}
