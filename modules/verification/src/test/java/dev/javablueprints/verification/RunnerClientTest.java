package dev.javablueprints.verification;
import static dev.javablueprints.verification.RunnerProtocol.*;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
class RunnerClientTest {
 @Test void ownershipIsCheckedBeforePublishingProgress() throws Exception {
  var progress=new AtomicInteger();var http=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  http.createContext("/internal/v1/executions",exchange->{
   Submit submit=JSON.readValue(exchange.getRequestBody(),Submit.class);
   var wrong=new Observation(submit.projectId(),submit.jobId(),submit.attemptId(),"wrong-execution",submit.specHash(),Phase.compile,"running",null,null,Bytes.text("private output"),Bytes.text(""),false,null,false);
   byte[] bytes=JSON.writeValueAsBytes(wrong);exchange.sendResponseHeaders(202,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
  });http.start();
  try {
   var client=new RunnerClient(URI.create("http://127.0.0.1:"+http.getAddress().getPort()),"unit-test");
   assertThrows(java.io.IOException.class,()->client.execute("project","job","attempt",1,RunnerClient.compileSpec(Map.of("Main.java","class Main {}")),()->false,o->progress.incrementAndGet()));
   assertEquals(0,progress.get());
  } finally {http.stop(0);}
 }
 @Test void compilerCleanupFailureStopsBeforeSubmittingAnotherExecution() throws Exception {
  var calls=new AtomicInteger();var http=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  http.createContext("/internal/v1/health",exchange->{byte[] bytes=JSON.writeValueAsBytes(Map.of("available",true));exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();});
  http.createContext("/internal/v1/executions",exchange->{
   calls.incrementAndGet();Submit submit=JSON.readValue(exchange.getRequestBody(),Submit.class);
   var observation=new Observation(submit.projectId(),submit.jobId(),submit.attemptId(),submit.executionId(),submit.specHash(),Phase.compile,"terminal",ExecutionOutcome.exited,0,Bytes.text(""),Bytes.text(""),false,"artifact",true);
   byte[] bytes=JSON.writeValueAsBytes(observation);exchange.sendResponseHeaders(202,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
  });http.start();
  try{var client=new RunnerClient(URI.create("http://127.0.0.1:"+http.getAddress().getPort()),"unit-test");
   var result=client.compare("p","j","a",1,Map.of("Main.java","class Main {}"),Map.of("Main.java","class Main {}"),"Main",List.of(new TestCase("case1","",List.of(),0,null,null)));
   assertEquals(ComparisonOutcome.inconclusive,result.outcome());assertEquals("cleanup_pending",result.reason());assertEquals(1,calls.get());assertFalse(result.coverageComplete());assertEquals(0,result.matched());
  }finally{http.stop(0);}
 }
}
