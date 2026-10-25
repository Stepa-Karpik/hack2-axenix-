import type { Diagnostic } from "./types";
export function diagnosticText(d: Diagnostic, source?: string): string {
  if (d.code === "UNSUPPORTED_CONTROL_FLOW")
    return "Для этого метода пока недоступны точная схема потока и правки блоками. Код сохранён.";
  if (
    d.code.includes("PARSE") ||
    /Parse error|Encountered|Was expecting|expected one of/i.test(d.message)
  ) {
    if (
      source !== undefined &&
      !/\b(class|interface|enum|record)\s+[A-Za-z_$]/.test(source) &&
      /\w+\s*\([^)]*\)\s*\{/.test(source)
    )
      return "Проверьте объявление класса. Метод должен находиться внутри класса, например class Main { … }.";
    if (/\";\"|semicolon/.test(d.message))
      return "Проверьте точку с запятой и скобки в указанной строке.";
    return "Ошибка синтаксиса Java. Проверьте скобки и объявление в указанной строке.";
  }
  return d.message.length > 260 ? d.message.slice(0, 257) + "…" : d.message;
}
