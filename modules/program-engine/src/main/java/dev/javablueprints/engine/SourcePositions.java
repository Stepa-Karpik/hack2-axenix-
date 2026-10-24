package dev.javablueprints.engine;

import java.util.Arrays;

/** Reusable line index over canonical LF text. Offsets and columns count UTF-16 code units. */
final class SourcePositions {
    private final int length;
    private final int[] lineStarts;

    SourcePositions(String source) {
        length = source.length();
        int lines = 1;
        for (int offset = 0; offset < length; offset++) if (source.charAt(offset) == '\n') lines++;
        lineStarts = new int[lines];
        int line = 1;
        for (int offset = 0; offset < length; offset++) {
            if (source.charAt(offset) == '\n') lineStarts[line++] = offset + 1;
        }
    }

    int[] at(int offset) {
        if (offset < 0 || offset > length) throw new IllegalArgumentException("Offset outside source");
        int line = Arrays.binarySearch(lineStarts, offset);
        if (line < 0) line = -line - 2;
        return new int[]{line + 1, offset - lineStarts[line] + 1};
    }
}
