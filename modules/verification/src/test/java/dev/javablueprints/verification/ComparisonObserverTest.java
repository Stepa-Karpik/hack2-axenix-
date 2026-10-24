package dev.javablueprints.verification;

import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;

class ComparisonObserverTest {
  private record Fixture(HttpServer server, RunnerClient client, AtomicInteger runtimeCalls) implements AutoCloseable {
    public void close() { server.stop(0); }
  }

  private Fixture fixture(boolean foreignRuntime) throws Exception {
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    var runtimeCalls=new AtomicInteger();
    var outputs=new HashMap<String,String>();
    server.createContext("/internal/v1/health",exchange->{
      byte[] bytes=JSON.writeValueAsBytes(Map.of("available",true));
      exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
    });
    server.createContext("/internal/v1/executions",exchange->{
      Submit submit=JSON.readValue(exchange.getRequestBody(),Submit.class);
      boolean compile=submit.executionSpec().phase()==Phase.compile;
      String artifact=compile?"artifact-"+submit.executionId():null;
      if(compile) outputs.put(artifact,new String(submit.executionSpec().sources().get("Main.java").decode(MAX_OUTPUT),java.nio.charset.StandardCharsets.UTF_8).contains("different")?"changed":"base");
      else runtimeCalls.incrementAndGet();
      var result=new Observation(submit.projectId(),!compile&&foreignRuntime?"foreign":submit.jobId(),submit.attemptId(),submit.executionId(),submit.specHash(),submit.executionSpec().phase(),"terminal",ExecutionOutcome.exited,0,Bytes.text(compile?"":outputs.get(submit.executionSpec().compileArtifactId())),Bytes.text(""),false,artifact,false);
      byte[] bytes=JSON.writeValueAsBytes(result);
      exchange.sendResponseHeaders(202,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
    });
    server.start();
    return new Fixture(server,new RunnerClient(URI.create("http://127.0.0.1:"+server.getAddress().getPort()),"unit-test"),runtimeCalls);
  }

  @Test void reportsRealObservationOrderAndUsesTheSameComparatorVerdict() throws Exception {
    try(var fixture=fixture(false)) {
      var events=new ArrayList<String>();
      var observer=new ComparisonObserver() {
        public void phase(Stage stage) { events.add(stage.name()); }
        public void caseStarted(String id) { events.add("start:"+id); }
        public void observed(String id,Side side,int index,Observation execution) { events.add(side.name()+":"+index); }
        public void caseFinished(TestResult result) { events.add("result:"+result.outcome()); }
      };
      var result=fixture.client.compare("p","j","a",1,Map.of("Main.java","class Main {}"),Map.of("Main.java","class Main {int different;}"),"Main",List.of(new TestCase("one","",List.of(),0,null,null)),()->false,observer);
      assertEquals(List.of("compile_base","compile_candidate","tests","start:one","base:1","candidate:1","base:2","candidate:2","base:3","candidate:3","result:mismatch"),events);
      assertEquals(ComparisonOutcome.mismatch,result.outcome());
      assertEquals(3,result.observedBaseCount());assertEquals(3,result.observedCandidateCount());
      assertEquals(6,fixture.runtimeCalls.get());
    }
  }

  @Test void cancellationAfterOneObservationDoesNotStartTheOtherVersion() throws Exception {
    try(var fixture=fixture(false)) {
      var cancel=new AtomicBoolean();var observations=new AtomicInteger();
      var observer=new ComparisonObserver() {
        public void observed(String id,Side side,int index,Observation execution) { observations.incrementAndGet();cancel.set(true); }
      };
      var result=fixture.client.compare("p","j","a",1,Map.of("Main.java","class Main {}"),Map.of("Main.java","class Main {}"),"Main",List.of(new TestCase("one","",List.of(),0,null,null)),cancel::get,observer);
      assertEquals(1,observations.get());assertEquals(1,fixture.runtimeCalls.get());
      assertEquals(1,result.observedBaseCount());assertEquals(0,result.observedCandidateCount());
      assertEquals(ComparisonOutcome.inconclusive,result.outcome());assertFalse(result.coverageComplete());
    }
  }

  @Test void foreignResultsNeverReachTheObservationCallback() throws Exception {
    try(var fixture=fixture(true)) {
      var observations=new AtomicInteger();
      var observer=new ComparisonObserver() {
        public void observed(String id,Side side,int index,Observation execution) { observations.incrementAndGet(); }
      };
      var result=fixture.client.compare("p","j","a",1,Map.of("Main.java","class Main {}"),Map.of("Main.java","class Main {}"),"Main",List.of(new TestCase("one","",List.of(),0,null,null)),()->false,observer);
      assertEquals(0,observations.get());assertEquals(0,result.observedBaseCount());
      assertEquals(ComparisonOutcome.inconclusive,result.outcome());
    }
  }
}
