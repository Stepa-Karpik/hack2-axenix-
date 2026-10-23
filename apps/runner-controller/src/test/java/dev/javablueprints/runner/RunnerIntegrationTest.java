package dev.javablueprints.runner;

import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;
import dev.javablueprints.verification.RunnerClient;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.nio.file.*;

@EnabledIfEnvironmentVariable(named="JB_RUNNER_INTEGRATION",matches="true")
class RunnerIntegrationTest {
    private static RunnerController controller;
    private static RunnerClient client;
    private static final String TOKEN=System.getenv().getOrDefault("JB_RUNNER_TEST_TOKEN",UUID.randomUUID().toString()+UUID.randomUUID());
    private static URI endpoint;
    @BeforeAll static void start()throws Exception{if(System.getenv("JB_RUNNER_TEST_URL")!=null){endpoint=URI.create(System.getenv("JB_RUNNER_TEST_URL"));}else{controller=new RunnerController(new InetSocketAddress("127.0.0.1",0),TOKEN,new DockerSandbox("test-"+UUID.randomUUID()));controller.start();endpoint=URI.create("http://127.0.0.1:"+controller.port());}client=new RunnerClient(endpoint,TOKEN);assertTrue(client.available(),"Real enforcing engine required");}
    @AfterAll static void stop(){if(controller!=null)controller.close();}
    private Comparison compare(String left,String right,TestCase test)throws Exception{return client.compare("project",UUID.randomUUID().toString(),UUID.randomUUID().toString(),1,Map.of("Main.java",left),Map.of("Main.java",right),"Main",List.of(test));}
    @Test void realCompileAndThreeIndependentRunsPreserveUnicodeAndEof()throws Exception{String source="public class Main {public static void main(String[] a)throws Exception{System.out.write(System.in.readAllBytes());System.err.print(\"err\");}}";var result=compare(source,source,new TestCase("unicode","Привет\n",List.of(),0,"Привет\n","err"));evidence("debug-matched",result);assertEquals(ComparisonOutcome.matched_on_tests,result.outcome());assertEquals(3,result.observedBaseCount());assertEquals(3,result.observedCandidateCount());evidence("matched",result);}
    @Test void realMismatchCompileFailureAndTimeout()throws Exception{String left="public class Main {public static void main(String[] a){System.out.print(1);}}";String right=left.replace("print(1)","print(2)");var mismatch=compare(left,right,new TestCase("zero","",List.of(),0,null,null));evidence("debug-mismatch",mismatch);assertEquals(ComparisonOutcome.mismatch,mismatch.outcome());evidence("mismatch",mismatch);var failure=compare(left,"public class Main { syntax error }",new TestCase("zero","",List.of(),0,null,null));assertEquals(ComparisonOutcome.compile_error,failure.outcome());evidence("compile-error",failure);var compile=client.execute("project","timeout-job","timeout-attempt",1,RunnerClient.compileSpec(Map.of("Main.java","public class Main {public static void main(String[] a){while(true){}}}")));var timeout=client.execute("project","timeout-job","timeout-attempt",1,RunnerClient.runtimeSpec(compile.compileArtifactId(),"Main",new TestCase("loop","",List.of(),null,null,null),1));assertEquals(ExecutionOutcome.timeout,timeout.outcome());assertFalse(timeout.cleanupPending());evidence("timeout",timeout);}
    @Test void realOutputLimit()throws Exception{var compile=client.execute("project","output-job","output-attempt",1,RunnerClient.compileSpec(Map.of("Main.java","public class Main {public static void main(String[] a){while(true){System.out.print(\"12345678901234567890123456789012\");System.err.print(\"abc\");}}}")));evidence("debug-output-compile",compile);var output=client.execute("project","output-job","output-attempt",1,RunnerClient.runtimeSpec(compile.compileArtifactId(),"Main",new TestCase("output","",List.of(),null,null,null),1));assertEquals(ExecutionOutcome.output_limit,output.outcome());assertTrue(output.truncated());assertTrue(output.stdout().length()+output.stderr().length()<=MAX_OUTPUT);evidence("output-limit",Map.of("outcome",output.outcome(),"stdoutBytes",output.stdout().length(),"stderrBytes",output.stderr().length(),"cleanupPending",output.cleanupPending()));}
    @Test void realCancelAndBoundaryProbe()throws Exception {
        var compile=client.execute("project","cancel-job","cancel-attempt",1,RunnerClient.compileSpec(Map.of("Main.java","public class Main {public static void main(String[] a){while(true){}}}")));
        var cancel=new java.util.concurrent.atomic.AtomicBoolean();Thread.ofVirtual().start(()->{try{Thread.sleep(1500);cancel.set(true);}catch(Exception ignored){}});
        var result=client.execute("project","cancel-job","cancel-attempt",1,RunnerClient.runtimeSpec(compile.compileArtifactId(),"Main",new TestCase("cancel","",List.of(),null,null,null),1),cancel::get);assertEquals(ExecutionOutcome.cancelled,result.outcome());assertFalse(result.cleanupPending());evidence("cancel",result);
        String probe="import java.nio.file.*; public class Main { public static void main(String[] a)throws Exception { if(Files.exists(Path.of(\"/var/run/docker.sock\"))||Files.exists(Path.of(\"/mnt/d\"))||System.getenv().keySet().stream().anyMatch(k->k.startsWith(\"JB_\")))throw new Error(\"secret or host boundary\"); String status=Files.readString(Path.of(\"/proc/self/status\"));if(!status.contains(\"NoNewPrivs:\\t1\")||!status.contains(\"Seccomp:\\t2\"))throw new Error(\"seccomp\"); try(var files=Files.list(Path.of(\"/sys/class/net\"))){if(!files.map(p->p.getFileName().toString()).toList().equals(java.util.List.of(\"lo\")))throw new Error(\"network\");}try{Files.writeString(Path.of(\"/etc/forbidden\"),\"x\");throw new Error(\"root writable\");}catch(java.nio.file.FileSystemException expected){}System.out.print(\"boundary-ok\");}}";
        var bc=client.execute("project","boundary-job","boundary-attempt",1,RunnerClient.compileSpec(Map.of("Main.java",probe)));assertEquals(ExecutionOutcome.exited,bc.outcome());var runtime=client.execute("project","boundary-job","boundary-attempt",1,RunnerClient.runtimeSpec(bc.compileArtifactId(),"Main",new TestCase("boundary","",List.of(),0,"boundary-ok",""),1));assertEquals(ExecutionOutcome.exited,runtime.outcome());assertEquals(0,runtime.exitCode());assertEquals(Bytes.text("boundary-ok"),runtime.stdout());evidence("boundaries",runtime);
    }
    @Test void serviceAuthAndUnsafePathsRejected()throws Exception{var bad=new RunnerClient(endpoint,"wrong-token");assertFalse(bad.available());assertThrows(Exception.class,()->client.execute("project","invalid-job","invalid-attempt",1,RunnerClient.compileSpec(Map.of("../Main.java","class Main{}"))));}
    @Test void realIdempotencyFenceAndOwnership()throws Exception {
        String job=UUID.randomUUID().toString();String attempt=UUID.randomUUID().toString();String execution=UUID.randomUUID().toString();
        var spec=RunnerClient.compileSpec(Map.of("Main.java","class Main {}"));var submit=new Submit("project",job,attempt,execution,spec.hash(),1,Instant.now().plusSeconds(90).toString(),spec);
        var headers=Map.of("Idempotency-Key",job+":"+attempt+":"+execution);
        assertEquals(202,raw("POST","/internal/v1/executions",submit,headers).statusCode());assertEquals(202,raw("POST","/internal/v1/executions",submit,headers).statusCode());
        var changedSpec=RunnerClient.compileSpec(Map.of("Main.java","class Main {int x;}"));var conflict=new Submit("project",job,attempt,execution,changedSpec.hash(),1,submit.leaseExpiresAt(),changedSpec);
        assertEquals(409,raw("POST","/internal/v1/executions",conflict,headers).statusCode());
        var foreign=Map.of("X-Project-Id","foreign","X-Job-Id",job,"X-Attempt-Id",attempt,"X-Spec-Hash",spec.hash(),"X-Fencing-Token","1");assertEquals(404,raw("GET","/internal/v1/executions/"+execution,null,foreign).statusCode());
        String newerAttempt=UUID.randomUUID().toString();var newer=client.execute("project",job,newerAttempt,2,spec);assertEquals(ExecutionOutcome.exited,newer.outcome());
        String staleId=UUID.randomUUID().toString();var stale=new Submit("project",job,attempt,staleId,spec.hash(),1,Instant.now().plusSeconds(90).toString(),spec);assertEquals(409,raw("POST","/internal/v1/executions",stale,Map.of("Idempotency-Key",job+":"+attempt+":"+staleId)).statusCode());
        evidence("ownership-idempotency-fence",Map.of("duplicateSubmit",202,"differentPayload",409,"foreignProject",404,"staleFence",409));
    }
    private static HttpResponse<String> raw(String method,String path,Object body,Map<String,String> headers)throws Exception {var b=HttpRequest.newBuilder(endpoint.resolve(path)).header("Authorization","Bearer "+TOKEN).header("Content-Type","application/json").timeout(Duration.ofSeconds(10));headers.forEach(b::header);b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body)));return HttpClient.newHttpClient().send(b.build(),HttpResponse.BodyHandlers.ofString());}
    private static void evidence(String name,Object data)throws Exception{Path root=Path.of(System.getenv().getOrDefault("JB_EVIDENCE_DIR","target/test-artifacts")).toAbsolutePath().normalize();Files.createDirectories(root);Files.write(root.resolve(name+".json"),JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(data));}
}
