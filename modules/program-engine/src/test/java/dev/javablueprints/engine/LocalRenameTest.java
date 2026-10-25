package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Parser and semantic checks only; no fixture is compiled or run on the host. */
class LocalRenameTest {
    private final ProgramEngine engine=new ProgramEngine();
    private Candidate rename(String source,String method,String statement,String name,String intent) {
        var bundle=new SourceBundle("rename-source",Map.of("Main.java",source,"Keep.java","class Keep {}\n"));
        var analysis=engine.inspect(bundle);
        assertEquals("valid",analysis.parseStatus());
        var callable=analysis.graph().methods().stream().filter(m->m.signature().startsWith(method+"(")).findFirst().orElseThrow();
        var selected=analysis.graph().nodes().stream().filter(n->n.methodId().equals(callable.id())
            && (statement==null ? n.id().equals(callable.entryNodeId()) : n.kind().equals("ExpressionStmt")
                && n.sourceRange()!=null && n.sourceRange().startOffset()==source.indexOf(statement))).findFirst().orElseThrow();
        assertTrue(selected.allowedOperations().contains("rename_local"));
        return engine.propose(bundle,analysis,new EditCommand(bundle.revisionId(),analysis.id(),callable.id(),selected.id(),"rename_local",new RenameLocal(name),intent));
    }
    private Candidate rename(String source,String method,String statement,String name) {return rename(source,method,statement,name,"preserve_behavior");}
    @Test void renamesOnlyExactLocalBindingAcrossFieldShadowingOverloadsAndOtherScopes() {
        String source="class Main { int value=9; int f(int input) { int value=input+1; return value+this.value; } int f() { int value=3; return value; } }\n";
        var candidate=rename(source,"f","int value=input+1;","result");
        assertEquals(source.replace("int value=input+1; return value+this.value;","int result=input+1; return result+this.value;"),candidate.files().get("Main.java"));
        assertEquals(2,candidate.changes().size());
        assertEquals("class Keep {}\n",candidate.files().get("Keep.java"));
    }
    @Test void preservesCommentsStringsTabsAndUnicodeWhileRenamingMultipleReadsWrites() {
        String source="class Main { int f() {\n\t// счёт 😀\n\tint счёт=1; счёт++; String s=\"счёт\"; return счёт;\n} }\n";
        var candidate=rename(source,"f","int счёт=1;","сумма");
        assertEquals(source.replace("int счёт=1; счёт++;","int сумма=1; сумма++;").replace("return счёт;","return сумма;"),candidate.files().get("Main.java"));
        assertEquals(3,candidate.changes().size());
    }
    @Test void soleParameterUsesEntryAndRetainsDeclarationSignatureTypesAndCallers() {
        String source="class Main { static int f(int value) { return value*value; } int g() { return f(3); } }\n";
        var candidate=rename(source,"f",null,"count");
        assertEquals(source.replace("f(int value) { return value*value; }","f(int count) { return count*count; }"),candidate.files().get("Main.java"));
        assertEquals(3,candidate.changes().size());
    }
    @Test void rejectsCollisionWithLocalFieldAndCaptureOfUnqualifiedFieldUse() {
        for(String source:new String[]{
            "class Main { int f() { int value=1; int total=2; return value+total; } }",
            "class Main { int total; int f() { int value=1; return value+total; } }",
            "class Main { int f() { int value=1; { int total=2; } return value; } }"}) {
            var error=assertThrows(EngineException.class,()->rename(source,"f","int value=1;","total"));
            assertTrue(error.getMessage().contains("collid"));
        }
    }
    @Test void unresolvedOldNameBeforeDeclarationIsRefused() {
        var error=assertThrows(EngineException.class,()->rename("class Main { int f() { value++; int value=1; return value; } }","f","int value=1;","total"));
        assertTrue(error.getMessage().contains("unresolved"));
    }
    @Test void nestedLambdaIsExplicitlyRefused() {
        var analysis=engine.inspect(new SourceBundle("r",Map.of("Main.java","class Main { int f() { int value=1; Runnable r=()->System.out.println(value); return value; } }")));
        assertFalse(analysis.graph().nodes().stream().anyMatch(n->n.allowedOperations().contains("rename_local")));
    }
    @Test void noOpInvalidNamesAndSemanticIntentAreRefused() {
        String source="class Main { int f() { int value=1; return value; } }";
        for(String name:new String[]{"value","class","bad-name","_","yield"}) assertThrows(EngineException.class,()->rename(source,"f","int value=1;",name));
        assertThrows(EngineException.class,()->rename(source,"f","int value=1;","total","semantic_edit"));
    }
    @Test void entryWithSeveralParametersAndMultivariableStatementDoNotAdvertiseRename() {
        var analysis=engine.inspect(new SourceBundle("r",Map.of("Main.java","class Main { int f(int one,int two) { int a=1,b=2; return a+b+one+two; } }")));
        assertFalse(analysis.graph().nodes().stream().anyMatch(n->n.allowedOperations().contains("rename_local")));
    }
}
