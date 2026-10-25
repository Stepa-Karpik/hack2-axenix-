package dev.javablueprints.server;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import com.github.javaparser.StaticJavaParser;
import dev.javablueprints.verification.RunnerProtocol;
import java.util.*;

class MethodHarnessTest {
    // Fixture text is parsed/rewritten only, never compiled or executed on the host.
    final Map<String,String> sources=Map.of("Maths.java","public class Maths { public static int call(int x){return x+1;} public static long call(long x){return x+2;} private static int hidden(){return 1;} public int instance(){return 1;} public static void mutate(int[] xs){xs[0]++;} }");
    Map<String,Object> target(String name,String...params){return Map.of("ownerType","Maths","methodName",name,"parameterTypes",List.of(params));}
    @Test void exactOverloadsAndExplicitUnsupportedMembers() {
        assertEquals(5,MethodHarness.targets(sources).size());
        assertEquals("int",MethodHarness.validateTarget(sources,target("call","int")).get("returnType"));
        assertEquals("long",MethodHarness.validateTarget(sources,target("call","long")).get("returnType"));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.validateTarget(sources,target("call","short")));
        assertEquals("method_private",assertThrows(IllegalArgumentException.class,()->MethodHarness.validateTarget(sources,target("hidden"))).getMessage());
        assertEquals("fresh_no_arg_instance",MethodHarness.validateTarget(sources,target("instance")).get("receiver"));
    }
    @Test void instanceTargetsUseFreshNoArgReceiverOnly() {
        var bounded=Map.of("Box.java","package p; public class Box { private int n; public Box(int n){this.n=n;} public int get(){return n;} }",
            "Abs.java","package p; public abstract class Abs { public int one(){return 1;} public abstract int two(); }",
            "Counter.java","package p; public class Counter { private int n=5; public Counter(){System.out.print(\"ctor;\");} public int add(int x){n+=x;return n;} }");
        var rows=MethodHarness.targets(bounded);
        java.util.function.Function<String,Map<String,Object>> row=name->rows.stream().filter(r->r.get("methodName").equals(name)).findFirst().orElseThrow();
        assertEquals("receiver_constructor_unsupported",row.apply("get").get("reason"));
        assertEquals("receiver_constructor_unsupported",row.apply("one").get("reason"));
        assertEquals(true,row.apply("add").get("supported"));
        var driver=MethodHarness.prepare(bounded,Map.of("ownerType","p.Counter","methodName","add","parameterTypes",List.of("int")),List.of(Map.of("arguments",List.of(3)),Map.of("arguments",List.of(4)))).get("__JbMethodHarness.java");
        // Every case constructs its own receiver; constructor failure is incomplete, not a method throw.
        assertEquals(2,driver.split("__jbReceiver=new p\\.Counter\\(\\)",-1).length-1);
        assertTrue(driver.contains("__jbReceiver.add(p0)"));
        assertTrue(driver.contains("catch(java.lang.Throwable error){java.nio.file.Files.writeString"));
        assertDoesNotThrow(()->StaticJavaParser.parse(driver));
    }
    @Test void generatedDirectDriverParsesAndPreservesUserSource() {
        var result=MethodHarness.prepare(sources,target("call","long"),List.of(Map.of("arguments",List.of("9223372036854775807"))));
        assertEquals(sources.get("Maths.java"),result.get("Maths.java"));
        String driver=result.get("__JbMethodHarness.java");
        assertTrue(driver.contains("long p0=9223372036854775807L"));assertTrue(driver.contains("Maths.call(p0)"));
        assertFalse(driver.contains("getDeclaredMethod"));assertFalse(driver.contains("Class.forName"));
        assertDoesNotThrow(()->StaticJavaParser.parse(driver));
    }
    @Test void arrayMutationAndVoidDriverHaveTypedInputs() {
        var driver=MethodHarness.prepare(sources,target("mutate","int[]"),List.of(Map.of("arguments",List.of(List.of(1,2))))).get("__JbMethodHarness.java");
        assertTrue(driver.contains("int[] p0=new int[]{1,2}"));assertTrue(driver.contains("Maths.mutate(p0);finish(null,null,inputs)"));
        assertDoesNotThrow(()->StaticJavaParser.parse(driver));
    }
    @Test void typedInputRejectsExpressionsOverflowNullPrimitivesAndOversizedArrays() {
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("int",RunnerProtocol.JSON.valueToTree("System.exit(0)")));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("byte",RunnerProtocol.JSON.valueToTree(128)));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("int",RunnerProtocol.JSON.nullNode()));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("int[]",RunnerProtocol.JSON.valueToTree(Collections.nCopies(257,0))));
        assertEquals("null",MethodHarness.literal("String",RunnerProtocol.JSON.nullNode()));
        assertEquals("(char)10",MethodHarness.literal("char",RunnerProtocol.JSON.valueToTree("\n")));
    }
    @Test void utf16QuotesAndControlInputCannotBreakGeneratedJava() {
        String literal=MethodHarness.literal("String",RunnerProtocol.JSON.valueToTree("\";\n\\u000a😀"));
        assertTrue(literal.startsWith("new java.lang.String(new char[]{"));
        assertDoesNotThrow(()->StaticJavaParser.parseExpression(literal));
    }
    @Test void typedExpectedLongStringsAndArrayPoststateRetainExactValues() throws Exception {
        var binding=MethodHarness.validateTarget(sources,target("call","long"));
        var expected=Map.of("complete",true,"completion","return","returnValue","9007199254740995","exception",RunnerProtocol.JSON.nullNode(),"argumentsAfter",List.of("9007199254740993"));
        String normalized=RunnerProtocol.JSON.writeValueAsString(MethodHarness.normalizeExpected(binding,expected));
        assertTrue(normalized.contains("\"returnValue\":9007199254740995"));assertTrue(normalized.contains("\"argumentsAfter\":[9007199254740993]"));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.normalizeExpected(binding,Map.of("complete",true,"completion","return","returnValue","9223372036854775808","exception",RunnerProtocol.JSON.nullNode(),"argumentsAfter",List.of(1))));
    }
    @Test void methodProfileBindsActualDriverAndArgumentSnapshotPrecedesExceptionAccessors() {
        assertTrue(MethodHarness.TEMPLATE.indexOf("after.add(value(a))")<MethodHarness.TEMPLATE.indexOf("java.lang.String exception=error"));
        assertTrue(MethodHarness.TEMPLATE.indexOf("java.lang.String returned=")<MethodHarness.TEMPLATE.indexOf("java.lang.String exception=error"));
        assertNotEquals(dev.javablueprints.verification.MethodContract.PROFILE_HASH,MethodHarness.profileHash());
        assertTrue(MethodHarness.profileHash().matches("[a-f0-9]{64}"));
    }
    @Test void methodOracleAndObservationArePlainJsonAcrossJackson2ToJackson3Boundary() {
        var binding=MethodHarness.validateTarget(sources,target("call","long"));
        var expected=Map.of("complete",true,"completion","return","returnValue","9007199254740995","exception",RunnerProtocol.JSON.nullNode(),"argumentsAfter",List.of("9007199254740993"));
        var normalized=MethodHarness.normalizeExpected(binding,expected);
        var jackson3=tools.jackson.databind.json.JsonMapper.builder().build();
        String persisted=jackson3.writeValueAsString(normalized);
        assertTrue(persisted.contains("\"complete\":true"));assertTrue(persisted.contains("\"returnValue\":9007199254740995"));assertFalse(persisted.contains("containerNode"));
        String view=jackson3.writeValueAsString(dev.javablueprints.verification.MethodContract.view(RunnerProtocol.Bytes.text(persisted)));
        assertTrue(view.contains("\"argumentsAfter\":[9007199254740993]"));assertFalse(view.contains("nodeType"));
    }
    @Test void consoleObservationKeepsExactStreamsAndNullOptionalMethodFields() {
        Workspace workspace=org.mockito.Mockito.mock(Workspace.class);
        org.mockito.Mockito.when(workspace.artifact(org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.anyString(),org.mockito.ArgumentMatchers.any(byte[].class))).thenReturn("artifact");
        JobWorker worker=new JobWorker(workspace,false,"http://127.0.0.1:8091","");
        try {
            var observation=new RunnerProtocol.Observation("p","j","a","e","hash",RunnerProtocol.Phase.runtime,"terminal",RunnerProtocol.ExecutionOutcome.exited,0,RunnerProtocol.Bytes.text("Привет\n"),RunnerProtocol.Bytes.text("exact stderr\n"),false,null,false);
            var view=worker.observation("p",observation);
            assertEquals("Привет\n",view.get("stdoutUtf8"));assertEquals("exact stderr\n",view.get("stderrUtf8"));assertNull(view.get("methodResult"));assertNull(view.get("methodResultRaw"));
            String encoded=tools.jackson.databind.json.JsonMapper.builder().build().writeValueAsString(view);
            assertTrue(encoded.contains("\"methodResult\":null"));assertFalse(encoded.contains("containerNode"));assertFalse(encoded.contains("nodeType"));
        } finally {worker.heartbeat.shutdownNow();worker.workers.shutdownNow();}
    }
    // Organizer-style monolith: default package, package-private static helpers, JDK collections.
    final Map<String,String> monolith=Map.of("Mess.java","""
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;
        import java.util.Scanner;
        import java.util.TreeSet;
        public class Mess {
            static int calls;
            static List<Integer> primes(int limit){return new ArrayList<>();}
            static int count(List<String> words, Map<String,Integer> seen){return 0;}
            static long[][] multiply(long[][] a,long[][] b){return a;}
            static Optional<String> find(String title){return Optional.empty();}
            static int readSize(Scanner in){return in.nextInt();}
            static TreeSet<Integer> unique(int[] xs){return new TreeSet<>();}
            protected static int prot(){return 1;}
            private static int hidden(){return 0;}
            static List raw(){return null;}
            static List<? extends Number> wild(){return null;}
            static Scanner leak(){return null;}
            static TreeSet<List<Integer>> unsorted(){return null;}
        }
        """);
    Map<String,Object> row(Map<String,String> files,String name){return MethodHarness.targets(files).stream().filter(r->r.get("methodName").equals(name)).findFirst().orElseThrow();}
    @Test void defaultPackagePackagePrivateStaticHelpersAreDirectTargets() {
        for(var name:List.of("primes","count","multiply","find","readSize","unique","prot")) {
            var r=row(monolith,name);assertEquals(true,r.get("supported"),name+" "+r.get("reason"));assertEquals("direct",r.get("invocation"));
        }
        assertEquals("package",row(monolith,"primes").get("access"));
        assertEquals(List.of("java.util.List<java.lang.String>","java.util.Map<java.lang.String,java.lang.Integer>"),row(monolith,"count").get("javaParameterTypes"));
        assertEquals("method_private",row(monolith,"hidden").get("reason"));
        for(var name:List.of("raw","wild","leak","unsorted"))assertEquals("type_adapter_unsupported",row(monolith,name).get("reason"),name);
        var files=MethodHarness.prepare(monolith,Map.of("ownerType","Mess","methodName","count","parameterTypes",List.of("List<String>","Map<String,Integer>")),
            List.of(Map.of("arguments",List.of(List.of("a","b"),List.of(List.of("a",1),List.of("c",2))))));
        String driver=files.get("__JbMethodHarness.java");
        assertEquals(2,files.size());assertEquals(monolith.get("Mess.java"),files.get("Mess.java"));
        assertTrue(driver.contains("java.util.List<java.lang.String> p0=__JbMethodHarness.fill(new java.util.ArrayList<java.lang.String>(),"),driver);
        assertTrue(driver.contains("java.util.Map<java.lang.String,java.lang.Integer> p1=__JbMethodHarness.put(new java.util.HashMap<java.lang.String,java.lang.Integer>(),"));
        assertTrue(driver.contains("java.lang.Integer.valueOf(1)"));assertTrue(driver.contains("Mess.count(p0,p1)"));
        assertDoesNotThrow(()->StaticJavaParser.parse(driver));
    }
    @Test void collectionOptionalScannerAndMatrixAdaptersAreLiteralOnly() {
        assertEquals("java.util.Optional.empty()",MethodHarness.literal("java.util.Optional<java.lang.String>",RunnerProtocol.JSON.valueToTree(Map.of("present",false))));
        assertTrue(MethodHarness.literal("java.util.Optional<java.lang.String>",RunnerProtocol.JSON.valueToTree(Map.of("present",true,"value","x"))).startsWith("java.util.Optional.of(new java.lang.String("));
        assertTrue(MethodHarness.literal("java.util.Scanner",RunnerProtocol.JSON.valueToTree("5\n")).startsWith("new java.util.Scanner(new java.lang.String("));
        assertEquals("new long[][]{new long[]{1L,2L},new long[]{3L}}",MethodHarness.literal("long[][]",RunnerProtocol.JSON.valueToTree(List.of(List.of(1,2),List.of(3)))));
        var dup=RunnerProtocol.JSON.valueToTree(List.of(List.of("a",1),List.of("a",2)));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("java.util.Map<java.lang.String,java.lang.Integer>",dup));
        var nullInTree=RunnerProtocol.JSON.createArrayNode().add(RunnerProtocol.JSON.nullNode());
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("java.util.TreeSet<java.lang.Integer>",nullInTree));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("java.util.List<java.lang.Integer>",RunnerProtocol.JSON.valueToTree("System.exit(0)")));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.literal("java.util.List<java.lang.Integer>",RunnerProtocol.JSON.valueToTree(Collections.nCopies(257,0))));
        // Expected values: maps are ordered [key,value] pairs, Scanner poststate is opaque null.
        var binding=row(monolith,"count");
        var expected=Map.of("complete",true,"completion","return","returnValue",3,"exception",RunnerProtocol.JSON.nullNode(),"argumentsAfter",List.of(List.of("a"),List.of(List.of("a","9"))));
        assertTrue(assertDoesNotThrow(()->RunnerProtocol.JSON.writeValueAsString(MethodHarness.normalizeExpected(binding,expected))).contains("[[\"a\",9]]"));
        var scanner=row(monolith,"readSize");
        var badScanner=Map.of("complete",true,"completion","return","returnValue",3,"exception",RunnerProtocol.JSON.nullNode(),"argumentsAfter",List.of("rest"));
        assertThrows(IllegalArgumentException.class,()->MethodHarness.normalizeExpected(scanner,badScanner));
    }
    @Test void shadowedJdkNamesAreNotAdapted() {
        var shadow=Map.of("Mess.java","import java.util.*; public class Mess { static int n(List<Integer> xs){return 0;} static int m(Map<String,Integer> xs){return 0;} }","List.java","class List<T> {}");
        assertEquals("type_adapter_unsupported",row(shadow,"n").get("reason"));
        assertEquals(true,row(shadow,"m").get("supported"));
        var awt=Map.of("Mess.java","import java.awt.List; public class Mess { static int n(List xs){return 0;} }");
        assertEquals("type_adapter_unsupported",row(awt,"n").get("reason"));
    }
    @Test void namedPackageNonPublicTargetsUseSamePackageBridgeNotReflection() {
        var packaged=Map.of("src/p/Hidden.java","package p; class Hidden { static int twice(int x){return 2*x;} Hidden(){} int inc(int x){return x+1;} }");
        assertEquals("package_bridge",row(packaged,"twice").get("invocation"));
        var files=MethodHarness.prepare(packaged,Map.of("ownerType","p.Hidden","methodName","twice","parameterTypes",List.of("int")),List.of(Map.of("arguments",List.of(3))));
        String bridge=files.get("p/__JbMethodAccess.java"),driver=files.get("__JbMethodHarness.java");
        assertTrue(bridge.startsWith("\npackage p;")||bridge.startsWith("package p;"));assertTrue(bridge.contains("public static int call(int a0) throws java.lang.Throwable {return Hidden.twice(a0);}"));
        assertTrue(driver.contains("p.__JbMethodAccess.call(p0)"));
        assertFalse(bridge.contains("getDeclaredMethod")||bridge.contains("setAccessible")||driver.contains("setAccessible"));
        var instance=MethodHarness.prepare(packaged,Map.of("ownerType","p.Hidden","methodName","inc","parameterTypes",List.of("int")),List.of(Map.of("arguments",List.of(3)))).get("p/__JbMethodAccess.java");
        assertTrue(instance.contains("return new Hidden();"));assertTrue(instance.contains("call(java.lang.Object receiver,int a0)"));assertTrue(instance.contains("((Hidden)receiver).inc(a0)"));
        assertDoesNotThrow(()->StaticJavaParser.parse(bridge));assertDoesNotThrow(()->StaticJavaParser.parse(instance));assertDoesNotThrow(()->StaticJavaParser.parse(driver));
        var collide=Map.of("src/p/__JbMethodAccess.java","package p; public class __JbMethodAccess {}","src/p/Hidden.java","package p; class Hidden { static int twice(int x){return 2*x;} }");
        assertThrows(IllegalArgumentException.class,()->MethodHarness.prepare(collide,Map.of("ownerType","p.Hidden","methodName","twice","parameterTypes",List.of("int")),List.of(Map.of("arguments",List.of(3)))));
    }
    @Test void organizerMonolithHelpersBecomeTargets() throws Exception {
        var dir=java.nio.file.Path.of("../../modules/program-engine/src/test/resources/organizer");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.isDirectory(dir));
        for(var name:List.of("NumberCruncherMess","TextAnalyzerMess","LibraryManagerMess")) {
            var file=dir.resolve(name+".java.txt");org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.exists(file));
            var rows=MethodHarness.targets(Map.of(name+".java",java.nio.file.Files.readString(file)));
            long supported=rows.stream().filter(r->Boolean.TRUE.equals(r.get("supported"))).count();
            var unsupported=rows.stream().filter(r->!Boolean.TRUE.equals(r.get("supported"))).map(r->r.get("methodName")+":"+r.get("reason")).toList();
            System.out.println(name+" targets="+rows.size()+" supported="+supported+" unsupported="+unsupported);
            assertTrue(supported>=rows.size()-2,name+" "+unsupported);
        }
    }
}
