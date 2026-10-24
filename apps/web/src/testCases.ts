export interface EditableCase {
  id: string;
  name?: string | null;
  stdinUtf8?: string;
  argv?: string[];
  expectedStdout?: string | null;
  expectedStderr?: string | null;
  expectedExitCode?: number | null;
  expectedExitCodes?: number[] | null;
  tags?: unknown;
}
export interface ParsedCases {
  cases: EditableCase[] | null;
  error: string | null;
}
const fields = new Set([
  "id",
  "name",
  "stdinUtf8",
  "argv",
  "expectedStdout",
  "expectedStderr",
  "expectedExitCode",
  "expectedExitCodes",
  "tags",
]);
const bytes = (text: string) => new TextEncoder().encode(text).length;
function wellFormed(text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
    if (code > 0xffff) i++;
  }
  return true;
}
const exitCode = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -2147483648 &&
  value <= 2147483647;

function safeNumbers(value: unknown) {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (
      typeof current === "number" &&
      (!Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current)))
    )
      return false;
    if (Array.isArray(current)) for (const item of current) pending.push(item);
    else if (current && typeof current === "object")
      for (const item of Object.values(current)) pending.push(item);
  }
  return true;
}

export function parseCases(raw: string): ParsedCases {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cases: null, error: "Исправьте JSON тестов" };
  }
  if (!Array.isArray(parsed))
    return { cases: null, error: "Нужен массив тестов" };
  if (parsed.length > 100)
    return { cases: null, error: "Не больше 100 тестов" };
  if (!safeNumbers(parsed))
    return {
      cases: null,
      error:
        "Число в JSON нельзя сохранить точно. Большие значения задавайте строкой.",
    };
  const ids = new Set<string>();
  let limitError: string | null = null;
  const limit = (index: number, message: string) => {
    limitError ??= `Тест ${index + 1}: ${message}`;
  };
  const invalid = (index: number, message: string): ParsedCases => ({
    cases: null,
    error: `Тест ${index + 1}: ${message}`,
  });
  for (let i = 0; i < parsed.length; i++) {
    const test = parsed[i];
    if (!test || typeof test !== "object" || Array.isArray(test))
      return invalid(i, "нужен объект");
    const unknown = Object.keys(test).filter((key) => !fields.has(key));
    if (unknown.length)
      return invalid(i, "неизвестные поля: " + unknown.join(", "));
    if (typeof test.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(test.id))
      return invalid(
        i,
        "id должен содержать 1–100 латинских букв, цифр, _ или -",
      );
    if (ids.has(test.id)) return invalid(i, "id повторяется");
    ids.add(test.id);
    if (test.name != null && typeof test.name !== "string")
      return invalid(i, "name должен быть текстом");
    if (test.stdinUtf8 !== undefined && typeof test.stdinUtf8 !== "string")
      return invalid(i, "stdinUtf8 должен быть текстом");
    for (const key of ["name", "stdinUtf8"] as const)
      if (typeof test[key] === "string" && !wellFormed(test[key]))
        limit(i, `${key} содержит некорректный Unicode`);
    for (const key of ["expectedStdout", "expectedStderr"] as const) {
      if (test[key] != null && typeof test[key] !== "string")
        return invalid(i, `${key} должен быть текстом`);
      if (typeof test[key] === "string" && !wellFormed(test[key]))
        limit(i, `${key} содержит некорректный Unicode`);
    }
    if (bytes(test.stdinUtf8 ?? "") > 1048576) limit(i, "ввод больше 1 МиБ");
    if (
      test.argv !== undefined &&
      (!Array.isArray(test.argv) ||
        test.argv.length > 100 ||
        test.argv.some((arg: unknown) => typeof arg !== "string"))
    )
      return invalid(i, "argv — массив не больше 100 строк");
    let total = 0;
    for (const arg of test.argv ?? []) {
      if (arg.includes("\0") || !wellFormed(arg))
        limit(i, "аргумент содержит недопустимый символ");
      const size = bytes(arg);
      if (size > 8192) limit(i, "аргумент больше 8 КиБ");
      total += size;
    }
    if (total > 65536) limit(i, "аргументы вместе больше 64 КиБ");
    if (test.expectedExitCode != null && !exitCode(test.expectedExitCode))
      return invalid(i, "код завершения должен быть целым 32-битным числом");
    if (
      test.expectedExitCodes != null &&
      (!Array.isArray(test.expectedExitCodes) ||
        test.expectedExitCodes.length !== 1 ||
        !exitCode(test.expectedExitCodes[0]))
    )
      return invalid(i, "поддерживается один ожидаемый код завершения");
  }
  return {
    cases: parsed as EditableCase[],
    error: limitError ?? (parsed.length ? null : "Добавьте хотя бы один тест"),
  };
}
export function writeCases(cases: EditableCase[]) {
  return JSON.stringify(cases, null, 2);
}
export function newCase(id: string, name: string): EditableCase {
  return { id, name, stdinUtf8: "", argv: [] };
}
export function oracleExit(test: EditableCase) {
  return test.expectedExitCodes?.[0] ?? test.expectedExitCode ?? null;
}
export function withOracleExit(
  test: EditableCase,
  value: number | null,
): EditableCase {
  const updated = { ...test };
  if (value === null) {
    delete updated.expectedExitCode;
    delete updated.expectedExitCodes;
  } else if (Array.isArray(test.expectedExitCodes))
    updated.expectedExitCodes = [value];
  else updated.expectedExitCode = value;
  return updated;
}
