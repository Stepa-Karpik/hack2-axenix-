/** Read the native machine-channel token without rounding JSON integer values in JS. */
export function methodReturnText(raw: unknown, parsed: unknown): string {
  if (typeof raw === "string" && raw.length <= 65536) {
    const key = '"returnValue":';
    const field = raw.indexOf(key);
    if (field >= 0) {
      let start = field + key.length;
      while (/\s/.test(raw[start] ?? "") && start < raw.length) start++;
      let depth = 0,
        quoted = false,
        escaped = false;
      for (let index = start; index < raw.length; index++) {
        const char = raw[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "[" || char === "{") depth++;
        else if (char === "]" || char === "}") {
          if (depth === 0) return raw.slice(start, index).trim();
          depth--;
        } else if (char === "," && depth === 0)
          return raw.slice(start, index).trim();
      }
    }
  }
  if (
    typeof parsed === "number" &&
    Number.isInteger(parsed) &&
    !Number.isSafeInteger(parsed)
  )
    return "Точное значение доступно только в исходном канале результата";
  return JSON.stringify(parsed) ?? "null";
}
