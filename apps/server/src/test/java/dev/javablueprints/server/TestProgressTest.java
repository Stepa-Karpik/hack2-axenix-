package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.map;
import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

import dev.javablueprints.verification.ComparisonObserver;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class TestProgressTest {
  private Observation execution(ExecutionOutcome outcome) {
    return new Observation("p","j","a","e","hash",Phase.runtime,"terminal",outcome,0,Bytes.text("ok"),Bytes.text(""),false,null,false);
  }
  @SuppressWarnings("unchecked") private List<Map<String,Object>> cases(Map<String,Object> snapshot) {
    return (List<Map<String,Object>>)snapshot.get("cases");
  }
  private Comparison comparison(List<TestResult> results, ComparisonOutcome outcome) {
    return new Comparison(outcome,null,true,3,3,3,1,2,results,null,null);
  }
  @Test void snapshotsMeasureActualWorkAndKeepCompletionSeparateFromSuccess() {
    var clock=new AtomicLong(); var saved=new ArrayList<Map<String,Object>>();
    var progress=new TestProgress("p","a",List.of(map("id","one","name","First"),map("id","two","name","Second")),saved::add,clock::get);
    progress.phase(ComparisonObserver.Stage.compile_base);
    assertNull(cases(progress.snapshot()).getFirst().get("elapsedMs"));
    progress.caseStarted("one"); clock.set(2_000_000_000L);
    assertEquals(2000L,cases(progress.snapshot()).getFirst().get("elapsedMs"));
    assertEquals(0L,progress.snapshot().get("completed"));
    var observations=List.of(execution(ExecutionOutcome.exited),execution(ExecutionOutcome.exited),execution(ExecutionOutcome.exited));
    for(int i=1;i<=3;i++) {
      progress.observed("one",ComparisonObserver.Side.base,i,observations.get(i-1));
      progress.observed("one",ComparisonObserver.Side.candidate,i,observations.get(i-1));
    }
    var mismatch=new TestResult("one",observations,observations,false,ComparisonOutcome.mismatch,List.of());
    progress.caseFinished(mismatch);
    clock.set(5_000_000_000L);
    assertEquals(2000L,progress.duration("one"));
    assertEquals(1L,progress.snapshot().get("completed"));
    assertEquals(0L,progress.snapshot().get("matched"));
    assertEquals("queued",cases(saved.getFirst()).getFirst().get("status"));
    progress.finish(comparison(List.of(mismatch),ComparisonOutcome.mismatch),false);
    assertEquals("not_run",cases(progress.snapshot()).get(1).get("status"));
    assertEquals("inconclusive",progress.snapshot().get("phase"));
    assertEquals(5000L,progress.snapshot().get("elapsedMs"));
  }
  @Test void cancellationPreservesFinishedCasesAndNeverCompletesUnobservedTests() {
    var clock=new AtomicLong();
    var progress=new TestProgress("p","a",List.of(map("id","one"),map("id","two"),map("id","three")),ignored->{},clock::get);
    var observations=Collections.nCopies(3,execution(ExecutionOutcome.exited));
    var passed=new TestResult("one",observations,observations,true,ComparisonOutcome.matched_on_tests,List.of());
    progress.caseStarted("one"); progress.caseFinished(passed);
    progress.caseStarted("two"); clock.set(3_000_000_000L);
    progress.observed("two",ComparisonObserver.Side.base,1,execution(ExecutionOutcome.cancelled));
    var partial=new TestResult("two",List.of(execution(ExecutionOutcome.cancelled)),List.of(),false,ComparisonOutcome.inconclusive,List.of("cancelled","incomplete"));
    progress.caseFinished(partial); progress.finish(comparison(List.of(passed,partial),ComparisonOutcome.inconclusive),true);
    assertEquals("cancelled",progress.snapshot().get("phase"));
    assertEquals(1L,progress.snapshot().get("completed"));
    assertEquals(1L,progress.snapshot().get("matched"));
    assertEquals(List.of("matched","cancelled","not_run"),cases(progress.snapshot()).stream().map(c->c.get("status")).toList());
    var frozen=progress.snapshot(); clock.set(8_000_000_000L);progress.phase(ComparisonObserver.Stage.tests);
    assertEquals(frozen,progress.snapshot());
  }
  @Test void invalidObservationsCannotInflateCountsAndFailureFreezesTheClock() {
    var clock=new AtomicLong();
    var progress=new TestProgress("p","a",List.of(map("id","one")),ignored->{},clock::get);
    progress.caseStarted("one");
    assertThrows(IllegalStateException.class,()->progress.observed("one",ComparisonObserver.Side.base,3,execution(ExecutionOutcome.exited)));
    assertEquals(0,cases(progress.snapshot()).getFirst().get("baseObserved"));
    clock.set(1_500_000_000L);progress.failed("LEASE_EXPIRED");clock.set(9_000_000_000L);
    assertEquals("failed",progress.snapshot().get("phase"));
    assertEquals(1500L,progress.snapshot().get("elapsedMs"));
    assertEquals(0L,progress.snapshot().get("completed"));
  }
  @Test void metadataBoundsDisplayNamesWithoutMutatingSuiteInputOrPublishingStreams() {
    String name="📦".repeat(1000);
    var input=map("id","one","name",name,"stdinUtf8","private input");
    var progress=new TestProgress("p","a",List.of(input),ignored->{},()->0L);
    var row=cases(progress.snapshot()).getFirst();
    String display=row.get("name").toString();
    assertEquals(161,display.codePointCount(0,display.length()));
    assertTrue(display.endsWith("…"));assertEquals(name,input.get("name"));
    assertFalse(row.containsKey("stdinUtf8"));assertFalse(row.containsKey("stdoutUtf8"));
  }
}
