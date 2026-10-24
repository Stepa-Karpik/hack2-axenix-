package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.map;
import static dev.javablueprints.verification.RunnerProtocol.*;

import dev.javablueprints.verification.ComparisonObserver;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Bounded comparison metadata. It is never a verification report or apply token. */
final class TestProgress implements ComparisonObserver {
  final String project, attempt;
  private final Consumer<Map<String,Object>> sink;
  private final LongSupplier clock;
  private final Map<String,Object> binding;
  private final long started;
  private final LinkedHashMap<String, CaseState> cases = new LinkedHashMap<>();
  private String phase = "queued", outcome, reason;
  private boolean finished;
  private long elapsed;

  private static final class CaseState {
    final String id, name;
    String status = "queued";
    int base, candidate;
    long started, elapsed;
    boolean hasStarted, active, completed;
    List<String> reasons = List.of();
    CaseState(String id, String name) { this.id=id; this.name=displayName(name); }
  }

  private static String displayName(String name) {
    var text=new StringBuilder();
    name.codePoints().limit(160).forEach(text::appendCodePoint);
    if(text.length()<name.length()) text.append('…');
    return text.toString();
  }

  TestProgress(String project, String attempt, List<Map<String,Object>> inputs, Consumer<Map<String,Object>> sink, Map<String,Object> binding) {
    this(project,attempt,inputs,sink,System::nanoTime,binding);
  }

  TestProgress(String project, String attempt, List<Map<String,Object>> inputs, Consumer<Map<String,Object>> sink, LongSupplier clock) {
    this(project,attempt,inputs,sink,clock,Map.of());
  }

  private TestProgress(String project, String attempt, List<Map<String,Object>> inputs, Consumer<Map<String,Object>> sink, LongSupplier clock, Map<String,Object> binding) {
    if(inputs.isEmpty() || inputs.size()>100) throw new IllegalArgumentException("Progress requires 1..100 tests");
    this.project=project; this.attempt=attempt; this.sink=sink; this.clock=clock;
    this.binding=Map.copyOf(binding);
    started=clock.getAsLong();
    for(var input:inputs) {
      String id=Objects.toString(input.get("id"),"");
      String name=Objects.toString(input.get("name"),id);
      if(id.isBlank() || cases.putIfAbsent(id,new CaseState(id,name))!=null) throw new IllegalArgumentException("Duplicate or missing test ID");
    }
  }

  private CaseState test(String id) {
    var value=cases.get(id);
    if(value==null) throw new IllegalArgumentException("Unknown test ID");
    return value;
  }

  private long milliseconds(long since) { return Math.max(0,(clock.getAsLong()-since)/1_000_000); }
  synchronized void publish() { sink.accept(snapshot()); }

  @Override public synchronized void phase(Stage next) {
    if(finished) return;
    phase=next.name(); publish();
  }

  @Override public synchronized void caseStarted(String id) {
    if(finished) return;
    var value=test(id);
    if(value.hasStarted) throw new IllegalStateException("Test already started");
    phase="tests"; value.status="running";
    value.hasStarted=true; value.active=true; value.started=clock.getAsLong();
    publish();
  }

  @Override public synchronized void observed(String id, Side side, int index, Observation execution) {
    if(finished) return;
    var value=test(id);
    int previous=side==Side.base?value.base:value.candidate;
    if(!value.active || index!=previous+1 || index>3 || execution.phase()!=Phase.runtime || !"terminal".equals(execution.status()))
      throw new IllegalStateException("Invalid comparison observation sequence");
    if(side==Side.base)value.base=index;else value.candidate=index;
    publish();
  }

  private void result(CaseState value, TestResult result) {
    value.base=result.baseExecutions().size(); value.candidate=result.candidateExecutions().size();
    if(value.active) value.elapsed=milliseconds(value.started);
    value.active=false;
    boolean cancelled=result.baseExecutions().stream().anyMatch(o->o.outcome()==ExecutionOutcome.cancelled)
        ||result.candidateExecutions().stream().anyMatch(o->o.outcome()==ExecutionOutcome.cancelled);
    value.completed=value.base==3&&value.candidate==3&&!cancelled;
    value.status=cancelled?"cancelled":result.matched()?"matched":result.outcome()==ComparisonOutcome.mismatch?"mismatch":"inconclusive";
    value.reasons=List.copyOf(result.reasons());
  }

  @Override public synchronized void caseFinished(TestResult result) {
    if(finished) return;
    result(test(result.caseId()),result); publish();
  }

  synchronized void finish(Comparison comparison, boolean userCancelled) {
    if(finished) return;
    for(var result:comparison.tests()) {
      var value=test(result.caseId());
      if(!value.hasStarted && result.baseExecutions().isEmpty() && result.candidateExecutions().isEmpty()) continue;
      result(value,result);
    }
    for(var value:cases.values()) {
      if(value.active) {
        value.elapsed=milliseconds(value.started); value.active=false;
        value.status=userCancelled?"cancelled":"inconclusive"; value.completed=false;
      } else if(value.status.equals("queued")) value.status="not_run";
      if(userCancelled && value.status.equals("inconclusive") && !value.completed) value.status="cancelled";
    }
    outcome=comparison.outcome().name(); reason=comparison.reason();
    phase=userCancelled?"cancelled":comparison.outcome()==ComparisonOutcome.compile_error?"compile_error":comparison.outcome()==ComparisonOutcome.unavailable?"unavailable":completed()==cases.size()?"finished":"inconclusive";
    finishClock(); publish();
  }

  synchronized void failed(String code) {
    if(finished) return;
    phase="failed"; reason=code;
    for(var value:cases.values()) {
      if(value.active) {value.elapsed=milliseconds(value.started);value.active=false;value.status="inconclusive";}
      else if(value.status.equals("queued")) value.status="not_run";
    }
    finishClock(); publish();
  }

  private void finishClock() { elapsed=milliseconds(started); finished=true; }
  private long completed() { return cases.values().stream().filter(value->value.completed).count(); }
  synchronized Long duration(String id) {
    var value=test(id);
    return value.hasStarted ? value.active?milliseconds(value.started):value.elapsed : null;
  }

  synchronized Map<String,Object> snapshot() {
    return map("binding",binding,"phase",phase,"finished",finished,"outcome",outcome,"reason",reason,
        "total",cases.size(),"completed",completed(),
        "matched",cases.values().stream().filter(value->value.status.equals("matched")).count(),
        "elapsedMs",finished?elapsed:milliseconds(started),"plannedRepeatCount",3,
        "cases",cases.values().stream().map(value->map("caseId",value.id,"name",value.name,"status",value.status,
            "baseObserved",value.base,"candidateObserved",value.candidate,"completed",value.completed,
            "elapsedMs",duration(value.id),"reasons",value.reasons)).toList());
  }
}
