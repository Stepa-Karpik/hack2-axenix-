package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class CaseLabelEditsTest {
    private final ProgramEngine engine=new ProgramEngine();
    private Candidate replace(String source, String label, String replacement) {
        var bundle=new SourceBundle("case",Map.of("Main.java",source));
        var analysis=engine.inspect(bundle);
        int start=source.indexOf(label,source.indexOf("switch"));
        var node=analysis.graph().nodes().stream().filter(n->n.kind().equals("expression")&&n.sourceRange().startOffset()==start
                &&n.sourceRange().endOffset()==start+label.length()).findFirst().orElseThrow();
        return engine.propose(bundle,analysis,new EditCommand("case",analysis.id(),node.methodId(),node.id(),"replace_expression",new ReplaceExpression("expression",replacement),"semantic_edit"));
    }
    @Test void refusesDecodedDuplicateIntegersCharactersAndStringLiterals() {
        for(String replacement:List.of("2","0x2","02","'\\u0002'","+2")) {
            String source="class Main {int f(int value){switch(value){case 1:return 3;case 2:return 4;default:return 5;}}}";
            var error=assertThrows(EngineException.class,()->replace(source,"1",replacement));
            assertEquals("UNSUPPORTED_OPERATION",error.code());
            assertTrue(error.getMessage().contains("duplicate"),error.getMessage());
        }
        var duplicateString=assertThrows(EngineException.class,()->replace("class Main {int f(String value){switch(value){case \"a\":return 1;case \"b\":return 2;default:return 0;}}}","\"a\"","\"\\u0062\""));
        assertTrue(duplicateString.getMessage().contains("duplicate"),duplicateString.getMessage());
    }
    @Test void acceptsSignedCharactersAndStringsButRefusesUnknownOrDifferentKinds() {
        String numeric="class Main {int f(int value){switch(value){case 1:return 3;default:return 5;}}}";
        for(String literal:List.of("-2","'a'","0x7fffffff","(-1)"))
            assertEquals("valid",replace(numeric,"1",literal).parseStatus());
        for(String unknown:List.of("next()","VALUE","1+2","\"text\"","null"))
            assertEquals("UNSUPPORTED_OPERATION",assertThrows(EngineException.class,()->replace(numeric,"1",unknown)).code());
        String strings="class Main {int f(String value){switch(value){case \"a\":return 1;default:return 0;}}}";
        assertTrue(replace(strings,"\"a\"","\"Ж:😀\"").files().get("Main.java").contains("case (\"Ж:😀\"):"));
    }
    @Test void compoundAndCommentedLabelsRetainReadOnlyProjection() {
        for(String label:List.of("1+2","(1 /* keep */)","VALUE")) {
            String source="class Main {static final int VALUE=7;int f(int value){switch(value){case "+label+":return 1;default:return 0;}}}";
            var analysis=engine.inspect(new SourceBundle("case",Map.of("Main.java",source)));
            int start=source.indexOf(label,source.indexOf("switch")),end=start+label.length();
            assertTrue(analysis.graph().nodes().stream().filter(n->n.kind().equals("expression")&&n.sourceRange().startOffset()>=start&&n.sourceRange().endOffset()<=end)
                    .allMatch(n->n.allowedOperations().isEmpty()));
        }
    }
}
