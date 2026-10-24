package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.commons.compress.archivers.zip.*;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

class TextTreeTest {
  MockMultipartFile upload(String path, byte[] bytes) {
    return new MockMultipartFile("files", path, "application/octet-stream", bytes);
  }

  byte[] zip(String name, byte[] content, int mode) throws IOException {
    var bytes = new ByteArrayOutputStream();
    try (var out = new ZipArchiveOutputStream(bytes)) {
      var entry = new ZipArchiveEntry(name);
      if (mode != 0) entry.setUnixMode(mode);
      out.putArchiveEntry(entry); out.write(content); out.closeArchiveEntry();
    }
    return bytes.toByteArray();
  }

  @Test void textTreeIncludesEmptyAndImplicitDirectoriesWithIndependentHash() {
    var tree = new TextTree(Map.of("src/Main.java", "class Main{}", "notes/План проекта.txt", "text"), List.of("empty"));
    assertEquals(Set.of("src", "notes", "empty"), tree.directories);
    assertEquals(Map.of("src/Main.java", "class Main{}"), tree.javaFiles());
    assertNotEquals(tree.hash(), new TextTree(tree.files, List.of()).hash());
    assertEquals(tree.hash(), new TextTree(new LinkedHashMap<>(tree.files), List.of("src", "empty", "notes")).hash());
    assertTrue(new TextTree(Map.of(), List.of()).javaFiles().isEmpty());
  }

  @Test void rejectsUnsafePathsAndFileDirectoryCollisions() {
    for (String path : List.of("../a", "/a", "C:/a", "a\\b", "a//b", "a/./b", "a/../b", "a/", "a\u0000b"))
      assertThrows(ApiError.class, () -> new TextTree(Map.of(path, "x"), List.of()), path);
    assertThrows(ApiError.class, () -> new TextTree(Map.of("a", "x", "a/b", "y"), List.of()));
    assertThrows(ApiError.class, () -> new TextTree(Map.of("a", "x"), List.of("a")));
    assertThrows(ApiError.class, () -> new TextTree(Map.of("src space/Main.java", ""), List.of()));
  }

  @Test void importKeepsOriginalDecodedBytesAndRejectsBinaryAndMalformedUtf8() throws Exception {
    String original = "\uFEFFline\r\ntext\r";
    var tree = TextTree.imports(List.of(upload("notes.txt", original.getBytes(StandardCharsets.UTF_8))), List.of("empty"));
    assertEquals(original, tree.files.get("notes.txt"));
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.txt", new byte[]{(byte)0xc3, 0x28})), List.of()));
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("binary", new byte[]{0, 1})), List.of()));
  }

  @Test void boundedZipRejectsTraversalSymlinksMalformedCrcAndBombs() throws Exception {
    var normal = zip("folder/notes.txt", "hello".getBytes(StandardCharsets.UTF_8), 0100644);
    assertEquals("hello", TextTree.imports(List.of(upload("source.zip", normal)), List.of()).files.get("folder/notes.txt"));
    for (String name : List.of("../outside.txt", "/absolute.txt", "C:/drive.txt")) {
      byte[] archive = zip(name, new byte[]{1}, 0100644);
      assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.zip", archive)), List.of()), name);
    }
    byte[] backslash = zip("a/b.txt", new byte[]{1}, 0100644);
    for (int i = 0; i < backslash.length - 7; i++)
      if (backslash[i] == 'a' && backslash[i+1] == '/' && backslash[i+2] == 'b') backslash[i+1] = '\\';
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.zip", backslash)), List.of()));
    byte[] symlink = zip("link", "target".getBytes(StandardCharsets.UTF_8), 0120777);
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.zip", symlink)), List.of()));
    byte[] bomb = zip("large.txt", new byte[1048577], 0100644);
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bomb.zip", bomb)), List.of()));
    byte[] badCrc = normal.clone();
    for (int i = 0; i < badCrc.length - 20; i++)
      if (badCrc[i] == 0x50 && badCrc[i+1] == 0x4b && badCrc[i+2] == 1 && badCrc[i+3] == 2) { badCrc[i+16] ^= 1; break; }
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.zip", badCrc)), List.of()));
    assertThrows(ApiError.class, () -> TextTree.imports(List.of(upload("bad.zip", Arrays.copyOf(normal, normal.length - 15))), List.of()));
  }

  @Test void combinedImplicitEntryAndActualByteLimitsApply() {
    var files = new TreeMap<String, String>();
    for (int i=0; i<51; i++) files.put("dir" + i + "/a.txt", "");
    assertThrows(ApiError.class, () -> new TextTree(files, List.of()));
    assertThrows(ApiError.class, () -> new TextTree(Map.of("large", "x".repeat(1048577)), List.of()));
    assertThrows(ApiError.class, () -> new TextTree(Map.of("unicode", "\ud800"), List.of()));
  }
}
