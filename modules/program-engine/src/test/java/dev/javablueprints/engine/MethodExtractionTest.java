package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class MethodExtractionTest {
    final ProgramEngine engine=new ProgramEngine();
    SourceBundle bundle(String source) { return new SourceBundle("base",Map.of("Main.java",source,"Other.java","// keep 😀\nclass Other {}\n")); }
    GraphNode node(Analysis a,String label) {
        return a.graph().nodes().stream().filter(n->n.label().equals(label) && n.allowedOperations().contains("extract_method")).findFirst().orElseThrow(()->new AssertionError(label));
    }
    Candidate extract(SourceBundle b,String first,String last,String name) {
        Analysis a=engine.inspect(b); GraphNode start=node(a,first),end=node(a,last);
        return engine.propose(b,a,new EditCommand(b.revisionId(),a.id(),start.methodId(),start.id(),"extract_method",new ExtractMethod(name,end.id()),"preserve_behavior"));
    }
    void fails(String fragment,String first,String last) {
        assertThrows(EngineException.class,()->extract(bundle(fragment),first,last,"extracted"));
    }
    @Test void inferredInputAndDeclaredOutputPreserveTailCompanionsAndSource() {
        var b=bundle("class Main {static int calc(int seed){int result = seed * 3; result += 2; return result;}}\n");
        var c=extract(b,"int result = seed * 3;","result += 2;","scaled");
        assertEquals(List.of(new ExtractionParameter("seed","int")),c.extraction().parameters());
        assertEquals("result",c.extraction().returnedVariable());assertEquals("int",c.extraction().returnType());assertTrue(c.extraction().isStatic());
        assertTrue(c.files().get("Main.java").contains("int result = scaled(seed); return result;"));
        assertTrue(c.files().get("Main.java").contains("private static int scaled(int seed)"));
        assertTrue(c.files().get("Main.java").contains("int result = seed * 3; result += 2;"));
        assertEquals(b.files().get("Other.java"),c.files().get("Other.java"));
        assertEquals("not_requested",c.compileStatus());assertEquals("unverified",c.verificationStatus());
        assertEquals("valid",engine.inspect(new SourceBundle("new",c.files())).parseStatus());
    }
    @Test void modifiedParameterIsPassedAndAssignedBackOnlyWhenLive() {
        var c=extract(bundle("class Main {int f(int x){x++; return x;}}"),"x++;","x++;","increment");
        assertTrue(c.files().get("Main.java").contains("x = increment(x); return x;"));
        assertEquals(List.of(new ExtractionParameter("x","int")),c.extraction().parameters());assertFalse(c.extraction().isStatic());
        var ignored=extract(bundle("class Main {void f(int x){x++;}}"),"x++;","x++;","increment");
        assertEquals("void",ignored.extraction().returnType());assertTrue(ignored.files().get("Main.java").contains("increment(x);}"));
    }
    @Test void writeOnlyUninitializedOutputDoesNotBecomeAnUninitializedArgument() {
        var c=extract(bundle("class Main {int f(int seed){int value; value = seed + 2; return value;}}"),"value = seed + 2;","value = seed + 2;","makeValue");
        assertEquals(List.of(new ExtractionParameter("seed","int")),c.extraction().parameters());
        assertTrue(c.files().get("Main.java").contains("value = makeValue(seed); return value;"));
        assertTrue(c.files().get("Main.java").contains("int value;\n"));
    }
    @Test void conditionalWriteCarriesInitialValueIntoHelper() {
        var c=extract(bundle("class Main {int f(int value,boolean flag){if(flag){value=7;} return value;}}"),"if(flag){value=7;}","if(flag){value=7;}","choose");
        assertEquals(Set.of("flag","value"),new HashSet<>(c.extraction().parameters().stream().map(ExtractionParameter::name).toList()));
        assertEquals("value",c.extraction().returnedVariable());
    }
    @Test void whileConditionBeforeSelectionKeepsWrittenValueLiveAcrossBackedge() {
        var c=extract(bundle("class Main {static void f(){int value=0;while(value<3){value++;}}}"),"value++;","value++;","advance");
        assertEquals("value",c.extraction().returnedVariable());
        assertEquals("int",c.extraction().returnType());
        assertEquals(List.of(new ExtractionParameter("value","int")),c.extraction().parameters());
        assertTrue(c.files().get("Main.java").contains("while(value<3){value = advance(value);}"));
    }
    @Test void forConditionAndUpdateBeforeBodySelectionRetainWrittenOutput() {
        var c=extract(bundle("class Main {static void f(){int value=0;for(;value<3;){value++;}}}"),"value++;","value++;","advance");
        assertEquals("value",c.extraction().returnedVariable());
        assertTrue(c.files().get("Main.java").contains("for(;value<3;){value = advance(value);}"));
        var updated=extract(bundle("class Main {static void f(){int value=0;for(int pass=0;pass<3;value++){value=pass+2;pass++;}}}"),"value=pass+2;","value=pass+2;","choose");
        assertEquals("value",updated.extraction().returnedVariable());
        assertTrue(updated.files().get("Main.java").contains("value = choose(pass);pass++;"));
    }
    @Test void doBodyEarlierReadAndConditionKeepWrittenValueLive() {
        var c=extract(bundle("class Main {static void f(){int value=0;do{if(value>=3)break;value++;}while(true);}}"),"value++;","value++;","advance");
        assertEquals("value",c.extraction().returnedVariable());
        assertTrue(c.files().get("Main.java").contains("if(value>=3)break;value = advance(value);"));
        var conditioned=extract(bundle("class Main {static void f(){int value=0;do{value++;}while(value<3);}}"),"value++;","value++;","advance");
        assertEquals("value",conditioned.extraction().returnedVariable());
    }
    @Test void nestedLoopBackedgeReadsOutsideSelectedSpanRetainWrittenOutput() {
        var c=extract(bundle("class Main {static void f(){int value=0;while(value<3){for(int pass=0;pass<1;pass++){value++;}}}}"),"value++;","value++;","advance");
        assertEquals("value",c.extraction().returnedVariable());
        assertEquals(List.of(new ExtractionParameter("value","int")),c.extraction().parameters());
        assertTrue(c.files().get("Main.java").contains("pass++){value = advance(value);}"));
    }
    @Test void escapingConstantVariableDeclarationCannotBecomeRuntimeInitializedOutput() {
        for(String type:List.of("String","java.lang.String","var")) {
            String declaration="final "+type+" text=\"x\";";
            var b=bundle("class Main {static boolean f(){"+declaration+"return (text+\"y\")==\"xy\";}}");
            var error=assertThrows(EngineException.class,()->extract(b,declaration,declaration,"makeText"),type);
            assertEquals("UNSUPPORTED_OPERATION",error.code());
        }
        fails("class Main {static int f(){final int count=3;return count+1;}}","final int count=3;","final int count=3;");
    }
    @Test void constantVariableInputCannotLoseConstantExpressionStatusInParameter() {
        for(String type:List.of("String","java.lang.String","var")) {
            String returning="return (text+\"y\")==\"xy\";";
            var b=bundle("class Main {static boolean f(){final "+type+" text=\"x\";"+returning+"}}");
            var error=assertThrows(EngineException.class,()->extract(b,returning,returning,"sameText"),type);
            assertEquals("UNSUPPORTED_OPERATION",error.code());
        }
        fails("class Main {static int f(){final int count=3;return count+1;}}","return count+1;","return count+1;");
    }
    @Test void constantDeclarationStayingInsideExtractedTailRetainsItsInitializer() {
        var c=extract(bundle("class Main {static boolean f(){final String text=\"x\";return (text+\"y\")==\"xy\";}}"),"final String text=\"x\";","return (text+\"y\")==\"xy\";","sameText");
        assertTrue(c.files().get("Main.java").contains("final String text=\"x\";return (text+\"y\")==\"xy\";"));
        assertNull(c.extraction().returnedVariable());
        assertEquals(List.of(),c.extraction().parameters());
    }
    @Test void oneDeclarationAloneCanReturnTheValueNeededByCaller() {
        var c=extract(bundle("class Main {int f(int seed){int answer = seed + 1; return answer;}}"),"int answer = seed + 1;","int answer = seed + 1;","answerFor");
        assertEquals("answer",c.extraction().returnedVariable());assertEquals("int",c.extraction().returnType());
        assertTrue(c.files().get("Main.java").contains("int answer = answerFor(seed); return answer;"));
    }
    @Test void lastReturnAndInternalLoopJumpsRemainInsideHelper() {
        var c=extract(bundle("class Main {static int f(int n){int sum=0;for(int i=0;i<n;i++){if(i==2)continue;if(i==7)break;sum+=i;}return sum;}}"),"int sum=0;","return sum;","sumFor");
        assertTrue(c.files().get("Main.java").contains("return sumFor(n);}"));assertNull(c.extraction().returnedVariable());
        assertTrue(c.files().get("Main.java").contains("continue;if(i==7)break;"));
    }
    @Test void nestedBodyStatementAndExactUnicodeCommentsStayIntact() {
        var c=extract(bundle("// 😀\nclass Main {void f(int x){if(x>0){/* before */System.out.println(\"Привет 😀\" + x); // after\n}}}"),"System.out.println(\"Привет 😀\" + x);","System.out.println(\"Привет 😀\" + x);","printValue");
        assertTrue(c.files().get("Main.java").contains("/* before */printValue(x); // after"));
        assertTrue(c.files().get("Main.java").contains("System.out.println(\"Привет 😀\" + x);"));
        assertEquals("void",c.extraction().returnType());
    }
    @Test void arraysAndMutableInstanceFieldsKeepTheirReceiverAndAliasing() {
        var c=extract(bundle("class Main {int total; void f(int[] xs){xs[0]++; total += xs[0];}}"),"xs[0]++;","total += xs[0];","update");
        assertEquals(List.of(new ExtractionParameter("xs","int[]")),c.extraction().parameters());
        assertTrue(c.files().get("Main.java").contains("private void update(int[] xs)"));
        assertTrue(c.files().get("Main.java").contains("total += xs[0];"));
    }
    @Test void checkedThrowIsDeclaredWhenCatchRemainsInCaller() {
        var c=extract(bundle("class Main {void f(){try{throw new java.io.IOException(\"x\");}catch(java.io.IOException e){System.out.print(e.getMessage());}}}"),"throw new java.io.IOException(\"x\");","throw new java.io.IOException(\"x\");","fail");
        assertTrue(c.files().get("Main.java").contains("fail() throws java.io.IOException"));
    }
    @Test void internallyCaughtCheckedExceptionDoesNotLeakFromHelper() {
        var b=bundle("class Main {void f(){try{throw new java.io.IOException(\"x\");}catch(java.io.IOException e){System.out.print(e.getMessage());}}}");
        var a=engine.inspect(b);var node=a.graph().nodes().stream().filter(n->n.kind().equals("try_entry")).findFirst().orElseThrow();
        var c=engine.propose(b,a,new EditCommand("base",a.id(),node.methodId(),node.id(),"extract_method",new ExtractMethod("handle",node.id()),"preserve_behavior"));
        assertTrue(c.files().get("Main.java").contains("handle() {"));
    }
    private Candidate extractTryAt(String source,String marker,String helper) {
        var b=bundle(source);var a=engine.inspect(b);
        var node=a.graph().nodes().stream().filter(n->n.kind().equals("try_entry") && n.sourceRange()!=null
                && n.sourceRange().startOffset()==source.indexOf(marker)).findFirst().orElseThrow();
        return engine.propose(b,a,new EditCommand("base",a.id(),node.methodId(),node.id(),"extract_method",new ExtractMethod(helper,node.id()),"preserve_behavior"));
    }
    private static final String CHECKED_RESOURCE=" class R implements AutoCloseable {R() throws java.io.IOException {} public void close() {}}";
    @Test void internallyCaughtCheckedResourceAcquisitionDoesNotLeakFromHelper() {
        String source="class Main {void f(){try(R resource=new R()){System.out.print(\"ok\");}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_RESOURCE;
        var c=extractTryAt(source,"try(R","acquire");
        assertTrue(c.files().get("Main.java").contains("private void acquire() {"),c.files().get("Main.java"));
        assertFalse(c.files().get("Main.java").contains("acquire() throws java.io.IOException"));
    }
    @Test void checkedExceptionThrownByCatchIsNotCaughtByTheSameResourceTry() {
        String source="class Main {void f(){try{try(R resource=new R()){}catch(java.io.IOException e){throw new java.io.IOException(\"handler\");}}catch(java.io.IOException outer){System.out.print(\"outer\");}}}"+CHECKED_RESOURCE;
        var c=extractTryAt(source,"try(R","acquire");
        assertTrue(c.files().get("Main.java").contains("private void acquire() throws java.io.IOException"),c.files().get("Main.java"));
    }
    @Test void checkedExceptionThrownByFinallyIsNotCaughtByTheSameResourceTry() {
        String source="class Main {void f(){try{try(R resource=new R()){}catch(java.io.IOException e){}finally{throw new java.io.IOException(\"cleanup\");}}catch(java.io.IOException outer){System.out.print(\"outer\");}}}"+CHECKED_RESOURCE;
        var c=extractTryAt(source,"try(R","acquire");
        assertTrue(c.files().get("Main.java").contains("private void acquire() throws java.io.IOException"),c.files().get("Main.java"));
    }
    private static final String CHECKED_CLOSE_RESOURCE=" class R implements AutoCloseable {public void close() throws java.io.IOException {}}";
    @Test void implicitCheckedCloseIsDeclaredWhenCatchRemainsOutsideSelectedTry() {
        String source="class Main {void f(){try{try(R resource=new R()) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE;
        var c=extractTryAt(source,"try(R","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.io.IOException"),c.files().get("Main.java"));
    }
    @Test void implicitlyCheckedCloseUsesDeclaredResourceTypeNotInitializerSubtype() {
        String source="class Main {void f(){try{try(AutoCloseable resource=new R()) {}}catch(Exception e){System.out.print(\"caught\");}}} class R implements AutoCloseable {public void close() {}}";
        var c=extractTryAt(source,"try(AutoCloseable","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.lang.Exception"),c.files().get("Main.java"));
    }
    @Test void closeExceptionsCaughtInsideSelectedTryDoNotLeak() {
        String source="class Main {void f(){try(R resource=new R()){}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE;
        var c=extractTryAt(source,"try(R","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() {"),c.files().get("Main.java"));
        String nested="class Main {void f(){try{try(R resource=new R()) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE;
        var all=extractTryAt(nested,"try{","cleanup");
        assertTrue(all.files().get("Main.java").contains("private void cleanup() {"),all.files().get("Main.java"));
    }
    @Test void inheritedCloseAndReusedResourceKeepExactCheckedContract() {
        String source="class Main {void f(){R resource=new R();try{try(resource) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}} class Base implements AutoCloseable {public void close() throws java.io.IOException {} public void close(int ignored) throws java.sql.SQLException {}} class R extends Base {}";
        var c=extractTryAt(source,"try(resource)","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup(R resource) throws java.io.IOException"),c.files().get("Main.java"));
        assertFalse(c.files().get("Main.java").contains("cleanup(R resource) throws java.sql.SQLException"));
    }
    @Test void overridingNoThrowCloseDoesNotInheritAutoCloseableException() {
        String source="class Main {void f(){try(R resource=new R()) {}}} class R implements AutoCloseable {public void close() {}}";
        var c=extractTryAt(source,"try(R","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() {"),c.files().get("Main.java"));
    }
    @Test void multipleResourceCloseContractsAreCollectedWithDeterministicOrder() {
        String source="class Main {void f(){try{try(R first=new R();S second=new S()) {}}catch(java.io.IOException|java.sql.SQLException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE+" class S implements AutoCloseable {public void close() throws java.sql.SQLException {}}";
        var c=extractTryAt(source,"try(R","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.io.IOException, java.sql.SQLException"),c.files().get("Main.java"));
    }
    @Test void implicitCloseInSelectedFinallyIsNotHandledBySameTryCatch() {
        String source="class Main {void f(){try{try{System.out.print(\"body\");}catch(RuntimeException e){}finally{try(R resource=new R()) {}}}catch(java.io.IOException e){System.out.print(\"outer\");}}}"+CHECKED_CLOSE_RESOURCE;
        var c=extractTryAt(source,"try{System","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.io.IOException"),c.files().get("Main.java"));
    }
    @Test void inferredVarAndFieldResourceCloseUseTheirStaticTypes() {
        String inferred="class Main {void f(){try{try(var resource=new R()) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE;
        var c=extractTryAt(inferred,"try(var","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.io.IOException"),c.files().get("Main.java"));
        String field="class Main {final R resource=new R();void f(){try{try(this.resource) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}}"+CHECKED_CLOSE_RESOURCE;
        var accessed=extractTryAt(field,"try(this.resource)","cleanup");
        assertTrue(accessed.files().get("Main.java").contains("private void cleanup() throws java.io.IOException"),accessed.files().get("Main.java"));
    }
    @Test void uncheckedCloseExceptionsDoNotWidenTheHelperCheckedContract() {
        String source="class Main {void f(){try(R resource=new R()) {}}} class R implements AutoCloseable {public void close() throws IllegalStateException {}}";
        var c=extractTryAt(source,"try(R","cleanup");
        assertTrue(c.files().get("Main.java").contains("private void cleanup() {"),c.files().get("Main.java"));
    }
    @Test void implicitClosePreservesExistingCallerThrowsAndInheritedJdkCloseableContract() {
        String source="class Main {void f() throws java.io.IOException {try(java.io.Closeable resource=new R()) {}}}"+CHECKED_CLOSE_RESOURCE.replace("implements AutoCloseable","implements java.io.Closeable");
        var c=extractTryAt(source,"try(java.io.Closeable","cleanup");
        assertTrue(c.files().get("Main.java").contains("void f() throws java.io.IOException"));
        assertTrue(c.files().get("Main.java").contains("private void cleanup() throws java.io.IOException"),c.files().get("Main.java"));
    }
    @Test void genericCloseExceptionAndIncomparableInterfaceContractsAreExplicitlyRefused() {
        String generic="class Main {void f(R<java.io.IOException> resource){try{try(resource) {}}catch(java.io.IOException e){System.out.print(\"caught\");}}} class R<E extends Exception> implements AutoCloseable {public void close() throws E {}}";
        var genericError=assertThrows(EngineException.class,()->extractTryAt(generic,"try(resource)","cleanup"));
        assertEquals("UNSUPPORTED_OPERATION",genericError.code());assertTrue(genericError.getMessage().contains("implicit close()"));
        String multiple="class Main {void f(Both resource){try(resource) {}}} interface A extends AutoCloseable {void close() throws java.io.IOException;} interface B extends AutoCloseable {void close() throws java.sql.SQLException;} interface Both extends A,B {}";
        var multipleError=assertThrows(EngineException.class,()->extractTryAt(multiple,"try(resource)","cleanup"));
        assertEquals("UNSUPPORTED_OPERATION",multipleError.code());assertTrue(multipleError.getMessage().contains("implicit close()"));
    }
    @Test void escapingJumpsNonTailReturnMultipleOutputsAndUnknownBindingsAreRefused() {
        fails("class Main {void f(){while(true){break;}}}","break;","break;");
        fails("class Main {int f(boolean b){if(b){return 1;}return 2;}}","if(b){return 1;}","if(b){return 1;}");
        fails("class Main {int f(){int a=1;int b=2;return a+b;}}","int a=1;","int b=2;");
        fails("class Main {void f(){missing++;}}","missing++;","missing++;");
    }
    @Test void exceptionsCannotLoseLiveLocalWritesObservedByAnOuterHandler() {
        fails("class Main {int f(){int value=0;try{value=1;throw new RuntimeException();}catch(RuntimeException e){return value;}}}","value=1;","throw new RuntimeException();");
    }
    @Test void sameBlockNameCollisionAndPreservationIntentAreValidated() {
        var b=bundle("class Main {void f(int x){x++;if(x>0){x--;}} void taken(){}}"); var a=engine.inspect(b);
        GraphNode start=node(a,"x++;"),end=node(a,"x--;");
        assertThrows(EngineException.class,()->engine.propose(b,a,new EditCommand("base",a.id(),start.methodId(),start.id(),"extract_method",new ExtractMethod("safe",end.id()),"preserve_behavior")));
        assertThrows(EngineException.class,()->extract(b,"x++;","x++;","taken"));
        assertThrows(EngineException.class,()->extract(b,"x++;","x++;","toString"));
        assertThrows(EngineException.class,()->extract(b,"x++;","x++;","not valid"));
        assertThrows(EngineException.class,()->engine.propose(b,a,new EditCommand("base",a.id(),start.methodId(),start.id(),"extract_method",new ExtractMethod("safe",start.id()),"semantic_edit")));
    }
}
