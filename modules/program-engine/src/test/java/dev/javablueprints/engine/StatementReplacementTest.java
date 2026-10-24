package dev.javablueprints.engine;

import static dev.javablueprints.engine.EngineModel.*;
import static org.junit.jupiter.api.Assertions.*;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StatementReplacementTest {
    final ProgramEngine engine=new ProgramEngine();
    final String source="// Сохранить вступление\npublic class Main { static void f() { int value = 5; System.out.println(value); } } // сохранить хвост\n";
    @Test void replacesTheWholeSelectedStatementWithoutChangingItsNeighborsOrComments() {
        var bundle=new SourceBundle("base",Map.of("Main.java",source));
        var analysis=engine.inspect(bundle);
        var node=analysis.graph().nodes().stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().contains("println")&&n.allowedOperations().contains("replace_statement")).findFirst().orElseThrow();
        var result=engine.propose(bundle,analysis,new EditCommand("base",analysis.id(),node.methodId(),node.id(),"replace_statement",new ReplaceStatement("System.out.println(value + 1);"),"semantic_edit"));
        assertEquals(source.replace("System.out.println(value);","System.out.println(value + 1);"),result.files().get("Main.java"));
        assertEquals(1,result.changes().size());
        assertEquals("unverified",result.verificationStatus());
    }
    @Test void rejectsMultipleStatementsAndStaleNodeBindings() {
        var bundle=new SourceBundle("base",Map.of("Main.java",source));var a=engine.inspect(bundle);
        var node=a.graph().nodes().stream().filter(n->n.allowedOperations().contains("replace_statement")).findFirst().orElseThrow();
        assertThrows(EngineException.class,()->engine.propose(bundle,a,new EditCommand("base",a.id(),node.methodId(),node.id(),"replace_statement",new ReplaceStatement("int a = 1; int b = 2;"),"semantic_edit")));
        assertThrows(EngineException.class,()->engine.propose(bundle,a,new EditCommand("base","stale",node.methodId(),node.id(),"replace_statement",new ReplaceStatement("int a = 1;"),"semantic_edit")));
    }
    @Test void commentedStatementsDoNotOfferAReplacementThatDiscardsTheirComment() {
        var a=engine.inspect(new SourceBundle("comments",Map.of("Main.java","class Main { static void f() { System.out.println(/* keep */ 5); } }")));
        var node=a.graph().nodes().stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().contains("println")).findFirst().orElseThrow();
        assertFalse(node.allowedOperations().contains("replace_statement"));
    }
    @Test void replacementCannotEscapeItsStatementWrapper() {
        var bundle=new SourceBundle("base",Map.of("Main.java",source));
        var analysis=engine.inspect(bundle);
        var node=analysis.graph().nodes().stream().filter(n->n.kind().equals("ExpressionStmt")&&n.label().contains("println")).findFirst().orElseThrow();
        for(String payload:java.util.List.of("System.out.println(value); } static void injected() {", "System.out.println(value); } // ignored tail", "System.out.println(value);\n}\nclass Extra {}")) {
            assertThrows(EngineException.class,()->engine.propose(bundle,analysis,new EditCommand("base",analysis.id(),node.methodId(),node.id(),"replace_statement",new ReplaceStatement(payload),"semantic_edit")),payload);
        }
    }
}
