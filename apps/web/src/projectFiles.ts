import type { Method } from "./types.ts";
export interface FileSnapshot {
  files: Record<string, string>;
  directories: string[];
}
export function directoryPaths(
  files: Record<string, string>,
  explicit: string[] = [],
) {
  const result = new Set(explicit);
  for (const path of [...Object.keys(files), ...explicit]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      result.add(parts.slice(0, i).join("/"));
  }
  return [...result].sort();
}
export function validatePath(path: string) {
  if (
    !path ||
    path.length > 240 ||
    path !== path.trim() ||
    /[\\\x00-\x1f:*?"<>|]/.test(path) ||
    path
      .split("/")
      .some(
        (p) =>
          !p || p === "." || p === ".." || p !== p.trim() || p.endsWith("."),
      )
  )
    throw new Error(
      "Укажите относительный путь без пустых частей, .. и служебных символов.",
    );
  return path;
}
export function movePath(
  snapshot: FileSnapshot,
  from: string,
  to: string,
): FileSnapshot {
  validatePath(to);
  if (from === to) return snapshot;
  const directories = directoryPaths(snapshot.files, snapshot.directories);
  if (!(from in snapshot.files) && !directories.includes(from))
    throw new Error("Файл или папка больше не существует.");
  if (to.startsWith(from + "/"))
    throw new Error("Нельзя переместить папку внутрь себя.");
  const affected = (path: string) =>
    path === from || path.startsWith(from + "/");
  const map = (path: string) =>
    affected(path) ? to + path.slice(from.length) : path;
  const occupied = [...Object.keys(snapshot.files), ...directories].filter(
    (p) => !affected(p),
  );
  if (
    occupied.some(
      (p) =>
        p === to ||
        p.startsWith(to + "/") ||
        (to.startsWith(p + "/") && p in snapshot.files),
    )
  )
    throw new Error("Этот путь уже занят. Выберите другое имя.");
  return {
    files: Object.fromEntries(
      Object.entries(snapshot.files).map(([p, t]) => [map(p), t]),
    ),
    directories: directories.map(map),
  };
}
export function addPath(
  snapshot: FileSnapshot,
  path: string,
  folder: boolean,
): FileSnapshot {
  validatePath(path);
  const dirs = directoryPaths(snapshot.files, snapshot.directories);
  if (
    path in snapshot.files ||
    dirs.includes(path) ||
    Object.keys(snapshot.files).some((p) => path.startsWith(p + "/"))
  )
    throw new Error("Этот путь уже занят. Выберите другое имя.");
  return folder
    ? { ...snapshot, directories: [...dirs, path] }
    : { ...snapshot, files: { ...snapshot.files, [path]: "" } };
}
export function languageFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        java: "java",
        py: "python",
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        md: "markdown",
        html: "html",
        css: "css",
        xml: "xml",
        yaml: "yaml",
        yml: "yaml",
        sql: "sql",
        sh: "shell",
        ps1: "powershell",
      } as Record<string, string>
    )[ext] ?? "plaintext"
  );
}
export function methodIdentity(method?: Method) {
  return method
    ? {
        filePath: method.sourceRange.filePath,
        signature: method.signature,
        fullyQualifiedName: method.fullyQualifiedName,
      }
    : undefined;
}
// Filename hint only. Compilation remains the authority for Java validity.
export function publicJavaType(source: string): string | undefined {
  if (/\\u+[\da-fA-F]{4}/.test(source)) return undefined;
  let code = "";
  for (let i = 0; i < source.length;) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end;
      code += " ";
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      code += " ";
    } else if (source[i] === '"' || source[i] === "'") {
      const delimiter = source.startsWith('"""', i) ? '"""' : source[i];
      i += delimiter.length;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source.startsWith(delimiter, i)) {
          i += delimiter.length;
          break;
        } else i++;
      }
      code += " ";
    } else code += source[i++];
  }
  const tokens =
    code.match(/[\p{ID_Start}_$][\p{ID_Continue}$]*|[{}();]/gu) ?? [];
  let depth = 0,
    parentheses = 0,
    isPublic = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") depth++;
    else if (token === "}") depth--;
    else if (token === "(") parentheses++;
    else if (token === ")") parentheses--;
    else if (depth === 0 && parentheses === 0) {
      if (token === ";") isPublic = false;
      else if (token === "public") isPublic = true;
      else if (
        isPublic &&
        ["class", "interface", "enum", "record"].includes(token)
      ) {
        const name = tokens[i + 1];
        return name && /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(name)
          ? name
          : undefined;
      }
    }
  }
}
export function matchingMethod(
  methods: Method[],
  identity?: ReturnType<typeof methodIdentity>,
) {
  return identity
    ? methods.find(
        (m) =>
          m.sourceRange.filePath === identity.filePath &&
          m.signature === identity.signature &&
          m.fullyQualifiedName === identity.fullyQualifiedName,
      )
    : undefined;
}
export function remapModels(
  models: Record<string, string>,
  from: string,
  to: string,
) {
  return Object.fromEntries(
    Object.entries(models).map(([path, id]) => [
      path === from || path.startsWith(from + "/")
        ? to + path.slice(from.length)
        : path,
      id,
    ]),
  );
}
