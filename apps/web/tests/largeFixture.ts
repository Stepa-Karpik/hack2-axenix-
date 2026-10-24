import { readFileSync } from "node:fs";

/** Read the versioned fixture; the browser and engine benchmark use the same source bytes. */
export function largeFixture(): Record<string, string> {
  const paths = [
    "demo/Main.java",
    ...Array.from({ length: 9 }, (_, i) => `demo/stages/Stage${i}.java`),
  ];
  return Object.fromEntries(
    paths.map((path) => [
      path,
      readFileSync(
        new URL("../../../fixtures/synthetic/large/" + path, import.meta.url),
        "utf8",
      ),
    ]),
  );
}

/** Independent reduction oracle for bounded inputs; no Java execution in the test host. */
export function expectedOutput(input: number[]) {
  const total = Array.from({ length: 45 }, (_, index) => index + 1).reduce(
    (total, bias) => {
      const values = input.map((value) => Math.abs(value + bias));
      if (!values.length) return total;
      const transformed = values.map((value) =>
        value % 2 === 0 ? value / 2 : value * 2,
      );
      return (
        total +
        transformed.reduce((a, b) => a + b, 0) +
        Math.max(...values) -
        Math.min(...values) +
        values.length
      );
    },
    0,
  );
  return `результат=${total}\n`;
}

export function largeCases() {
  let seed = 20261024;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  return Array.from({ length: 20 }, (_, index) => {
    const count = index === 0 ? 0 : index === 1 ? 1 : (next() % 15) + 1;
    const values = Array.from(
      { length: count },
      () => Number(next() % 41) - 20,
    );
    return {
      id: "large-" + index,
      name: index === 0 ? "Пустой вход" : `Набор ${index}`,
      stdinUtf8: count + "\n" + values.join(" ") + "\n",
      argv: [],
      expectedExitCode: 0,
      expectedStdout: expectedOutput(values),
      expectedStderr: "",
    };
  });
}
