package dev.javablueprints.runner;

import static dev.javablueprints.verification.RunnerProtocol.*;
import com.sun.net.httpserver.*;
import java.net.*;
import java.nio.file.*;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Private trusted service. Docker privilege belongs exclusively to this process. */
public final class RunnerController implements AutoCloseable {
    private final DockerSandbox docker;
    private final byte[] token;
    private final HttpServer server;
    private final Map<String,Entry> executions=new HashMap<>();
    private final Map<String,Attempt> attempts=new HashMap<>();
    private final Map<String,Artifact> artifacts=new HashMap<>();
    private final ExecutorService workers=Executors.newFixedThreadPool(2);
    private final ExecutorService httpWorkers=Executors.newFixedThreadPool(8);
    private final ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean ready=new AtomicBoolean();
    static final int MAX_RETAINED_EXECUTIONS=1024;
    private long retainedBytes;
    private static final long MAX_RETAINED=64L*1024*1024;
    private record Attempt(String project,String attempt,long fence,AtomicReference<Instant> expiry) {}
    private record Artifact(String project,String job,String attempt,Map<String,byte[]> classes) {}
    private static final class Entry {
        final Submit request; final AtomicBoolean cancelled=new AtomicBoolean(); final Instant created=Instant.now();
        volatile Observation result;
        final LiveSession live;
        Entry(Submit s) {live=s.executionSpec().interactive()?new LiveSession(s.executionSpec().stdin().length()):null;request=s; result=observation(s,"queued",null,null,Bytes.of(new byte[0]),Bytes.of(new byte[0]),false,null,false);}
    }
    public RunnerController(InetSocketAddress address,String secret,DockerSandbox docker) throws Exception {
        if(secret==null || secret.length()<32) throw new IllegalArgumentException("Runner secret must contain at least32 characters");
        this.token=("Bearer "+secret).getBytes(StandardCharsets.UTF_8); this.docker=docker;
        try { docker.reconcile(); ready.set(docker.available()); } catch(Exception ignored) { ready.set(false); }
        server=HttpServer.create(address,32); server.setExecutor(httpWorkers);
        server.createContext("/internal/v1/",this::handle);
        watchdog.scheduleWithFixedDelay(()->{expire();docker.retryCleanup();},1,1,TimeUnit.SECONDS);
    }
    public void start(){server.start();}
    public int port(){return server.getAddress().getPort();}
    private void handle(HttpExchange exchange) throws java.io.IOException {
        try {
            String authorization=exchange.getRequestHeaders().getFirst("Authorization");
            if(authorization==null || !MessageDigest.isEqual(token,authorization.getBytes(StandardCharsets.UTF_8))) { respond(exchange,401,Map.of("error","UNAUTHORIZED"));return; }
            String path=exchange.getRequestURI().getPath(); String method=exchange.getRequestMethod();
            if(path.equals("/internal/v1/health") && method.equals("GET")) { boolean available=docker.available(); ready.set(available); respond(exchange,200,Map.of("available",available,"profileId",PROFILE,"profileHash",PROFILE_HASH));return; }
            if(path.equals("/internal/v1/executions") && method.equals("POST")) {
                var request=JSON.readValue(body(exchange),Submit.class);
                if(!Objects.equals(exchange.getRequestHeaders().getFirst("Idempotency-Key"),request.jobId()+":"+request.attemptId()+":"+request.executionId())) throw new IllegalArgumentException("Idempotency key");
                respond(exchange,202,submit(request)); return;
            }
            if(path.startsWith("/internal/v1/executions/")) {
                String suffix=path.substring("/internal/v1/executions/".length()); boolean cancel=suffix.endsWith("/cancel"), input=suffix.endsWith("/stdin");
                String id=cancel?suffix.substring(0,suffix.length()-7):input?suffix.substring(0,suffix.length()-6):suffix; id(id);
                Entry entry;
                synchronized(this){entry=executions.get(id); if(entry==null || !owned(exchange,entry)) {respond(exchange,404,Map.of("error","NOT_FOUND"));return;}}
                if(input && method.equals("POST")) {
                    if(entry.live==null || entry.result.status().equals("terminal") || entry.cancelled.get() || stale(entry.request)) throw new Conflict();
                    var frame=JSON.readValue(body(exchange),InputFrame.class);
                    entry.live.accept(frame);respond(exchange,200,Map.of("accepted",true));return;
                }
                if(cancel && method.equals("POST")) {entry.cancelled.set(true); clearArtifacts(entry.request); respond(exchange,202,entry.result);return;}
                if(!cancel && !input && method.equals("GET")){
                    Observation view=entry.result;
                    if(entry.live!=null && !view.status().equals("terminal")) view=observation(entry.request,view.status(),null,null,Bytes.of(entry.live.stdout.toByteArray()),Bytes.of(entry.live.stderr.toByteArray()),false,null,false);
                    respond(exchange,200,view);return;}
            }
            if(path.startsWith("/internal/v1/attempts/") && path.endsWith("/renew") && method.equals("POST")) {
                String attemptId=path.substring("/internal/v1/attempts/".length(),path.length()-6); id(attemptId);
                Map<?,?> data=JSON.readValue(body(exchange),Map.class); Instant expiry=Instant.parse((String)data.get("leaseExpiresAt"));
                if(!expiry.isAfter(Instant.now()) || expiry.isAfter(Instant.now().plusSeconds(120))) throw new IllegalArgumentException("Lease bound");
                synchronized(this) {
                    Attempt attempt=attempts.get(exchange.getRequestHeaders().getFirst("X-Job-Id"));
                    if(attempt==null || !attempt.attempt().equals(attemptId) || !attempt.project().equals(exchange.getRequestHeaders().getFirst("X-Project-Id")) || attempt.fence()!=Long.parseLong(exchange.getRequestHeaders().getFirst("X-Fencing-Token")) || attempt.expiry().get().isBefore(Instant.now())) {respond(exchange,409,Map.of("error","STALE_ATTEMPT"));return;}
                    attempt.expiry().set(expiry);
                }
                respond(exchange,200,Map.of("renewed",true));return;
            }
            respond(exchange,404,Map.of("error","NOT_FOUND"));
        } catch(Conflict e){respond(exchange,409,Map.of("error","EXECUTION_CONFLICT"));}
        catch(Limit e){respond(exchange,413,Map.of("error","INPUT_LIMIT_EXCEEDED"));}
        catch(Unavailable e){respond(exchange,503,Map.of("error","RUNNER_UNAVAILABLE"));}
        catch(Capacity e){respond(exchange,429,Map.of("error","QUEUE_LIMIT"));}
        catch(Exception e){respond(exchange,400,Map.of("error","INVALID_EXECUTION"));}
        finally{exchange.close();}
    }
    private synchronized Observation submit(Submit s) {
        validate(s);
        Entry old=executions.get(s.executionId());
        if(old!=null) { if(!same(old.request,s)) throw new Conflict(); return old.result; }
        if(!ready.get()||docker.cleanupPending()) throw new Unavailable();
        if(executions.size()>=MAX_RETAINED_EXECUTIONS || retainedBytes>MAX_RETAINED || executions.values().stream().filter(e->!e.result.status().equals("terminal")).count()>=32) throw new Capacity();
        Attempt previous=attempts.get(s.jobId()); Instant lease=Instant.parse(s.leaseExpiresAt());
        if(previous!=null) {
            if(!previous.project().equals(s.projectId()) || previous.fence()>s.fencingToken() || previous.fence()==s.fencingToken() && !previous.attempt().equals(s.attemptId()) || previous.fence()==s.fencingToken() && previous.expiry().get().isBefore(Instant.now())) throw new Conflict();
            if(previous.fence()<s.fencingToken()) { for(Entry e:executions.values()) if(e.request.jobId().equals(s.jobId())) e.cancelled.set(true); artifacts.entrySet().removeIf(e->e.getValue().job().equals(s.jobId())); }
        }
        if(s.executionSpec().phase()==Phase.runtime) {
            Artifact a=artifacts.get(s.executionSpec().compileArtifactId());
            if(a==null || !a.project().equals(s.projectId()) || !a.job().equals(s.jobId()) || !a.attempt().equals(s.attemptId())) throw new Conflict();
        }
        if(previous==null || previous.fence()<s.fencingToken()) attempts.put(s.jobId(),new Attempt(s.projectId(),s.attemptId(),s.fencingToken(),new AtomicReference<>(lease)));
        else if(lease.isAfter(previous.expiry().get())) previous.expiry().set(lease);
        Entry entry=new Entry(s); executions.put(s.executionId(),entry); workers.submit(()->run(entry)); return entry.result;
    }
    private void run(Entry entry) {
        Submit s=entry.request;
        entry.result=observation(s,"running",null,null,Bytes.of(new byte[0]),Bytes.of(new byte[0]),false,null,false);
        Map<String,byte[]> classes;
        synchronized(this) { var artifact=artifacts.get(s.executionSpec().compileArtifactId());classes=artifact==null?Map.of():artifact.classes(); }
        var result=docker.execute(s,classes,()->entry.cancelled.get() || stale(s),entry.live);
        synchronized(this) {
            String artifactId=null;
            if(s.executionSpec().phase()==Phase.compile && result.outcome()==ExecutionOutcome.exited && !entry.cancelled.get() && !stale(s)) {
                long size=result.classes().values().stream().mapToLong(b->b.length).sum();
                if(retainedBytes+size<MAX_RETAINED) {artifactId=UUID.randomUUID().toString();artifacts.put(artifactId,new Artifact(s.projectId(),s.jobId(),s.attemptId(),result.classes()));retainedBytes+=size;}
            }
            retainedBytes+=result.stdout().length()+result.stderr().length();
            ExecutionOutcome outcome=entry.cancelled.get() || stale(s)?ExecutionOutcome.cancelled:result.outcome();
            if(s.executionSpec().phase()==Phase.compile && outcome==ExecutionOutcome.exited && artifactId==null) outcome=ExecutionOutcome.sandbox_error;
            entry.result=new Observation(s.projectId(),s.jobId(),s.attemptId(),s.executionId(),s.specHash(),s.executionSpec().phase(),"terminal",outcome,result.exit(),result.stdout(),result.stderr(),result.truncated(),artifactId,result.cleanupPending(),result.metrics());
        }
    }
    private synchronized boolean stale(Submit s){Attempt a=attempts.get(s.jobId()); return a==null || a.fence()!=s.fencingToken() || !a.attempt().equals(s.attemptId()) || a.expiry().get().isBefore(Instant.now());}
    private synchronized void clearArtifacts(Submit s){artifacts.entrySet().removeIf(e->e.getValue().job().equals(s.jobId()) && e.getValue().attempt().equals(s.attemptId()));}
    private synchronized void expire(){for(Entry e:executions.values())if(stale(e.request)){e.cancelled.set(true);clearArtifacts(e.request);} executions.entrySet().removeIf(e->e.getValue().created.plusSeconds(600).isBefore(Instant.now()) && e.getValue().result.status().equals("terminal")); retainedBytes=artifacts.values().stream().flatMap(a->a.classes().values().stream()).mapToLong(b->b.length).sum()+executions.values().stream().mapToLong(e->e.result.stdout().length()+e.result.stderr().length()).sum();}
    private boolean owned(HttpExchange x,Entry e){var h=x.getRequestHeaders();Submit s=e.request;return Objects.equals(h.getFirst("X-Project-Id"),s.projectId()) && Objects.equals(h.getFirst("X-Job-Id"),s.jobId()) && Objects.equals(h.getFirst("X-Attempt-Id"),s.attemptId()) && Objects.equals(h.getFirst("X-Spec-Hash"),s.specHash()) && Objects.equals(h.getFirst("X-Fencing-Token"),Long.toString(s.fencingToken()));}
    private static boolean same(Submit a,Submit b){return a.projectId().equals(b.projectId())&&a.jobId().equals(b.jobId())&&a.attemptId().equals(b.attemptId())&&a.fencingToken()==b.fencingToken()&&a.specHash().equals(b.specHash());}
    static void validate(Submit s) {
        id(s.projectId());id(s.jobId());id(s.attemptId());id(s.executionId()); if(s.fencingToken()<1)throw new IllegalArgumentException("Fence");
        Instant lease=Instant.parse(s.leaseExpiresAt());if(!lease.isAfter(Instant.now())||lease.isAfter(Instant.now().plusSeconds(120)))throw new IllegalArgumentException("Lease");
        Spec spec=s.executionSpec();if(!PROFILE.equals(spec.profileId())||!spec.hash().equals(s.specHash()))throw new IllegalArgumentException("Spec integrity/profile");
        spec.stdin().decode(1024*1024);
        if(spec.interactive() && (spec.phase()!=Phase.runtime || !"single".equals(spec.caseId()) || spec.observationIndex()!=1)) throw new IllegalArgumentException("Interactive single run only");
        if(spec.phase()==Phase.compile){if(spec.sources().isEmpty()||spec.sources().size()>100)throw new Limit();long size=0;for(var e:spec.sources().entrySet()){path(e.getKey());if(!e.getKey().endsWith(".java"))throw new IllegalArgumentException("Source extension");byte[] bytes=e.getValue().decode(1024*1024);size+=bytes.length;try{StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes));}catch(CharacterCodingException ex){throw new IllegalArgumentException("UTF8");}}if(size>1024*1024)throw new Limit();}
        else if(spec.phase()==Phase.runtime){id(spec.compileArtifactId());id(spec.caseId());if(!spec.sources().isEmpty()||spec.observationIndex()<1||spec.observationIndex()>3||spec.mainClass()==null||spec.mainClass().length()>240||!spec.mainClass().matches("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*"))throw new IllegalArgumentException("Runtime arguments");arguments(spec.args());}else throw new IllegalArgumentException("Phase");
    }
    private static Observation observation(Submit s,String status,ExecutionOutcome outcome,Integer exit,Bytes out,Bytes err,boolean truncated,String artifact,boolean cleanup){return new Observation(s.projectId(),s.jobId(),s.attemptId(),s.executionId(),s.specHash(),s.executionSpec().phase(),status,outcome,exit,out,err,truncated,artifact,cleanup);}
    private static byte[] body(HttpExchange x)throws java.io.IOException{byte[] data=x.getRequestBody().readNBytes(16*1024*1024+1);if(data.length>16*1024*1024)throw new Limit();return data;}
    private static void respond(HttpExchange x,int status,Object data)throws java.io.IOException{byte[] bytes=JSON.writeValueAsBytes(data);x.getResponseHeaders().set("Content-Type","application/json");x.sendResponseHeaders(status,bytes.length);x.getResponseBody().write(bytes);}
    private static final class Conflict extends RuntimeException{} private static final class Limit extends RuntimeException{} private static final class Capacity extends RuntimeException{} private static final class Unavailable extends RuntimeException{}
    @Override public void close(){server.stop(0);httpWorkers.shutdownNow();workers.shutdownNow();watchdog.shutdownNow();try{docker.reconcile();}catch(Exception ignored){}}
    public static void main(String[] args)throws Exception{
        String secretFile=System.getenv("JB_RUNNER_TOKEN_FILE");String secret=secretFile==null?System.getenv("JB_RUNNER_TOKEN"):Files.readString(Path.of(secretFile)).strip();
        var controller=new RunnerController(new InetSocketAddress(System.getenv().getOrDefault("JB_RUNNER_BIND","0.0.0.0"),Integer.parseInt(System.getenv().getOrDefault("JB_RUNNER_PORT","8091"))),secret,new DockerSandbox());
        Runtime.getRuntime().addShutdownHook(new Thread(controller::close));controller.start();System.out.println("Runner controller listening; fixed profile="+PROFILE);
    }
}
