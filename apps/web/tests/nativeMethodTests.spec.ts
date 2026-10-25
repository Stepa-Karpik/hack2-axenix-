import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// No main method. All fixture compilation/invocation is delegated to the isolated Linux runner.
const source=`public class Target {
  public static int choose(int value) { return value + 1; }
  public static long choose(long value) { return value + 2; }
  private static int hidden(int value) { return value; }
  public int instance(int value) { return value; }
  public static String contract(int mode, int[] values) throws Exception {
    values[0] += 3;
    if(mode==0)return "ok:"+values[0];
    Exception body=new Exception("body",new IllegalArgumentException("root"));
    body.addSuppressed(new IllegalStateException("first"));body.addSuppressed(new RuntimeException("second"));
    if(mode==1)throw body;
    if(mode==2) {try {throw body;}finally {throw new IllegalStateException("replacement",new RuntimeException("cause"));}}
    if(mode==3){System.exit(0);return "unreachable";}
    if(mode==5)throw new MessageEffect(values);
    Exception a=new Exception("a"),b=new Exception("b");a.initCause(b);b.initCause(a);throw a;
  }
  public static class MessageEffect extends Exception {
    final int[] input;
    MessageEffect(int[] input){this.input=input;}
    public String getMessage(){input[0]=99;System.out.print("metadata;");return "meta";}
  }
}
`;
const error=(type:string,message:string,cause:any=null,suppressed:any[]=[])=>({type,message,cause,suppressed});
const oracle=(completion:string,returnValue:any,exception:any,argumentsAfter:any[])=>({complete:true,completion,returnValue,exception,argumentsAfter});
async function finished(request:APIRequestContext,base:string,id:string){let job:any;await expect.poll(async()=>{job=(await(await request.get(base+"/jobs/"+id)).json()).data;return job.status;},{timeout:300000}).toMatch(/^(succeeded|failed|cancelled)$/);expect(job.status,JSON.stringify(job)).toBe("succeeded");return job;}
async function fixture(request:APIRequestContext){const made=await request.post("/api/v1/projects",{headers:await headers(request),data:{name:"Native method tests "+crypto.randomUUID()}});expect(made.status()).toBe(201);const base="/api/v1/projects/"+(await made.json()).data.id;const saved=await request.post(base+"/revisions",{headers:await headers(request,"empty"),data:{files:[{path:"Target.java",content:source}],intent:"semantic_edit"}});expect(saved.status()).toBe(201);return {base,revision:(await saved.json()).data};}
async function compare(request:APIRequestContext,f:any,methodName:string,parameterTypes:string[],cases:any[]){
  const target={ownerType:"Target",methodName,parameterTypes};
  const created=await request.post(f.base+"/test-suites",{headers:await headers(request),data:{mode:"method",comparisonPolicyId:"method-v1",revisionId:f.revision.id,target,cases:cases.map(row=>({expectedStdout:"",expectedStderr:"",...row}))}});expect(created.status(),await created.text()).toBe(201);const suite=(await created.json()).data;
  const submitted=await request.post(f.base+"/comparisons",{headers:await headers(request),data:{baseRevisionId:f.revision.id,candidateRevisionId:f.candidateRevisionId??f.revision.id,suiteVersionId:suite.id,profileId:"java21-v1"}});expect(submitted.status()).toBe(202);const job=await finished(request,f.base,(await submitted.json()).data.id);return {suite,report:job.result.report??(await(await request.get(f.base+"/comparisons/"+job.result.comparisonId)).json()).data};
}

test("native selected method runs without main with return array mutation cause suppressed and finally contracts",async({request},info)=>{
  test.setTimeout(420000);const f=await fixture(request);
  const discovery=await request.get(f.base+"/revisions/"+f.revision.id+"/method-targets");expect(discovery.status()).toBe(200);const targets=(await discovery.json()).data.targets;
  expect(targets.find((v:any)=>v.methodName==="hidden")).toMatchObject({supported:false,reason:"method_not_public"});expect(targets.find((v:any)=>v.methodName==="instance")).toMatchObject({supported:true,receiver:"fresh_no_arg_instance"});
  const cases=[
    {id:"returns-and-mutates",arguments:[0,[4]],expectedMethodResult:oracle("return","ok:7",null,[0,[7]])},
    {id:"cause-and-ordered-suppressed",arguments:[1,[4]],expectedMethodResult:oracle("throw",null,error("java.lang.Exception","body",error("java.lang.IllegalArgumentException","root"),[error("java.lang.IllegalStateException","first"),error("java.lang.RuntimeException","second")]),[1,[7]])},
    {id:"finally-replaces-original",arguments:[2,[4]],expectedMethodResult:oracle("throw",null,error("java.lang.IllegalStateException","replacement",error("java.lang.RuntimeException","cause")),[2,[7]])},
    {id:"snapshot-before-metadata-accessor",arguments:[5,[4]],expectedStdout:"metadata;",expectedMethodResult:oracle("throw",null,error("Target$MessageEffect","meta"),[5,[7]])},
  ];await info.attach("pre-execution-independent-method-contract",{body:JSON.stringify({source,cases}),contentType:"application/json"});
  const result=await compare(request,f,"contract",["int","int[]"],cases);await info.attach("actual-native-method-report",{body:JSON.stringify(result),contentType:"application/json"});
  expect(result.report).toMatchObject({mode:"method",comparisonPolicyId:"method-v1",harnessVersion:"method-v1",outcome:"matched_on_tests",coverageComplete:true,observedRepeatCounts:{base:12,candidate:12}});
  for(const row of result.report.testResults){const contract=cases.find(c=>c.id===row.caseId)!;expect(row.baseExecutions).toHaveLength(3);expect(row.candidateExecutions).toHaveLength(3);for(const observed of [...row.baseExecutions,...row.candidateExecutions])expect(observed).toMatchObject({outcome:"exited",exitCode:0,stdoutUtf8:contract.expectedStdout??"",stderrUtf8:"",methodResult:contract.expectedMethodResult});}
  expect((await head(request,f.base)).id).toBe(f.revision.id);
});

test("native method overload selection is exact and long string adapters preserve values beyond JS safe integers",async({request},info)=>{
  test.setTimeout(420000);const f=await fixture(request);
  const a=await compare(request,f,"choose",["int"],[{id:"int",arguments:[5],expectedMethodResult:oracle("return",6,null,[5])}]);expect(a.report.outcome).toBe("matched_on_tests");
  const b=await compare(request,f,"choose",["long"],[{id:"long",arguments:["9007199254740993"],expectedMethodResult:oracle("return","9007199254740995",null,["9007199254740993"])}]);expect(b.report.outcome).toBe("matched_on_tests");
  const raw=b.report.testResults[0].baseExecutions[0].methodResultRaw;expect(raw).toContain('"returnValue":9007199254740995');expect(raw).toContain('"argumentsAfter":[9007199254740993]');
  const bad=await request.post(f.base+"/test-suites",{headers:await headers(request),data:{mode:"method",comparisonPolicyId:"method-v1",revisionId:f.revision.id,target:{ownerType:"Target",methodName:"choose",parameterTypes:["short"]},cases:[{id:"bad",arguments:[1]}]}});expect(bad.status()).toBe(422);
  await info.attach("actual-exact-overloads",{body:JSON.stringify({a,b}),contentType:"application/json"});
});

test("System.exit and exception cause cycles produce incomplete method observations instead of false matches",async({request},info)=>{
  test.setTimeout(420000);const f=await fixture(request);const result=await compare(request,f,"contract",["int","int[]"],[{id:"exit-before-channel",arguments:[3,[4]]},{id:"exception-cycle",arguments:[4,[4]]}]);
  await info.attach("missing-and-incomplete-native-channel",{body:JSON.stringify(result),contentType:"application/json"});expect(result.report.outcome).toBe("inconclusive");expect(result.report.coverageComplete).toBe(false);expect(result.report.inconclusiveReasons).toContain("method_result_missing_or_incomplete");expect(result.report.observedRepeatCounts).toEqual({base:6,candidate:6});
});

test("native method report gates an exact detached source proposal and CAS while an unrelated current-version report cannot apply it",async({request},info)=>{
  test.setTimeout(480000);const f=await fixture(request);
  const started=await request.post(f.base+"/revisions/"+f.revision.id+"/analysis",{headers:await headers(request),data:{}});expect(started.status()).toBe(202);await finished(request,f.base,(await started.json()).data.id);
  const analysis=(await(await request.get(f.base+"/revisions/"+f.revision.id+"/analysis")).json()).data;
  const node=analysis.graph.nodes.find((value:any)=>value.kind==="expression"&&value.sourceRange?.filePath==="Target.java"&&source.slice(value.sourceRange.startOffset,value.sourceRange.endOffset)==="value + 1");expect(node).toBeTruthy();
  const pending=await request.post(f.base+"/changes",{headers:await headers(request),data:{baseRevisionId:f.revision.id,analysisId:analysis.id,methodId:node.methodId,nodeId:node.id,operation:"replace_expression",payload:{field:"expression",source:"value + 0 + 1"},intent:"preserve_behavior"}});expect(pending.status()).toBe(202);const queued=(await pending.json()).data;await finished(request,f.base,queued.jobId);const proposal=(await(await request.get(f.base+"/changes/"+queued.id)).json()).data;expect(proposal.checks.compileStatus).toBe("passed");
  const cases=[{id:"zero",arguments:[0],expectedMethodResult:oracle("return",1,null,[0])},{id:"negative",arguments:[-1],expectedMethodResult:oracle("return",0,null,[-1])}];
  const wrong=await compare(request,f,"choose",["int"],cases);
  const rejected=await request.post(f.base+"/head",{headers:await headers(request,f.revision.id),data:{expectedHeadRevisionId:f.revision.id,proposalId:proposal.id,candidateRevisionId:proposal.candidateRevisionId,verificationReportId:wrong.report.id}});expect(rejected.status()).toBe(409);expect((await head(request,f.base)).id).toBe(f.revision.id);
  const exact=await compare(request,{...f,candidateRevisionId:proposal.candidateRevisionId},"choose",["int"],cases);expect(exact.report.outcome).toBe("matched_on_tests");expect(exact.report.mode).toBe("method");expect(exact.report.methodHarnessSourceHashes.base).toMatch(/^[a-f0-9]{64}$/);
  const applied=await request.post(f.base+"/head",{headers:await headers(request,f.revision.id),data:{expectedHeadRevisionId:f.revision.id,proposalId:proposal.id,candidateRevisionId:proposal.candidateRevisionId,verificationReportId:exact.report.id}});expect(applied.status(),await applied.text()).toBe(200);expect((await head(request,f.base)).id).toBe(proposal.candidateRevisionId);
  expect((await(await request.get(f.base+"/revisions/"+f.revision.id)).json()).data.files[0].canonicalText).toBe(source);
  await info.attach("native-exact-report-apply-gate",{body:JSON.stringify({proposal,wrong,exact}),contentType:"application/json"});
});
