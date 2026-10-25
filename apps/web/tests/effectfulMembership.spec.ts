import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

const source = `public class Main {
  static int calls;
  static String next(String raw) {
    calls++;
    System.out.print("q"+calls+"="+raw+";");
    if(raw.equals("boom"))throw new IllegalStateException("query");
    return raw.equals("null") ? null : raw;
  }
  public static void main(String[] args) {
    try { search(args); }
    catch(IllegalStateException failure) { System.out.println("caught:"+calls); }
  }
  static void search(String[] queries) {
    java.util.ArrayList<String> allowed=new java.util.ArrayList<>();
    allowed.add("Aa");allowed.add(null);allowed.add("Aa");
    for(String raw:queries) {
      if(raw.equals("skip")) { System.out.print("skip;");continue; }
      boolean found=allowed.contains(next(raw)) || allowed.contains(next("null"));
      System.out.print(found+";");
    }
    System.out.println("calls="+calls);
  }
}`;
// Hand-derived before execution: each q prefix witnesses one actual argument evaluation.
const cases = [
  { id: "zero", argv: [], expectedStdout: "calls=0\n" },
  { id: "skipped", argv: ["skip"], expectedStdout: "skip;calls=0\n" },
  { id: "short-circuit-order-null", argv: ["Aa", "missing", "null", "skip"], expectedStdout: "q1=Aa;true;q2=missing;q3=null;true;q4=null;true;skip;calls=4\n" },
  { id: "throw-first", argv: ["boom"], expectedStdout: "q1=boom;caught:1\n" },
  { id: "throw-stops-later-queries", argv: ["Aa", "boom", "null"], expectedStdout: "q1=Aa;true;q2=boom;caught:2\n" },
  { id: "repeat-count", argv: ["Aa", "Aa"], expectedStdout: "q1=Aa;true;q2=Aa;true;calls=2\n" },
];

async function done(request: APIRequestContext, base: string, id: string) {
  let job: any;
  await expect.poll(async () => {
    job=(await (await request.get(base+"/jobs/"+id)).json()).data;
    return job.status;
  }, { timeout: 240000 }).toMatch(/^(succeeded|failed|cancelled)$/);
  expect(job.status,JSON.stringify(job)).toBe("succeeded");
  return job;
}

test("effectful membership query preserves exact counter exception null and short-circuit observations", async ({ request }, info) => {
  test.setTimeout(480000);
  const created=await request.post("/api/v1/projects",{headers:await headers(request),data:{name:"Effectful membership "+crypto.randomUUID()}});
  expect(created.status()).toBe(201);
  const base="/api/v1/projects/"+(await created.json()).data.id;
  const saved=await request.post(base+"/revisions",{headers:await headers(request,"empty"),data:{files:[{path:"Main.java",content:source}],intent:"semantic_edit"}});
  expect(saved.status()).toBe(201);
  const original=(await saved.json()).data;
  const analyzing=await request.post(base+"/revisions/"+original.id+"/analysis",{headers:await headers(request),data:{}});
  expect(analyzing.status()).toBe(202);
  await done(request,base,(await analyzing.json()).data.id);
  const analysis=(await (await request.get(base+"/revisions/"+original.id+"/analysis")).json()).data;
  expect(analysis.optimizations).toHaveLength(1);
  const opportunity=analysis.optimizations[0];
  expect(opportunity).toMatchObject({ruleId:"OPT-MEMBERSHIP-001",ruleVersion:"3",querySites:2});
  const preparing=await request.post(base+"/changes",{headers:await headers(request),data:{baseRevisionId:original.id,analysisId:analysis.id,
    methodId:opportunity.methodId,nodeId:opportunity.nodeId,operation:"optimize_membership",payload:{},intent:"preserve_behavior"}});
  expect(preparing.status()).toBe(202);
  const pending=(await preparing.json()).data;
  await done(request,base,pending.jobId);
  const proposal=(await (await request.get(base+"/changes/"+pending.id)).json()).data;
  expect(proposal.checks.compileStatus).toBe("passed");
  const candidate=(await (await request.get(base+"/revisions/"+proposal.candidateRevisionId)).json()).data;
  const text=candidate.files.find((file:any)=>file.path==="Main.java").canonicalText;
  expect(text).toContain('boolean found=jbMembership.contains(next(raw)) || jbMembership.contains(next("null"));');
  expect(text.match(/next\(/g)).toHaveLength(source.match(/next\(/g)!.length);
  expect((await head(request,base)).id).toBe(original.id);
  const premature=await request.post(base+"/head",{headers:await headers(request,original.id),data:{expectedHeadRevisionId:original.id,
    proposalId:pending.id,candidateRevisionId:proposal.candidateRevisionId}});
  expect(premature.status()).toBeGreaterThanOrEqual(400);
  const suite=await request.post(base+"/test-suites",{headers:await headers(request),data:{mode:"console",entryPoint:"Main",comparisonPolicyId:"exact-v1",
    cases:cases.map(item=>({stdinUtf8:"",expectedStderr:"",expectedExitCode:0,...item}))}});
  expect(suite.status()).toBe(201);
  const comparing=await request.post(base+"/comparisons",{headers:await headers(request),data:{baseRevisionId:original.id,candidateRevisionId:proposal.candidateRevisionId,
    suiteVersionId:(await suite.json()).data.id,profileId:"java21-v1"}});
  expect(comparing.status()).toBe(202);
  const report=(await done(request,base,(await comparing.json()).data.id)).result.report;
  expect(report).toMatchObject({outcome:"matched_on_tests",coverageComplete:true,matched:cases.length});
  for(const row of report.testResults){expect(row.baseExecutions).toHaveLength(3);expect(row.candidateExecutions).toHaveLength(3);}
  const applied=await request.post(base+"/head",{headers:await headers(request,original.id),data:{expectedHeadRevisionId:original.id,proposalId:pending.id,
    candidateRevisionId:proposal.candidateRevisionId,verificationReportId:report.id}});
  expect(applied.ok()).toBe(true);
  expect((await head(request,base)).id).toBe(proposal.candidateRevisionId);
  await info.attach("effectful-membership-report",{body:JSON.stringify({cases,proposal,report}),contentType:"application/json"});
});
