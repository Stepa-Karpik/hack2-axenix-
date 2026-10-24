package dev.javablueprints.engine;

import dev.javablueprints.engine.EngineModel.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class SourcePositionsTest {
    @Test void positionsRespectEmptyLinesTabsSurrogatePairsAndEndOfFile() {
        for (String source : List.of("", "\n", "\n\n", "a", "a\n", "\tA😀\n\nкириллица\t😀\nlast", "a\nb\n")) {
            var positions = new SourcePositions(source);
            for (int offset = 0; offset <= source.length(); offset++) {
                String prefix = source.substring(0, offset);
                int line = 1 + (int)prefix.chars().filter(c -> c == '\n').count();
                int column = offset - prefix.lastIndexOf('\n');
                assertArrayEquals(new int[]{line, column}, positions.at(offset), source + " @" + offset);
            }
            assertThrows(IllegalArgumentException.class, () -> positions.at(-1));
            assertThrows(IllegalArgumentException.class, () -> positions.at(source.length() + 1));
        }
    }

    @Test void rangesStayExactAcrossManyLinesAndFiles() {
        StringBuilder text = new StringBuilder("// 😀\npackage demo;\nclass Main {\n");
        for (int method = 0; method < 60; method++) {
            text.append("\tString f").append(method).append("() {\n\t\tString value = \"😀").append(method)
                    .append("\";\n\t\tif (value.isEmpty()) return \"пусто\";\n\t\treturn value;\n\t}\n");
        }
        text.append("}\n");
        Map<String,String> files = Map.of("demo/Main.java", text.toString(), "demo/Other.java", "package demo;\nclass Other {\n\tint value() { return 42; }\n}\n");
        Analysis analysis = new ProgramEngine().inspect(new SourceBundle("positions", files));
        assertEquals("valid", analysis.parseStatus());
        assertEquals(61, analysis.graph().methods().size());
        List<SourceRange> ranges = new ArrayList<>();
        analysis.declarations().forEach(d -> ranges.add(d.sourceRange()));
        analysis.graph().methods().forEach(m -> ranges.add(m.sourceRange()));
        analysis.graph().nodes().forEach(n -> { ranges.add(n.sourceRange()); ranges.addAll(n.editableFieldRanges().values()); });
        analysis.semantics().symbols().forEach(s -> ranges.add(s.sourceRange()));
        analysis.semantics().references().forEach(r -> ranges.add(r.sourceRange()));
        analysis.quality().methods().forEach(m -> ranges.add(m.sourceRange()));
        analysis.quality().findings().forEach(f -> ranges.add(f.sourceRange()));
        for (SourceRange range : ranges) {
            if (range == null) continue;
            String source = files.get(range.filePath());
            assertNotNull(source);
            assertTrue(range.startOffset() >= 0 && range.endOffset() >= range.startOffset() && range.endOffset() <= source.length());
            assertPosition(source, range.startOffset(), range.startLine(), range.startColumn());
            assertPosition(source, range.endOffset(), range.endLine(), range.endColumn());
        }
        assertTrue(ranges.size() > 1000);
    }

    private void assertPosition(String source, int offset, int line, int column) {
        String prefix = source.substring(0, offset);
        assertEquals(1 + prefix.chars().filter(c -> c == '\n').count(), line);
        assertEquals(offset - prefix.lastIndexOf('\n'), column);
    }
}
