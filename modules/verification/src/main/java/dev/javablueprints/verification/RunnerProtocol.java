package dev.javablueprints.verification;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/** Immutable, bounded, service-only transport; never expose these credentials to a browser. */
public final class RunnerProtocol {
    private RunnerProtocol() {}
    public static final ObjectMapper JSON = new ObjectMapper();
    public static final String PROFILE = "java21-v1";
    public static final String IMAGE = "eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0";
    public static final int MAX_OUTPUT = 1024 * 1024;
    public static final String PROFILE_HASH = hash(("runner-transport-v1-ustar1|"+PROFILE+"|"+IMAGE+"|uid65534|readonly|caps:none|seccomp:builtin|network:none|memory512m|cpu1|pids128|workspace64m|tmp16m|compile20s|runtime5s|interactive120s-input1m-frames1024|output1m|javac-proc:none-release21|env-unset-javaoptions|java-Xmx256m-Xss512k-utf8-en-US-UTC|stdin-empty-noattach-v1|metrics-cgroup-peak-execwall-v1").getBytes(StandardCharsets.UTF_8));
    public enum Phase { compile, runtime }
    public enum ExecutionOutcome { exited, timeout, oom, output_limit, compile_error, cancelled, sandbox_error }
    public enum ComparisonOutcome { matched_on_tests, mismatch, compile_error, inconclusive, unavailable }
    public enum JobStatus { queued, running, succeeded, failed, cancelled }
    public record Bytes(String base64, int length, String sha256) {
        public static Bytes of(byte[] value) { return new Bytes(Base64.getEncoder().encodeToString(value), value.length, hash(value)); }
        public static Bytes text(String value) { return of(value.getBytes(StandardCharsets.UTF_8)); }
        public byte[] decode(int max) {
            if (length < 0 || length > max || base64 == null || base64.length() > ((long)max + 2) / 3 * 4) throw new IllegalArgumentException("Byte limit");
            byte[] result = Base64.getDecoder().decode(base64);
            if (result.length != length || !hash(result).equals(sha256)) throw new IllegalArgumentException("Byte integrity");
            return result;
        }
    }
    public record Spec(String profileId, Phase phase, Map<String, Bytes> sources, String compileArtifactId,
                       String mainClass, List<String> args, Bytes stdin, String caseId, int observationIndex, boolean interactive, boolean methodHarness) {
        public Spec(String profileId, Phase phase, Map<String, Bytes> sources, String compileArtifactId, String mainClass, List<String> args, Bytes stdin, String caseId, int observationIndex, boolean interactive) {
            this(profileId,phase,sources,compileArtifactId,mainClass,args,stdin,caseId,observationIndex,interactive,false);
        }
        public Spec(String profileId, Phase phase, Map<String, Bytes> sources, String compileArtifactId, String mainClass, List<String> args, Bytes stdin, String caseId, int observationIndex) {
            this(profileId, phase, sources, compileArtifactId, mainClass, args, stdin, caseId, observationIndex, false, false);
        }
        public Spec { sources = sources == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(sources)); args = args == null ? List.of() : List.copyOf(args); }
        public String hash() { try { return RunnerProtocol.hash(JSON.writeValueAsBytes(List.of(PROFILE_HASH,this))); } catch (Exception e) { throw new IllegalArgumentException(e); } }
    }
    public record Submit(String projectId, String jobId, String attemptId, String executionId, String specHash,
                         long fencingToken, String leaseExpiresAt, Spec executionSpec) {}
    public record InputFrame(String id, Bytes data, boolean eof) {}
    public record ExecutionMetrics(long executionWallMs, Long containerPeakMemoryBytes, String memoryScope) {
        public ExecutionMetrics {
            if(executionWallMs<0 || containerPeakMemoryBytes!=null && containerPeakMemoryBytes<1)
                throw new IllegalArgumentException("Invalid measured resource values");
            if(!"cgroup-v2-container-lifetime-including-setup-and-probe".equals(memoryScope))
                throw new IllegalArgumentException("Unknown memory measurement scope");
        }
    }
    public record Observation(String projectId, String jobId, String attemptId, String executionId, String specHash,
                              Phase phase, String status, ExecutionOutcome outcome, Integer exitCode, Bytes stdout,
                              Bytes stderr, boolean truncated, String compileArtifactId, boolean cleanupPending, ExecutionMetrics metrics, Bytes methodResult) {
        public Observation(String projectId,String jobId,String attemptId,String executionId,String specHash,Phase phase,String status,ExecutionOutcome outcome,Integer exitCode,Bytes stdout,Bytes stderr,boolean truncated,String compileArtifactId,boolean cleanupPending,ExecutionMetrics metrics) {
            this(projectId,jobId,attemptId,executionId,specHash,phase,status,outcome,exitCode,stdout,stderr,truncated,compileArtifactId,cleanupPending,metrics,null);
        }
        public Observation(String projectId,String jobId,String attemptId,String executionId,String specHash,
                           Phase phase,String status,ExecutionOutcome outcome,Integer exitCode,Bytes stdout,
                           Bytes stderr,boolean truncated,String compileArtifactId,boolean cleanupPending) {
            this(projectId,jobId,attemptId,executionId,specHash,phase,status,outcome,exitCode,stdout,stderr,truncated,compileArtifactId,cleanupPending,null,null);
        }
    }
    public record TestCase(String id, String stdin, List<String> args, Integer expectedExitCode, String expectedStdout, String expectedStderr, String expectedMethodResult) {
        public TestCase(String id,String stdin,List<String> args,Integer expectedExitCode,String expectedStdout,String expectedStderr) {
            this(id,stdin,args,expectedExitCode,expectedStdout,expectedStderr,null);
        }
        public TestCase { args = args == null ? List.of() : List.copyOf(args); }
    }
    public record TestResult(String caseId, List<Observation> baseExecutions, List<Observation> candidateExecutions, boolean matched,
                             ComparisonOutcome outcome, List<String> reasons) {
        public TestResult(String caseId,List<Observation> base,List<Observation> candidate,boolean matched) {this(caseId,List.copyOf(base),List.copyOf(candidate),matched,null,List.of());}
    }
    public record Comparison(ComparisonOutcome outcome, String reason, boolean coverageComplete, int plannedRepeatCount,
                             int observedBaseCount, int observedCandidateCount, int matched, int total, List<TestResult> tests,
                             Observation baseCompile, Observation candidateCompile) {}
    public static String hash(byte[] bytes) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch (Exception e) { throw new IllegalStateException(e); } }
    public static void id(String id) { if (id == null || !id.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("Invalid identifier"); }
    public static void path(String path) { if (path == null || path.length() > 240 || !path.matches("([A-Za-z_$][A-Za-z0-9_$]*/)*([A-Za-z_$][A-Za-z0-9_$]*|package-info|module-info)\\.(java|class)")) throw new IllegalArgumentException("Unsafe artifact path"); }
    public static void arguments(List<String> args) {
        if(args==null||args.size()>100)throw new IllegalArgumentException("Argument count");
        long total=0;
        for(String arg:args){
            if(arg==null||arg.indexOf(0)>=0)throw new IllegalArgumentException("Invalid argument");
            int bytes=arg.getBytes(StandardCharsets.UTF_8).length;
            if(bytes>8192)throw new IllegalArgumentException("Argument byte limit");
            total+=bytes;
        }
        if(total>65536)throw new IllegalArgumentException("Combined argument byte limit");
    }
}
