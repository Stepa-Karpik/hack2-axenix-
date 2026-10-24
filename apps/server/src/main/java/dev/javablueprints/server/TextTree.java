package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import java.util.zip.CRC32;
import org.apache.commons.compress.archivers.zip.ZipFile;
import org.apache.commons.compress.utils.SeekableInMemoryByteChannel;
import org.springframework.web.multipart.MultipartFile;

/** The bounded text snapshot boundary, independent of Java analysis and execution. */
final class TextTree {
  static final int MAX_BYTES = 1048576, MAX_ENTRIES = 100;
  final SortedMap<String, String> files;
  final SortedSet<String> directories;

  TextTree(Map<String, String> files, Collection<String> directories) {
    this.files = new TreeMap<>(files);
    this.directories = new TreeSet<>();
    long bytes = 0;
    for (String directory : directories) {
      path(directory);
      if (!this.directories.add(directory)) throw invalid("Duplicate directory path");
    }
    for (var file : this.files.entrySet()) {
      path(file.getKey());
      if (file.getValue() == null) throw invalid("Text content required");
      bytes += utf8(file.getValue()).length;
      if (file.getValue().indexOf(0) >= 0) throw invalid("Binary files are unsupported");
      if (file.getKey().endsWith(".java")) {
        try { dev.javablueprints.verification.RunnerProtocol.path(file.getKey()); }
        catch (IllegalArgumentException e) { throw invalid("Unsupported Java source path"); }
      }
      parents(file.getKey(), this.directories);
    }
    for (String directory : List.copyOf(this.directories)) parents(directory, this.directories);
    for (String directory : this.directories)
      if (this.files.containsKey(directory)) throw conflict("File and directory paths collide");
    if (bytes > MAX_BYTES || this.files.size() + this.directories.size() > MAX_ENTRIES)
      throw limit();
  }

  static void path(String path) {
    if (path == null || path.isBlank() || path.length() > 240 || path.startsWith("/")
        || path.indexOf('\\') >= 0 || path.indexOf(':') >= 0
        || path.codePoints().anyMatch(c -> Character.isISOControl(c) || c == 127))
      throw invalid("Unsafe relative path");
    for (String part : path.split("/", -1))
      if (part.isEmpty() || part.equals(".") || part.equals("..")) throw invalid("Unsafe relative path");
    utf8(path);
  }

  static void parents(String path, Set<String> directories) {
    for (int slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1))
      directories.add(path.substring(0, slash));
  }

  static byte[] utf8(String text) {
    try {
      ByteBuffer b = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(text));
      byte[] bytes = new byte[b.remaining()]; b.get(bytes); return bytes;
    } catch (CharacterCodingException e) { throw invalid("Text must contain valid Unicode"); }
  }

  static String decode(byte[] bytes) {
    try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
    catch (CharacterCodingException e) { throw invalid("Only strict UTF-8 text files are supported"); }
  }

  static TextTree imports(List<MultipartFile> uploads, List<String> directories) throws IOException {
    if (uploads.size() > MAX_ENTRIES) throw limit();
    var files = new TreeMap<String, String>();
    var dirs = new ArrayList<>(directories);
    if (uploads.size() == 1 && Objects.toString(uploads.getFirst().getOriginalFilename(), "").toLowerCase(Locale.ROOT).endsWith(".zip")) {
      var upload = uploads.getFirst();
      if (upload.getSize() > MAX_BYTES) throw limit();
      byte[] archive = upload.getBytes();
      try (var channel = new SeekableInMemoryByteChannel(archive);
          var zip = ZipFile.builder().setSeekableByteChannel(channel).get()) {
        var entries = zip.getEntries();
        var seen = new HashSet<String>();
        long total = 0; int count = 0;
        while (entries.hasMoreElements()) {
          var entry = entries.nextElement();
          if (++count > MAX_ENTRIES) throw limit();
          String name = entry.getName();
          String rawName = decode(entry.getRawName());
          if (rawName.indexOf('\\') >= 0 || !rawName.equals(name)) throw invalid("Unsafe ZIP entry name");
          boolean directory = entry.isDirectory();
          if (directory) name = name.substring(0, name.length() - 1);
          path(name);
          int type = entry.getUnixMode() & 0170000;
          if (entry.isUnixSymlink() || (type != 0 && type != 0100000 && type != 0040000)
              || (type == 0040000 && !directory) || (type == 0100000 && directory)
              || entry.getGeneralPurposeBit().usesEncryption() || !zip.canReadEntryData(entry))
            throw invalid("Unsupported ZIP entry type or encryption");
          if (!seen.add(name)) throw invalid("Duplicate ZIP path");
          if (entry.getSize() < 0 || entry.getSize() > MAX_BYTES - total) throw limit();
          byte[] bytes;
          try (var input = zip.getInputStream(entry)) { bytes = input.readNBytes((int)(MAX_BYTES - total) + 1); }
          total += bytes.length;
          if (total > MAX_BYTES) throw limit();
          var crc = new CRC32(); crc.update(bytes);
          if (bytes.length != entry.getSize() || crc.getValue() != entry.getCrc()) throw invalid("Corrupt ZIP entry");
          if (directory) {
            if (bytes.length != 0) throw invalid("Directory contains data");
            dirs.add(name);
          } else files.put(name, decode(bytes));
        }
      } catch (ApiError e) { throw e; }
      catch (IOException | IllegalArgumentException e) { throw invalid("Invalid ZIP archive"); }
    } else {
      long total = 0;
      for (var upload : uploads) {
        if (upload.getSize() > MAX_BYTES - total) throw limit();
        byte[] bytes = upload.getBytes(); total += bytes.length;
        if (total > MAX_BYTES) throw limit();
        if (files.put(upload.getOriginalFilename(), decode(bytes)) != null) throw invalid("Duplicate file path");
      }
    }
    return new TextTree(files, dirs);
  }

  Map<String, String> javaFiles() {
    var java = new TreeMap<String, String>();
    files.forEach((p, text) -> { if (p.endsWith(".java")) java.put(p, text); });
    return java;
  }

  Map<String, Object> preview() {
    return map("files", files.entrySet().stream().map(e -> map("path", e.getKey(), "content", e.getValue())).toList(),
        "directories", List.copyOf(directories));
  }

  String hash() {
    try {
      var bytes = new ByteArrayOutputStream();
      try (var data = new DataOutputStream(bytes)) {
        data.writeUTF("text-tree-v1");
        for (String directory : directories) { data.writeByte(0); write(data, directory); }
        for (var e : files.entrySet()) { data.writeByte(1); write(data, e.getKey()); write(data, e.getValue()); }
      }
      return Workspace.hash(bytes.toByteArray());
    } catch (IOException e) { throw new IllegalStateException(e); }
  }

  static void write(DataOutputStream out, String value) throws IOException { byte[] b = utf8(value); out.writeInt(b.length); out.write(b); }
  static ApiError invalid(String message) { return new ApiError(400, "INVALID_REQUEST", message); }
  static ApiError conflict(String message) { return new ApiError(409, "FILE_CONFLICT", message); }
  static ApiError limit() { return new ApiError(413, "INPUT_LIMIT_EXCEEDED", "Text tree limit is 100 entries and 1 MiB"); }
}
