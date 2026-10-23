package dev.javablueprints.verification;

import static dev.javablueprints.verification.RunnerProtocol.*;
import java.util.*;

public final class Comparator {
    private Comparator() {}
    public static boolean equal(Observation a, Observation b) { return Objects.equals(a.exitCode(), b.exitCode()) && a.stdout().equals(b.stdout()) && a.stderr().equals(b.stderr()); }
    public static Comparison compare(List<TestCase> cases,List<TestResult> results,Observation bc,Observation cc) {
        if(cases.isEmpty())throw new IllegalArgumentException("Empty suite");
        if(cases.stream().map(TestCase::id).distinct().count()!=cases.size())throw new IllegalArgumentException("Duplicate case ids");
        int base=0,candidate=0,matched=0;boolean mismatch=false,complete=true;
        var aggregated=new ArrayList<TestResult>();var allReasons=new LinkedHashSet<String>();
        for(var c:cases) {
            var found=results.stream().filter(r->r.caseId().equals(c.id())).toList();
            var r=found.size()==1?found.getFirst():new TestResult(c.id(),List.of(),List.of(),false);
            var reasons=new LinkedHashSet<String>();
            if((bc!=null&&bc.cleanupPending())||(cc!=null&&cc.cleanupPending()))reasons.add("cleanup_pending");
            base+=r.baseExecutions().size();candidate+=r.candidateExecutions().size();
            if(r.baseExecutions().size()!=3||r.candidateExecutions().size()!=3)reasons.add("incomplete");
            var all=new ArrayList<>(r.baseExecutions());all.addAll(r.candidateExecutions());
            for(var e:all) {
                if(!"terminal".equals(e.status())||e.outcome()==null)reasons.add("incomplete");
                else if(e.outcome()!=ExecutionOutcome.exited)reasons.add(switch(e.outcome()){case oom->"memory_limit";case sandbox_error->"infrastructure_error";default->e.outcome().name();});
                if(e.truncated())reasons.add("output_limit");
                if(e.cleanupPending())reasons.add("cleanup_pending");
                if(e.exitCode()==null&&e.outcome()==ExecutionOutcome.exited)reasons.add("incomplete");
            }
            boolean caseMatched=false,caseMismatch=false;
            if(reasons.isEmpty()) {
                var b=r.baseExecutions().getFirst();var d=r.candidateExecutions().getFirst();
                if(r.baseExecutions().stream().anyMatch(e->!equal(b,e))||r.candidateExecutions().stream().anyMatch(e->!equal(d,e)))reasons.add("nondeterministic");
                else if((b.exitCode()!=0||d.exitCode()!=0)&&c.expectedExitCode()==null)reasons.add("nonzero_without_oracle");
                else {
                    boolean same=equal(b,d);
                    if(c.expectedExitCode()!=null)same&=Objects.equals(c.expectedExitCode(),b.exitCode())&&Objects.equals(c.expectedExitCode(),d.exitCode());
                    if(c.expectedStdout()!=null)same&=Bytes.text(c.expectedStdout()).equals(b.stdout())&&Bytes.text(c.expectedStdout()).equals(d.stdout());
                    if(c.expectedStderr()!=null)same&=Bytes.text(c.expectedStderr()).equals(b.stderr())&&Bytes.text(c.expectedStderr()).equals(d.stderr());
                    caseMatched=same;caseMismatch=!same;
                }
            }
            if(caseMatched)matched++;if(caseMismatch)mismatch=true;if(!reasons.isEmpty())complete=false;
            allReasons.addAll(reasons);
            aggregated.add(new TestResult(c.id(),r.baseExecutions(),r.candidateExecutions(),caseMatched,caseMatched?ComparisonOutcome.matched_on_tests:caseMismatch?ComparisonOutcome.mismatch:ComparisonOutcome.inconclusive,List.copyOf(reasons)));
        }
        return new Comparison(mismatch?ComparisonOutcome.mismatch:complete?ComparisonOutcome.matched_on_tests:ComparisonOutcome.inconclusive,allReasons.isEmpty()?null:String.join(",",allReasons),complete,3,base,candidate,matched,cases.size(),List.copyOf(aggregated),bc,cc);
    }
}
