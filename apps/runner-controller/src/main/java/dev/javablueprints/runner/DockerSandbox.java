package dev.javablueprints.runner;

import static dev.javablueprints.verification.RunnerProtocol.*;
import java.io.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

/** Trusted fixed Docker template. Input bytes are copied; no host bind mounts exist. */
public final class DockerSandbox {
    static final String LABEL = "dev.javablueprints.sandbox=true";
    private final List<String> prefix;
    private final String namespace;
    private final Set<String> pendingCleanup=ConcurrentHashMap.newKeySet();
    public DockerSandbox() {this(System.getenv().getOrDefault("JB_RUNNER_NAMESPACE","local"));}
    public DockerSandbox(String namespace) {
        id(namespace);this.namespace=namespace;
        prefix=System.getProperty("os.name").startsWith("Windows") ? List.of("wsl.exe","-d","JavaBlueprints","-u","root","--","docker") : List.of("docker");
    }
    public boolean available() {
        if(System.getProperty("os.name").startsWith("Windows"))return false;
        try {
            var info=command(List.of("info","--format","{{.OSType}}|{{json .SecurityOptions}}|{{.CgroupVersion}}"),new byte[0],10_000,()->false);
            var image=command(List.of("image","inspect",IMAGE,"--format","{{.Id}}"),new byte[0],10_000,()->false);
            return info.exit()==0 && new String(info.stdout()).contains("linux|") && new String(info.stdout()).contains("seccomp") && new String(info.stdout()).trim().endsWith("|2") && image.exit()==0;
        } catch(Exception e) { return false; }
    }
    public void reconcile() throws Exception {
        var r=command(List.of("ps","-aq","--filter","label="+LABEL,"--filter","label=dev.javablueprints.namespace="+namespace),new byte[0],10_000,()->false);
        if(r.exit()!=0) throw new IOException("Engine unavailable");
        for(String id:new String(r.stdout()).split("\\s+")) if(!id.isBlank() && id.matches("[a-f0-9]{12,64}")) remove(id);
    }
    public boolean remove(String name) {
        try {boolean removed=command(List.of("rm","-f",name),new byte[0],10_000,()->false).exit()==0;if(removed)pendingCleanup.remove(name);else pendingCleanup.add(name);return removed;} catch(Exception e) {pendingCleanup.add(name);return false;}
    }
    public void retryCleanup(){for(String name:List.copyOf(pendingCleanup))remove(name);}
    public boolean cleanupPending(){return !pendingCleanup.isEmpty();}
    public record Result(ExecutionOutcome outcome,Integer exit,Bytes stdout,Bytes stderr,boolean truncated,Map<String,byte[]> classes,boolean cleanupPending,ExecutionMetrics metrics) {}
    public Result execute(Submit submit,Map<String,byte[]> classes,BooleanSupplier cancelled) {
        return execute(submit,classes,cancelled,null);
    }
    Result execute(Submit submit,Map<String,byte[]> classes,BooleanSupplier cancelled,LiveSession live) {
        String name="jb-"+UUID.randomUUID();
        var spec=submit.executionSpec();
        ExecutionOutcome outcome=ExecutionOutcome.sandbox_error; Integer exit=null;
        byte[] stdout=new byte[0],stderr=new byte[0]; boolean truncated=false,clean=true;
        Map<String,byte[]> output=Map.of();
        ExecutionMetrics metrics=null;
        try {
            Map<String,byte[]> files=new TreeMap<>();
            if(spec.phase()==Phase.compile) spec.sources().forEach((p,b)->files.put(p,b.decode(1024*1024))); else files.putAll(classes);
            List<String> create=new ArrayList<>(List.of("create","--name",name,"--label",LABEL,"--label","dev.javablueprints.namespace="+namespace,"--label","dev.javablueprints.job="+submit.jobId(),"--label","dev.javablueprints.attempt="+submit.attemptId(),"--network","none","--read-only","--user","65534:65534","--cap-drop","ALL","--security-opt","no-new-privileges:true","--memory","512m","--memory-swap","512m","--cpus","1","--pids-limit","128","--ipc","private","--ulimit","core=0","--tmpfs","/workspace:rw,nosuid,nodev,size=64m,mode=1777","--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777","--workdir","/workspace","--env","LANG=C.UTF-8","--env","LC_ALL=C.UTF-8","--env","TZ=UTC","--entrypoint","/usr/bin/sleep",IMAGE,"infinity"));
            require(command(create,new byte[0],15_000,cancelled));
            require(command(List.of("start",name),new byte[0],10_000,cancelled));
            require(command(List.of("exec","-i",name,"tar","--no-same-owner","--no-same-permissions","-xf","-","-C","/workspace"),ClassArchive.pack(files),10_000,cancelled));
            List<String> args=new ArrayList<>(List.of("exec"));
            // An empty fixed input needs no attached stream. Closing an already
            // empty CLI pipe can race Docker's attach and leave System.in open.
            if(spec.interactive() || spec.stdin().length()>0) args.add("-i");
            args.addAll(List.of("--user","65534:65534",name,"env","-u","JAVA_TOOL_OPTIONS","-u","JDK_JAVA_OPTIONS"));
            long wall;
            if(spec.phase()==Phase.compile) { args.addAll(List.of("javac","-J-Xmx256m","-J-Dfile.encoding=UTF-8","-proc:none","--release","21","-encoding","UTF-8","-d","/workspace/classes")); args.addAll(spec.sources().keySet()); wall=20_000; }
            else { args.addAll(List.of("java","-Xmx256m","-Xss512k","-XX:ActiveProcessorCount=1","-Dfile.encoding=UTF-8","-Duser.language=en","-Duser.country=US","-Duser.timezone=UTC","-cp","/workspace",spec.mainClass())); args.addAll(spec.args()); wall=spec.interactive()?120_000:5_000; }
            long remaining=Duration.between(Instant.now(),Instant.parse(submit.leaseExpiresAt())).toMillis();
            long executionStarted=System.nanoTime();
            var r=command(args,spec.stdin().decode(1024*1024),spec.interactive()?wall:Math.max(1,Math.min(wall,remaining)),cancelled,MAX_OUTPUT,live);
            long executionWallMs=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-executionStarted);
            stdout=r.stdout(); stderr=r.stderr(); truncated=r.limit(); exit=r.exit();
            if(r.timeout()||r.limit()||cancelled.getAsBoolean()) command(List.of("kill",name),new byte[0],3000,()->false);
            var state=command(List.of("inspect","--format","{{.State.OOMKilled}}",name),new byte[0],5000,()->false);
            boolean oom=new String(state.stdout()).trim().equals("true");
            Long peak=null;
            if(!cancelled.getAsBoolean() && !r.timeout() && !r.limit() && !oom) try {
                var measured=command(List.of("exec",name,"/usr/bin/cat","/sys/fs/cgroup/memory.peak"),new byte[0],3000,()->false,128);
                if(measured.exit()==0 && !measured.limit() && !measured.timeout()) peak=peakBytes(new String(measured.stdout(),java.nio.charset.StandardCharsets.US_ASCII));
            } catch(Exception ignored) { /* Missing metrics must never turn a run into a false match or failure. */ }
            metrics=new ExecutionMetrics(executionWallMs,peak,"cgroup-v2-container-lifetime-including-setup-and-probe");
            outcome=cancelled.getAsBoolean()?ExecutionOutcome.cancelled:r.limit()?ExecutionOutcome.output_limit:r.timeout()?ExecutionOutcome.timeout:oom?ExecutionOutcome.oom:r.exit()==0?ExecutionOutcome.exited:spec.phase()==Phase.compile?ExecutionOutcome.compile_error:ExecutionOutcome.exited;
            if(outcome!=ExecutionOutcome.exited && outcome!=ExecutionOutcome.compile_error) exit=null;
            if(spec.phase()==Phase.compile && outcome==ExecutionOutcome.exited) {
                var archive=command(List.of("exec",name,"tar","--format=ustar","-cf","-","-C","/workspace/classes","."),new byte[0],10_000,cancelled,9*1024*1024);
                require(archive);output=ClassArchive.unpack(archive.stdout());
            }
        } catch(Exception e) { System.err.println("Sandbox diagnostic: "+e); if(cancelled.getAsBoolean()) outcome=ExecutionOutcome.cancelled; else {outcome=ExecutionOutcome.sandbox_error; stderr="Sandbox setup or artifact validation failed".getBytes(java.nio.charset.StandardCharsets.UTF_8);} }
        finally {
            clean=remove(name);

        }
        return new Result(outcome,exit,Bytes.of(stdout),Bytes.of(stderr),truncated,output,!clean,metrics);
    }
    static Long peakBytes(String raw) {
        try { String value=raw.trim(); if(!value.matches("[0-9]{1,18}"))return null;
            long bytes=Long.parseLong(value);return bytes>0?bytes:null;
        } catch(RuntimeException failure) { return null; }
    }
    private static void require(Command r) throws IOException { if(r.exit()!=0 || r.timeout() || r.limit()) throw new IOException("Engine operation failed: "+new String(r.stderr(),java.nio.charset.StandardCharsets.UTF_8)); }
    record Command(int exit,byte[] stdout,byte[] stderr,boolean timeout,boolean limit) {}
    Command command(List<String> args,byte[] stdin,long wall,BooleanSupplier cancelled) throws IOException,InterruptedException {
        return command(args,stdin,wall,cancelled,MAX_OUTPUT);
    }
    Command command(List<String> args,byte[] stdin,long wall,BooleanSupplier cancelled,int ceiling) throws IOException,InterruptedException {
        return command(args,stdin,wall,cancelled,ceiling,null);
    }
    Command command(List<String> args,byte[] stdin,long wall,BooleanSupplier cancelled,int ceiling,LiveSession live) throws IOException,InterruptedException {
        var all=new ArrayList<>(prefix); all.addAll(args);
        ProcessBuilder builder=new ProcessBuilder(all);
        builder.environment().remove("JAVA_TOOL_OPTIONS"); builder.environment().remove("JDK_JAVA_OPTIONS");
        Process p=builder.start(); AtomicInteger remaining=new AtomicInteger(ceiling); AtomicBoolean limit=new AtomicBoolean();
        ByteArrayOutputStream out=live==null?new ByteArrayOutputStream():live.stdout,err=live==null?new ByteArrayOutputStream():live.stderr;
        Thread a=Thread.ofVirtual().start(()->drain(p.getInputStream(),out,remaining,limit));
        Thread b=Thread.ofVirtual().start(()->drain(p.getErrorStream(),err,remaining,limit));
        Thread writer=Thread.ofVirtual().start(()->{try(var stream=p.getOutputStream()){
            stream.write(stdin);stream.flush();
            if(live!=null) while(p.isAlive()) {
                InputFrame frame=live.input.poll(100,TimeUnit.MILLISECONDS);
                if(frame==null)continue;
                stream.write(frame.data().decode(8192));stream.flush();
                if(frame.eof())break;
            }
        }catch(IOException|InterruptedException ignored){}});
        long deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(wall); boolean timeout=false;
        while(p.isAlive()) { if(cancelled.getAsBoolean() || limit.get() || System.nanoTime()>deadline) { timeout=System.nanoTime()>deadline; p.destroyForcibly(); break; } Thread.sleep(10); }
        if(!p.waitFor(3,TimeUnit.SECONDS)) p.destroyForcibly();
        a.join(2000); b.join(2000); writer.interrupt(); writer.join(100);
        if(a.isAlive()||b.isAlive()){p.getInputStream().close();p.getErrorStream().close();a.join(1000);b.join(1000);if(a.isAlive()||b.isAlive())throw new IOException("Stream drain incomplete");}
        return new Command(p.isAlive()?-1:p.exitValue(),out.toByteArray(),err.toByteArray(),timeout,limit.get());
    }
    private static void drain(InputStream in,ByteArrayOutputStream out,AtomicInteger remaining,AtomicBoolean limit) {
        try(in) { byte[] bytes=new byte[8192]; int n; while((n=in.read(bytes))!=-1) { int before=remaining.getAndAdd(-n); int keep=Math.max(0,Math.min(before,n)); if(keep>0) out.write(bytes,0,keep); if(keep<n) limit.set(true); } } catch(IOException ignored) {}
    }
}
