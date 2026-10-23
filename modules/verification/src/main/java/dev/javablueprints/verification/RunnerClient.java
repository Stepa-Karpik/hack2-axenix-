package dev.javablueprints.verification;

import static dev.javablueprints.verification.RunnerProtocol.*;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.io.*;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Service-only client; executions run exclusively in the remote isolated controller. */
public final class RunnerClient {
    private final URI endpoint;
    private final String token;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    public RunnerClient(URI endpoint, String token) { this.endpoint = endpoint; this.token = token; }
    public boolean available() { try { return request("GET", "/internal/v1/health", null, Map.of(), Map.class).get("available").equals(Boolean.TRUE); } catch (Exception e) { return false; } }
    public Observation execute(String projectId, String jobId, String attemptId, long fence, Spec spec) throws IOException, InterruptedException {
        return execute(projectId, jobId, attemptId, fence, spec, () -> false);
    }
    public Observation execute(String projectId, String jobId, String attemptId, long fence, Spec spec, BooleanSupplier cancelled) throws IOException, InterruptedException {
        String executionId = UUID.randomUUID().toString();
        Submit submit = new Submit(projectId, jobId, attemptId, executionId, spec.hash(), fence, Instant.now().plusSeconds(90).toString(), spec);
        Map<String,String> ownership = Map.of("X-Project-Id",projectId,"X-Job-Id",jobId,"X-Attempt-Id",attemptId,"X-Spec-Hash",spec.hash(),"X-Fencing-Token",Long.toString(fence));
        Observation result = request("POST", "/internal/v1/executions", submit, Map.of("Idempotency-Key",jobId + ":" + attemptId + ":" + executionId), Observation.class);
        long deadline = System.nanoTime() + Duration.ofSeconds(80).toNanos();
        boolean cancellationSent=false;
        while (!result.status().equals("terminal")) {
            if ((cancelled.getAsBoolean() && !cancellationSent) || System.nanoTime() > deadline) {
                if(cancellationSent) throw new IOException("Runner cancellation unconfirmed; cleanup pending");
                request("POST", "/internal/v1/executions/" + executionId + "/cancel", Map.of(), ownership, Observation.class);
                cancellationSent=true;deadline=System.nanoTime()+Duration.ofSeconds(15).toNanos();
            }
            Thread.sleep(80);
            result = request("GET", "/internal/v1/executions/" + executionId, null, ownership, Observation.class);
        }
        if (!result.projectId().equals(projectId) || !result.jobId().equals(jobId) || !result.attemptId().equals(attemptId) || !result.executionId().equals(executionId) || !result.specHash().equals(spec.hash())) throw new IOException("Runner result ownership mismatch");
        result.stdout().decode(MAX_OUTPUT); result.stderr().decode(MAX_OUTPUT);
        if (result.stdout().length() + result.stderr().length() > MAX_OUTPUT) throw new IOException("Runner result output ceiling");
        return result;
    }
    public static Spec compileSpec(Map<String,String> sources) { var encoded = new TreeMap<String,Bytes>(); sources.forEach((p,s) -> encoded.put(p,Bytes.text(s))); return new Spec(PROFILE,Phase.compile,encoded,null,null,List.of(),Bytes.of(new byte[0]),null,0); }
    public static Spec runtimeSpec(String artifactId,String mainClass,TestCase c,int observation) { return new Spec(PROFILE,Phase.runtime,Map.of(),artifactId,mainClass,c.args(),Bytes.text(c.stdin()),c.id(),observation); }
    public Comparison compare(String projectId,String jobId,String attemptId,long fence,Map<String,String> baseline,Map<String,String> candidate,String mainClass,List<TestCase> cases) throws InterruptedException {
        return compare(projectId,jobId,attemptId,fence,baseline,candidate,mainClass,cases,()->false);
    }
    public Comparison compare(String projectId,String jobId,String attemptId,long fence,Map<String,String> baseline,Map<String,String> candidate,String mainClass,List<TestCase> cases,BooleanSupplier cancelled) throws InterruptedException {
        if(cases.isEmpty() || cases.size()>100) throw new IllegalArgumentException("Suite must contain 1..100 cases");
        Observation bc = null, cc = null;
        var results=new ArrayList<TestResult>();
        String currentCase=null;var partialBase=new ArrayList<Observation>();var partialCandidate=new ArrayList<Observation>();
        try {
            if(!available()) return unavailable(cases.size());
            bc = execute(projectId,jobId,attemptId,fence,compileSpec(baseline),cancelled);
            if(bc.cleanupPending())return new Comparison(ComparisonOutcome.inconclusive,"cleanup_pending",false,3,0,0,0,cases.size(),List.of(),bc,null);
            cc = execute(projectId,jobId,attemptId,fence,compileSpec(candidate),cancelled);
            if(bc.cleanupPending()||cc.cleanupPending())return new Comparison(ComparisonOutcome.inconclusive,"cleanup_pending",false,3,0,0,0,cases.size(),List.of(),bc,cc);
            if(bc.outcome()!=ExecutionOutcome.exited || cc.outcome()!=ExecutionOutcome.exited) {
                boolean error = bc.outcome()==ExecutionOutcome.compile_error || cc.outcome()==ExecutionOutcome.compile_error;
                return new Comparison(error?ComparisonOutcome.compile_error:ComparisonOutcome.inconclusive,error?"compile_error":"compile_execution_limit",false,3,0,0,0,cases.size(),List.of(),bc,cc);
            }
            for(var c:cases) {
                currentCase=c.id();var b=new ArrayList<Observation>(); var d=new ArrayList<Observation>();partialBase=b;partialCandidate=d;
                for(int i=1;i<=3;i++) { b.add(execute(projectId,jobId,attemptId,fence,runtimeSpec(bc.compileArtifactId(),mainClass,c,i),cancelled)); d.add(execute(projectId,jobId,attemptId,fence,runtimeSpec(cc.compileArtifactId(),mainClass,c,i),cancelled)); if(cancelled.getAsBoolean()) break; }
                results.add(new TestResult(c.id(),List.copyOf(b),List.copyOf(d),false));
                currentCase=null;
                if(cancelled.getAsBoolean()) break;
            }
            return Comparator.compare(cases,results,bc,cc);
        } catch(IOException e) {
            if(currentCase!=null)results.add(new TestResult(currentCase,partialBase,partialCandidate,false));
            if(results.isEmpty())return new Comparison(ComparisonOutcome.unavailable,"runner_unavailable",false,3,0,0,0,cases.size(),List.of(),bc,cc);
            return Comparator.compare(cases,results,bc,cc);
        }
    }
    private static Comparison unavailable(int count) { return new Comparison(ComparisonOutcome.unavailable,"runner_unavailable",false,3,0,0,0,count,List.of(),null,null); }
    private <T> T request(String method,String path,Object body,Map<String,String> headers,Class<T> type) throws IOException,InterruptedException {
        var builder=HttpRequest.newBuilder(endpoint.resolve(path)).timeout(Duration.ofSeconds(15)).header("Authorization","Bearer "+token).header("Content-Type","application/json");
        headers.forEach(builder::header);
        builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body)));
        var response=http.send(builder.build(),HttpResponse.BodyHandlers.ofInputStream());
        try(var stream=response.body()) {
            byte[] bytes=stream.readNBytes(4*1024*1024+1);
            if(response.statusCode()<200 || response.statusCode()>=300 || bytes.length>4*1024*1024) throw new IOException("Runner transport status "+response.statusCode());
            return JSON.readValue(bytes,type);
        }
    }
}
